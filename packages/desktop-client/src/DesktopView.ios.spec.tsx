import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

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
    View: 'View',
}));

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
// fit = min(390/1280, 844/720); the picture is 390 wide, centred vertically.
const SCALE = Math.min(BOUNDS.width / DESKTOP.width, BOUNDS.height / DESKTOP.height);
const ORIGIN_Y = (BOUNDS.height - DESKTOP.height * SCALE) / 2;

type Touch = { locationX: number; locationY: number };
function touch(x: number, y: number): Touch { return { locationX: x, locationY: y }; }

async function openView(options: { gestures?: 'desktop' | 'browser' | 'device'; accessibilityLabel?: string } = {}) {
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
            <DesktopView sessionId={id} gestures={options.gestures} accessibilityLabel={options.accessibilityLabel} />,
        );
    });
    const outer = () => renderer!.root.findByType('View').props as {
        onLayout: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
        onResponderGrant: (event: { nativeEvent: { touches: Touch[] } }) => void;
        onResponderMove: (event: { nativeEvent: { touches: Touch[] } }) => void;
        onResponderRelease: (event: { nativeEvent: { touches: Touch[] } }) => void;
        [key: string]: unknown;
    };
    TestRenderer.act(() => {
        outer().onLayout({ nativeEvent: { layout: { ...BOUNDS } } });
        nativeDesklink.setSurfaceSize(id, DESKTOP.width, DESKTOP.height);
        peer.ontrack!({ track: { kind: 'video' }, streams: [] });
    });
    const grant = (at: Touch[]) => TestRenderer.act(() => { outer().onResponderGrant({ nativeEvent: { touches: at } }); });
    const move = (at: Touch[]) => TestRenderer.act(() => { outer().onResponderMove({ nativeEvent: { touches: at } }); });
    const release = (at: Touch[] = []) => TestRenderer.act(() => { outer().onResponderRelease({ nativeEvent: { touches: at } }); });
    const submit = () => TestRenderer.act(() => {
        renderer!.root.findByType('TextInput').props.onSubmitEditing();
    });
    const rtcStyle = () => renderer!.root.findByType(MockRTCView).props.style as { left: number; top: number; width: number; height: number };
    return { id, nativeDesklink, renderer: renderer!, sent, outer, grant, move, release, submit, rtcStyle };
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
        const { renderer, grant, move } = await openView();
        grant([touch(195, 420)]);
        move([touch(250, 430)]);
        const cursor = renderer.root.findAllByType('View')[1].props.style as unknown[];
        const mark = cursor[1] as { left: number; top: number };
        const desktop = { x: Math.floor(250 / SCALE), y: Math.floor((430 - ORIGIN_Y) / SCALE) };
        expect(mark.left).toBeCloseTo((desktop.x + 0.5) * SCALE - 3, 1);
        expect(mark.top).toBeCloseTo(ORIGIN_Y + (desktop.y + 0.5) * SCALE - 3, 1);
        expect(renderer.root.findAllByType('View')[1].props.accessible).toBe(false);
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
