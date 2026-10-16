//! Where a shared window sits on a Hyprland desktop, from Hyprland's own IPC.
//!
//! Hyprland's ScreenCast portal reports every stream at (0, 0) and never says
//! which window was picked, while the pointer device spans the whole desktop.
//! Hyprland itself announces each window share by title on its event socket
//! (`screencastv2>>1,window,<title>`) and lists every window's place in
//! `j/clients`. So the shared window is the one with that title and the
//! stream's size, followed by its address from then on, and the pointer goes
//! onto it through Hyprland's own cursor warp at the window's current place:
//! a window moved after the share started still maps. Anything less certain
//! (no announcement, no such window, two alike, a window off screen) is a
//! refusal, never a guess.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::session::WINDOW_POINTER_REFUSAL as UNKNOWN;

fn instance() -> Option<PathBuf> {
    let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    Some(PathBuf::from(runtime).join("hypr").join(signature))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Hyprland's window-share announcements, heard from before the portal asks
/// for consent. Dropping it closes the event socket, which ends its reader.
pub struct ShareWatch {
    socket: UnixStream,
    titles: Arc<Mutex<Vec<String>>>,
}

impl ShareWatch {
    /// `None` when this is not a Hyprland session.
    pub fn start() -> Option<Self> {
        let socket = UnixStream::connect(instance()?.join(".socket2.sock")).ok()?;
        let reader = socket.try_clone().ok()?;
        let titles = Arc::new(Mutex::new(Vec::new()));
        let heard = titles.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                if let Some(title) = line.strip_prefix("screencastv2>>1,window,") {
                    lock(&heard).push(title.to_owned());
                }
            }
        });
        Some(Self { socket, titles })
    }
}

impl Drop for ShareWatch {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// The window a portal window share shows, placed by Hyprland.
pub struct WindowLocator {
    watch: ShareWatch,
    /// The stream's own pixel size, which the window's size times its
    /// monitor's scale must match.
    source: (i64, i64),
    address: Mutex<Option<String>>,
    /// Whether this Hyprland reads a Lua config, whose `dispatch` takes Lua.
    lua: Mutex<Option<bool>>,
}

impl WindowLocator {
    pub fn new(watch: ShareWatch, width: i32, height: i32) -> Self {
        Self {
            watch,
            source: (i64::from(width.max(1)), i64::from(height.max(1))),
            address: Mutex::new(None),
            lua: Mutex::new(None),
        }
    }

    /// Put the pointer on `(x, y)` in the shared window's own pixels.
    pub fn place(&self, x: i64, y: i64) -> Result<(), String> {
        let (clients, monitors) = (query("j/clients")?, query("j/monitors")?);
        let clients = clients.as_array().map(Vec::as_slice).unwrap_or_default();
        // A window nobody sees has no point on the screen.
        let shown = |window: &Value| {
            let workspace = &window["workspace"]["id"];
            window["mapped"].as_bool() != Some(false)
                && window["hidden"].as_bool() != Some(true)
                && (window["pinned"].as_bool() == Some(true)
                    || monitors.as_array().into_iter().flatten().any(|monitor| {
                        &monitor["activeWorkspace"]["id"] == workspace
                            || &monitor["specialWorkspace"]["id"] == workspace
                    }))
        };
        let mut address = lock(&self.address);
        if address.is_none() {
            *address = Some(self.identify(clients, &monitors)?);
        }
        let index = clients
            .iter()
            .position(|client| client["address"].as_str() == address.as_deref())
            .ok_or("a shared window cannot take taps: the window has closed")?;
        let window = &clients[index];
        if !shown(window) {
            return Err(String::from(
                "a shared window cannot take taps while it is on a hidden workspace",
            ));
        }
        let (left, top, width, height) = bounds(window).ok_or(UNKNOWN)?;
        let (source_w, source_h) = self.source;
        let (px, py) = (
            left + x as f64 * width / source_w as f64,
            top + y as f64 * height / source_h as f64,
        );
        // Hyprland clamps the cursor to the screen edge, so a point off every
        // monitor would press something else or nothing.
        let on_screen = monitors.as_array().into_iter().flatten().any(|monitor| {
            let scale = monitor["scale"].as_f64().filter(|scale| *scale > 0.0);
            monitor["disabled"].as_bool() != Some(true)
                && matches!(
                    (
                        monitor["x"].as_f64(),
                        monitor["y"].as_f64(),
                        monitor["width"].as_f64(),
                        monitor["height"].as_f64(),
                        scale
                    ),
                    (Some(mx), Some(my), Some(mw), Some(mh), Some(scale))
                        if (mx..mx + mw / scale).contains(&px)
                            && (my..my + mh / scale).contains(&py)
                )
        });
        if !on_screen {
            return Err(String::from(
                "a shared window cannot take taps where it hangs off screen",
            ));
        }
        // Hyprland draws tiled windows, then floating ones, then fullscreen
        // ones, and pinned ones above all; j/clients lists them in the
        // compositor's own stacking order, so a later layer-mate holding the
        // point is what a press there would reach. A floating window let over
        // fullscreen draws above it, but j/clients cannot tell that one from
        // any floating window, so either pairing over the point is a refusal.
        let layer = |w: &Value| {
            if w["pinned"].as_bool() == Some(true) {
                3
            } else if w["fullscreen"].as_i64().is_some_and(|mode| mode > 0) {
                2
            } else {
                u8::from(w["floating"].as_bool() == Some(true))
            }
        };
        let covered = clients.iter().enumerate().any(|(i, other)| {
            shown(other)
                && bounds(other).is_some_and(|(l, t, w, h)| {
                    (l..l + w).contains(&px) && (t..t + h).contains(&py)
                })
                && match (layer(other), layer(window), i > index) {
                    (1, 2, _) | (2, 1, _) => true,
                    (above, own, later) => above > own || (above == own && later),
                }
        });
        if covered {
            return Err(String::from(
                "a shared window cannot take taps where another window covers it",
            ));
        }
        self.warp((px.floor() as i64, py.floor() as i64))
    }

    /// The address of the one window Hyprland said it is sharing.
    fn identify(&self, clients: &[Value], monitors: &Value) -> Result<String, String> {
        let mut titles = lock(&self.watch.titles).clone();
        titles.dedup();
        let [title] = titles.as_slice() else {
            return Err(String::from(UNKNOWN));
        };
        let (source_w, source_h) = self.source;
        let scale = |monitor: &Value| {
            monitors
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| &m["id"] == monitor)
                .and_then(|m| m["scale"].as_f64())
        };
        let alike: Vec<&Value> = clients
            .iter()
            .filter(|client| {
                let size = |i: usize| client["size"][i].as_f64();
                client["title"].as_str() == Some(title.as_str())
                    && client["mapped"].as_bool() != Some(false)
                    && client["hidden"].as_bool() != Some(true)
                    && matches!(
                        (size(0), size(1), scale(&client["monitor"])),
                        (Some(w), Some(h), Some(s))
                            if ((w * s).round() as i64 - source_w).abs() <= 1
                                && ((h * s).round() as i64 - source_h).abs() <= 1
                    )
            })
            .collect();
        match alike.as_slice() {
            [window] => window["address"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| String::from(UNKNOWN)),
            [] => Err(String::from(UNKNOWN)),
            _ => Err(format!(
                "a shared window cannot take taps: {} windows look like it; share the whole screen to point and click",
                alike.len()
            )),
        }
    }

    fn warp(&self, (x, y): (i64, i64)) -> Result<(), String> {
        let legacy = format!("dispatch movecursor {x} {y}");
        let lua = format!("dispatch hl.dsp.cursor.move({{ x = {x}, y = {y} }})");
        let mut dialect = lock(&self.lua);
        let tries: &[(bool, &str)] = match *dialect {
            Some(true) => &[(true, &lua)],
            Some(false) => &[(false, &legacy)],
            None => &[(false, &legacy), (true, &lua)],
        };
        let mut said = String::new();
        for (is_lua, command) in tries {
            said = request(command)?;
            if said.trim() == "ok" {
                *dialect = Some(*is_lua);
                return Ok(());
            }
        }
        Err(format!("Hyprland did not move the pointer: {}", said.trim()))
    }
}

/// A window's box in the layout: left, top, width, height.
fn bounds(window: &Value) -> Option<(f64, f64, f64, f64)> {
    let pair = |key: &str| Some((window[key][0].as_f64()?, window[key][1].as_f64()?));
    let ((left, top), (width, height)) = pair("at").zip(pair("size"))?;
    Some((left, top, width, height))
}

fn request(command: &str) -> Result<String, String> {
    let ask = || -> std::io::Result<String> {
        let path = instance()
            .ok_or_else(|| std::io::Error::other("HYPRLAND_INSTANCE_SIGNATURE is not set"))?;
        let mut socket = UnixStream::connect(path.join(".socket.sock"))?;
        socket.write_all(command.as_bytes())?;
        let mut reply = String::new();
        socket.read_to_string(&mut reply)?;
        Ok(reply)
    };
    ask().map_err(|error| format!("Hyprland's control socket did not answer: {error}"))
}

fn query(command: &str) -> Result<Value, String> {
    serde_json::from_str(&request(command)?)
        .map_err(|error| format!("Hyprland's {command} was not JSON: {error}"))
}
