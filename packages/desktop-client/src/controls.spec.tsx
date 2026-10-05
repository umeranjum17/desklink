import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The key row and the clipboard pill, rendered with `react-native` primitives as host strings. */
vi.mock('react-native', () => ({
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StatusBar: 'StatusBar',
    Text: 'Text',
    View: 'View',
    Settings: { get: () => 'ws://localhost/desktop?token=test' },
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }),
}));

const example = vi.hoisted(() => ({
    write: vi.fn(),
    copy: vi.fn(),
    connect: vi.fn(),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: example.write }));
vi.mock('@desklink/react-native', async () => ({
    CONTROL_PERMISSIONS: ['view', 'control', 'clipboard'],
    ClipboardConfirmation: (await import('./ClipboardConfirmation')).ClipboardConfirmation,
    ModifierKeys: (await import('./ModifierKeys')).ModifierKeys,
    DesktopView: 'DesktopView',
    useDesktopSession: () => ({
        snapshot: { status: 'live' },
        nativeId: 'example-session',
        modifiers: { Control: 'off', Shift: 'off', Alt: 'off', Meta: 'off' },
        clipboard: null,
        connect: example.connect,
        setInputEnabled: vi.fn(),
        copyRemoteToLocal: example.copy,
        tapModifier: vi.fn(),
    }),
}));

import { KEY_COLORS, ModifierKeys } from './ModifierKeys';
import { CLIPBOARD_CONFIRMATION_MS, ClipboardConfirmation, PILL_COLORS, describeTransfer } from './ClipboardConfirmation';
import { NO_MODIFIERS } from './stickyModifiers';
import type { ClipboardTransfer } from './useDesktopSession';
import App from '../example/App';

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
        expect(JSON.stringify(place)).toContain('Sent to desktop · “hello world”');

        act(() => { vi.advanceTimersByTime(CLIPBOARD_CONFIRMATION_MS - 1); });
        expect(tree.toJSON()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(1); });
        expect(tree.toJSON()).toBeNull();

        // The same text again is a new transfer and is confirmed again.
        act(() => { tree.update(<ClipboardConfirmation transfer={transfer(2)} />); });
        expect(tree.toJSON()).not.toBeNull();
    });

    it('describes where the text went and how it starts, with no byte count', () => {
        expect(describeTransfer({ id: 1, direction: 'to-phone', text: 'a\n  b', truncated: false })).toBe('Copied to phone · “a b”');
        expect(describeTransfer({ id: 1, direction: 'to-phone', text: 'x'.repeat(2048), truncated: true })).toBe(`Copied to phone · “${'x'.repeat(24)}…”`);
        expect(describeTransfer({ id: 1, direction: 'to-desktop', text: ' ', truncated: false })).toBe('Sent to desktop');
    });

    it('reads at 4.5:1 or better over a white or a black desktop', () => {
        expect(contrast(PILL_COLORS.text, PILL_COLORS.backing, '#ffffff')).toBeGreaterThanOrEqual(4.5);
        expect(contrast(PILL_COLORS.text, PILL_COLORS.backing, '#000000')).toBeGreaterThanOrEqual(4.5);
    });
});

describe('example Copy', () => {
    it('writes only on a tap and retains a backed accessible failure until the next tap', async () => {
        example.write.mockReset();
        example.copy.mockReset();
        example.copy.mockImplementation(async (write: (text: string) => Promise<void>) => { await write('desktop text'); });
        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => { tree = TestRenderer.create(<App />); });
        expect(example.write).not.toHaveBeenCalled();
        const tap = () => tree.root.findByProps({ testID: 'desklink-copy' }).props.onPress();

        example.copy.mockRejectedValueOnce(new Error('clipboard is unavailable for this desktop source'));
        await act(async () => { tap(); });
        expect(tree.root.findByProps({ testID: 'desklink-copy-error' }).findByType('Text').props.children)
            .toBe('Clipboard failed: clipboard is unavailable for this desktop source');
        expect(example.write).not.toHaveBeenCalled();

        example.write.mockResolvedValue(false);
        await act(async () => { tap(); });
        expect(example.write).toHaveBeenCalledWith('desktop text');
        const error = tree.root.findByProps({ testID: 'desklink-copy-error' });
        expect(error.props.accessible).toBe(true);
        expect(error.props.accessibilityRole).toBe('alert');
        expect(error.props.accessibilityLiveRegion).toBe('polite');
        const style = flatten(error.props.style);
        expect(style.paddingHorizontal).toBeGreaterThan(0);
        expect(style.paddingVertical).toBeGreaterThan(0);
        expect(contrast('#ffffff', style.backgroundColor as string)).toBeGreaterThanOrEqual(4.5);
        expect(error.findByType('Text').props.children).toBe('Clipboard failed: The phone refused the clipboard write.');
        expect(tree.root.findAllByProps({ testID: 'desklink-clipboard' })).toHaveLength(0);

        vi.useFakeTimers();
        try {
            act(() => { vi.advanceTimersByTime(5000); });
            expect(tree.root.findAllByProps({ testID: 'desklink-copy-error' })).toHaveLength(1);
        } finally { vi.useRealTimers(); }

        example.write.mockRejectedValue(new Error('native write refused'));
        await act(async () => { tap(); });
        expect(tree.root.findByProps({ testID: 'desklink-copy-error' }).findByType('Text').props.children).toBe('Clipboard failed: native write refused');

        let finish!: (written: boolean) => void;
        example.write.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        await act(async () => { tap(); });
        expect(tree.root.findAllByProps({ testID: 'desklink-copy-error' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'desklink-clipboard' })).toHaveLength(0);
        await act(async () => { finish(true); });
        expect(tree.root.findAllByProps({ testID: 'desklink-copy-error' })).toHaveLength(0);
        act(() => { tree.unmount(); });
    });
});
