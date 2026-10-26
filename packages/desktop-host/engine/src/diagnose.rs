//! `desklink-host diagnose`: the machine facts behind `desklink-host doctor`.
//!
//! Every check here is a question, not an action: the X server is connected to
//! and read, the portal's version properties are fetched, and an encoder codes
//! one blank 320x240 frame. Nothing opens a portal session, asks for consent,
//! captures a desktop or creates an input device. `doctor` in the Node CLI adds
//! the package facts and decides which answer a person needs to act on.

use anyhow::Result;
use serde_json::{json, Value};

pub async fn run() -> Result<()> {
    let session = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "wayland"
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "none"
    };
    let x11 = if session == "x11" { probe_x11() } else { Value::Null };
    let wayland = if session == "wayland" {
        probe_wayland().await
    } else {
        Value::Null
    };
    // `prepare` rather than `probe`: on a machine with no hardware encoder the
    // engine fetches Cisco's openh264 once at first need, so that is the answer
    // a session would get. It is a bounded download, not a session or a prompt.
    let encoder = crate::h264::prepare().map(|info| {
        json!({ "name": info.encoder, "hardware": info.hardware })
    });
    println!(
        "{}",
        serde_json::to_string(&json!({
            "version": env!("CARGO_PKG_VERSION"),
            "session": session,
            "x11": x11,
            "wayland": wayland,
            "encoder": encoder,
            "uinput": crate::input::probe().is_ok(),
        }))?
    );
    Ok(())
}

/// Connect exactly as the capture backend would, then report the two
/// extensions it wants and XTest for input.
fn probe_x11() -> Value {
    match crate::x11::X11Desktop::connect(None) {
        Ok(desktop) => json!({
            "connected": true,
            "display": std::env::var("DISPLAY").ok(),
            "width": desktop.width,
            "height": desktop.height,
            "shm": desktop.capture_path() == "shm",
            "damage": desktop.damage_armed(),
            "xtest": desktop.input_available(),
        }),
        Err(error) => json!({ "connected": false, "error": format!("{error:#}") }),
    }
}

/// Ask the session portal whether its ScreenCast and RemoteDesktop interfaces
/// are there. Building these proxies reads the interface's `version` property;
/// it creates no session and cannot prompt. The PipeWire socket is the capture
/// backend's own half of a screen share.
async fn probe_wayland() -> Value {
    let screencast = ashpd::desktop::screencast::Screencast::new().await;
    let remote_desktop = ashpd::desktop::remote_desktop::RemoteDesktop::new().await;
    json!({
        "screencast": screencast.is_ok(),
        "screencast_error": screencast.err().map(|error| error.to_string()),
        "remote_desktop": remote_desktop.is_ok(),
        "remote_desktop_error": remote_desktop.err().map(|error| error.to_string()),
        "pipewire": pipewire_socket(),
    })
}

/// Whether the session PipeWire socket is present. A portal screencast hands
/// back a remote on this socket, so a portal without one cannot deliver frames.
fn pipewire_socket() -> bool {
    let runtime = std::env::var_os("PIPEWIRE_RUNTIME_DIR")
        .filter(|path| !path.is_empty())
        .or_else(|| std::env::var_os("XDG_RUNTIME_DIR"))
        .map(std::path::PathBuf::from);
    let Some(directory) = runtime else {
        return false;
    };
    let remote = std::env::var("PIPEWIRE_REMOTE")
        .ok()
        .filter(|remote| !remote.is_empty())
        .unwrap_or_else(|| String::from("pipewire-0"));
    let remote = std::path::Path::new(&remote);
    if remote.is_absolute() {
        remote.exists()
    } else {
        directory.join(remote).exists()
    }
}
