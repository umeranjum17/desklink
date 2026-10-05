//! A latency stamp for a Wayland compositor this process owns.
//!
//! It asks for a fullscreen toplevel and repaints on its own clock (120 Hz by
//! default), never waiting for the compositor's frame callback. Each repaint
//! writes the wall clock in milliseconds (low 24 bits of `CLOCK_REALTIME`) as 24
//! black-or-white 48 px blocks along the top-left edge. A receiver that decodes
//! those blocks from a presented frame knows how old that frame's picture is.
//!
//! `--mode typing` changes only the stamp strip; `--mode scroll` also redraws a
//! full-screen field of shifted stripes on every repaint, a worst case like
//! dense scrolling text; `--mode still` freezes the stamp when `--freeze-file`
//! appears, else `--freeze-after` seconds after it starts (two by default), so
//! a receiver can check that a still screen gets its sharp refine pass.
//!
//! `--cursor-fixture` is for a lab compositor with no input devices: it adds a
//! virtual pointer to the seat, shows a 16 px magenta cursor whose hotspot is
//! `CURSOR_HOTSPOT`, and with `--pointer-log` appends each pointer position the
//! compositor delivers to the surface as a JSON line. `--background dark`
//! paints the field dark instead of white.
//!
//! ```sh
//! WAYLAND_DISPLAY=wayland-1 cargo run --example wl_stamp_target -- --mode scroll
//! ```

#[cfg(target_os = "linux")]
use anyhow::{bail, Context, Result};
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::os::fd::AsFd;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "linux")]
use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_output, wl_pointer, wl_registry, wl_seat, wl_shm, wl_shm_pool,
    wl_surface,
};
#[cfg(target_os = "linux")]
use wayland_client::{Connection, Dispatch, QueueHandle};
#[cfg(target_os = "linux")]
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};
#[cfg(target_os = "linux")]
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1 as virtual_pointer_manager,
    zwlr_virtual_pointer_v1 as virtual_pointer,
};

#[cfg(target_os = "linux")]
const BLOCK: usize = 48;
#[cfg(target_os = "linux")]
const BITS: usize = 24;
#[cfg(target_os = "linux")]
const WHITE: u32 = 0x00ff_ffff;
#[cfg(target_os = "linux")]
const BLACK: u32 = 0;
/// Enough buffers that one is nearly always released by the next repaint.
#[cfg(target_os = "linux")]
const BUFFERS: usize = 4;
#[cfg(target_os = "linux")]
const CURSOR_HOTSPOT: (i32, i32) = (4, 6);
#[cfg(target_os = "linux")]
const DARK: u32 = 0x0020_2228;

#[derive(PartialEq)]
#[cfg(target_os = "linux")]
enum Mode {
    Typing,
    Scroll,
    Still,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct State {
    cursor_enabled: bool,
    cursor_surface: Option<wl_surface::WlSurface>,
    pointer_log: Option<File>,
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    /// Size the compositor configured, once acknowledged.
    size: Option<(usize, usize)>,
    pending_size: (usize, usize),
    /// The output's current mode: the size to use when the first configure
    /// leaves it to the client, as a compositor does before a surface maps.
    output_size: (usize, usize),
    busy: [bool; BUFFERS],
    closed: bool,
    seat: Option<wl_seat::WlSeat>,
    pointers: Option<virtual_pointer_manager::ZwlrVirtualPointerManagerV1>,
    virtual_pointer: Option<virtual_pointer::ZwlrVirtualPointerV1>,
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("wl_stamp_target is Linux-only");
}

#[cfg(target_os = "linux")]
fn main() -> Result<()> {
    let mut mode = Mode::Typing;
    let mut rate = 120u64;
    let mut freeze_after = Duration::from_secs(2);
    let mut freeze_file: Option<String> = None;
    let mut pointer_log = None;
    let mut background = WHITE;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cursor-fixture" => {}
            "--pointer-log" => {
                pointer_log = Some(File::create(
                    args.next().context("--pointer-log needs a value")?,
                )?)
            }
            "--background" => {
                background = match args.next().as_deref() {
                    Some("light") => WHITE,
                    Some("dark") => DARK,
                    other => bail!("--background must be light or dark, not {other:?}"),
                }
            }
            "--mode" => {
                mode = match args.next().as_deref() {
                    Some("typing") => Mode::Typing,
                    Some("scroll") => Mode::Scroll,
                    Some("still") => Mode::Still,
                    other => bail!("--mode must be typing, scroll or still, not {other:?}"),
                }
            }
            "--rate" => rate = args.next().context("--rate needs a value")?.parse()?,
            "--freeze-file" => {
                freeze_file = Some(args.next().context("--freeze-file needs a value")?)
            }
            "--freeze-after" => {
                freeze_after = Duration::from_secs(
                    args.next()
                        .context("--freeze-after needs a value")?
                        .parse()?,
                )
            }
            other => bail!("unknown argument {other}"),
        }
    }

    let connection =
        Connection::connect_to_env().context("no Wayland compositor in WAYLAND_DISPLAY")?;
    let mut queue = connection.new_event_queue();
    let qh = queue.handle();
    connection.display().get_registry(&qh, ());
    let mut state = State {
        cursor_enabled: std::env::args().any(|a| a == "--cursor-fixture"),
        pointer_log,
        ..State::default()
    };
    // Two round trips: the globals, then the output's mode events.
    queue.roundtrip(&mut state)?;
    queue.roundtrip(&mut state)?;
    let compositor = state.compositor.clone().context("no wl_compositor")?;
    let shm = state.shm.clone().context("no wl_shm")?;
    let wm_base = state.wm_base.clone().context("no xdg_wm_base")?;

    if let (Some(pointers), Some(seat)) = (&state.pointers, &state.seat) {
        state.virtual_pointer = Some(pointers.create_virtual_pointer(Some(seat), &qh, ()));
    }
    let cursor_file = memfd(16 * 16 * 4)?;
    if state.cursor_enabled {
        // Task-owned fixture: an unmistakable opaque magenta cursor.
        let cursor_pixels = unsafe { memmap(&cursor_file, 16 * 16 * 4)? };
        for pixel in cursor_pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&0xffff00ffu32.to_le_bytes());
        }
        let cursor_pool = shm.create_pool(cursor_file.as_fd(), 16 * 16 * 4, &qh, ());
        let cursor_buffer =
            cursor_pool.create_buffer(0, 16, 16, 64, wl_shm::Format::Argb8888, &qh, ());
        let cursor_surface = compositor.create_surface(&qh, ());
        cursor_surface.attach(Some(&cursor_buffer), 0, 0);
        cursor_surface.damage(0, 0, 16, 16);
        cursor_surface.commit();
        state.cursor_surface = Some(cursor_surface);
    }
    let surface = compositor.create_surface(&qh, ());
    let xdg = wm_base.get_xdg_surface(&surface, &qh, ());
    let toplevel = xdg.get_toplevel(&qh, ());
    toplevel.set_app_id("desklink-stamp".into());
    toplevel.set_fullscreen(None);
    surface.commit();
    while state.size.is_none() {
        queue.blocking_dispatch(&mut state)?;
    }
    let (width, height) = state.size.unwrap();
    if width == 0 || height == 0 {
        bail!("the compositor gave no size and reported no output mode");
    }
    let frame_bytes = width * height * 4;

    let file = memfd(frame_bytes * BUFFERS)?;
    // SAFETY: the file is ours, sized above, and only this process writes it.
    let map = unsafe { memmap(&file, frame_bytes * BUFFERS)? };
    let pool = shm.create_pool(file.as_fd(), (frame_bytes * BUFFERS) as i32, &qh, ());
    let buffers: Vec<_> = (0..BUFFERS)
        .map(|index| {
            pool.create_buffer(
                (index * frame_bytes) as i32,
                width as i32,
                height as i32,
                (width * 4) as i32,
                wl_shm::Format::Xrgb8888,
                &qh,
                index,
            )
        })
        .collect();
    for pixel in map.chunks_exact_mut(4) {
        pixel.copy_from_slice(&background.to_le_bytes());
    }

    println!("{{\"ready\":true,\"width\":{width},\"height\":{height}}}");
    let interval = Duration::from_nanos(1_000_000_000 / rate.max(1));
    let started = Instant::now();
    let mut next = Instant::now();
    let mut frame = 0usize;
    let mut frozen_ms = None;
    let mut frozen_at = 0usize;
    while !state.closed {
        queue.dispatch_pending(&mut state)?;
        connection.flush()?;
        if let Some(guard) = queue.prepare_read() {
            let timeout = next.saturating_duration_since(Instant::now());
            let mut poll = libc::pollfd {
                fd: std::os::fd::AsRawFd::as_raw_fd(&guard.connection_fd()),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd for the duration of the call.
            let ready = unsafe { libc::poll(&mut poll, 1, timeout.as_millis() as i32) };
            if ready > 0 {
                guard.read()?;
            }
        }
        queue.dispatch_pending(&mut state)?;
        if Instant::now() < next {
            continue;
        }
        next += interval;
        if Instant::now() > next {
            next = Instant::now() + interval;
        }
        // A still screen is one that stops committing: once the frozen stamp
        // is shown, the compositor has nothing new to capture.
        if freeze_file
            .as_deref()
            .is_some_and(|path| !std::path::Path::new(path).exists())
        {
            frozen_ms = None;
        }
        if frozen_ms.is_some() && frame > frozen_at {
            continue;
        }
        let Some(index) = (0..BUFFERS).find(|&i| !state.busy[i]) else {
            continue;
        };
        let pixels = &mut map[index * frame_bytes..(index + 1) * frame_bytes];
        let pixels: &mut [u32] = bytemuck(pixels);
        if mode == Mode::Scroll {
            fill(
                pixels,
                width,
                0,
                2 * BLOCK,
                width,
                height - 2 * BLOCK,
                WHITE,
            );
            let mut y = 2 * BLOCK;
            while y + 12 <= height {
                let mut x = (frame * 7 + y) % 37;
                while x < width {
                    fill(pixels, width, x, y, 3 + (x + y) % 11, 12, BLACK);
                    x += 37;
                }
                y += 24;
            }
        }
        let now = now_ms();
        let told = freeze_file
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).exists());
        let ms = if mode == Mode::Still
            && (told || (freeze_file.is_none() && started.elapsed() > freeze_after))
        {
            *frozen_ms.get_or_insert_with(|| {
                frozen_at = frame;
                now
            })
        } else {
            now
        } & 0xff_ffff;
        for bit in 0..BITS {
            let on = (ms >> (BITS - 1 - bit)) & 1 == 1;
            fill(
                pixels,
                width,
                bit * BLOCK,
                0,
                BLOCK,
                BLOCK,
                if on { WHITE } else { BLACK },
            );
        }
        state.busy[index] = true;
        surface.attach(Some(&buffers[index]), 0, 0);
        if mode == Mode::Scroll {
            surface.damage_buffer(0, 0, width as i32, height as i32);
        } else {
            surface.damage_buffer(0, 0, (BITS * BLOCK) as i32, BLOCK as i32);
        }
        surface.commit();
        frame += 1;
    }
    drop(toplevel);
    Ok(())
}

#[cfg(target_os = "linux")]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn fill(pixels: &mut [u32], stride: usize, x: usize, y: usize, w: usize, h: usize, colour: u32) {
    let height = pixels.len() / stride;
    for row in y..(y + h).min(height) {
        let start = row * stride + x.min(stride);
        let end = row * stride + (x + w).min(stride);
        pixels[start..end].fill(colour);
    }
}

#[cfg(target_os = "linux")]
fn bytemuck(bytes: &mut [u8]) -> &mut [u32] {
    assert_eq!(bytes.as_ptr() as usize % 4, 0);
    // SAFETY: aligned (checked), and every bit pattern is a valid u32.
    unsafe { std::slice::from_raw_parts_mut(bytes.as_mut_ptr().cast(), bytes.len() / 4) }
}

#[cfg(target_os = "linux")]
fn memfd(len: usize) -> Result<File> {
    // SAFETY: a static C string name; the fd is owned by the returned File.
    let fd = unsafe { libc::memfd_create(c"desklink-stamp".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        bail!("memfd_create failed: {}", std::io::Error::last_os_error());
    }
    // SAFETY: fd was just created and is owned by nothing else.
    let file = unsafe { <File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
    file.set_len(len as u64)?;
    Ok(file)
}

/// # Safety
/// `file` must be at least `len` bytes and must outlive the mapping.
#[cfg(target_os = "linux")]
unsafe fn memmap(file: &File, len: usize) -> Result<&'static mut [u8]> {
    let ptr = libc::mmap(
        std::ptr::null_mut(),
        len,
        libc::PROT_READ | libc::PROT_WRITE,
        libc::MAP_SHARED,
        std::os::fd::AsRawFd::as_raw_fd(file),
        0,
    );
    if ptr == libc::MAP_FAILED {
        bail!("mmap failed: {}", std::io::Error::last_os_error());
    }
    Ok(std::slice::from_raw_parts_mut(ptr.cast(), len))
}

#[cfg(target_os = "linux")]
impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            match interface.as_str() {
                "wl_compositor" => {
                    state.compositor = Some(registry.bind(name, version.min(4), qh, ()))
                }
                "wl_seat" if state.cursor_enabled => {
                    let seat = registry.bind::<wl_seat::WlSeat, _, _>(name, version.min(5), qh, ());
                    state.seat = Some(seat);
                }
                // The lab seat's only pointer device; the harness moves the
                // cursor through the compositor, never through this.
                "zwlr_virtual_pointer_manager_v1" if state.cursor_enabled => {
                    state.pointers = Some(registry.bind(name, 1, qh, ()));
                }
                "wl_shm" => state.shm = Some(registry.bind(name, 1, qh, ())),
                "xdg_wm_base" => state.wm_base = Some(registry.bind(name, 1, qh, ())),
                "wl_output" => {
                    registry.bind::<wl_output::WlOutput, _, _>(name, 1, qh, ());
                }
                _ => {}
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Dispatch<xdg_wm_base::XdgWmBase, ()> for State {
    fn event(
        _: &mut Self,
        base: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            base.pong(serial);
        }
    }
}

#[cfg(target_os = "linux")]
impl Dispatch<xdg_surface::XdgSurface, ()> for State {
    fn event(
        state: &mut Self,
        surface: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            surface.ack_configure(serial);
            // The stamp keeps the first real size; a later reconfigure would
            // need new buffers, which a fixed-size lab output never asks for.
            if state.size.is_none() {
                let (w, h) = state.pending_size;
                state.size = Some(if w > 0 && h > 0 {
                    (w, h)
                } else {
                    state.output_size
                });
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Dispatch<xdg_toplevel::XdgToplevel, ()> for State {
    fn event(
        state: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } => {
                state.pending_size = (width.max(0) as usize, height.max(0) as usize)
            }
            xdg_toplevel::Event::Close => state.closed = true,
            _ => {}
        }
    }
}

#[cfg(target_os = "linux")]
impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Mode {
            flags,
            width,
            height,
            ..
        } = event
        {
            if flags
                .into_result()
                .is_ok_and(|f| f.contains(wl_output::Mode::Current))
            {
                state.output_size = (width.max(0) as usize, height.max(0) as usize);
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Dispatch<wl_buffer::WlBuffer, usize> for State {
    fn event(
        state: &mut Self,
        _: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = event {
            state.busy[*index] = false;
        }
    }
}

#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: ignore wl_compositor::WlCompositor);
#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: ignore wl_surface::WlSurface);
#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: ignore wl_shm::WlShm);
#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: ignore wl_shm_pool::WlShmPool);

#[cfg(target_os = "linux")]
impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: wayland_client::WEnum::Value(capabilities),
        } = event
        {
            if capabilities.contains(wl_seat::Capability::Pointer) {
                seat.get_pointer(qh, ());
            }
        }
    }
}
#[cfg(target_os = "linux")]
impl Dispatch<wl_pointer::WlPointer, ()> for State {
    fn event(
        state: &mut Self,
        pointer: &wl_pointer::WlPointer,
        event: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let (x, y) = match event {
            wl_pointer::Event::Enter {
                serial,
                surface_x,
                surface_y,
                ..
            } => {
                let (hx, hy) = CURSOR_HOTSPOT;
                pointer.set_cursor(serial, state.cursor_surface.as_ref(), hx, hy);
                (surface_x, surface_y)
            }
            wl_pointer::Event::Motion {
                surface_x,
                surface_y,
                ..
            } => (surface_x, surface_y),
            _ => return,
        };
        if let Some(log) = state.pointer_log.as_mut() {
            use std::io::Write;
            let _ = writeln!(log, "{{\"x\":{x},\"y\":{y}}}");
        }
    }
}
#[cfg(target_os = "linux")]
impl Dispatch<wl_buffer::WlBuffer, ()> for State {
    fn event(
        _: &mut Self,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: virtual_pointer_manager::ZwlrVirtualPointerManagerV1);
#[cfg(target_os = "linux")]
wayland_client::delegate_noop!(State: virtual_pointer::ZwlrVirtualPointerV1);
