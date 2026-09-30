//! Windows input seam. This build never injects input.

pub fn unavailable_reason() -> &'static str {
    "Windows input is not implemented in this build."
}
