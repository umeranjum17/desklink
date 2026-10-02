//! Session-owned selection service on the selected X server, never the ambient display.
use anyhow::Result;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{ConnectionExt as _, CreateWindowAux, EventMask, PropMode, SelectionNotifyEvent, WindowClass};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

pub struct Clipboard {
    connection: RustConnection,
    window: u32,
    selection: u32,
    utf8: u32,
    targets: u32,
    property: u32,
    incr: u32,
    text: Mutex<String>,
    stopped: AtomicBool,
    serving: AtomicBool,
}

impl Clipboard {
    pub fn connect(display: Option<&str>) -> Result<Arc<Self>> {
        let (connection, screen) = RustConnection::connect(display)?;
        let window = connection.generate_id()?;
        connection.create_window(0, window, connection.setup().roots[screen].root,
            0, 0, 1, 1, 0, WindowClass::INPUT_ONLY, 0,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE))?.check()?;
        let atom = |name: &[u8]| -> Result<u32> { Ok(connection.intern_atom(false, name)?.reply()?.atom) };
        let clipboard = Arc::new(Self {
            window, selection: atom(b"CLIPBOARD")?, utf8: atom(b"UTF8_STRING")?,
            targets: atom(b"TARGETS")?, property: atom(b"DESKLINK_CLIPBOARD")?,
            incr: atom(b"INCR")?, connection,
            text: Mutex::new(String::new()), stopped: AtomicBool::new(false), serving: AtomicBool::new(false),
        });
        Ok(clipboard)
    }

    // Kept alive only while this selection is owned. Revocation stops the
    // service and releases ownership even if another task retains an Arc.
    pub fn stop(&self) {
        let _guard = self.text.lock().unwrap();
        self.stopped.store(true, Ordering::SeqCst);
        if self.connection.get_selection_owner(self.selection).ok()
            .and_then(|cookie| cookie.reply().ok()).is_some_and(|owner| owner.owner == self.window) {
            let _ = self.connection.set_selection_owner(0u32, self.selection, x11rb::CURRENT_TIME);
            let _ = self.connection.flush();
        }
    }

    pub fn write(self: &Arc<Self>, text: &str) -> Result<()> {
        let mut held = self.text.lock().unwrap();
        anyhow::ensure!(!self.stopped.load(Ordering::SeqCst), "the session has ended");
        anyhow::ensure!(text.len() <= crate::clipboard::MAX_CLIPBOARD_BYTES, "clipboard text exceeds the transfer limit");
        anyhow::ensure!(text.len() + 24 <= self.connection.maximum_request_bytes(), "clipboard text exceeds the X server request limit");
        *held = text.to_owned();
        self.connection.set_selection_owner(self.window, self.selection, x11rb::CURRENT_TIME)?.check()?;
        self.connection.flush()?;
        anyhow::ensure!(self.connection.get_selection_owner(self.selection)?.reply()?.owner == self.window,
            "the X server refused clipboard ownership");
        drop(held);
        if self.serving.swap(true, Ordering::SeqCst) { return Ok(()); }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(clipboard) = weak.upgrade() {
                if clipboard.stopped.load(Ordering::SeqCst) { break; }
                match clipboard.connection.poll_for_event() {
                    Ok(Some(Event::SelectionRequest(request))) => {
                        let _ = clipboard.serve(request);
                    }
                    Err(_) => break,
                    _ => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Ok(())
    }

    fn serve(&self, request: x11rb::protocol::xproto::SelectionRequestEvent) -> Result<()> {
        let text = self.text.lock().unwrap();
        anyhow::ensure!(!self.stopped.load(Ordering::SeqCst), "the session has ended");
        let property = if request.property == 0 { request.target } else { request.property };
        let accepted = if request.target == self.targets {
            self.connection.change_property32(PropMode::REPLACE, request.requestor, property,
                x11rb::protocol::xproto::AtomEnum::ATOM, &[self.targets, self.utf8])?.check()?;
            true
        } else if request.target == self.utf8 {
            self.connection.change_property8(PropMode::REPLACE, request.requestor, property,
                self.utf8, text.as_bytes())?.check()?;
            true
        } else { false };
        self.connection.send_event(false, request.requestor, EventMask::NO_EVENT, SelectionNotifyEvent {
            response_type: x11rb::protocol::xproto::SELECTION_NOTIFY_EVENT, sequence: 0,
            time: request.time, requestor: request.requestor, selection: request.selection,
            target: request.target, property: if accepted { property } else { 0 },
        })?;
        self.connection.flush()?;
        Ok(())
    }

    pub fn read(&self, display: Option<&str>) -> Result<(String, bool)> {
        anyhow::ensure!(!self.stopped.load(Ordering::SeqCst), "the session has ended");
        // Separate connection so the selection server can keep serving during a read.
        let reader = Self::connect(display)?;
        reader.connection.convert_selection(reader.window, reader.selection, reader.utf8,
            reader.property, x11rb::CURRENT_TIME)?;
        reader.connection.flush()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let limit = crate::clipboard::MAX_CLIPBOARD_BYTES;
        let mut incremental = false;
        let mut raw = Vec::new();
        loop {
            anyhow::ensure!(Instant::now() < deadline, "the desktop clipboard did not answer");
            match reader.connection.poll_for_event()? {
                Some(Event::SelectionNotify(event)) => {
                    anyhow::ensure!(event.property != 0, "the desktop clipboard has no text");
                    let reply = reader.connection.get_property(true, reader.window, reader.property,
                        x11rb::protocol::xproto::AtomEnum::ANY, 0, (limit / 4 + 1) as u32)?.reply()?;
                    if reply.type_ == reader.incr {
                        incremental = true;
                        reader.connection.flush()?;
                    } else {
                        anyhow::ensure!(reply.type_ == reader.utf8 && reply.format == 8, "the clipboard has no UTF-8 text");
                        raw = reply.value;
                        return crate::clipboard::bounded_text(&raw, limit);
                    }
                }
                Some(Event::PropertyNotify(event)) if incremental && event.state == x11rb::protocol::xproto::Property::NEW_VALUE => {
                    let reply = reader.connection.get_property(true, reader.window, reader.property,
                        reader.utf8, 0, (limit / 4 + 1) as u32)?.reply()?;
                    let empty = reply.value.is_empty();
                    raw.extend_from_slice(&reply.value[..reply.value.len().min(limit + 1 - raw.len())]);
                    reader.connection.flush()?;
                    if empty || raw.len() > limit { return crate::clipboard::bounded_text(&raw, limit); }
                }
                _ => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) { let _ = self.connection.destroy_window(self.window); let _ = self.connection.flush(); }
}
