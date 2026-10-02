import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { pictureBox } from '../test/picture-box.mjs';

/** `act` refuses to flush state updates unless React is told this is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Drives the real iOS view — its gestures, keyboard and control channel — and
 * reads the exact messages the desktop receives. Only the platform underneath
 * is stood in for: `react-native` primitives are host strings, the WebRTC
 * stack arrives through the bundler's lazy require, and the peer hands over a
 * data channel that records what it is asked to send. Behaviour here must
 * match `DesktopView.kt`.
 */

vi.mock('react-native', () => ({
    Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
    StyleSheet: { create: (styles: unknown) => styles },
    TextInput: 'TextInput',
    Image: 'Image',
    View: 'View',
}));

/** Whether the build carries the package's native input view; by default it stands for one without. */
const nativeInput = { installed: false };
vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: (name: string) => (nativeInput.installed && name === 'DesklinkInput' ? {} : null),
    requireNativeViewManager: () => 'DesklinkInput',
}));

// The bundler's inline require, standing in: it goes through the stubbed global so the spec sees when it runs.
vi.mock('./webrtc.ios', () => ({ requireWebRTC: () => (globalThis as unknown as { require: (id: string) => unknown }).require('react-native-webrtc') }));

class MockStream {
    addTrack = vi.fn();
    toURL() { return 'stream'; }
}
class MockPeer {
    ontrack?: (event: { track: { kind: string }; streams: never[] }) => void;
    ondatachannel?: (event: { channel: unknown }) => void;
    oniceconnectionstatechange?: () => void;
    iceConnectionState = 'new';
    localDescription = { sdp: 'answer' };
    setRemoteDescription = vi.fn(async () => undefined);
    addIceCandidate = vi.fn(async () => undefined);
    createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }));
    setLocalDescription = vi.fn(async () => undefined);
    close = vi.fn();
    constructor() { peers.push(this); }
}
const peers: MockPeer[] = [];
function MockRTCView() { return null; }

/** What the bundler's lazy require handed out, in order. */
const required: string[] = [];

const BOUNDS = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };
// Most of this spec works on the whole desktop (`whole: true`, as after
// `fitToView()`): fit = min(390/1280, 844/720); the picture is 390 wide,
// centred vertically.
const SCALE = Math.min(BOUNDS.width / DESKTOP.width, BOUNDS.height / DESKTOP.height);
const ORIGIN_Y = (BOUNDS.height - DESKTOP.height * SCALE) / 2;

type Touch = { locationX: number; locationY: number; timestamp?: number };
function touch(x: number, y: number, timestamp?: number): Touch { return { locationX: x, locationY: y, timestamp }; }

async function openView(options: { gestures?: 'desktop' | 'browser' | 'device'; accessibilityLabel?: string; native?: boolean; whole?: boolean; desktop?: { width: number; height: number }; bounds?: { width: number; height: number }; insets?: { top: number; left: number; bottom: number; right: number } } = {}) {
    nativeInput.installed = options.native === true;
    const { desktopInputEnabled, nativeDesklink } = await import('./native.ios');
    const { DesktopView } = await import('./DesktopView.ios');
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)!;
    const sent: Record<string, unknown>[] = [];
    peer.ondatachannel!({
        channel: { readyState: 'open', send: (value: string) => { sent.push(JSON.parse(value)); }, close: () => undefined },
    });
    nativeDesklink.setInputEnabled(id, true);
    expect(desktopInputEnabled(id)).toBe(true);
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(
            <DesktopView sessionId={id} gestures={options.gestures} accessibilityLabel={options.accessibilityLabel} insets={options.insets} />,
        );
    });
    const outer = () => renderer!.root.findByType(options.native ? 'DesklinkInput' as never : 'View').props as {
        onLayout: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
        onResponderGrant: (event: { nativeEvent: { touches: Touch[] } }) => void;
        onResponderMove: (event: { nativeEvent: { touches: Touch[] } }) => void;
        onResponderRelease: (event: { nativeEvent: { touches: Touch[] } }) => void;
        [key: string]: unknown;
    };
    TestRenderer.act(() => {
        outer().onLayout({ nativeEvent: { layout: { ...(options.bounds ?? BOUNDS) } } });
        nativeDesklink.setSurfaceSize(id, (options.desktop ?? DESKTOP).width, (options.desktop ?? DESKTOP).height);
        peer.ontrack!({ track: { kind: 'video' }, streams: [] });
    });
    if (options.whole ?? true) TestRenderer.act(() => { nativeDesklink.fitToView(id); });
    const grant = (at: Touch[]) => TestRenderer.act(() => { outer().onResponderGrant({ nativeEvent: { touches: at } }); });
    const move = (at: Touch[]) => TestRenderer.act(() => { outer().onResponderMove({ nativeEvent: { touches: at } }); });
    const release = (at: Touch[] = []) => TestRenderer.act(() => { outer().onResponderRelease({ nativeEvent: { touches: at } }); });
    const submit = () => TestRenderer.act(() => {
        renderer!.root.findByType('TextInput').props.onSubmitEditing();
    });
    const rtcStyle = () => renderer!.root.findByType(MockRTCView).props.style as { left: number; top: number; width: number; height: number };
    /** What the native input view reports, as its events. */
    const native = {
        key: (usage: number, down: boolean, characters = '', modifiers: string[] = []) => TestRenderer.act(() => {
            (outer().onKey as (event: unknown) => void)({ nativeEvent: { usage, down, characters, modifiers } });
        }),
        pointer: (phase: string, x: number, y: number, buttons = 0, timestamp?: number) => TestRenderer.act(() => {
            (outer().onPointer as (event: unknown) => void)({ nativeEvent: { phase, x, y, buttons, timestamp } });
        }),
        wheel: (phase: string, dx: number, dy: number, x = 195, y = 420) => TestRenderer.act(() => {
            (outer().onWheel as (event: unknown) => void)({ nativeEvent: { phase, dx, dy, x, y } });
        }),
    };
    return { id, nativeDesklink, renderer: renderer!, sent, outer, grant, move, release, submit, rtcStyle, native };
}

beforeEach(() => {
    peers.length = 0;
    required.length = 0;
    // The device bundler evaluates `react-native-webrtc` on first require;
    // nothing in this package may require it at import time.
    vi.stubGlobal('require', (mod: string) => {
        required.push(mod);
        if (mod === 'react-native-webrtc') return { MediaStream: MockStream, RTCPeerConnection: MockPeer, RTCView: MockRTCView };
        throw new Error(`unexpected require: ${mod}`);
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('DesktopView.ios parity with DesktopView.kt', () => {
    it('fits portrait width, then zooms and pans without distorting the desktop', async () => {
        const { sent, rtcStyle, grant, move, release } = await openView({ whole: false });
        expect(rtcStyle()).toMatchObject({ left: 0, top: 0, width: BOUNDS.width });
        expect(rtcStyle().height).toBeCloseTo(DESKTOP.height * SCALE, 5);
        grant([touch(100, 100)]);
        move([touch(100, 100), touch(140, 100)]);
        move([touch(80, 100), touch(160, 100)]);
        release();
        const before = rtcStyle();
        expect(before.width / before.height).toBeCloseTo(DESKTOP.width / DESKTOP.height, 5);
        grant([touch(260, 400)]);
        move([touch(200, 400)]);
        release();
        expect(sent.filter((message) => message.kind === 'pointer')).toEqual([]);
        expect(rtcStyle().left).toBeCloseTo(before.left - 60, 5);
        const at = rtcStyle();
        grant([touch(100, 300)]);
        release();
        expect(sent.filter((message) => message.kind === 'pointer')).toMatchObject([
            { kind: 'pointer', phase: 'down', x: Math.floor((100 - at.left) / (SCALE * 2)), y: Math.floor((300 - at.top) / (SCALE * 2)), button: 1 },
            { kind: 'pointer', phase: 'up', x: Math.floor((100 - at.left) / (SCALE * 2)), y: Math.floor((300 - at.top) / (SCALE * 2)), button: 1 },
        ]);
    });

    it('pans a tall portrait desktop to both vertical edges at fit-width', async () => {
        const insets = { top: 47, left: 0, bottom: 21, right: 0 };
        const { rtcStyle, grant, move, release } = await openView({ whole: false, insets, desktop: { width: 720, height: 1800 } });
        expect(rtcStyle().width).toBeCloseTo(390, 5);
        expect(rtcStyle().top).toBeCloseTo(47, 5);
        grant([touch(200, 400)]);
        move([touch(200, -2000)]);
        release();
        expect(rtcStyle().top + rtcStyle().height).toBeCloseTo(823, 5);
        grant([touch(200, 400)]);
        move([touch(200, 2000)]);
        release();
        expect(rtcStyle().top).toBeCloseTo(47, 5);
    });

    it('starts again at the top-left corner after a rotation, and keeps the whole desktop when the same size is reported again', async () => {
        const { id, nativeDesklink, outer, rtcStyle, grant, move, release } = await openView({ whole: false });
        grant([touch(260, 400)]);
        move([touch(200, 400)]);
        release();
        expect(rtcStyle().left).toBeCloseTo(0, 5);
        const layout = (bounds: { width: number; height: number }) => TestRenderer.act(() => {
            (outer().onLayout as (event: unknown) => void)({ nativeEvent: { layout: bounds } });
        });
        layout({ width: BOUNDS.height, height: BOUNDS.width });
        // Landscape crops the bottom, never the top.
        expect(rtcStyle().top).toBeCloseTo(0, 5);
        expect(rtcStyle().left).toBeCloseTo(0, 5);
        layout(BOUNDS);
        expect(rtcStyle().left).toBeCloseTo(0, 5);
        TestRenderer.act(() => { nativeDesklink.fitToView(id); });
        TestRenderer.act(() => { nativeDesklink.setSurfaceSize(id, DESKTOP.width, DESKTOP.height); });
        expect(rtcStyle().width).toBeCloseTo(BOUNDS.width, 5);
    });

    it('resets both default offsets on equal-scale layout and inset changes', async () => {
        const { DesktopView } = await import('./DesktopView.ios');
        const insets = { top: 0, left: 47, bottom: 21, right: 47 };
        const { id, renderer, outer, rtcStyle, grant, move, release } = await openView({ whole: false, bounds: { width: 844, height: 390 }, insets });
        const pan = () => {
            grant([touch(400, 200)]);
            move([touch(340, 140)]);
            release();
        };
        const width = rtcStyle().width;
        pan();
        expect(rtcStyle().left).toBeLessThan(47);
        expect(rtcStyle().top).toBeLessThan(0);
        TestRenderer.act(() => { outer().onLayout({ nativeEvent: { layout: { width: 844, height: 400 } } }); });
        expect(rtcStyle()).toMatchObject({ left: 47, top: 0, width });
        pan();
        TestRenderer.act(() => { renderer.update(<DesktopView sessionId={id} insets={{ top: 10, left: 50, right: 44, bottom: 21 }} />); });
        expect(rtcStyle()).toMatchObject({ left: 50, top: 10, width });
    });

    it('starts and pans inside the insets while the picture still reaches under them', async () => {
        const landscape = { width: 844, height: 390 };
        const insets = { top: 0, left: 47, bottom: 21, right: 47 };
        const { rtcStyle, grant, move, release } = await openView({ whole: false, bounds: landscape, insets });
        const fill = Math.max(landscape.width / DESKTOP.width, landscape.height / DESKTOP.height);
        expect(rtcStyle().width).toBeCloseTo(DESKTOP.width * fill, 5);
        // The desktop's top-left corner shows just inside the cutout's side.
        expect(rtcStyle().left).toBeCloseTo(47, 5);
        expect(rtcStyle().top).toBeCloseTo(0, 5);
        // Panned all the way, the desktop's right and bottom edges reach the
        // uncovered part's edges, not the screen's.
        grant([touch(600, 300)]);
        move([touch(-2000, -2000)]);
        release();
        expect(rtcStyle().left + rtcStyle().width).toBeCloseTo(landscape.width - 47, 5);
        expect(rtcStyle().top + rtcStyle().height).toBeCloseTo(landscape.height - 21, 5);
        for (const x of [-2000, 2000]) for (const y of [-2000, 2000]) {
            grant([touch(400, 200)]);
            move([touch(x, y)]);
            release();
            const box = rtcStyle();
            const width = Math.min(landscape.width, box.left + box.width) - Math.max(0, box.left);
            const height = Math.min(landscape.height, box.top + box.height) - Math.max(0, box.top);
            expect(1 - width * height / (landscape.width * landscape.height)).toBeLessThan(0.15);
            expect(box.width / box.height).toBeCloseTo(DESKTOP.width / DESKTOP.height, 5);
        }

    });

    it('leaves no black bars on a landscape phone, and fitToView shows the whole desktop', async () => {
        const landscape = { width: 844, height: 390 };
        const { id, nativeDesklink, rtcStyle } = await openView({ whole: false, bounds: landscape });
        expect(rtcStyle().width).toBeCloseTo(landscape.width, 5);
        expect(rtcStyle().left).toBeCloseTo(0, 5);
        TestRenderer.act(() => { nativeDesklink.fitToView(id); });
        expect(rtcStyle().height).toBeCloseTo(landscape.height, 5);
        expect(rtcStyle().width).toBeCloseTo(DESKTOP.width * landscape.height / DESKTOP.height, 5);
    });

    it('ignores a one-finger drag that starts in the letterbox', async () => {
        const { sent, grant, move, release } = await openView();
        // y = 10 is above the fitted picture (it starts at ORIGIN_Y).
        grant([touch(10, 10)]);
        move([touch(50, 50)]);
        release();
        expect(sent.filter((message) => message.kind === 'pointer')).toEqual([]);
        // Sanity: the same drag on the picture carries the pointer.
        grant([touch(195, 420)]);
        move([touch(250, 430)]);
        release();
        expect(sent.filter((message) => message.kind === 'pointer' && message.phase === 'move')).not.toEqual([]);
    });

    it('zooms around the pinch focus and re-clamps after zooming out', async () => {
        const { rtcStyle, grant, move } = await openView();
        grant([touch(100, 400)]);
        move([touch(100, 400), touch(140, 400)]);
        move([touch(80, 400), touch(160, 400)]);
        expect(rtcStyle().width).toBeCloseTo(DESKTOP.width * SCALE * 2, 0);
        // The desktop point under the focus (120, 400) stays under it.
        expect(rtcStyle().left).toBeCloseTo(-120, 0);
        // Pinching back to 1x recentres: no stale offset left behind.
        move([touch(100, 400), touch(140, 400)]);
        expect(rtcStyle().width).toBeCloseTo(BOUNDS.width, 0);
        expect(rtcStyle().left).toBeCloseTo(0, 5);
    });

    it('accumulates wheel below the send threshold and moves the pointer to the scroll focus', async () => {
        const { sent, grant, move, release } = await openView();
        grant([touch(190, 420)]);
        move([touch(190, 420), touch(200, 420)]);
        move([touch(192, 421), touch(202, 421)]);
        move([touch(194, 422), touch(204, 422)]);
        move([touch(196, 423), touch(206, 423)]);
        // The last step crosses the slop into a scroll, but its own single
        // pixel stays below the 0.05 detent threshold: held back.
        move([touch(197, 424), touch(207, 424)]);
        const wheels = () => sent.filter((message) => message.kind === 'wheel');
        expect(wheels()).toEqual([]);
        // A second pixel crosses it: one fractional wheel step goes out.
        move([touch(198, 424), touch(208, 424)]);
        expect(wheels()).toHaveLength(1);
        expect(wheels()[0].dx).toBeCloseTo(-2 / SCALE / 120, 5);
        expect(wheels()[0].dy).toBeCloseTo(-1 / SCALE / 120, 5);
        // The desktop scrolled whatever was under its pointer.
        expect(sent.filter((message) => message.kind === 'pointer' && message.phase === 'move')).not.toEqual([]);
        release();
    });

    it('releases a held device drag when the profile switches away', async () => {
        const first = await openView({ gestures: 'device' });
        first.grant([touch(195, 420)]);
        expect(first.sent.at(-1)).toMatchObject({ kind: 'pointer', phase: 'down', button: 1 });
        const { DesktopView } = await import('./DesktopView.ios');
        TestRenderer.act(() => {
            first.renderer.update(<DesktopView sessionId={first.id} gestures="desktop" />);
        });
        expect(first.sent.at(-1)).toMatchObject({ kind: 'release_all' });
    });

    it('sends Enter through capture while a sticky modifier is held', async () => {
        const { id, nativeDesklink, sent, submit } = await openView();
        const keys: Record<string, unknown>[] = [];
        const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
            if (event.sessionId === id && event.name === 'keyboard') keys.push(event.payload);
        });
        nativeDesklink.captureKeyboard(id, true);
        submit();
        listener.remove();
        expect(keys).toEqual([{ key: 'Enter' }]);
        expect(sent.filter((message) => message.kind === 'key')).toEqual([]);
    });

    it('puts the cursor mark tip on the pointer with a hotspot', async () => {
        const { renderer, sent, grant, move, release } = await openView();
        grant([touch(195, 420)]);
        move([touch(250, 430)]);
        const image = renderer.root.findByType('Image');
        const cursor = image.props.style as unknown[];
        const mark = cursor[1] as { left: number; top: number };
        const desktop = { x: Math.floor(250 / SCALE), y: Math.floor((430 - ORIGIN_Y) / SCALE) };
        expect(mark.left).toBeCloseTo((desktop.x + 0.5) * SCALE - 3, 1);
        expect(mark.top).toBeCloseTo(ORIGIN_Y + (desktop.y + 0.5) * SCALE - 3, 1);
        expect(image.props.accessible).toBe(false);
        expect(image.props.pointerEvents).toBe('none');
        release();
        grant([touch(mark.left + 3, mark.top + 3)]);
        release();
        expect(sent.filter((message) => message.kind === 'pointer').slice(-2)).toMatchObject([
            { kind: 'pointer', phase: 'down', ...desktop, button: 1 },
            { kind: 'pointer', phase: 'up', ...desktop, button: 1 },
        ]);
    });

    it('exposes the surface to VoiceOver only with a label', async () => {
        const labelled = await openView({ accessibilityLabel: 'Desktop' });
        expect(labelled.outer().accessible).toBe(true);
        const unlabelled = await openView();
        expect(unlabelled.outer().accessible).toBe(false);
        expect(unlabelled.renderer.root.findByType('TextInput').props.accessible).toBe(false);
    });

    it('keeps WebRTC out of the import and loads it on first render', async () => {
        vi.resetModules();
        await import('./DesktopView.ios');
        expect(required).not.toContain('react-native-webrtc');
        await openView();
        expect(required).toContain('react-native-webrtc');
    });
});

describe('DesktopView.ios hardware keyboard and pointer', () => {
    /** Desktop pixels under a point of the view. */
    const pixel = (x: number, y: number) => ({ x: Math.floor(x / SCALE), y: Math.floor((y - ORIGIN_Y) / SCALE) });
    const pointers = (sent: Record<string, unknown>[]) => sent.filter((message) => message.kind === 'pointer')
        .map(({ phase, x, y, button }) => ({ phase, x, y, button }));

    it('keeps a plain view where the build has no native input view', async () => {
        const { renderer } = await openView();
        expect(renderer.root.findAllByType('DesklinkInput' as never)).toEqual([]);
    });

    it('arms the native view only while control is enabled', async () => {
        const { id, nativeDesklink, outer } = await openView({ native: true });
        expect(outer().enabled).toBe(true);
        TestRenderer.act(() => { nativeDesklink.setInputEnabled(id, false); });
        expect(outer().enabled).toBe(false);
    });

    it('sends arrows, Esc, Tab and a Command chord from the hardware keyboard', async () => {
        const { sent, native } = await openView({ native: true });
        native.key(0x52, true); native.key(0x52, false);
        native.key(0x29, true); native.key(0x29, false);
        native.key(0x2b, true, '\t'); native.key(0x2b, false, '\t');
        native.key(0xe3, true, '', ['Meta']);
        native.key(0x06, true, 'c', ['Meta']);
        native.key(0x06, false, 'c', ['Meta']);
        native.key(0xe3, false);
        native.key(0x0b, true, 'h'); native.key(0x0b, false, 'h');
        expect(sent.map(({ seq: _seq, ...message }) => message)).toEqual([
            { kind: 'key', name: 'ArrowUp', modifiers: [], down: true }, { kind: 'key', name: 'ArrowUp', modifiers: [], down: false },
            { kind: 'key', name: 'Escape', modifiers: [], down: true }, { kind: 'key', name: 'Escape', modifiers: [], down: false },
            { kind: 'key', name: 'Tab', modifiers: [], down: true }, { kind: 'key', name: 'Tab', modifiers: [], down: false },
            { kind: 'key', name: 'Meta', modifiers: ['Meta'], down: true },
            { kind: 'key', character: 'c', modifiers: ['Meta'], down: true }, { kind: 'key', character: 'c', modifiers: ['Meta'], down: false },
            { kind: 'key', name: 'Meta', modifiers: [], down: false },
            { kind: 'text', text: 'h' },
        ]);
    });

    it('hands hardware keys to the session while a sticky modifier waits', async () => {
        const { id, nativeDesklink, sent, native } = await openView({ native: true });
        const keys: Record<string, unknown>[] = [];
        const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
            if (event.sessionId === id && event.name === 'keyboard') keys.push(event.payload);
        });
        nativeDesklink.captureKeyboard(id, true);
        native.key(0x19, true, 'v');
        native.key(0x28, true, '\r');
        listener.remove();
        expect(keys).toEqual([{ text: 'v' }, { key: 'Enter' }]);
        expect(sent).toEqual([]);
    });

    it('hovers the desktop pointer without a button or a drawn mark, and not from the letterbox', async () => {
        const { sent, native, renderer } = await openView({ native: true });
        native.pointer('hover', 10, 10);
        native.pointer('hover', 200, 400);
        expect(pointers(sent)).toEqual([{ phase: 'move', ...pixel(200, 400), button: undefined }]);
        // The system draws the trackpad's own pointer.
        expect(renderer.root.findAllByType('View')).toEqual([]);
    });

    it('drags with a trackpad press the native view reported before touch saw it', async () => {
        const { sent, native, grant, move, release } = await openView({ native: true });
        native.pointer('down', 100, 400, 1, 5000);
        grant([touch(100, 400, 5000)]);
        native.pointer('move', 160, 410, 1);
        move([touch(160, 410, 5010)]);
        native.pointer('up', 160, 410, 0);
        release();
        expect(pointers(sent)).toEqual([
            { phase: 'down', ...pixel(100, 400), button: 1 },
            { phase: 'move', ...pixel(160, 410), button: 1 },
            { phase: 'up', ...pixel(160, 410), button: 1 },
        ]);
    });

    it('right-clicks with a secondary press touch saw first, and no long press follows', async () => {
        vi.useFakeTimers();
        try {
            const { sent, native, grant, release } = await openView({ native: true });
            grant([touch(100, 400, 6000)]);
            native.pointer('down', 100, 400, 2, 6000);
            TestRenderer.act(() => { vi.advanceTimersByTime(600); });
            native.pointer('up', 100, 400, 0);
            release();
            expect(pointers(sent)).toEqual([
                { phase: 'down', ...pixel(100, 400), button: 3 },
                { phase: 'up', ...pixel(100, 400), button: 3 },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not press twice when a device-profile touch already pressed for the trackpad', async () => {
        const { sent, native, grant, release } = await openView({ native: true, gestures: 'device' });
        grant([touch(100, 400, 7000)]);
        native.pointer('down', 100, 400, 1, 7000);
        native.pointer('up', 100, 400, 0);
        release();
        expect(pointers(sent)).toEqual([
            { phase: 'down', ...pixel(100, 400), button: 1 },
            { phase: 'up', ...pixel(100, 400), button: 1 },
        ]);
    });

    it('scrolls the desktop under the pointer with a trackpad, content following the fingers', async () => {
        const { sent, native } = await openView({ native: true });
        native.wheel('begin', 0, -30, 200, 400);
        native.wheel('move', 0, -0.01, 200, 400);
        native.wheel('end', 0, 0, 200, 400);
        expect(pointers(sent)).toEqual([{ phase: 'move', ...pixel(200, 400), button: undefined }]);
        const wheels = sent.filter((message) => message.kind === 'wheel');
        expect(wheels).toHaveLength(2);
        expect(wheels[0].dy).toBeCloseTo(30 / SCALE / 120, 5);
        // What stayed below the send threshold goes out when the scroll ends.
        expect(wheels[1].dy).toBeCloseTo(0.01 / SCALE / 120, 5);
    });
});


describe('iOS proof picture bounds', () => {
    it('measures contiguous paper without including the disconnected home indicator', () => {
        for (const density of [1, 3]) {
            const png = { width: 390 * density, height: 844 * density, data: new Uint8Array(390 * 844 * density * density * 4) };
            const paper = (left: number, top: number, right: number, bottom: number) => {
                for (let y = top * density; y < bottom * density; y++) for (let x = left * density; x < right * density; x++) {
                    const i = (y * png.width + x) * 4;
                    png.data.set([251, 250, 247, 255], i);
                }
            };
            paper(0, 47, 390, 266);
            paper(125, 825, 265, 830);
            expect(pictureBox(png, 390)).toEqual({ top: 47, left: 0, bottom: 266 });
            png.data.fill(0);
            paper(0, 203, 390, 642);
            paper(125, 825, 265, 830);
            expect(pictureBox(png, 390)).toEqual({ top: 203, left: 0, bottom: 642 });
            png.data.fill(0);
            paper(47, 0, 390, 844);
            expect(pictureBox(png, 390)).toEqual({ top: 0, left: 47, bottom: 844 });
        }
    });
});
