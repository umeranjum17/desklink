//! A test target for the X11 backend, on a display this process owns.
//!
//! It draws one unmistakable pattern, records every pointer and key event it
//! receives as a JSON line, and paints a marker where it was last clicked. That
//! combination is what makes an end-to-end check honest: the viewer has to be
//! rendering the real pixels of a real X client, and the events that client
//! reports have to be the ones the user produced on the phone.
//!
//! Run it against a server you own:
//!
//! ```sh
//! Xvfb :99 -screen 0 1280x720x24 &
//! DISPLAY=:99 cargo run --example x11_target
//! ```

#[cfg(target_os = "linux")]
use anyhow::{Context, Result};
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateGCAux, CreateWindowAux, EventMask, Rectangle, WindowClass,
};
#[cfg(target_os = "linux")]
use x11rb::protocol::Event;
#[cfg(target_os = "linux")]
use x11rb::rust_connection::RustConnection;

#[cfg(target_os = "linux")]
const WIDTH: u16 = 1280;
#[cfg(target_os = "linux")]
const HEIGHT: u16 = 720;

// Where the animated marker sits. The phone's portrait cover view is pinned to
// the desktop's top-left corner and crops the rest, so a marker in the middle
// or the far corner is cut away and a motion check on that picture sees nothing
// move. This puts it in the top-left region both that crop and the recovery
// probe sample: three cells sweep x 132-228 at y 216-248.
#[cfg(target_os = "linux")]
const MARKER_X: i16 = 132;
#[cfg(target_os = "linux")]
const MARKER_Y: i16 = 216;
#[cfg(target_os = "linux")]
const MARKER_SIZE: u16 = 32;
#[cfg(target_os = "linux")]
const MARKER_STEPS: usize = 3;

// The far-corner cell `--corner <file>` paints: the desktop's bottom-right
// corner, where a picture that shows only part of the desktop cuts it away.
#[cfg(target_os = "linux")]
const CORNER_SIZE: u16 = 96;

#[cfg(target_os = "linux")]
fn main() -> Result<()> {
    let (connection, screen_number) =
        RustConnection::connect(None).context("cannot open the X display in DISPLAY")?;
    let screen = &connection.setup().roots[screen_number as usize];
    if std::env::args().any(|arg| arg == "--probe") {
        let vendor = String::from_utf8_lossy(&connection.setup().vendor);
        let xwayland = connection.query_extension(b"XWAYLAND")?.reply()?.present;
        println!(
            "vendor={vendor} size={}x{} xwayland={xwayland}",
            screen.width_in_pixels, screen.height_in_pixels
        );
        return Ok(());
    }
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|arg| arg == "--warp-pointer") {
        let x: i16 = args.get(i + 1).context("missing x")?.parse()?;
        let y: i16 = args.get(i + 2).context("missing y")?.parse()?;
        connection.warp_pointer(x11rb::NONE, screen.root, 0, 0, 0, 0, x, y)?;
        connection.flush()?;
        connection.get_input_focus()?.reply()?; // round trip before disconnect
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--desktop-state") {
        let pointer = connection.query_pointer(screen.root)?.reply()?;
        let focus = connection.get_input_focus()?.reply()?;
        println!(
            "{{\"x\":{},\"y\":{},\"focus\":{}}}",
            pointer.root_x, pointer.root_y, focus.focus
        );
        if let Some(path) = args
            .iter()
            .position(|arg| arg == "--desktop-frame")
            .and_then(|i| args.get(i + 1))
        {
            let frame = connection
                .get_image(
                    x11rb::protocol::xproto::ImageFormat::Z_PIXMAP,
                    screen.root,
                    0,
                    0,
                    screen.width_in_pixels,
                    screen.height_in_pixels,
                    u32::MAX,
                )?
                .reply()?;
            std::fs::write(path, frame.data)?;
        }
        return Ok(());
    }
    let window = connection.generate_id()?;
    connection
        .create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            screen.root,
            0,
            0,
            WIDTH,
            HEIGHT,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new()
                .background_pixel(screen.white_pixel)
                .event_mask(
                    EventMask::EXPOSURE
                        | EventMask::BUTTON_PRESS
                        | EventMask::BUTTON_RELEASE
                        | EventMask::POINTER_MOTION
                        | EventMask::KEY_PRESS
                        | EventMask::KEY_RELEASE,
                ),
        )
        .context("cannot create the test window")?;
    connection.map_window(window)?;

    let graphics = connection.generate_id()?;
    connection.create_gc(graphics, window, &CreateGCAux::new())?;

    let args: Vec<String> = std::env::args().collect();
    // `--paint-text` draws the keys this window receives, so a capture shows the
    // typed text arriving rather than only the event log recording it. The
    // default fixture stays silent: its pattern is read by pixel, not by font.
    let paint_text = args.iter().any(|arg| arg == "--paint-text");
    if paint_text {
        let font = connection.generate_id()?;
        connection.open_font(font, b"fixed")?;
        connection.change_gc(graphics, &x11rb::protocol::xproto::ChangeGCAux::new().font(font))?;
    }

    // A pattern that cannot be confused with a desktop: four coloured bands, a
    // grid, and the coordinates written into the top-left corner as a ladder of
    // ticks every 100 pixels so a capture can be read without any font.
    let mut marker = None;
    let mut typed = String::new();
    paint(&connection, window, graphics, marker, &typed, paint_text)?;
    connection.flush()?;

    // Put the pointer inside the window so key events have an obvious target on
    // a server with no window manager.
    connection.warp_pointer(
        x11rb::NONE,
        window,
        8,
        8,
        0,
        0,
        (WIDTH / 2) as i16,
        (HEIGHT / 2) as i16,
    )?;
    connection.flush()?;

    let record_text = args
        .iter()
        .position(|arg| arg == "--record-text")
        .and_then(|i| args.get(i + 1));
    let animate = args.iter().any(|arg| arg == "--animate");
    let moving = std::env::args().any(|arg| arg == "--move");
    // `--corner <file>`: on each animation tick, paint the far-corner cell in
    // the colour the file names (`rrggbb`), so a flow can change a fixed spot
    // in place, when it chooses, and look for exactly that change. The value
    // `still` instead freezes the blink and the moving marker: the desktop
    // goes quiet, and only the corner cell itself may change again.
    let corner = args
        .iter()
        .position(|arg| arg == "--corner")
        .and_then(|i| args.get(i + 1));
    let mut corner_colour = None;
    let mut position = 0usize;
    let mut bright = false;
    let mut still = false;
    let mut out = std::io::stdout();
    emit(
        &mut out,
        "ready",
        &[("width", WIDTH.to_string()), ("height", HEIGHT.to_string())],
    );

    loop {
        let mut event = if animate {
            connection.poll_for_event()?
        } else {
            Some(
                connection
                    .wait_for_event()
                    .context("the X connection dropped")?,
            )
        };
        // Drain queued input before the animation sleep: X autorepeat produces
        // press/release pairs faster than one event per 80 ms animation tick.
        while let Some(current) = event {
            match current {
                Event::Expose(_) => {
                    paint(&connection, window, graphics, marker, &typed, paint_text)?;
                    corner_colour = None;
                    connection.flush()?;
                }
                Event::MotionNotify(motion) => {
                    emit(
                        &mut out,
                        "pointer",
                        &[
                            ("x", motion.event_x.to_string()),
                            ("y", motion.event_y.to_string()),
                        ],
                    );
                }
                Event::ButtonPress(press) => {
                    emit(
                        &mut out,
                        "button",
                        &[
                            ("x", press.event_x.to_string()),
                            ("y", press.event_y.to_string()),
                            ("button", press.detail.to_string()),
                            ("phase", String::from("down")),
                        ],
                    );
                }
                Event::ButtonRelease(release) => {
                    // A press and release at the same place is what the phone sends
                    // for a tap; recording the marker there makes the click visible in
                    // the captured picture as well as in this log.
                    if release.detail == 1 {
                        marker = Some((release.event_x, release.event_y));
                        paint(&connection, window, graphics, marker, &typed, paint_text)?;
                        corner_colour = None;
                    }
                    emit(
                        &mut out,
                        "button",
                        &[
                            ("x", release.event_x.to_string()),
                            ("y", release.event_y.to_string()),
                            ("button", release.detail.to_string()),
                            ("phase", String::from("up")),
                        ],
                    );
                    connection.flush()?;
                }
                Event::KeyPress(press) => {
                    emit(
                        &mut out,
                        "key",
                        &[
                            ("keycode", press.detail.to_string()),
                            ("phase", String::from("down")),
                        ],
                    );
                    if let Some(path) = record_text {
                        let mapping = connection.get_keyboard_mapping(press.detail, 1)?.reply()?;
                        let shift = press
                            .state
                            .contains(x11rb::protocol::xproto::KeyButMask::SHIFT);
                        let symbol = mapping
                            .keysyms
                            .get(usize::from(shift))
                            .or(mapping.keysyms.first())
                            .copied()
                            .unwrap_or(0);
                        if (32..=126).contains(&symbol) {
                            typed.push(char::from_u32(symbol).unwrap());
                            std::fs::write(path, &typed)?;
                            if paint_text {
                                paint(&connection, window, graphics, marker, &typed, paint_text)?;
                                connection.flush()?;
                            }
                        }
                    }
                    if press.detail == 9 {
                        // Escape: the lab's own stop key.
                        emit(&mut out, "quit", &[]);
                        connection.destroy_window(window)?;
                        connection.flush()?;
                        return Ok(());
                    }
                }
                Event::KeyRelease(release) => {
                    emit(
                        &mut out,
                        "key",
                        &[
                            ("keycode", release.detail.to_string()),
                            ("phase", String::from("up")),
                        ],
                    );
                }
                _ => {}
            }
            event = if animate {
                connection.poll_for_event()?
            } else {
                None
            };
        }
        if animate {
            let request = corner
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|text| text.trim().to_string());
            if request.as_deref() == Some("still") {
                still = true;
            }
            let wanted = request.and_then(|text| u32::from_str_radix(&text, 16).ok());
            if wanted.is_some() && wanted != corner_colour {
                corner_colour = wanted;
                connection.change_gc(
                    graphics,
                    &x11rb::protocol::xproto::ChangeGCAux::new().foreground(wanted),
                )?;
                connection.poly_fill_rectangle(
                    window,
                    graphics,
                    &[Rectangle {
                        x: (WIDTH - CORNER_SIZE) as i16,
                        y: (HEIGHT - CORNER_SIZE) as i16,
                        width: CORNER_SIZE,
                        height: CORNER_SIZE,
                    }],
                )?;
            }
            if !still {
                if moving {
                    connection.change_gc(
                        graphics,
                        &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00d04040),
                    )?;
                    connection.poly_fill_rectangle(
                        window,
                        graphics,
                        &[Rectangle {
                            x: MARKER_X + (position * MARKER_SIZE as usize) as i16,
                            y: MARKER_Y,
                            width: MARKER_SIZE,
                            height: MARKER_SIZE,
                        }],
                    )?;
                    position = (position + 1) % MARKER_STEPS;
                }
                bright = !bright;
                connection.change_gc(
                    graphics,
                    &x11rb::protocol::xproto::ChangeGCAux::new().foreground(if bright {
                        0x00ffffff
                    } else {
                        0x00000000
                    }),
                )?;
                connection.poly_fill_rectangle(
                    window,
                    graphics,
                    &[Rectangle {
                        x: if moving {
                            MARKER_X + (position * MARKER_SIZE as usize) as i16
                        } else {
                            MARKER_X + MARKER_SIZE as i16
                        },
                        y: MARKER_Y,
                        width: MARKER_SIZE,
                        height: MARKER_SIZE,
                    }],
                )?;
            }
            connection.flush()?;
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    }
}

#[cfg(target_os = "linux")]
fn paint(
    connection: &RustConnection,
    window: u32,
    graphics: u32,
    marker: Option<(i16, i16)>,
    typed: &str,
    paint_text: bool,
) -> Result<()> {
    let bands: [(u32, u16, u16); 4] = [
        (0x00d04040, 0, HEIGHT / 4),
        (0x0040d040, HEIGHT / 4, HEIGHT / 2),
        (0x004040d0, HEIGHT / 2, HEIGHT * 3 / 4),
        (0x00d0d040, HEIGHT * 3 / 4, HEIGHT),
    ];
    for (colour, y, height) in bands {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(colour),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: 0,
                y: y as i16,
                width: WIDTH,
                height: (height - y) as u16,
            }],
        )?;
    }
    connection.change_gc(
        graphics,
        &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
    )?;
    let mut ticks = Vec::new();
    for step in 0..(WIDTH / 100) {
        let x = step * 100;
        ticks.push(Rectangle {
            x: x as i16,
            y: 0,
            width: 2,
            height: if step % 5 == 0 { 40 } else { 16 },
        });
    }
    for step in 0..(HEIGHT / 100) {
        let y = step * 100;
        ticks.push(Rectangle {
            x: 0,
            y: y as i16,
            width: if step % 5 == 0 { 40 } else { 16 },
            height: 2,
        });
    }
    connection.poly_fill_rectangle(window, graphics, &ticks)?;
    if paint_text && !typed.is_empty() {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
        )?;
        // On the red band, clear of the ruler ticks and the click marker.
        connection.image_text8(window, graphics, 50, 160, typed.as_bytes())?;
    }
    if let Some((x, y)) = marker {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00000000),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: x.saturating_sub(6),
                y: y.saturating_sub(6),
                width: 12,
                height: 12,
            }],
        )?;
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: x.saturating_sub(2),
                y: y.saturating_sub(2),
                width: 4,
                height: 4,
            }],
        )?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn emit(out: &mut impl Write, kind: &str, fields: &[(&str, String)]) {
    let mut line = format!("{{\"kind\":\"{kind}\"");
    for (name, value) in fields {
        if value.chars().all(|c| c.is_ascii_digit()) {
            line.push_str(&format!(",\"{name}\":{value}"));
        } else {
            line.push_str(&format!(",\"{name}\":\"{value}\""));
        }
    }
    line.push('}');
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("this example is only available on Linux");
}
