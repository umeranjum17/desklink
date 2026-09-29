//! A glass-to-glass stamp target for the latency/fps lab (`g2g-flow.mjs`).
//!
//! It paints a full-screen override-redirect window whose top row holds 24
//! black-or-white 48 px blocks encoding `CLOCK_REALTIME` milliseconds (low 24
//! bits), exactly like the scout's `lab/stamp.c`, so the harness can read the
//! capture clock back from every presented frame. There is no new C toolchain
//! dependency: this is x11rb in the same shape as `examples/x11_target.rs`.
//!
//! ```sh
//! Xvfb :99 -screen 0 1920x1080x24 &
//! DISPLAY=:99 MODE=scroll cargo run --example stamp_target
//! ```
//!
//! Configuration comes from the environment, like the C original:
//!
//! - `RATE`: repaints per second (default 120).
//! - `MODE`: `typing` (stamp only), `scroll` (full-screen motion plus the
//!   stamp) or `still` (the stamp freezes `STILL_AFTER_MS` after mapping, to
//!   check the engine still refines a frozen desktop).
//! - `STILL_AFTER_MS`: when `still` stops repainting (default 2000).
//!
//! `--probe` prints the server vendor and geometry and exits, so the harness
//! can verify it owns the display it was given.

use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateGCAux, CreateWindowAux, Rectangle, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn paint(
    connection: &RustConnection,
    window: u32,
    graphics: u32,
    width: i16,
    height: i16,
    frame: u64,
    stamp: u64,
    motion: bool,
) -> Result<()> {
    if motion {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: 0,
                y: 96,
                width: width as u16,
                height: (height - 96).max(0) as u16,
            }],
        )?;
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00000000),
        )?;
        let mut stripes = Vec::new();
        let mut y = 96i16;
        while y < height {
            let mut x = ((frame * 7 + y as u64) % 37) as i16;
            while x < width {
                stripes.push(Rectangle {
                    x,
                    y,
                    width: ((x as u64 + y as u64) % 11 + 3) as u16,
                    height: 12,
                });
                x += 37;
            }
            y += 24;
        }
        for chunk in stripes.chunks(500) {
            connection.poly_fill_rectangle(window, graphics, chunk)?;
        }
    }
    for block in 0..24u64 {
        let white = (stamp >> (23 - block)) & 1 == 1;
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(if white {
                0x00ffffff
            } else {
                0x00000000
            }),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: (block * 48) as i16,
                y: 0,
                width: 48,
                height: 48,
            }],
        )?;
    }
    connection.flush()?;
    Ok(())
}

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
    let (width, height) = (
        screen.width_in_pixels as i16,
        screen.height_in_pixels as i16,
    );
    let rate: u64 = std::env::var("RATE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120)
        .max(1);
    let mode = std::env::var("MODE").unwrap_or_else(|_| String::from("typing"));
    let motion = mode == "scroll" || mode == "motion";
    let still_after_ms: u64 = std::env::var("STILL_AFTER_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);

    let window = connection.generate_id()?;
    connection
        .create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            screen.root,
            0,
            0,
            width as u16,
            height as u16,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new().background_pixel(screen.white_pixel),
        )
        .context("cannot create the stamp window")?;
    let attributes = x11rb::protocol::xproto::ChangeWindowAttributesAux::new().override_redirect(1);
    connection
        .change_window_attributes(window, &attributes)
        .context("cannot make the stamp window override-redirect")?;
    connection.map_window(window)?;
    // Above everything else on a server with no window manager.
    connection
        .configure_window(
            window,
            &x11rb::protocol::xproto::ConfigureWindowAux::new()
                .stack_mode(x11rb::protocol::xproto::StackMode::ABOVE),
        )
        .ok();
    let graphics = connection.generate_id()?;
    connection.create_gc(graphics, window, &CreateGCAux::new())?;

    let started = now_ms();
    let mut frame = 0u64;
    // `still` freezes the stamp so the desktop stops changing; the stamp it
    // freezes on is the last one painted, repainted on expose.
    let mut frozen: Option<u64> = None;
    println!("ready mode={mode} size={width}x{height}");
    loop {
        while let Some(event) = connection.poll_for_event()? {
            match event {
                Event::Expose(_) => {
                    paint(
                        &connection,
                        window,
                        graphics,
                        width,
                        height,
                        frame,
                        frozen.unwrap_or_else(now_ms),
                        motion,
                    )?;
                }
                _ => {}
            }
        }
        if mode == "still" && now_ms() - started >= still_after_ms {
            if frozen.is_none() {
                frozen = Some(now_ms() & 0xFF_FFFF);
                paint(
                    &connection,
                    window,
                    graphics,
                    width,
                    height,
                    frame,
                    frozen.unwrap_or(0),
                    false,
                )?;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            continue;
        }
        let stamp = now_ms() & 0xFF_FFFF;
        paint(
            &connection,
            window,
            graphics,
            width,
            height,
            frame,
            stamp,
            motion,
        )?;
        frame += 1;
        std::thread::sleep(std::time::Duration::from_millis(1000 / rate));
    }
}
