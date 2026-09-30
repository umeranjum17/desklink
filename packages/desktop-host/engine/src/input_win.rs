use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
}

impl Button {
    pub fn from_number(number: i64) -> Self {
        match number {
            2 => Self::Middle,
            3 => Self::Right,
            _ => Self::Left,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HeldState {
    keys: Vec<i16>,
    buttons: Vec<Button>,
}

impl HeldState {
    pub fn key(&mut self, code: i16, down: bool) {
        if down {
            if !self.keys.contains(&code) {
                self.keys.push(code);
            }
        } else {
            self.keys.retain(|held| *held != code);
        }
    }

    pub fn button(&mut self, button: Button, down: bool) {
        if down {
            if !self.buttons.contains(&button) {
                self.buttons.push(button);
            }
        } else {
            self.buttons.retain(|held| *held != button);
        }
    }

    pub fn release_plan(&mut self) -> (Vec<Button>, Vec<i16>) {
        (
            std::mem::take(&mut self.buttons),
            std::mem::take(&mut self.keys),
        )
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InputUnavailable {
    pub reason: String,
    pub remedy: String,
}

pub fn unavailable_reason() -> &'static str {
    "Windows input is not implemented in this build."
}
pub fn probe() -> Result<(), InputUnavailable> {
    Err(InputUnavailable {
        reason: unavailable_reason().into(),
        remedy: "Use a future Windows input-enabled build.".into(),
    })
}
// This private, unconstructible adapter cannot inject native input.
pub struct InputDevices {
    _private: (),
}
impl InputDevices {
    pub fn create_for_display(_width: i32, _height: i32, _display: u32) -> Result<Self> {
        bail!("{}", unavailable_reason())
    }
    pub fn move_absolute(&mut self, _x: i64, _y: i64) {}
    pub fn button(&mut self, _button: Button, _down: bool) {}
    pub fn scroll(&mut self, _dx: f64, _dy: f64) {}
    pub fn key(&mut self, _code: i16, _down: bool) -> Result<()> {
        bail!("{}", unavailable_reason())
    }
    pub fn unicode_text(&mut self, _text: &str) -> Result<()> {
        bail!("{}", unavailable_reason())
    }
}

pub fn native_keycode(_code: i16) -> Result<i16> {
    bail!("{}", unavailable_reason())
}
