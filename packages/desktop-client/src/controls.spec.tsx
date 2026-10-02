import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The key row and the clipboard pill, rendered with `react-native` primitives as host strings. */
vi.mock('react-native', () => ({
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));

import { KEY_COLORS, ModifierKeys } from './ModifierKeys';
import { CLIPBOARD_CONFIRMATION_MS, ClipboardConfirmation, PILL_COLORS, describeTransfer } from './ClipboardConfirmation';
import { NO_MODIFIERS } from './stickyModifiers';
import type { ClipboardTransfer } from './useDesktopSession';

type Style = Record<string, unknown>;
const flatten = (style: unknown): Style =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ? (style as Style) : {};

/** WCAG contrast of two colours, the first drawn with its alpha over `under`. */
function contrast(top: string, bottom: string, under = '#000000'): number {
    const rgba = (c: string) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (m) { const [r, g, b, a = 1] = m[1].split(',').map(Number); return [r, g, b, a]; }
        return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).concat(1);
    };
    const over = (c: string) => {
        const [r, g, b, a] = rgba(c);
        const [ur, ug, ub] = rgba(under);
        return [r * a + ur * (1 - a), g * a + ug * (1 - a), b * a + ub * (1 - a)];
    };
    const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [l1, l2] = [lum(over(top)), lum(over(bottom))].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
}

describe('ModifierKeys', () => {
    function render(modifiers = NO_MODIFIERS, onTap = vi.fn()) {
        let tree!: TestRenderer.ReactTestRenderer;
        act(() => { tree = TestRenderer.create(<ModifierKeys modifiers={modifiers} onTap={onTap} />); });
        const key = (name: string) => tree.root.find((node) => node.props.testID === `desklink-key-${name}`);
        return { key, onTap };
    }

    it('draws off, latched and locked as three different keys and names each state', () => {
        const { key } = render({ Control: 'off', Shift: 'once', Alt: 'lock', Meta: 'off' });
        const look = (name: string) => {
            const node = key(name);
            const [, bar] = node.props.children;
            return { key: flatten(node.props.style), bar: flatten(bar.props.style), said: node.props.accessibilityValue.text };
        };
        const off = look('Control');
        const latched = look('Shift');
        const locked = look('Alt');
        expect([off.said, latched.said, locked.said]).toEqual(['off', 'latched', 'locked']);
        expect(off.key.backgroundColor).not.toBe(latched.key.backgroundColor);
        // Latched and locked share a fill and differ in shape: the rim and the bar.
        expect(locked.key.borderColor).not.toBe(latched.key.borderColor);
        expect(locked.bar.backgroundColor).not.toBe(latched.bar.backgroundColor);
        expect(key('Control').props.accessibilityState).toEqual({ selected: false });
        expect(key('Shift').props.accessibilityState).toEqual({ selected: true });
    });

    it('hands a tap to the session', () => {
        const { key, onTap } = render();
        key('Control').props.onPress();
        expect(onTap).toHaveBeenCalledWith('Control');
    });

    it('keeps every label at 4.5:1 or better', () => {
        expect(contrast(KEY_COLORS.offLabel, KEY_COLORS.off)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(KEY_COLORS.onLabel, KEY_COLORS.on)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('ClipboardConfirmation', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const transfer = (id: number, text = 'hello world'): ClipboardTransfer => ({ id, direction: 'to-desktop', text, truncated: false });

    it('shows each transfer, ignores touches, and goes away after about 1.5 s', () => {
        let tree!: TestRenderer.ReactTestRenderer;
        act(() => { tree = TestRenderer.create(<ClipboardConfirmation transfer={null} />); });
        expect(tree.toJSON()).toBeNull();

        act(() => { tree.update(<ClipboardConfirmation transfer={transfer(1)} />); });
        const place = tree.toJSON() as TestRenderer.ReactTestRendererJSON;
        expect(place.props.pointerEvents).toBe('none');
        expect(flatten(place.props.style).position).toBeUndefined();
        expect(JSON.stringify(place)).toContain('Sent to desktop · “hello world” · 11 B');

        act(() => { vi.advanceTimersByTime(CLIPBOARD_CONFIRMATION_MS - 1); });
        expect(tree.toJSON()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(1); });
        expect(tree.toJSON()).toBeNull();

        // The same text again is a new transfer and is confirmed again.
        act(() => { tree.update(<ClipboardConfirmation transfer={transfer(2)} />); });
        expect(tree.toJSON()).not.toBeNull();
    });

    it('describes where the text went, how it starts and how big it is', () => {
        expect(describeTransfer({ id: 1, direction: 'to-phone', text: 'a\n  b', truncated: false })).toBe('Copied to phone · “a b” · 5 B');
        expect(describeTransfer({ id: 1, direction: 'to-phone', text: 'x'.repeat(2048), truncated: true })).toBe(`Copied to phone · “${'x'.repeat(24)}…” · 2.0 KB+`);
        expect(describeTransfer({ id: 1, direction: 'to-desktop', text: ' ', truncated: false })).toBe('Sent to desktop · 1 B');
    });

    it('reads at 4.5:1 or better over a white or a black desktop', () => {
        expect(contrast(PILL_COLORS.text, PILL_COLORS.backing, '#ffffff')).toBeGreaterThanOrEqual(4.5);
        expect(contrast(PILL_COLORS.text, PILL_COLORS.backing, '#000000')).toBeGreaterThanOrEqual(4.5);
    });
});
