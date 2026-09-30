//! Windows capture seam. No display access in the compile-only lane.

pub fn unavailable_reason() -> &'static str {
    "Windows display capture is not implemented in this build."
}
