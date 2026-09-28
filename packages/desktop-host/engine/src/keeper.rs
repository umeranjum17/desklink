//! The display keeper: a kiosk window manager for one X screen.
//!
//! A consumer that owns a private X server (one `Xvfb` per screen it created)
//! runs the keeper on it. The keeper takes SubstructureRedirect on the root
//! window — it is that screen's window manager — fills the screen with every
//! normal top-level window, parks tiny helper windows off-screen, keeps the
//! input focus on the newest window, and reports the screen's windows as one
//! JSON line per change on stdout.
//!
//! That report is what lets a consumer say "a browser is open on this screen"
//! without asking any browser tool: it reads what is really mapped.
//!
//! The contract is a stdout JSON-lines stream and nothing else; there are no
//! stdin commands. Authentication is the ambient `XAUTHORITY`. The keeper exits
//! by itself when the display goes away, which is the normal end of its life,
//! and reports fatal refusals as one error line before exiting.

use anyhow::{anyhow, Result};
use std::collections::VecDeque;
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt as _, EventMask,
    InputFocus, MapState, StackMode, Window, WindowClass, ACCESS_ERROR,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

/// A top-level window smaller than this on either side is not content. An
/// emulator draws its side toolbar as a tiny second window; parked off-screen,
/// it cannot end up in a capture of the screen.
pub const MIN_CONTENT_SIDE: u16 = 120;

/// Where parked windows live: far enough off any real screen to be invisible.
pub const PARKED_XY: i16 = -30000;

/// A change is reported after this much quiet on the screen.
const DEBOUNCE: Duration = Duration::from_millis(100);

/// … but never later than this after the first unreported change, so a busy
/// screen cannot starve its consumer of reports.
const MAX_REPORT_DELAY: Duration = Duration::from_millis(300);

/// One top-level window on the kept screen, as reported to the consumer.
pub struct KeeperWindow {
    pub id: u32,
    pub title: Option<String>,
    pub class: Option<String>,
    pub pid: Option<u32>,
    pub width: u16,
    pub height: u16,
}

/// A window this size or larger on both sides is content; anything smaller is
/// parked, and parked means never focused either.
fn is_content(width: u16, height: u16) -> bool {
    width >= MIN_CONTENT_SIDE && height >= MIN_CONTENT_SIDE
}

/// Where a top-level window of this size belongs on a screen of `screen_w` by
/// `screen_h`: filling the screen, or parked off it when it is too small to be
/// content.
fn kiosk_geometry(width: u16, height: u16, screen_w: u16, screen_h: u16) -> (i32, i32, u32, u32) {
    if is_content(width, height) {
        (0, 0, u32::from(screen_w), u32::from(screen_h))
    } else {
        (
            i32::from(PARKED_XY),
            i32::from(PARKED_XY),
            u32::from(width),
            u32::from(height),
        )
    }
}

/// `WM_CLASS` is two NUL-separated strings: instance, then class. The class is
/// the one consumers filter on ("Chromium", "Google-chrome").
fn decode_wm_class(data: &[u8]) -> Option<String> {
    let mut strings = data
        .split(|&byte| byte == 0)
        .filter(|part| !part.is_empty());
    strings.next()?;
    strings.next().map(latin1)
}

/// A title is the trimmed text; empty is no title. The caller decodes the
/// property's bytes (`_NET_WM_NAME` is UTF-8; the `WM_NAME` fallback Latin-1).
fn decode_title(title: &str) -> Option<String> {
    let title = title.trim().to_owned();
    (!title.is_empty()).then_some(title)
}

/// `STRING` properties are ISO Latin-1.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| byte as char).collect()
}

/// The stdout line that reports a window list.
fn window_line(windows: &[KeeperWindow]) -> String {
    serde_json::to_string(&serde_json::json!({
        "windows": windows
            .iter()
            .map(|window| serde_json::json!({
                "id": window.id,
                "title": window.title,
                "class": window.class,
                "pid": window.pid,
                "width": window.width,
                "height": window.height,
            }))
            .collect::<Vec<_>>()
    }))
    .expect("a window report always serialises")
}

/// The display a `keep` invocation names: the value after `--display`, and
/// nothing else. One spelling, per the documented contract.
fn display_argument(args: &[String]) -> Option<String> {
    let mut remaining = args.iter();
    while let Some(arg) = remaining.next() {
        if arg == "--display" {
            return remaining.next().cloned();
        }
    }
    None
}

/// `desklink-host keep --display :N`: keep one display until it goes away. The
/// display is required on purpose: a bare `keep` must never go hunting for a
/// screen to manage.
pub fn command(args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("usage: desklink-host keep --display :N");
        return 0;
    }
    let display = display_argument(args);
    let mut out = BufWriter::new(std::io::stdout().lock());
    match keep(display.as_deref(), &mut out) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error:#}");
            1
        }
    }
}

/// Runs the keeper until the display goes away. A refused startup is reported
/// as the protocol's one-line error object on stdout and returned as `Err`;
/// the display going away is a normal end and returns `Ok`.
pub fn keep(display: Option<&str>, out: &mut impl Write) -> Result<()> {
    let Some(display) = display.filter(|display| !display.is_empty()) else {
        return fatal(out, "no display given");
    };
    let (conn, screen_number) = match RustConnection::connect(Some(display)) {
        Ok(opened) => opened,
        Err(error) => return fatal(out, &format!("cannot open X display {display}: {error}")),
    };
    let Some(screen) = conn.setup().roots.get(screen_number) else {
        return fatal(out, "the X display has no screen");
    };
    let root = screen.root;
    let (screen_w, screen_h) = (screen.width_in_pixels, screen.height_in_pixels);

    // The claim is the whole election: a server hands SubstructureRedirect to
    // exactly one client, and refuses a second with an Access error.
    let claim = conn.change_window_attributes(
        root,
        &ChangeWindowAttributesAux::new()
            .event_mask(EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY),
    );
    // The display was opened, so a connection that dies during the election
    // is the display going away — the normal end. Only the server's own error
    // replies refuse the keeper.
    let claim = match claim {
        Ok(cookie) => cookie,
        Err(_) => return Ok(()),
    };
    match claim.check() {
        Ok(()) => {}
        Err(ReplyError::X11Error(error)) if error.error_code == ACCESS_ERROR => {
            return fatal(out, "another window manager");
        }
        Err(ReplyError::ConnectionError(_)) => return Ok(()),
        Err(error) => return fatal(out, &format!("cannot keep {display:?}: {error}")),
    }

    // Created if missing: a fresh Xvfb may not have them yet, and this keeper
    // is the only client that reads them on this screen. With the claim won, a
    // failed request is the display going away — the keeper's normal end.
    let (Some(net_wm_name), Some(utf8_string), Some(net_wm_pid)) = (
        intern(&conn, "_NET_WM_NAME"),
        intern(&conn, "UTF8_STRING"),
        intern(&conn, "_NET_WM_PID"),
    ) else {
        return Ok(());
    };

    // Windows already on the screen when the keeper starts join the kiosk.
    let Ok(Ok(tree)) = conn.query_tree(root).map(|cookie| cookie.reply()) else {
        return Ok(());
    };
    let mut tracked: VecDeque<Window> = VecDeque::new();
    for window in tree.children {
        track(&conn, window, &mut tracked, screen_w, screen_h);
    }
    let _ = refocus(&conn, &tracked);

    // The consumer learns the screen's state once at startup, then on change.
    write_line(
        out,
        &window_line(&snapshot(&conn, root, net_wm_name, utf8_string, net_wm_pid)),
    )?;

    // (first unreported change, when the report is due)
    let mut dirty: Option<(Instant, Instant)> = None;
    loop {
        if let Some((first, due)) = dirty {
            if Instant::now() >= due || Instant::now().duration_since(first) >= MAX_REPORT_DELAY {
                dirty = None;
                let line =
                    window_line(&snapshot(&conn, root, net_wm_name, utf8_string, net_wm_pid));
                write_line(out, &line)?;
                continue;
            }
        }
        // From here on, every connection error means the display is gone (X
        // protocol errors surface through replies, and the only checked reply
        // is the claim above). That is the keeper's normal end.
        if conn.flush().is_err() {
            return Ok(());
        }
        let event = if dirty.is_some() {
            match conn.poll_for_event() {
                Ok(Some(event)) => event,
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => return Ok(()),
            }
        } else {
            match conn.wait_for_event() {
                Ok(event) => event,
                Err(_) => return Ok(()),
            }
        };
        match event {
            Event::MapRequest(event) => {
                // A new window wants to be seen: give it its kiosk geometry,
                // then map it. Override-redirect windows never ask.
                if let Some((x, y, width, height)) = mapped_size(&conn, event.window)
                    .map(|(w, h)| kiosk_geometry(w, h, screen_w, screen_h))
                {
                    conn.configure_window(
                        event.window,
                        &ConfigureWindowAux::new()
                            .x(x)
                            .y(y)
                            .width(width)
                            .height(height)
                            .stack_mode(StackMode::ABOVE),
                    );
                    conn.map_window(event.window);
                    track(&conn, event.window, &mut tracked, screen_w, screen_h);
                    let _ = refocus(&conn, &tracked);
                    mark_dirty(&mut dirty);
                }
            }
            Event::ConfigureRequest(event) => {
                // The client asks for a geometry; the kiosk answer is ours.
                // Zero size fields mean "unchanged", so read the current size.
                let current = mapped_size(&conn, event.window);
                if let Some((width, height)) = current.map(|(w, h)| {
                    (
                        if event.width > 0 { event.width } else { w },
                        if event.height > 0 { event.height } else { h },
                    )
                }) {
                    let (x, y, width, height) = kiosk_geometry(width, height, screen_w, screen_h);
                    conn.configure_window(
                        event.window,
                        &ConfigureWindowAux::new()
                            .x(x)
                            .y(y)
                            .width(width)
                            .height(height),
                    );
                    mark_dirty(&mut dirty);
                }
            }
            Event::MapNotify(event) => {
                // Covers windows that appeared without a request through this
                // connection. Already-tracked and unkeepable windows are skipped
                // inside `track`.
                if track(&conn, event.window, &mut tracked, screen_w, screen_h) {
                    let _ = refocus(&conn, &tracked);
                    mark_dirty(&mut dirty);
                }
            }
            Event::UnmapNotify(event) => {
                if untrack(&mut tracked, event.window) {
                    let _ = refocus(&conn, &tracked);
                    mark_dirty(&mut dirty);
                }
            }
            Event::DestroyNotify(event) => {
                if untrack(&mut tracked, event.window) {
                    let _ = refocus(&conn, &tracked);
                    mark_dirty(&mut dirty);
                }
            }
            Event::ConfigureNotify(_) | Event::PropertyNotify(_) => {
                mark_dirty(&mut dirty);
            }
            _ => {}
        }
    }
}

/// Records that the screen changed and a report is due.
fn mark_dirty(dirty: &mut Option<(Instant, Instant)>) {
    let now = Instant::now();
    match dirty {
        Some((_, due)) => {
            *due = now + DEBOUNCE;
        }
        None => *dirty = Some((now, now + DEBOUNCE)),
    }
}

/// Marks a window kept (kiosk geometry, property watching) if it is a normal
/// top-level window, and reports whether the screen's state changed.
fn track(
    conn: &RustConnection,
    window: Window,
    tracked: &mut VecDeque<Window>,
    screen_w: u16,
    screen_h: u16,
) -> bool {
    let Ok(Ok(attributes)) = conn
        .get_window_attributes(window)
        .map(|cookie| cookie.reply())
    else {
        return false;
    };
    if attributes.override_redirect
        || attributes.class != WindowClass::INPUT_OUTPUT
        || tracked.contains(&window)
    {
        return false;
    }
    conn.change_window_attributes(
        window,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    );
    if attributes.map_state == MapState::VIEWABLE {
        let (x, y, width, height) = mapped_size(conn, window)
            .map(|(w, h)| kiosk_geometry(w, h, screen_w, screen_h))
            .unwrap_or((0, 0, u32::from(screen_w), u32::from(screen_h)));
        conn.configure_window(
            window,
            &ConfigureWindowAux::new()
                .x(x)
                .y(y)
                .width(width)
                .height(height),
        );
    }
    tracked.push_back(window);
    true
}

/// Stops tracking a window; reports whether it was tracked.
fn untrack(tracked: &mut VecDeque<Window>, window: Window) -> bool {
    let before = tracked.len();
    tracked.retain(|&tracked_window| tracked_window != window);
    tracked.len() != before
}

/// Puts the input focus on the newest tracked content window, so keyboard
/// events an engine session sends go to what the user would be looking at.
/// Parked helpers are never focused: an off-screen window would swallow keys.
fn refocus(conn: &RustConnection, tracked: &VecDeque<Window>) -> Result<()> {
    let newest = tracked.iter().rev().copied().find(|&window| {
        mapped_size(conn, window).is_some_and(|(width, height)| is_content(width, height))
    });
    if let Some(window) = newest {
        conn.set_input_focus(InputFocus::POINTER_ROOT, window, x11rb::CURRENT_TIME)?;
    }
    Ok(())
}

/// The current size of a window worth keeping, if it still exists.
fn mapped_size(conn: &RustConnection, window: Window) -> Option<(u16, u16)> {
    let Ok(Ok(geometry)) = conn.get_geometry(window).map(|cookie| cookie.reply()) else {
        return None;
    };
    Some((geometry.width, geometry.height))
}

/// Every visible, non-override-redirect top-level window, bottom of the
/// stacking order first.
fn snapshot(
    conn: &RustConnection,
    root: Window,
    net_wm_name: Atom,
    utf8_string: Atom,
    net_wm_pid: Atom,
) -> Vec<KeeperWindow> {
    let Ok(Ok(tree)) = conn.query_tree(root).map(|cookie| cookie.reply()) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    for &window in &tree.children {
        let Ok(Ok(attributes)) = conn
            .get_window_attributes(window)
            .map(|cookie| cookie.reply())
        else {
            continue;
        };
        if attributes.override_redirect
            || attributes.class != WindowClass::INPUT_OUTPUT
            || attributes.map_state != MapState::VIEWABLE
        {
            continue;
        }
        let Ok(Ok(geometry)) = conn.get_geometry(window).map(|cookie| cookie.reply()) else {
            continue;
        };
        let property = |name: Atom, type_: Atom, length: u32| {
            conn.get_property(false, window, name, type_, 0, length)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
        };
        let title = property(net_wm_name, utf8_string, u32::MAX)
            .map(|reply| reply.value)
            .and_then(|value| decode_title(&String::from_utf8_lossy(&value)))
            .or_else(|| {
                property(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into(), u32::MAX)
                    .map(|reply| reply.value)
                    .and_then(|value| decode_title(&latin1(&value)))
            });
        let class = property(AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into(), u32::MAX)
            .map(|reply| reply.value)
            .and_then(|value| decode_wm_class(&value));
        let pid = property(net_wm_pid, AtomEnum::CARDINAL.into(), 1).and_then(|reply| {
            let mut values = reply.value32()?;
            values.next()
        });
        windows.push(KeeperWindow {
            id: window,
            title,
            class,
            pid,
            width: geometry.width,
            height: geometry.height,
        });
    }
    windows
}

/// Interns an atom, or `None` when the connection is gone; the caller has
/// already won the WM claim, so there is nothing left to refuse.
fn intern(conn: &RustConnection, name: &str) -> Option<Atom> {
    conn.intern_atom(false, name.as_bytes())
        .ok()?
        .reply()
        .ok()
        .map(|reply| reply.atom)
}

fn write_line(out: &mut impl Write, line: &str) -> Result<()> {
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

/// One error line, then stop. This is how a refused keeper talks.
fn fatal(out: &mut impl Write, error: &str) -> Result<()> {
    write_line(out, &serde_json::json!({ "error": error }).to_string())?;
    Err(anyhow!("{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_fills_the_screen_and_helpers_are_parked() {
        assert_eq!(kiosk_geometry(1240, 760, 1280, 800), (0, 0, 1280, 800));
        // Exactly at the limit is content; one pixel under is not.
        assert_eq!(kiosk_geometry(120, 120, 1280, 800), (0, 0, 1280, 800));
        assert_eq!(
            kiosk_geometry(119, 800, 1280, 800),
            (i32::from(PARKED_XY), i32::from(PARKED_XY), 119, 800)
        );
        assert_eq!(
            kiosk_geometry(1000, 24, 1280, 800),
            (i32::from(PARKED_XY), i32::from(PARKED_XY), 1000, 24)
        );
    }

    #[test]
    fn wm_class_reads_the_class_not_the_instance() {
        assert_eq!(
            decode_wm_class(b"google-chrome\0Google-chrome\0"),
            Some(String::from("Google-chrome"))
        );
        assert_eq!(decode_wm_class(b"instance-only\0"), None);
        assert_eq!(decode_wm_class(b""), None);
    }

    #[test]
    fn titles_come_from_either_name_property_and_blank_is_none() {
        assert_eq!(
            decode_title("Pricing — Acme Store"),
            Some(String::from("Pricing — Acme Store"))
        );
        assert_eq!(
            decode_title("PPF probe - Google Chrome"),
            Some(String::from("PPF probe - Google Chrome"))
        );
        assert_eq!(decode_title("   "), None);
        assert_eq!(decode_title(""), None);
        assert_eq!(
            decode_title(&latin1(b"Gr\xf6\xdfe")),
            Some(String::from("Gr\u{00f6}\u{00df}e"))
        );
    }

    #[test]
    fn the_report_line_is_exactly_the_promised_shape() {
        let line = window_line(&[KeeperWindow {
            id: 0x0040_0001,
            title: Some(String::from("PPF probe - Google Chrome")),
            class: Some(String::from("Google-chrome")),
            pid: Some(1003571),
            width: 1280,
            height: 800,
        }]);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({
                "windows": [{
                    "id": 0x40_0001_u64,
                    "title": "PPF probe - Google Chrome",
                    "class": "Google-chrome",
                    "pid": 1003571,
                    "width": 1280,
                    "height": 800,
                }]
            })
        );
        assert_eq!(window_line(&[]), r#"{"windows":[]}"#);
    }

    #[test]
    fn missing_fields_are_null_not_absent() {
        let line = window_line(&[KeeperWindow {
            id: 7,
            title: None,
            class: None,
            pid: None,
            width: 100,
            height: 100,
        }]);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        let window = &parsed["windows"][0];
        assert_eq!(window["title"], serde_json::Value::Null);
        assert_eq!(window["class"], serde_json::Value::Null);
        assert_eq!(window["pid"], serde_json::Value::Null);
        assert!(window.get("width").is_some());
    }

    #[test]
    fn an_unopenable_display_is_refused_in_one_error_line() {
        let mut out = Vec::new();
        assert!(keep(Some("not a display"), &mut out).is_err());
        let line: serde_json::Value =
            serde_json::from_str(&String::from_utf8(out).unwrap()).unwrap();
        assert!(line["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()));
    }

    #[test]
    fn a_refused_keeper_says_why_in_its_error_line() {
        let mut out = Vec::new();
        let error = fatal(&mut out, "another window manager").unwrap_err();
        assert_eq!(error.to_string(), "another window manager");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"error\":\"another window manager\"}\n"
        );
    }

    #[test]
    fn the_display_flag_has_one_spelling() {
        let flag = |args: &[&str]| {
            display_argument(
                &args
                    .iter()
                    .map(|arg| String::from(*arg))
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(flag(&["--display", ":42"]), Some(String::from(":42")));
        assert_eq!(
            flag(&["--display", ":42", "--x"]),
            Some(String::from(":42"))
        );
        assert_eq!(flag(&[]), None);
        assert_eq!(flag(&["--display"]), None);
        // The undocumented `--display=:42` spelling is not a display: `keep`
        // refuses it rather than guessing what was meant.
        assert_eq!(flag(&["--display=:42"]), None);
    }
}
