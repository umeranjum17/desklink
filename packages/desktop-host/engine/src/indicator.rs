//! Local feedback for agent sessions. The helper is a separate nonactivating
//! window-owning process so its windows can be excluded from desktop capture.
use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

/// One drawn state of the X11 agent cue, announced by the helper before it
/// reaches the screen: the window's origin and size plus the inputs of
/// `desklink_indicator_covered`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cue {
    pub x: i64,
    pub y: i64,
    pub size: i64,
    pub unit: f64,
    pub opacity: f64,
    pub click: f64,
    pub typed: f64,
    pub threshold: u32,
    /// Logical radius drawn so far while the shaped cue appears or leaves.
    pub reveal: f64,
}

impl Cue {
    fn parse(line: &str) -> Option<Self> {
        let mut parts = line.strip_prefix("P ")?.split(' ');
        let mut next = || parts.next();
        Some(Self {
            x: next()?.parse().ok()?,
            y: next()?.parse().ok()?,
            size: next()?
                .parse()
                .ok()
                .filter(|size| (1..=1024).contains(size))?,
            unit: next()?
                .parse()
                .ok()
                .filter(|unit: &f64| unit.is_finite() && *unit > 0.0)?,
            opacity: next()?.parse().ok()?,
            click: next()?.parse().ok()?,
            typed: next()?.parse().ok()?,
            threshold: next()?.parse().ok()?,
            reveal: next()?.parse().ok()?,
        })
    }
}

/// The X11 agent cue's announcements, read by the capture loop itself. The
/// helper writes each state before drawing it, so everything a grab can
/// contain is already in the pipe when the grab returns.
#[derive(Default)]
pub struct CueFeed {
    reader: Option<BufReader<std::process::ChildStdout>>,
    line: Vec<u8>,
    recent: Vec<Cue>,
}

impl CueFeed {
    /// The last two states (the newer may not be drawn yet) plus every state
    /// announced since the previous call.
    pub fn drain(&mut self) -> Vec<Cue> {
        let mut states = self.recent.clone();
        while let Some(reader) = self.reader.as_mut() {
            match reader.read_until(b'\n', &mut self.line) {
                Ok(_) if self.line.ends_with(b"\n") => {
                    if let Some(cue) = Cue::parse(String::from_utf8_lossy(&self.line).trim()) {
                        states.push(cue);
                        self.recent.push(cue);
                        if self.recent.len() > 2 {
                            self.recent.remove(0);
                        }
                    }
                    self.line.clear();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // The helper exited, and it closes its window before that.
                _ => {
                    self.reader = None;
                    self.recent.clear();
                }
            }
        }
        states
    }
}

pub type Cues = std::sync::Arc<std::sync::Mutex<CueFeed>>;

pub struct Indicator {
    child: Option<Child>,
    input: Option<ChildStdin>,
    scale_x: f64,
    scale_y: f64,
    #[cfg(target_os = "linux")]
    position: std::sync::Arc<std::sync::Mutex<Option<(i64, i64)>>>,
    cues: Cues,
}

#[cfg(target_os = "linux")]
fn point_wayland_executable() -> Result<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("DESKLINK_POINT_TEST_ENGINE") {
        return Ok(path.into());
    }
    Ok(std::env::current_exe()?)
}

impl Indicator {
    #[cfg(target_os = "linux")]
    pub fn wayland_layer_shell_available() -> Result<bool> {
        let mut command = Command::new(point_wayland_executable()?);
        command.arg("point-layer-shell-probe");
        match Self::spawn(&mut command, 1.0, 1.0) {
            Ok(helper) => {
                helper.stop();
                Ok(true)
            }
            Err(error) if error.to_string().contains("layer_shell_unavailable") => Ok(false),
            Err(error) => Err(error),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn start(display_id: u32, width: usize, height: usize) -> Result<Self> {
        let executable = std::env::current_exe()?;
        let (_, _, points_w, points_h) = crate::mac::display_geometry(display_id)
            .context("the selected display is unavailable")?;
        Self::spawn(
            Command::new(executable)
                .arg("agent-overlay")
                .arg(display_id.to_string()),
            points_w / width as f64,
            points_h / height as f64,
        )
    }

    #[cfg(target_os = "linux")]
    pub fn start(display: &str, width: usize, height: usize) -> Result<Self> {
        let executable = std::env::current_exe()?;
        let _ = (width, height);
        Self::spawn(
            Command::new(executable).arg("agent-overlay").arg(display),
            1.0,
            1.0,
        )
    }

    #[cfg(target_os = "linux")]
    pub fn start_point(display: &str) -> Result<Self> {
        Self::spawn(
            Command::new(std::env::current_exe()?)
                .arg("point-overlay")
                .arg(display),
            1.0,
            1.0,
        )
    }

    #[cfg(target_os = "linux")]
    pub fn start_point_wayland(
        width: i32,
        height: i32,
        position: Option<(i32, i32)>,
    ) -> Result<Self> {
        let (x, y) = position.unwrap_or_default();
        Self::spawn(
            Command::new(point_wayland_executable()?)
                .arg("point-overlay-wayland")
                .args([
                    width.to_string(),
                    height.to_string(),
                    i32::from(position.is_some()).to_string(),
                    x.to_string(),
                    y.to_string(),
                ]),
            1.0,
            1.0,
        )
    }

    #[cfg(target_os = "macos")]
    pub fn start_point(display_id: u32, width: usize, height: usize) -> Result<Self> {
        let (_, _, points_w, points_h) = crate::mac::display_geometry(display_id)
            .context("the selected display is unavailable")?;
        Self::spawn(
            Command::new(std::env::current_exe()?)
                .arg("point-overlay")
                .arg(display_id.to_string()),
            points_w / width as f64,
            points_h / height as f64,
        )
    }

    #[cfg(all(test, target_os = "linux"))]
    pub fn test_pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    pub fn point(&mut self, x: i64, y: i64, timeout_ms: u64, label: &str) -> Result<()> {
        let input = self.input.as_mut().context("point overlay exited")?;
        writeln!(
            input,
            "P {:.2} {:.2} {timeout_ms} {label}",
            x as f64 * self.scale_x,
            y as f64 * self.scale_y
        )?;
        Ok(())
    }

    /// Point markers have no fade: close/clear must remove them and reap the helper.
    pub fn stop(mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[cfg(target_os = "linux")]
    pub fn start_wayland(width: usize, height: usize) -> Result<Self> {
        let executable = std::env::current_exe()?;
        Self::spawn(
            Command::new(executable)
                .arg("agent-overlay-wayland")
                .arg(width.to_string())
                .arg(height.to_string()),
            1.0,
            1.0,
        )
    }

    #[cfg(target_os = "linux")]
    pub fn position(&self) -> std::sync::Arc<std::sync::Mutex<Option<(i64, i64)>>> {
        self.position.clone()
    }

    fn spawn(command: &mut Command, scale_x: f64, scale_y: f64) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("could not start agent indicator")?;
        let stdout = child.stdout.take().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut ready = String::new();
            let _ = reader.read_line(&mut ready);
            let _ = ready_tx.send((ready.trim().to_owned(), reader));
        });
        let (ready, reader_after) = match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok((ready, reader)) => (ready, Some(reader)),
            Err(_) => (String::new(), None),
        };
        if ready != "READY" {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            anyhow::bail!("agent indicator did not open its overlay within 5s: {ready}");
        }
        drop(reader);
        // Only the X11 agent cue writes after READY, and only its capture loop
        // reads; the helper blocks on a full pipe rather than draw unannounced.
        let cues = Cues::default();
        #[cfg(not(unix))]
        drop(reader_after);
        #[cfg(unix)]
        if let Some(reader) = reader_after {
            use std::os::fd::AsRawFd;
            let fd = reader.get_ref().as_raw_fd();
            unsafe {
                libc::fcntl(
                    fd,
                    libc::F_SETFL,
                    libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
                )
            };
            if let Ok(mut feed) = cues.lock() {
                feed.reader = Some(reader);
            }
        }
        Ok(Self {
            input: child.stdin.take(),
            child: Some(child),
            scale_x,
            scale_y,
            #[cfg(target_os = "linux")]
            position: Default::default(),
            cues,
        })
    }

    pub fn cues(&self) -> Cues {
        self.cues.clone()
    }

    #[cfg(target_os = "macos")]
    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    pub fn event(&mut self, kind: char, x: i64, y: i64) {
        if let Some(input) = &mut self.input {
            let (x, y) = (x as f64 * self.scale_x, y as f64 * self.scale_y);
            if writeln!(input, "{kind} {x:.2} {y:.2}").is_err() {
                self.input = None;
            }
            #[cfg(target_os = "linux")]
            if x >= 0.0 && y >= 0.0 {
                if let Ok(mut position) = self.position.lock() {
                    *position = Some((x as i64, y as i64));
                }
            }
        }
    }
}

impl Drop for Indicator {
    fn drop(&mut self) {
        // Closing stdin fades the edge and exits; do not wait for the animation.
        self.input.take();
        if let Some(mut child) = self.child.take() {
            // Keep reading the cue's pipe open until it exits, so it can
            // still animate out; it leaves at once only when the engine does.
            let cues = self.cues.clone();
            std::thread::spawn(move || {
                let _ = child.wait();
                drop(cues);
            });
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn cue_feed_keeps_recent_states_until_the_helper_exits() {
        use std::os::fd::AsRawFd;
        let mut child = std::process::Command::new("sh")
            .args([
                "-c",
                "for x in 1 2 3; do echo \"P $x 0 110 1 1 -1 -1 128 99\"; done; read _",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let reader = super::BufReader::new(child.stdout.take().unwrap());
        let fd = reader.get_ref().as_raw_fd();
        unsafe {
            libc::fcntl(
                fd,
                libc::F_SETFL,
                libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
            )
        };
        let mut feed = super::CueFeed {
            reader: Some(reader),
            ..Default::default()
        };
        let mut drained = vec![];
        for _ in 0..200 {
            drained.extend(feed.drain().into_iter().map(|cue| cue.x));
            if drained.len() >= 3 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            drained,
            [1, 2, 3],
            "a drain that finds nothing does not block"
        );
        let xs =
            |feed: &mut super::CueFeed| feed.drain().iter().map(|cue| cue.x).collect::<Vec<_>>();
        assert_eq!(
            xs(&mut feed),
            [2, 3],
            "either of the last two may be on screen"
        );
        drop(child.stdin.take());
        child.wait().unwrap();
        assert_eq!(xs(&mut feed), [2, 3]);
        assert!(
            xs(&mut feed).is_empty(),
            "a closed helper has no window left"
        );
    }

    unsafe extern "C" {
        fn desklink_wayland_geometry(
            source_w: i32,
            source_h: i32,
            surface_w: i32,
            surface_h: i32,
            px: f64,
            py: f64,
            x: *mut f64,
            y: *mut f64,
        ) -> i32;
        fn desklink_wayland_policy(
            anchor: *mut u32,
            keyboard_focus: *mut u32,
            empty_input: *mut u32,
        );
    }

    #[test]
    fn layer_shell_maps_source_pixels_and_never_takes_input_or_focus() {
        let (mut x, mut y) = (0.0, 0.0);
        unsafe {
            assert_eq!(
                desklink_wayland_geometry(3840, 2160, 1920, 1080, 1000.0, 600.0, &mut x, &mut y),
                1
            );
            assert_eq!((x, y), (500.0, 300.0));
            assert_eq!(
                desklink_wayland_geometry(0, 2160, 1920, 1080, 10.0, 10.0, &mut x, &mut y),
                0
            );
            let (mut anchor, mut keyboard, mut empty) = (0, 1, 0);
            desklink_wayland_policy(&mut anchor, &mut keyboard, &mut empty);
            assert_eq!((anchor, keyboard, empty), (15, 0, 1));
        }
    }
}
