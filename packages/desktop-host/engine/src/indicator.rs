//! Local feedback for agent sessions. The helper is a separate nonactivating
//! window-owning process so its windows can be excluded from desktop capture.
use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

pub struct Indicator {
    child: Option<Child>,
    input: Option<ChildStdin>,
    scale_x: f64,
    scale_y: f64,
    #[cfg(target_os = "linux")]
    position: std::sync::Arc<std::sync::Mutex<Option<(i64, i64)>>>,
}

impl Indicator {
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
            let mut ready = String::new();
            let result = BufReader::new(stdout).read_line(&mut ready);
            let _ = ready_tx.send(result.is_ok() && ready.trim() == "READY");
        });
        if ready_rx.recv_timeout(std::time::Duration::from_secs(5)) != Ok(true) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            anyhow::bail!("agent indicator did not open its overlay within 5s");
        }
        let _ = reader.join();
        Ok(Self {
            input: child.stdin.take(),
            child: Some(child),
            scale_x,
            scale_y,
            #[cfg(target_os = "linux")]
            position: Default::default(),
        })
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
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
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
