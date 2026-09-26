use anyhow::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keystroke {
    pub code: i16,
    pub shift: bool,
    pub alt_gr: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Keystroke {
    fn simple(code: i16) -> Self {
        Self {
            code,
            shift: false,
            alt_gr: false,
            ctrl: false,
            alt: false,
            meta: false,
        }
    }

    pub fn modifiers(&self) -> Vec<i16> {
        let mut keys = Vec::new();
        if self.ctrl {
            keys.push(59);
        }
        if self.alt {
            keys.push(58);
        }
        if self.meta {
            keys.push(55);
        }
        if self.shift {
            keys.push(56);
        }
        if self.alt_gr {
            keys.push(61);
        }
        keys
    }
}

pub fn named_key(name: &str) -> Option<Keystroke> {
    let code = match name {
        "Enter" | "Return" => 36,
        "Tab" => 48,
        "Escape" => 53,
        "Backspace" | "DeleteBackward" => 51,
        "Delete" | "DeleteForward" => 117,
        "ArrowUp" => 126,
        "ArrowDown" => 125,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "Home" => 115,
        "End" => 119,
        "PageUp" => 116,
        "PageDown" => 121,
        _ => return None,
    };
    Some(Keystroke::simple(code))
}

pub fn modifier_key(name: &str) -> Option<i16> {
    match name {
        "Control" | "ControlLeft" | "Ctrl" => Some(59),
        "ControlRight" => Some(62),
        "Shift" | "ShiftLeft" => Some(56),
        "ShiftRight" => Some(60),
        "Alt" | "AltLeft" => Some(58),
        "AltRight" | "AltGraph" => Some(61),
        "Meta" | "MetaLeft" | "Super" | "Command" => Some(55),
        "MetaRight" => Some(54),
        _ => None,
    }
}

pub struct LayoutNames;
impl LayoutNames {
    pub fn from_environment() -> Self {
        Self
    }
    pub fn identity(&self) -> String {
        crate::mac::keyboard_layout()
    }
}

pub struct Layout;
impl Layout {
    pub fn from_environment() -> Result<Self> {
        Ok(Self)
    }

    pub fn keystroke_for_char(&self, character: char) -> Option<Keystroke> {
        let (code, shift) = us_ansi_key(character)?;
        Some(Keystroke {
            shift,
            ..Keystroke::simple(code)
        })
    }
}

fn us_ansi_key(character: char) -> Option<(i16, bool)> {
    let (letter_code, shift) = match character.to_ascii_lowercase() {
        'a' => (0, character.is_ascii_uppercase()),
        's' => (1, character.is_ascii_uppercase()),
        'd' => (2, character.is_ascii_uppercase()),
        'f' => (3, character.is_ascii_uppercase()),
        'h' => (4, character.is_ascii_uppercase()),
        'g' => (5, character.is_ascii_uppercase()),
        'z' => (6, character.is_ascii_uppercase()),
        'x' => (7, character.is_ascii_uppercase()),
        'c' => (8, character.is_ascii_uppercase()),
        'v' => (9, character.is_ascii_uppercase()),
        'b' => (11, character.is_ascii_uppercase()),
        'q' => (12, character.is_ascii_uppercase()),
        'w' => (13, character.is_ascii_uppercase()),
        'e' => (14, character.is_ascii_uppercase()),
        'r' => (15, character.is_ascii_uppercase()),
        'y' => (16, character.is_ascii_uppercase()),
        't' => (17, character.is_ascii_uppercase()),
        'o' => (31, character.is_ascii_uppercase()),
        'u' => (32, character.is_ascii_uppercase()),
        'i' => (34, character.is_ascii_uppercase()),
        'p' => (35, character.is_ascii_uppercase()),
        'l' => (37, character.is_ascii_uppercase()),
        'j' => (38, character.is_ascii_uppercase()),
        'k' => (40, character.is_ascii_uppercase()),
        'n' => (45, character.is_ascii_uppercase()),
        'm' => (46, character.is_ascii_uppercase()),
        _ => (-1, false),
    };
    if letter_code >= 0 {
        return Some((letter_code, shift));
    }
    Some(match character {
        '1' => (18, false),
        '!' => (18, true),
        '2' => (19, false),
        '@' => (19, true),
        '3' => (20, false),
        '#' => (20, true),
        '4' => (21, false),
        '$' => (21, true),
        '5' => (23, false),
        '%' => (23, true),
        '6' => (22, false),
        '^' => (22, true),
        '7' => (26, false),
        '&' => (26, true),
        '8' => (28, false),
        '*' => (28, true),
        '9' => (25, false),
        '(' => (25, true),
        '0' => (29, false),
        ')' => (29, true),
        '-' => (27, false),
        '_' => (27, true),
        '=' => (24, false),
        '+' => (24, true),
        '[' => (33, false),
        '{' => (33, true),
        ']' => (30, false),
        '}' => (30, true),
        ';' => (41, false),
        ':' => (41, true),
        '\'' => (39, false),
        '"' => (39, true),
        ',' => (43, false),
        '<' => (43, true),
        '.' => (47, false),
        '>' => (47, true),
        '/' => (44, false),
        '?' => (44, true),
        '\\' => (42, false),
        '|' => (42, true),
        '`' => (50, false),
        '~' => (50, true),
        ' ' => (49, false),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_ascii_to_ansi_virtual_keys() {
        let layout = Layout::from_environment().unwrap();
        let lower = layout.keystroke_for_char('a').unwrap();
        let upper = layout.keystroke_for_char('A').unwrap();
        assert_eq!(lower.code, 0);
        assert_eq!(upper.code, lower.code);
        assert!(upper.shift);
        assert_eq!(layout.keystroke_for_char('!').unwrap().code, 18);
        assert!(layout.keystroke_for_char('\u{1f600}').is_none());
    }

    #[test]
    fn resolves_mac_named_keys_and_modifiers() {
        assert_eq!(named_key("Return").unwrap().code, 36);
        assert_eq!(named_key("ArrowLeft").unwrap().code, 123);
        assert_eq!(modifier_key("Command"), Some(55));
        assert!(named_key("Frobnicate").is_none());
    }
}
