//! desklink scout instrumentation (dev-only, `DESKLINK_ICE_TRACE=1`).
//!
//! Timestamped stderr trace of the ICE agent's restart/check/nomination timeline
//! for ICE restart diagnosis. Not part of the shipped patch; see
//! DESKLINK-PATCH.md. Every call site is marked `// desklink scout trace:` so the
//! whole diff is trivially droppable.

use std::fmt::Arguments;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether tracing is on; cached, so the hot path is one atomic load.
pub(crate) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| flag("DESKLINK_ICE_TRACE"))
}

/// A dev-only scout switch, read fresh each time (these are experiments).
pub(crate) fn flag(name: &str) -> bool {
    match std::env::var(name) {
        Ok(v) => v != "0" && !v.is_empty(),
        Err(_) => false,
    }
}

/// Microseconds since the Unix epoch; the vendored crate, the engine and the
/// browser/relay side all stamp this way (ms on the JS side), so lines from
/// every observer sort into one timeline.
pub(crate) fn t_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0)
}

/// Emit one trace line.
pub(crate) fn write(line: Arguments<'_>) {
    eprintln!("[ice {}] {}", t_us(), line);
}

macro_rules! dl_ice {
    ($($arg:tt)*) => {{
        if $crate::dl_trace::enabled() {
            $crate::dl_trace::write(format_args!($($arg)*));
        }
    }};
}

pub(crate) use dl_ice;
