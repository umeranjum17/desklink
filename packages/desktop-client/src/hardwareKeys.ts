import type { ControlMessage } from './protocol';

/** A hardware key as the iOS input view reports it: its HID usage, the characters it types, and what is held. */
export type HardwareKey = { usage: number; down: boolean; characters: string; modifiers: string[] };

/** What a key press does: a control message, or a key or text for the session's sticky modifiers. */
export type HardwareKeyAction = { send: ControlMessage } | { capture: { key: string } | { text: string } };

/** Keys with no character of their own, by HID keyboard usage, in the engine's names. */
const NAMED: Record<number, string> = {
    0x28: 'Enter', 0x29: 'Escape', 0x2a: 'Backspace', 0x2b: 'Tab', 0x58: 'Enter',
    0x3a: 'F1', 0x3b: 'F2', 0x3c: 'F3', 0x3d: 'F4', 0x3e: 'F5', 0x3f: 'F6',
    0x40: 'F7', 0x41: 'F8', 0x42: 'F9', 0x43: 'F10', 0x44: 'F11', 0x45: 'F12',
    0x4a: 'Home', 0x4b: 'PageUp', 0x4c: 'Delete', 0x4d: 'End', 0x4e: 'PageDown',
    0x4f: 'ArrowRight', 0x50: 'ArrowLeft', 0x51: 'ArrowDown', 0x52: 'ArrowUp',
    0xe0: 'Control', 0xe1: 'Shift', 0xe2: 'Alt', 0xe3: 'Meta',
    0xe4: 'ControlRight', 0xe5: 'ShiftRight', 0xe6: 'AltGraph', 0xe7: 'MetaRight',
};
const MODIFIERS = new Set(['Control', 'ControlRight', 'Shift', 'ShiftRight', 'Alt', 'AltGraph', 'Meta', 'MetaRight']);

/** The letter or digit a key stands for where it sits, whatever the layout types: a chord names a key. */
function chordCharacter(usage: number): string | undefined {
    if (usage >= 0x04 && usage <= 0x1d) return String.fromCharCode(0x61 + usage - 0x04);
    if (usage >= 0x1e && usage <= 0x26) return String(usage - 0x1d);
    if (usage === 0x27) return '0';
    return undefined;
}

/** Control characters and the private-use codes UIKit gives keys like F13 type nothing. */
const TYPES_NOTHING = /[\u0000-\u001f\u007f-]/;

/**
 * Turn one hardware key into what the desktop receives, as the web and Android
 * receivers do: named keys and modifiers travel as key events with what is
 * held, Control and Command chords as the key's own letter or digit, and
 * anything else as the text it types. `chordsDown` remembers the chord keys
 * still down, so a chord's key-up is sent even when its modifier let go first.
 */
export function hardwareKey(key: HardwareKey, chordsDown: Set<number>, captured: boolean): HardwareKeyAction | null {
    const { usage, down, modifiers } = key;
    const name = NAMED[usage];
    if (name !== undefined) {
        // A plain key pressed while a sticky modifier waits is the session's to
        // chord. Only the press is held back: a release still goes, so a key
        // that was down before the capture cannot stick.
        if (captured && down && modifiers.length === 0 && !MODIFIERS.has(name)) return { capture: { key: name } };
        return { send: { kind: 'key', name, modifiers, down } };
    }
    const character = chordCharacter(usage);
    if (character !== undefined) {
        // Alt alone is not a chord: Option composes a character with the layout.
        if ((modifiers.includes('Control') || modifiers.includes('Meta')) && (down || chordsDown.has(usage))) {
            if (down) chordsDown.add(usage);
            else chordsDown.delete(usage);
            return { send: { kind: 'key', character, modifiers, down } };
        }
        if (!down && chordsDown.delete(usage)) return { send: { kind: 'key', character, modifiers: [], down: false } };
    }
    if (!down || key.characters === '' || TYPES_NOTHING.test(key.characters)) return null;
    return captured ? { capture: { text: key.characters } } : { send: { kind: 'text', text: key.characters } };
}
