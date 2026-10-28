//! Passive observation of the desktop's own pointer buttons, cursor and keys.
//!
//! The engine only listens; events are the ones `docs/PROTOCOL.md` describes. A
//! platform that cannot observe says why with a typed reason and delivers nothing.

use crate::protocol::{CursorPosition, ObservedInput};
use std::sync::Arc;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Observation {
    Input {
        timestamp_us: u64,
        input: ObservedInput,
    },
    Cursor(CursorPosition),
}

pub type Sink = Arc<dyn Fn(Observation) + Send + Sync + 'static>;

/// Keeps an observer running; dropping it stops it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Tap {
    pub mechanism: &'static str,
    pub guard: Box<dyn Send>,
}

/// Why the desktop's input cannot be observed, and what the owner can do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable {
    pub code: &'static str,
    pub reason: String,
    pub remedy: String,
}

#[cfg(target_os = "macos")]
pub fn start(display_id: u32, pixels: (usize, usize), sink: Sink) -> Result<Tap, Unavailable> {
    crate::input::observe(display_id, pixels, sink)
}

#[cfg(not(target_os = "macos"))]
pub fn start(_: u32, _: (usize, usize), _: Sink) -> Result<Tap, Unavailable> {
    Err(Unavailable {
        code: "unsupported-platform",
        reason: String::from("observing the desktop's own input is only implemented on macOS"),
        remedy: String::from("none: this platform delivers no input events"),
    })
}

/// The `inputObservation` member of the `session.open` reply.
pub fn status(result: Option<&Result<Tap, Unavailable>>) -> serde_json::Value {
    match result {
        None => serde_json::json!({"observing": false}),
        Some(Ok(tap)) => serde_json::json!({"observing": true, "mechanism": tap.mechanism}),
        Some(Err(error)) => serde_json::json!({
            "observing": false,
            "code": error.code,
            "reason": error.reason,
            "remedy": error.remedy,
        }),
    }
}
