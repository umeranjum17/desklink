//! Passive observation of the desktop's own pointer buttons, cursor and keys.
//!
//! The person at the computer is the one typing and clicking; the engine only
//! listens. Everything arrives as the events `docs/PROTOCOL.md` describes
//! (`session.input.observed`, `session.cursor`) in the source's own pixels and
//! on the engine's monotonic clock. A platform that cannot observe says so with
//! a typed reason and delivers nothing: there is no fake or zero event.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn a_platform_that_cannot_observe_says_so_and_delivers_nothing() {
        let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = delivered.clone();
        let sink: Sink = Arc::new(move |_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let refused = start(0, (1920, 1080), sink);
        let status = status(Some(&refused));
        assert_eq!(status["observing"], false);
        assert_eq!(status["code"], "unsupported-platform");
        assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn an_unrequested_observer_reports_not_observing_without_a_reason() {
        assert_eq!(status(None), serde_json::json!({"observing": false}));
    }

    #[test]
    fn a_refusal_carries_its_code_reason_and_remedy() {
        let refused: Result<Tap, Unavailable> = Err(Unavailable {
            code: "missing-input-monitoring",
            reason: String::from("reason"),
            remedy: String::from("remedy"),
        });
        assert_eq!(
            status(Some(&refused)),
            serde_json::json!({"observing": false, "code": "missing-input-monitoring", "reason": "reason", "remedy": "remedy"})
        );
    }
}
