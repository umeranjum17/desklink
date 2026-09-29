import { describe, expect, it } from 'vitest';
import { hardwareKey } from './hardwareKeys';

const press = (usage: number, down: boolean, characters = '', modifiers: string[] = []) => ({ usage, down, characters, modifiers });

describe('hardwareKey', () => {
    it('sends named keys down and up with what is held', () => {
        const chords = new Set<number>();
        expect(hardwareKey(press(0x52, true), chords, false)).toEqual({ send: { kind: 'key', name: 'ArrowUp', modifiers: [], down: true } });
        expect(hardwareKey(press(0x29, false), chords, false)).toEqual({ send: { kind: 'key', name: 'Escape', modifiers: [], down: false } });
        expect(hardwareKey(press(0x58, true, '\r'), chords, false)).toEqual({ send: { kind: 'key', name: 'Enter', modifiers: [], down: true } });
        expect(hardwareKey(press(0x2b, true, '\t', ['Shift']), chords, false)).toEqual({ send: { kind: 'key', name: 'Tab', modifiers: ['Shift'], down: true } });
        expect(hardwareKey(press(0xe3, true, '', ['Meta']), chords, false)).toEqual({ send: { kind: 'key', name: 'Meta', modifiers: ['Meta'], down: true } });
    });

    it('sends a Command or Control chord as its key, and its release even after the modifier let go', () => {
        const chords = new Set<number>();
        // Cmd-C on a layout where that key types something else still names c.
        expect(hardwareKey(press(0x06, true, 'ç', ['Meta']), chords, false)).toEqual({ send: { kind: 'key', character: 'c', modifiers: ['Meta'], down: true } });
        expect(hardwareKey(press(0x06, false, 'c'), chords, false)).toEqual({ send: { kind: 'key', character: 'c', modifiers: [], down: false } });
        expect(chords.size).toBe(0);
        expect(hardwareKey(press(0x27, true, '0', ['Control']), chords, false)).toEqual({ send: { kind: 'key', character: '0', modifiers: ['Control'], down: true } });
    });

    it('types characters as text on the way down, including what Shift and Option compose', () => {
        const chords = new Set<number>();
        expect(hardwareKey(press(0x04, true, 'A', ['Shift']), chords, false)).toEqual({ send: { kind: 'text', text: 'A' } });
        expect(hardwareKey(press(0x04, false, 'A', ['Shift']), chords, false)).toBeNull();
        expect(hardwareKey(press(0x04, true, 'å', ['Alt']), chords, false)).toEqual({ send: { kind: 'text', text: 'å' } });
        expect(hardwareKey(press(0x2c, true, ' '), chords, false)).toEqual({ send: { kind: 'text', text: ' ' } });
        // A key that types nothing, or a private-use code, sends nothing.
        expect(hardwareKey(press(0x39, true, ''), chords, false)).toBeNull();
        expect(hardwareKey(press(0x68, true, ''), chords, false)).toBeNull();
    });

    it('hands plain keys and text to the session while a sticky modifier waits', () => {
        const chords = new Set<number>();
        expect(hardwareKey(press(0x28, true, '\r'), chords, true)).toEqual({ capture: { key: 'Enter' } });
        expect(hardwareKey(press(0x28, false, '\r'), chords, true)).toEqual({ send: { kind: 'key', name: 'Enter', modifiers: [], down: false } });
        expect(hardwareKey(press(0x19, true, 'v'), chords, true)).toEqual({ capture: { text: 'v' } });
        // A real modifier held on the hardware keyboard is its own chord.
        expect(hardwareKey(press(0x50, true, '', ['Shift']), chords, true)).toEqual({ send: { kind: 'key', name: 'ArrowLeft', modifiers: ['Shift'], down: true } });
    });
});
