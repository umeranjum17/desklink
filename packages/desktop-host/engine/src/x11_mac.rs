use crate::convert::I420;
use anyhow::{bail, Result};

pub mod button {
    pub const LEFT: u8 = 1;
    pub const MIDDLE: u8 = 2;
    pub const RIGHT: u8 = 3;
}

pub struct X11Desktop;

impl X11Desktop {
    pub fn connect(_: Option<&str>) -> Result<Self> {
        bail!("the X11 backend is only available on Linux")
    }

    pub fn screen_size(&self) -> (i32, i32) {
        (0, 0)
    }

    pub fn input_available(&self) -> bool {
        false
    }

    pub fn capture_with_pixels(&mut self, _: usize, _: usize) -> Result<(I420, Vec<u8>)> {
        bail!("the X11 backend is only available on Linux")
    }

    pub fn capture_path(&self) -> &'static str {
        "get_image"
    }

    pub fn damage_armed(&self) -> bool {
        false
    }

    pub fn take_damage(&self) -> bool {
        true
    }

    pub fn move_pointer(&mut self, _: i64, _: i64) -> Result<()> {
        bail!("the X11 backend is only available on Linux")
    }

    pub fn button(&mut self, _: u8, _: bool) -> Result<()> {
        bail!("the X11 backend is only available on Linux")
    }

    pub fn scroll(&mut self, _: i64, _: i64) -> Result<()> {
        bail!("the X11 backend is only available on Linux")
    }

    pub fn key(&mut self, _: i16, _: bool) -> Result<()> {
        bail!("the X11 backend is only available on Linux")
    }
}
