//! Windows desktop capture is deferred; encoded sources never call this adapter.
use crate::convert::I420;
use crate::portal::PortalSession;
use anyhow::{bail, Result};

pub type FrameSink = Box<dyn Fn(I420, u64, Pixels) + Send + 'static>;
pub type Pixels<'a> = &'a mut dyn FnMut() -> Option<Vec<u8>>;
pub struct Capture;

pub fn unavailable_reason() -> &'static str {
    "Windows display capture is not implemented in this build."
}

pub fn start(
    _session: PortalSession,
    _width: usize,
    _height: usize,
    _fps: u32,
    _sink: FrameSink,
    _status: Box<dyn Fn(bool, String) + Send>,
) -> Result<Capture> {
    bail!("{}", unavailable_reason())
}
