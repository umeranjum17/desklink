use anyhow::Result;
#[cfg(desklink_vpx)]
use crate::protocol::ObservedInput;

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

/// Event types of a CGEventTap that carry a key.
#[cfg(desklink_vpx)]
pub mod key_event {
    pub const DOWN: u32 = 10;
    pub const UP: u32 = 11;
    pub const FLAGS_CHANGED: u32 = 12;
}

/// Generic modifier bits of a CGEvent's flags.
#[cfg(desklink_vpx)]
const SHIFT: u64 = 0x2_0000;
#[cfg(desklink_vpx)]
const CONTROL: u64 = 0x4_0000;
#[cfg(desklink_vpx)]
const ALT: u64 = 0x8_0000;
#[cfg(desklink_vpx)]
const META: u64 = 0x10_0000;

/// A modifier key: its name, and the bit of the event flags that is set while
/// this key (not just its twin on the other side) is held. Caps Lock and Fn have
/// no per-side bit, so theirs is the generic one.
#[cfg(desklink_vpx)]
const MODIFIER_KEYS: [(i16, &str, u64); 10] = [
    (59, "Control", 0x1), (62, "ControlRight", 0x2000), (56, "Shift", 0x2),
    (60, "ShiftRight", 0x4), (58, "Alt", 0x20), (61, "AltRight", 0x40),
    (55, "Meta", 0x8), (54, "MetaRight", 0x10), (57, "CapsLock", 0x1_0000),
    (63, "Fn", 0x80_0000),
];

/// Keys that have a name rather than a character, following `KeyboardEvent.key`.
/// Every name here that the control channel accepts maps to the same virtual key
/// code through `named_key`.
#[cfg(desklink_vpx)]
const NAMED_KEYS: [(i16, &str); 36] = [
    (36, "Enter"), (76, "Enter"), (48, "Tab"), (53, "Escape"),
    (51, "Backspace"), (117, "Delete"), (126, "ArrowUp"), (125, "ArrowDown"),
    (123, "ArrowLeft"), (124, "ArrowRight"), (115, "Home"), (119, "End"),
    (116, "PageUp"), (121, "PageDown"), (122, "F1"), (120, "F2"),
    (99, "F3"), (118, "F4"), (96, "F5"), (97, "F6"),
    (98, "F7"), (100, "F8"), (101, "F9"), (109, "F10"),
    (103, "F11"), (111, "F12"), (105, "F13"), (107, "F14"),
    (113, "F15"), (106, "F16"), (64, "F17"), (79, "F18"),
    (80, "F19"), (90, "F20"), (114, "Help"), (110, "ContextMenu"),
];

/// Names of the modifiers held in `flags`, in the order the control channel's
/// own examples use.
#[cfg(desklink_vpx)]
pub fn modifier_names(flags: u64) -> Vec<String> {
    [
        (CONTROL, "Control"),
        (ALT, "Alt"),
        (SHIFT, "Shift"),
        (META, "Meta"),
    ]
    .into_iter()
    .filter(|(bit, _)| flags & bit != 0)
    .map(|(_, name)| name.to_owned())
    .collect()
}

/// The character a key makes on the US ANSI map this engine injects with. Only
/// a fallback: a control chord, or an event the system gave no text, has none.
#[cfg(desklink_vpx)]
fn base_character(code: i16, shift: bool) -> Option<char> {
    (' '..='~').find(|character| us_ansi_key(*character) == Some((code, shift)))
}

/// The single printable character a key produced on the layout in use.
#[cfg(desklink_vpx)]
fn printable(text: &str) -> Option<char> {
    let mut characters = text.chars();
    let character = characters.next()?;
    // U+F700..U+F8FF is where AppKit puts the function and arrow keys.
    (characters.next().is_none() && !character.is_control() && !('\u{f700}'..='\u{f8ff}').contains(&character))
        .then_some(character)
}

/// What a CGEventTap key event means, in the control channel's `key` vocabulary.
///
/// `text` is what the event types on the active layout. Auto-repeat is not an
/// event: a held key is one down and one up. A modifier arrives as a flags
/// change, whose direction is its own bit being set.
#[cfg(desklink_vpx)]
pub fn observed_key(
    event_type: u32,
    code: i16,
    flags: u64,
    autorepeat: bool,
    text: &str,
) -> Option<ObservedInput> {
    let modifiers = modifier_names(flags);
    if event_type == key_event::FLAGS_CHANGED {
        let (_, name, bit) = MODIFIER_KEYS.iter().find(|(key, _, _)| *key == code)?;
        return Some(ObservedInput::Key {
            name: Some((*name).to_owned()),
            character: None,
            down: flags & bit != 0,
            modifiers,
        });
    }
    let down = match event_type {
        key_event::DOWN if autorepeat => return None,
        key_event::DOWN => true,
        key_event::UP => false,
        _ => return None,
    };
    let named = NAMED_KEYS.iter().find(|(key, _)| *key == code);
    let character = if named.is_some() {
        None
    } else {
        printable(text).or_else(|| base_character(code, flags & SHIFT != 0))
    };
    let name = match (named, character) {
        (Some((_, name)), _) => Some((*name).to_owned()),
        (None, Some(_)) => None,
        (None, None) => Some(String::from("Unidentified")),
    };
    Some(ObservedInput::Key {
        name,
        character: character.map(String::from),
        down,
        modifiers,
    })
}

#[cfg(all(test, desklink_vpx))]
mod tests {
    use super::*;

    fn key(
        event_type: u32,
        code: i16,
        flags: u64,
        autorepeat: bool,
        text: &str,
    ) -> Option<ObservedInput> {
        observed_key(event_type, code, flags, autorepeat, text)
    }

    #[test]
    fn a_letter_is_a_character_with_the_modifier_state_after_the_event() {
        assert_eq!(
            key(key_event::DOWN, 0, SHIFT, false, "A"),
            Some(ObservedInput::Key {
                name: None,
                character: Some(String::from("A")),
                down: true,
                modifiers: vec![String::from("Shift")],
            })
        );
    }

    #[test]
    fn a_named_key_carries_no_character() {
        assert_eq!(
            key(key_event::UP, 36, 0, false, "\r"),
            Some(ObservedInput::Key {
                name: Some(String::from("Enter")),
                character: None,
                down: false,
                modifiers: Vec::new(),
            })
        );
    }

    #[test]
    fn a_chord_with_no_text_falls_back_to_the_key_it_is() {
        // Control-C types U+0003, which is not a character a keycap can show.
        let Some(ObservedInput::Key {
            character,
            modifiers,
            ..
        }) = key(key_event::DOWN, 8, CONTROL, false, "\u{3}")
        else {
            panic!("a chord is a key");
        };
        assert_eq!(character.as_deref(), Some("c"));
        assert_eq!(modifiers, vec![String::from("Control")]);
    }

    #[test]
    fn an_event_with_no_text_is_still_the_shifted_character() {
        let Some(ObservedInput::Key { character, .. }) =
            key(key_event::DOWN, 4, SHIFT, false, "")
        else {
            panic!("a letter is a key");
        };
        assert_eq!(character.as_deref(), Some("H"));
    }

    #[test]
    fn a_held_key_is_one_down_and_one_up() {
        assert_eq!(key(key_event::DOWN, 0, 0, true, "a"), None);
        assert!(key(key_event::UP, 0, 0, false, "a").is_some());
    }

    #[test]
    fn releasing_one_shift_while_the_other_is_held_is_an_up() {
        // Left shift went up; right shift (bit 0x4) and the generic bit remain.
        let Some(ObservedInput::Key {
            name,
            down,
            modifiers,
            ..
        }) = key(key_event::FLAGS_CHANGED, 56, SHIFT | 0x4, false, "")
        else {
            panic!("a modifier change is a key");
        };
        assert_eq!(name.as_deref(), Some("Shift"));
        assert!(!down);
        assert_eq!(modifiers, vec![String::from("Shift")]);
        let Some(ObservedInput::Key { down, .. }) =
            key(key_event::FLAGS_CHANGED, 56, SHIFT | 0x2 | 0x4, false, "")
        else {
            panic!("a modifier change is a key");
        };
        assert!(down);
    }

    #[test]
    fn a_key_with_no_name_and_no_text_is_unidentified_not_empty() {
        let Some(ObservedInput::Key {
            name, character, ..
        }) = key(key_event::DOWN, 127, 0, false, "")
        else {
            panic!("an unknown key is still a key");
        };
        assert_eq!(name.as_deref(), Some("Unidentified"));
        assert_eq!(character, None);
    }

    #[test]
    fn the_private_use_characters_appkit_gives_arrows_are_not_text() {
        assert_eq!(printable("\u{f702}"), None);
        assert_eq!(printable("é"), Some('é'));
        assert_eq!(printable("ab"), None);
    }

    #[test]
    fn what_is_observed_is_what_the_control_channel_would_inject() {
        for (code, name) in NAMED_KEYS {
            if let Some(stroke) = named_key(name) {
                // Keypad Enter (76) shares its name with Return (36).
                assert!(stroke.code == code || name == "Enter", "{name}");
            }
        }
        for (code, name, _) in MODIFIER_KEYS {
            if let Some(injected) = modifier_key(name) {
                assert_eq!(injected, code, "{name}");
            }
        }
    }
}
