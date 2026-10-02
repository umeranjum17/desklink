//! An X11 desktop: capture and input over one connection.
//!
//! This is the second capture backend, and the one a machine without a working
//! screen-cast portal uses — a headless X server, a remote X session, or
//! XWayland. It is capability-detected rather than assumed: the portal is
//! preferred when it is there, because the portal is what carries the user's
//! consent on a Wayland desktop.
//!
//! Capture reads the root window directly and input goes through XTest, so on an
//! X server this process owns, **nothing it does can reach another session's
//! keyboard**: XTest is scoped to the X server it is connected to, unlike
//! `uinput`, which the kernel delivers to whatever holds the seat.

use crate::convert::{fit, to_i420, I420};
use anyhow::{Context, Result};
use std::os::unix::io::{AsFd, AsRawFd};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, Screen};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

/// X key codes are evdev codes offset by 8 on every evdev-backed server,
/// including Xvfb, so the layout mapping the engine already has applies here too.
const X_KEYCODE_OFFSET: u8 = 8;

/// X core-protocol button numbers.
pub mod button {
    pub const LEFT: u8 = 1;
    pub const MIDDLE: u8 = 2;
    pub const RIGHT: u8 = 3;
    pub const WHEEL_UP: u8 = 4;
    pub const WHEEL_DOWN: u8 = 5;
    pub const WHEEL_LEFT: u8 = 6;
    pub const WHEEL_RIGHT: u8 = 7;
}

pub struct X11Desktop {
    connection: RustConnection,
    root: u32,
    pub width: usize,
    pub height: usize,
    /// Bytes per pixel the server reports; 4 for the 24/32-bit TrueColor that
    /// every normal server uses, and the only depth this backend reads.
    depth: u8,
    /// A reused server-allocated MIT-SHM segment. Absent on a server without
    /// MIT-SHM (remote X), where grabs fall back to socket GetImage.
    shm: Option<ShmSegment>,
    /// An XDamage object watching the root. Absent where the server lacks the
    /// extension, where the capture loop falls back to pixel hashing.
    damage: Option<u32>,
}

/// A server-allocated MIT-SHM segment, mmapped into this process and reused
/// for every grab. The server frees its side when this connection closes, so
/// dropping the mapping and the fd here is the whole cleanup.
struct ShmSegment {
    seg: u32,
    // Held open for the mapping's lifetime and closed on drop; never read.
    #[allow(dead_code)]
    fd: std::os::unix::io::OwnedFd,
    ptr: *mut u8,
    len: usize,
}

// Only touched through `&mut X11Desktop`, itself always behind a Mutex.
unsafe impl Send for ShmSegment {}

impl Drop for ShmSegment {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.ptr as *mut libc::c_void, self.len);
        }
    }
}

impl X11Desktop {
    /// Connect to `display` (`:99`, or the `DISPLAY` environment when omitted).
    pub fn connect(display: Option<&str>) -> Result<Self> {
        let (connection, screen_number) = match display {
            Some(display) => RustConnection::connect(Some(display))
                .with_context(|| format!("cannot open X display {display}"))?,
            None => {
                RustConnection::connect(None).context("cannot open the X display in DISPLAY")?
            }
        };
        let screen: &Screen = connection
            .setup()
            .roots
            .get(screen_number as usize)
            .context("the X display has no screen")?;
        if screen.root_depth != 24 {
            anyhow::bail!(
                "unsupported X root depth {}; this backend reads 24-bit TrueColor",
                screen.root_depth
            );
        }
        Ok(Self {
            root: screen.root,
            width: screen.width_in_pixels as usize,
            height: screen.height_in_pixels as usize,
            depth: screen.root_depth,
            shm: Self::setup_shm(
                &connection,
                screen.width_in_pixels as usize,
                screen.height_in_pixels as usize,
            ),
            damage: Self::setup_damage(&connection, screen.root),
            connection,
        })
    }

    /// Allocate one MIT-SHM segment for the full root and map it here. Any
    /// failure means "no SHM on this server", never an error: the caller
    /// falls back to socket GetImage and reports it via [`Self::capture_path`].
    fn setup_shm(connection: &RustConnection, width: usize, height: usize) -> Option<ShmSegment> {
        let len = width.checked_mul(height)?.checked_mul(4)?;
        let size: u32 = len.try_into().ok()?;
        if size == 0 {
            return None;
        }
        connection
            .extension_information(x11rb::protocol::shm::X11_EXTENSION_NAME)
            .ok()??;
        let reply = connection.shm_query_version().ok()?.reply().ok()?;
        let _ = (reply.major_version, reply.minor_version);
        let seg = connection.generate_id().ok()?;
        let reply = connection
            .shm_create_segment(seg, size, false)
            .ok()?
            .reply()
            .ok()?;
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                reply.shm_fd.as_fd().as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        Some(ShmSegment {
            seg,
            fd: reply.shm_fd,
            ptr: ptr as *mut u8,
            len,
        })
    }

    /// Watch the root for changes at NON_EMPTY level: one event per change
    /// batch, re-armed by [`Self::take_damage`]. Absent where unsupported.
    fn setup_damage(connection: &RustConnection, root: u32) -> Option<u32> {
        use x11rb::protocol::damage::ReportLevel;
        let ext = connection
            .extension_information(x11rb::protocol::damage::X11_EXTENSION_NAME)
            .ok()?;
        ext?;
        connection.damage_query_version(1, 1).ok()?.reply().ok()?;
        let damage = connection.generate_id().ok()?;
        connection
            .damage_create(damage, root, ReportLevel::NON_EMPTY)
            .ok()?
            .check()
            .ok()?;
        connection.flush().ok()?;
        Some(damage)
    }

    /// Which grab path is in use: `"shm"`, or `"get_image"` on a server
    /// without MIT-SHM. Labs cite this so a number is never ambiguous.
    pub fn capture_path(&self) -> &'static str {
        if self.shm.is_some() {
            "shm"
        } else {
            "get_image"
        }
    }

    /// Whether XDamage watches the root. When false the capture loop keeps
    /// the old pixel-hash change detection.
    pub fn damage_armed(&self) -> bool {
        self.damage.is_some()
    }

    /// Drain queued events and report whether the root changed since the last
    /// call. Without Damage this always returns true and the caller hashes.
    pub fn take_damage(&self) -> bool {
        let damage = match self.damage {
            Some(damage) => damage,
            None => return true,
        };
        let mut changed = false;
        loop {
            match self.connection.poll_for_event() {
                Ok(Some(Event::DamageNotify(_))) => changed = true,
                Ok(Some(_)) => {}
                Ok(None) => break,
                // Let the next grab surface connection trouble as an error.
                Err(_) => return true,
            }
        }
        if changed {
            // Clear the pending region so the next change notifies again.
            let _ = self.connection.damage_subtract(damage, 0u32, 0u32);
            let _ = self.connection.flush();
        }
        changed
    }

    pub fn screen_size(&self) -> (i32, i32) {
        (self.width as i32, self.height as i32)
    }

    /// Read the whole root window as I420, downscaled into the caller's box.
    ///
    /// The root image is the composited screen contents: on a server with no
    /// compositor this is every window drawn onto the framebuffer, which is what
    /// the viewer expects to see.
    pub fn capture(&mut self, max_width: usize, max_height: usize) -> Result<I420> {
        self.capture_with_pixels(max_width, max_height)
            .map(|(frame, _)| frame)
    }

    /// The frame and the root image it came from: `width * 4`-byte BGRX rows at
    /// the screen's own size, which a caller that keeps pre-encode pixels
    /// samples into the frame's geometry with `convert::to_bgrx`.
    pub fn capture_with_pixels(
        &mut self,
        max_width: usize,
        max_height: usize,
    ) -> Result<(I420, Vec<u8>)> {
        let raw = self.capture_raw()?;
        let frame = self.convert(&raw, max_width, max_height)?;
        Ok((frame, raw))
    }

    /// The root image as `width * 4`-byte BGRX rows at the screen's own size.
    pub fn capture_raw(&mut self) -> Result<Vec<u8>> {
        // The server's depth is the only field that can tell us how the pixel is
        // packed; the engine assumes the byte order every TrueColor server uses.
        let _ = self.depth;
        let stride = self.width * 4;
        // Prefer MIT-SHM. A segment that worked at connect can still break
        // later (revoked by the server); that degrades to the socket path,
        // which keeps capturing, instead of stalling on failing grabs.
        if let Ok(output) = self.capture_shm(stride) {
            return Ok(output);
        }
        self.shm = None;
        let image = self
            .connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                0,
                0,
                self.width as u16,
                self.height as u16,
                u32::MAX,
            )
            .context("X11 GetImage failed")?
            .reply()
            .context("X11 GetImage returned no reply")?;
        if image.data.len() < stride * self.height {
            anyhow::bail!(
                "X11 returned {} bytes for a {}x{} screen",
                image.data.len(),
                self.width,
                self.height
            );
        }
        Ok(image.data)
    }

    /// Downscale a [`Self::capture_raw`] image into the caller's box as I420.
    pub fn convert(&self, raw: &[u8], max_width: usize, max_height: usize) -> Result<I420> {
        let (width, height) = fit(self.width, self.height, max_width, max_height);
        to_i420(
            raw,
            self.width,
            self.height,
            self.width * 4,
            crate::convert::PixelFormat::Bgrx,
            width,
            height,
        )
        .context("the captured X11 pixels are not a format this engine can read")
    }

    /// One MIT-SHM grab into the reused segment. The caller tears the
    /// segment down on any error and falls back to the socket path.
    fn capture_shm(&self, stride: usize) -> Result<Vec<u8>> {
        let (seg, ptr, len) = match &self.shm {
            Some(shm) => (shm.seg, shm.ptr, shm.len),
            None => anyhow::bail!("no MIT-SHM segment"),
        };
        // MIT-SHM: the server writes the root straight into our mapping;
        // the reply only signals completion. The segment is reused, so
        // copy out before the next grab.
        self.connection
            .shm_get_image(
                self.root,
                0,
                0,
                self.width as u16,
                self.height as u16,
                u32::MAX,
                u8::from(ImageFormat::Z_PIXMAP),
                seg,
                0,
            )
            .context("X11 ShmGetImage failed")?
            .reply()
            .context("X11 ShmGetImage returned no reply")?;
        let pixels = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
        // Snapshot the length: the caller drops the mapping on error, so no
        // slice may be alive past this return.
        let byte_len = pixels.len();
        if byte_len < stride * self.height {
            anyhow::bail!(
                "X11 shared memory holds {} bytes for a {}x{} screen",
                byte_len,
                self.width,
                self.height
            );
        }
        // Copy out of the reused segment before the next grab overwrites
        // it. This copy is inherent to SHM; the socket arm moves its reply.
        Ok(pixels.to_vec())
    }

    fn flush(&self) -> Result<()> {
        self.connection
            .flush()
            .context("the X11 connection dropped")
    }

    /// Query the root pointer independently of pixel damage. GetImage and
    /// MIT-SHM do not contain the server cursor and we never composite it.
    pub fn cursor_position(&self) -> Result<(i32, i32, bool)> {
        let pointer = self.connection.query_pointer(self.root)?.reply()?;
        Ok((
            i32::from(pointer.root_x),
            i32::from(pointer.root_y),
            pointer.same_screen
                && pointer.root_x >= 0
                && pointer.root_y >= 0
                && (pointer.root_x as usize) < self.width
                && (pointer.root_y as usize) < self.height,
        ))
    }

    pub fn move_pointer(&self, x: i64, y: i64) -> Result<()> {
        let (x, y) = self.clamp(x, y);
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::MOTION_NOTIFY_EVENT,
                false as u8,
                0,
                self.root,
                x as i16,
                y as i16,
                0,
            )
            .context("XTest motion failed")?;
        self.flush()
    }

    pub fn button(&self, button: u8, down: bool) -> Result<()> {
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::BUTTON_PRESS_EVENT + u8::from(!down),
                button,
                0,
                self.root,
                0,
                0,
                0,
            )
            .context("XTest button failed")?;
        self.flush()
    }

    /// A wheel notch. `dy` is in detents and positive means "down", matching the
    /// control channel's convention.
    pub fn scroll(&self, dx: i64, dy: i64) -> Result<()> {
        for _ in 0..dy.abs().min(20) {
            self.button(
                if dy > 0 {
                    button::WHEEL_DOWN
                } else {
                    button::WHEEL_UP
                },
                true,
            )?;
            self.button(
                if dy > 0 {
                    button::WHEEL_DOWN
                } else {
                    button::WHEEL_UP
                },
                false,
            )?;
        }
        for _ in 0..dx.abs().min(20) {
            self.button(
                if dx > 0 {
                    button::WHEEL_RIGHT
                } else {
                    button::WHEEL_LEFT
                },
                true,
            )?;
            self.button(
                if dx > 0 {
                    button::WHEEL_RIGHT
                } else {
                    button::WHEEL_LEFT
                },
                false,
            )?;
        }
        Ok(())
    }

    /// `evdev_code` is the layout layer's Linux key code; the X server's own key
    /// code for it is that value plus eight.
    pub fn key(&self, evdev_code: i16, down: bool) -> Result<()> {
        let keycode = evdev_code.saturating_add(X_KEYCODE_OFFSET as i16);
        if !(8..=255).contains(&keycode) {
            anyhow::bail!("{evdev_code} is not a key this X server can press");
        }
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::KEY_PRESS_EVENT + u8::from(!down),
                keycode as u8,
                0,
                0,
                0,
                0,
                0,
            )
            .context("XTest key failed")?;
        self.flush()
    }

    fn clamp(&self, x: i64, y: i64) -> (i64, i64) {
        (
            x.clamp(0, self.width.saturating_sub(1) as i64),
            y.clamp(0, self.height.saturating_sub(1) as i64),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitting_never_upscales_and_keeps_even_dimensions() {
        assert_eq!(fit(800, 600, 1280, 800), (800, 600));
        assert_eq!(fit(1920, 1080, 1280, 720), (1280, 720));
        let (w, h) = fit(1000, 1000, 600, 600);
        assert_eq!((w, h), (600, 600));
    }
}
