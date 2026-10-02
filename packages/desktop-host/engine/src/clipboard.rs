//! Explicit, user-invoked clipboard transfer.
//!
//! Read and write are separate requests the consumer makes on a user action.
//! The clipboard is never polled, never watched, and never used as a hidden way
//! to type: a phone that silently replaced the user's clipboard would be worse
//! than one that could not copy at all.

use anyhow::{Context, Result};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use wl_clipboard_rs::paste::{ClipboardType, MimeType as PasteMime, Seat};

/// The engine's bound on a single clipboard transfer. Larger than any real
/// paste of text, small enough that a hostile client cannot use it as a file
/// transfer.
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;

pub fn read() -> Result<(String, bool)> {
    let options = wl_clipboard_rs::paste::get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        PasteMime::Text,
    );
    let (mut pipe, _mime) = options.context("no text on the desktop clipboard")?;
    let mut raw = Vec::new();
    std::io::Read::take(&mut pipe, MAX_CLIPBOARD_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .context("the clipboard did not read")?;
    bounded_text(&raw, MAX_CLIPBOARD_BYTES)
}

/// The text within `limit` bytes, cut on a character boundary, and whether
/// anything past the limit was dropped.
fn bounded_text(raw: &[u8], limit: usize) -> Result<(String, bool)> {
    let truncated = raw.len() > limit;
    let bytes = if truncated { &raw[..limit] } else { raw };
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_owned(), truncated)),
        Err(error) if truncated && error.error_len().is_none() => {
            // The invalid sequence is an incomplete one at the cut, so the bytes
            // before it are the text the desktop held.
            let valid = error.valid_up_to();
            Ok((String::from_utf8_lossy(&bytes[..valid]).into_owned(), true))
        }
        Err(_) => Err(anyhow::anyhow!(
            "the clipboard contents are not valid UTF-8 text"
        )),
    }
}

pub fn write(text: &str) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!("refusing to place {} bytes on the clipboard", text.len());
    }
    // wl-copy acknowledges setup before forking its selection server. The
    // explicit copy survives Back/engine exit, until another app replaces it.
    let mut child = Command::new("wl-copy")
        .args(["--type", "text/plain;charset=utf-8"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("wl-clipboard is required to write the desktop clipboard")?;
    let written = child
        .stdin
        .take()
        .expect("piped clipboard input")
        .write_all(text.as_bytes());
    let status = child.wait().context("the clipboard writer did not exit")?;
    written.context("the clipboard writer did not accept the text")?;
    anyhow::ensure!(status.success(), "the compositor refused a clipboard write");
    Ok(())
}

pub fn writer_available() -> bool {
    Command::new("wl-copy")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Distinguishing "nothing there" from "unsupported" matters for the message the
/// user sees, so the caller can report which one happened.
pub fn read_or_explain() -> Result<(String, bool), String> {
    match read() {
        Ok(result) => Ok(result),
        Err(error) => {
            let root = error.root_cause().to_string();
            if root.contains("no suitable") || root.contains("was provided") {
                Err(String::from("the desktop clipboard has no text"))
            } else {
                Err(root)
            }
        }
    }
}

/// Each operation uses its own connection: capture drains selection events.
fn x11_window(display: &str) -> Result<(x11rb::rust_connection::RustConnection, u32)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass};
    let (connection, screen) = x11rb::connect(Some(display))?;
    let window = connection.generate_id()?;
    connection
        .create_window(
            0,
            window,
            connection.setup().roots[screen].root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new(),
        )?
        .check()?;
    Ok((connection, window))
}

fn x11_atom(connection: &impl x11rb::connection::Connection, name: &[u8]) -> Result<u32> {
    use x11rb::protocol::xproto::ConnectionExt;
    Ok(connection.intern_atom(false, name)?.reply()?.atom)
}

/// Own CLIPBOARD until another client replaces it, the engine exits, or X dies.
/// No INCR send: a single bounded property is the entire supported transfer.
pub fn x11_write(display: &str, text: &str) -> Result<()> {
    use x11rb::connection::{Connection, RequestConnection};
    use x11rb::protocol::{xproto::*, Event};
    use x11rb::wrapper::ConnectionExt as _;
    anyhow::ensure!(
        text.len() <= MAX_CLIPBOARD_BYTES,
        "refusing to place {} bytes on the clipboard",
        text.len()
    );
    let (connection, window) = x11_window(display)?;
    // Leave room for the ChangeProperty header and alignment padding.
    anyhow::ensure!(
        text.len() <= connection.maximum_request_bytes().saturating_sub(28),
        "clipboard text is too large for one transfer (INCR is unsupported)"
    );
    let selection = x11_atom(&connection, b"CLIPBOARD")?;
    let targets = x11_atom(&connection, b"TARGETS")?;
    let utf8 = x11_atom(&connection, b"UTF8_STRING")?;
    let text_target = x11_atom(&connection, b"TEXT")?;
    connection
        .set_selection_owner(window, selection, x11rb::CURRENT_TIME)?
        .check()?;
    anyhow::ensure!(
        connection.get_selection_owner(selection)?.reply()?.owner == window,
        "the X server refused clipboard ownership"
    );
    let text = text.to_owned();
    std::thread::Builder::new()
        .name(String::from("desklink-x11-clipboard"))
        .spawn(move || -> Result<()> {
            loop {
                match connection.wait_for_event()? {
                    Event::SelectionClear(_) => break,
                    Event::SelectionRequest(request) => {
                        let property = if request.property == x11rb::NONE {
                            request.target
                        } else {
                            request.property
                        };
                        let accepted = if request.target == targets {
                            connection
                                .change_property32(
                                    PropMode::REPLACE,
                                    request.requestor,
                                    property,
                                    AtomEnum::ATOM,
                                    &[targets, utf8, text_target],
                                )?
                                .check()
                                .is_ok()
                        } else if request.target == utf8 || request.target == text_target {
                            connection
                                .change_property8(
                                    PropMode::REPLACE,
                                    request.requestor,
                                    property,
                                    utf8,
                                    text.as_bytes(),
                                )?
                                .check()
                                .is_ok()
                        } else {
                            false
                        };
                        let reply = SelectionNotifyEvent {
                            response_type: SELECTION_NOTIFY_EVENT,
                            sequence: 0,
                            time: request.time,
                            requestor: request.requestor,
                            selection: request.selection,
                            target: request.target,
                            property: if accepted { property } else { x11rb::NONE },
                        };
                        connection.send_event(
                            false,
                            request.requestor,
                            EventMask::NO_EVENT,
                            reply,
                        )?;
                        connection.flush()?;
                    }
                    _ => {}
                }
            }
            Ok(())
        })?;
    Ok(())
}

pub fn x11_read(display: &str) -> Result<(String, bool)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::{xproto::ConnectionExt, Event};
    let (connection, window) = x11_window(display)?;
    let selection = x11_atom(&connection, b"CLIPBOARD")?;
    anyhow::ensure!(
        connection.get_selection_owner(selection)?.reply()?.owner != x11rb::NONE,
        "the desktop clipboard has no text"
    );
    let utf8 = x11_atom(&connection, b"UTF8_STRING")?;
    let incr = x11_atom(&connection, b"INCR")?;
    let property = x11_atom(&connection, b"DESKLINK_CLIPBOARD")?;
    connection.convert_selection(window, selection, utf8, property, x11rb::CURRENT_TIME)?;
    connection.flush()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2500);
    loop {
        if let Some(Event::SelectionNotify(event)) = connection.poll_for_event()? {
            if event.requestor != window || event.selection != selection {
                continue;
            }
            anyhow::ensure!(
                event.property != x11rb::NONE,
                "the desktop clipboard has no text"
            );
            let reply = connection
                .get_property(
                    true,
                    window,
                    property,
                    x11rb::protocol::xproto::AtomEnum::ANY,
                    0,
                    (MAX_CLIPBOARD_BYTES / 4 + 1) as u32,
                )?
                .reply()?;
            // ponytail: one property only; implement INCR when larger transfers are needed.
            anyhow::ensure!(
                reply.type_ != incr,
                "clipboard text is too large for one transfer (INCR is unsupported)"
            );
            anyhow::ensure!(
                reply.format == 8 && reply.type_ == utf8,
                "the clipboard contents are not UTF-8 text"
            );
            let (text, truncated) = bounded_text(&reply.value, MAX_CLIPBOARD_BYTES)?;
            return Ok((text, truncated || reply.bytes_after > 0));
        }
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "the clipboard owner did not answer"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_clipboard_is_cut_cleanly_and_reported() {
        let mut raw = vec![b'a'; 4];
        raw.extend_from_slice("\u{e9}".as_bytes());
        raw.extend_from_slice(b"zzzz");
        let (text, truncated) =
            bounded_text(&raw, 5).expect("a character-boundary cut is valid text");
        assert!(truncated, "a cut past the limit must be reported");
        assert_eq!(
            text, "aaaa",
            "the partial character is dropped, not invented"
        );

        // A byte that is not valid UTF-8 before the cut is not a partial
        // character; the whole read is refused.
        let mut invalid = vec![b'a'; 4];
        invalid.push(0xff);
        invalid.extend_from_slice(b"zzzz");
        assert!(bounded_text(&invalid, 5).is_err());

        let (text, truncated) = bounded_text(b"hello", 5).unwrap();
        assert!(!truncated);
        assert_eq!(text, "hello");

        let (text, truncated) = bounded_text(b"hello world", 5).unwrap();
        assert!(truncated);
        assert_eq!(text, "hello");
    }
}
