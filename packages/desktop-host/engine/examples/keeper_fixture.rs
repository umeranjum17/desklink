//! Scriptable X client fixture for the display keeper's live proof.
//!
//! One long-lived client on a display the test owns. The driver writes one
//! command per line on stdin and reads exactly one reply line per command on
//! stdout, so a test can create, map, unmap, resize and inspect real
//! top-level windows while a keeper manages the screen:
//!
//! ```text
//! screen                                        -> screen <root> <w> <h>
//! create <W>x<H> [name ..] [class <i> <c>] [pid <n>]
//!                                               -> created <id>
//! map <id> | unmap <id> | destroy <id>          -> ok <id>
//! askgeo <id> <W>x<H>                           -> ok <id>   (client resize request)
//! geometry <id>                                 -> geometry <id> <x> <y> <w> <h>
//! focus                                         -> focus none|pointer-root|<id>
//! quit                                          -> bye
//! ```

use anyhow::{bail, Context, Result};
use std::io::{BufRead, Write};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
    WindowClass,
};
use x11rb::rust_connection::RustConnection;

fn main() -> Result<()> {
    let (conn, screen_number) = RustConnection::connect(None)?;
    let screen = &conn.setup().roots[screen_number as usize];
    let (root, white) = (screen.root, screen.white_pixel);
    let utf8_string = conn.intern_atom(false, b"UTF8_STRING")?.reply()?.atom;
    let net_wm_name = conn.intern_atom(false, b"_NET_WM_NAME")?.reply()?.atom;
    let net_wm_pid = conn.intern_atom(false, b"_NET_WM_PID")?.reply()?.atom;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    say(&mut out, "ready")?;
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let words: Vec<&str> = line.split_whitespace().collect();
        let reply = match drive(
            &conn,
            root,
            white,
            utf8_string,
            net_wm_name,
            net_wm_pid,
            &words,
        ) {
            Ok(text) => text,
            Err(error) => format!("err {error:#}"),
        };
        say(&mut out, &reply)?;
        if words.first() == Some(&"quit") {
            return Ok(());
        }
    }
    Ok(())
}

fn say(out: &mut dyn Write, line: &str) -> std::io::Result<()> {
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

fn drive(
    conn: &RustConnection,
    root: x11rb::protocol::xproto::Window,
    white: u32,
    utf8_string: Atom,
    net_wm_name: Atom,
    net_wm_pid: Atom,
    words: &[&str],
) -> Result<String> {
    match words {
        ["screen"] => {
            let screen = &conn.setup().roots[conn
                .setup()
                .roots
                .iter()
                .position(|s| s.root == root)
                .context("root vanished")?];
            Ok(format!(
                "screen {root} {} {}",
                screen.width_in_pixels, screen.height_in_pixels
            ))
        }
        ["create", size, rest @ ..] => create(
            conn,
            root,
            white,
            utf8_string,
            net_wm_name,
            net_wm_pid,
            size,
            rest,
        ),
        ["map", id] => {
            conn.map_window(parse_id(id)?)?;
            conn.flush()?;
            Ok(format!("ok {id}"))
        }
        ["unmap", id] => {
            conn.unmap_window(parse_id(id)?)?;
            conn.flush()?;
            Ok(format!("ok {id}"))
        }
        ["destroy", id] => {
            conn.destroy_window(parse_id(id)?)?;
            conn.flush()?;
            Ok(format!("ok {id}"))
        }
        ["askgeo", id, size] => {
            let (width, height) = size_pair(size)?;
            conn.configure_window(
                parse_id(id)?,
                &ConfigureWindowAux::new()
                    .width(u32::from(width))
                    .height(u32::from(height)),
            )?;
            conn.flush()?;
            Ok(format!("ok {id}"))
        }
        ["geometry", id] => {
            let reply = conn.get_geometry(parse_id(id)?)?.reply()?;
            Ok(format!(
                "geometry {id} {} {} {} {}",
                reply.x, reply.y, reply.width, reply.height
            ))
        }
        ["focus"] => {
            let reply = conn.get_input_focus()?.reply()?;
            // X reports focus 0 as None and PointerRoot as 1.
            Ok(match reply.focus {
                0 => String::from("focus none"),
                1 => String::from("focus pointer-root"),
                window => format!("focus {window}"),
            })
        }
        ["quit"] => Ok(String::from("bye")),
        _ => bail!("unknown command: {}", words.join(" ")),
    }
}

fn parse_id(text: &str) -> Result<x11rb::protocol::xproto::Window> {
    Ok(text.parse().context("bad window id")?)
}

fn create(
    conn: &RustConnection,
    root: x11rb::protocol::xproto::Window,
    white: u32,
    utf8_string: Atom,
    net_wm_name: Atom,
    net_wm_pid: Atom,
    size: &str,
    rest: &[&str],
) -> Result<String> {
    let (width, height) = size_pair(size)?;
    let (mut title, mut instance, mut class, mut pid) = (
        String::from("probe"),
        String::from("probe"),
        String::from("Probe"),
        0u32,
    );
    let mut i = 0;
    while i < rest.len() {
        match rest[i] {
            "name" => {
                i += 1;
                let mut parts = Vec::new();
                while i < rest.len() && rest[i] != "class" && rest[i] != "pid" {
                    parts.push(rest[i].to_string());
                    i += 1;
                }
                if !parts.is_empty() {
                    title = parts.join(" ");
                }
            }
            "class" => {
                instance = (*rest.get(i + 1).context("class needs two words")?).to_string();
                class = (*rest.get(i + 2).context("class needs two words")?).to_string();
                i += 3;
            }
            "pid" => {
                pid = (*rest.get(i + 1).context("pid needs a value")?).parse()?;
                i += 2;
            }
            other => bail!("unknown create arg {other}"),
        }
    }
    let window = conn.generate_id()?;
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        width,
        height,
        0,
        WindowClass::INPUT_OUTPUT,
        x11rb::COPY_FROM_PARENT,
        &CreateWindowAux::new()
            .background_pixel(white)
            .event_mask(EventMask::EXPOSURE | EventMask::STRUCTURE_NOTIFY),
    )?;
    let name = title.as_bytes();
    conn.change_property(
        PropMode::REPLACE,
        window,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        8,
        name.len() as u32,
        name,
    )?;
    conn.change_property(
        PropMode::REPLACE,
        window,
        net_wm_name,
        utf8_string,
        8,
        name.len() as u32,
        name,
    )?;
    let class_data = format!("{instance}\0{class}\0");
    conn.change_property(
        PropMode::REPLACE,
        window,
        AtomEnum::WM_CLASS,
        AtomEnum::STRING,
        8,
        class_data.len() as u32,
        class_data.as_bytes(),
    )?;
    conn.change_property(
        PropMode::REPLACE,
        window,
        net_wm_pid,
        AtomEnum::CARDINAL,
        32,
        1,
        pid.to_ne_bytes().as_slice(),
    )?;
    conn.flush()?;
    Ok(format!("created {window}"))
}

fn size_pair(text: &str) -> Result<(u16, u16)> {
    let (width, height) = text.split_once('x').context("size must be WxH")?;
    Ok((width.parse()?, height.parse()?))
}
