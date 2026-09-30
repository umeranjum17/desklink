use anyhow::Result;

// No key mapping is advertised until the native input lane is implemented.
pub struct Keystroke {
    pub code: i16,
}
impl Keystroke {
    pub fn modifiers(&self) -> Vec<i16> {
        Vec::new()
    }
}

pub fn named_key(_name: &str) -> Option<Keystroke> {
    None
}
pub fn modifier_key(_name: &str) -> Option<i16> {
    None
}
pub fn keyboard_layout() -> &'static str {
    "unknown"
}
pub struct LayoutNames;
impl LayoutNames {
    pub fn from_environment() -> Self {
        Self
    }
    pub fn identity(&self) -> String {
        keyboard_layout().into()
    }
}
pub struct Layout;
impl Layout {
    pub fn from_environment() -> Result<Self> {
        Ok(Self)
    }
    pub fn keystroke_for_char(&self, _character: char) -> Option<Keystroke> {
        None
    }
}
