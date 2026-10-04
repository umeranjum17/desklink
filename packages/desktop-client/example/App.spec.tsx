import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate as tick } from 'node:timers/promises';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { SessionSnapshot } from '../src/protocol';
import App, { statusText } from './App';

/** `act` refuses to flush state updates unless React is told this is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The example app's status line as a person sees it: the real app, the real
 * session hook and the real bridge signaling, over a socket that stands in for
 * the bridge. Its launch URL carries a pairing token, which no status may show.
 */

const { BRIDGE_URL } = vi.hoisted(() => ({ BRIDGE_URL: 'ws://127.0.0.1:47317/desktop?token=demo-pairing-secret' }));

type NativeSessionEvent = { sessionId: string; name: string; payload: Record<string, unknown> };
const nativeListeners = new Set<(event: NativeSessionEvent) => void>();
let nativeSessions = 0;

vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Linking: { getInitialURL: async () => `desklink-example://connect?url=${encodeURIComponent(BRIDGE_URL)}`, addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android' },
    Settings: { get: (key: string) => (key === 'desklinkUrl' ? BRIDGE_URL : undefined) },
    StatusBar: 'StatusBar',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Text: 'Text',
    View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }),
}));

vi.mock('@desklink/react-native', async () => ({
    DesktopView: 'DesktopView',
    useDesktopSession: (await import('../src/useDesktopSession')).useDesktopSession,
}));

// Android's native module, standing in under the package's own binding.
vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: (name: string) => (name !== 'Desklink' ? null : {
        createSession: () => `native-${++nativeSessions}`,
        setRemoteDescription: () => true,
        addRemoteCandidate: () => true,
        sendControl: () => true,
        setInputEnabled: () => true,
        closeSession: () => true,
        addListener: (_name: string, handler: (event: NativeSessionEvent) => void) => {
            nativeListeners.add(handler);
            return { remove: () => { nativeListeners.delete(handler); } };
        },
    }),
}));


/** How the stand-in bridge treats the next sockets. */
let bridge: 'unreachable' | 'open' | 'no-screen' = 'open';
const sockets: FakeSocket[] = [];

class FakeSocket {
    onopen?: () => void;
    onerror?: () => void;
    onclose?: () => void;
    onmessage?: (message: { data: string }) => void;
    constructor(readonly url: string) {
        sockets.push(this);
        setTimeout(() => (bridge === 'unreachable' ? this.onerror?.() : this.onopen?.()), 0);
    }
    send(data: string): void {
        const { id, method } = JSON.parse(data) as { id: number; method: string };
        const reply = method !== 'session.open'
            ? { id, result: {} }
            : bridge === 'no-screen'
                ? { id, error: { code: 'no-screen', message: `no display behind ${this.url}` } }
                : {
                    id,
                    result: {
                        sessionId: 'engine-1',
                        generation: 1,
                        geometry: { source: { width: 1280, height: 800 }, encoded: { width: 1280, height: 800 }, origin: { x: 0, y: 0 } },
                    },
                };
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
    }
    event(event: string, params: Record<string, unknown>): void {
        TestRenderer.act(() => this.onmessage?.({ data: JSON.stringify({ event, params }) }));
    }
    close(): void {}
}

let renderer: ReturnType<typeof TestRenderer.create> | null = null;

beforeEach(() => {
    // Real macrotasks stay real: the session loads its platform module asynchronously.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubGlobal('WebSocket', FakeSocket);
    nativeSessions = 0;
    sockets.length = 0;
    bridge = 'open';
});

afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Runs the session for `ms` of its time, letting its promises and renders through as it goes. */
async function settle(ms = 0): Promise<void> {
    for (let at = 0; at <= ms; at += 50) {
        await TestRenderer.act(async () => {
            await tick();
            await vi.advanceTimersByTimeAsync(ms === 0 ? 0 : 50);
        });
    }
}

/**
 * Runs the session until the status line reads `text`, for at most `ms` of its
 * time. The platform module loads on real time, so the first wait is on that.
 */
async function until(text: string, ms = 2000): Promise<void> {
    await vi.waitFor(() => expect(status()).not.toBe(''), { timeout: 5000 });
    for (let at = 0; at < ms && status() !== text; at += 50) await settle(50);
    expect(status()).toBe(text);
}

async function mount(): Promise<void> {
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<App />);
    });
}

/** The status line exactly as rendered. */
function status(): string {
    return renderer!.root.findByProps({ testID: 'desklink-status' }).children.join('');
}

function expectPlain(text: string): void {
    expect(text).not.toContain('token=');
    expect(text).not.toContain('demo-pairing-secret');
    expect(text).not.toMatch(/ws:\/\/|127\.0\.0\.1|47317/);
    // Developer metrics: raw states, geometry and failure codes.
    expect(text).not.toMatch(/presented|\d+x\d+|revoked|transport|no-screen|consumer/);
}

/** The native view shows the session's first picture, once the session has one. */
async function presented(): Promise<void> {
    for (let at = 0; at < 2000 && nativeSessions === 0; at += 50) await settle(50);
    expect(nativeSessions).toBe(1);
    TestRenderer.act(() => {
        for (const listener of [...nativeListeners]) listener({ sessionId: 'native-1', name: 'presented', payload: {} });
    });
}

describe('the example status line', () => {
    it('says Connected once the picture shows', async () => {
        await mount();
        await until('Connecting…');
        await presented();
        await until('Connected');
        expectPlain(status());
    });

    it('says the desktop ended a revoked session, not why the engine did', async () => {
        await mount();
        await until('Connecting…');
        await presented();
        await until('Connected');
        sockets[0]!.event('session.revoked', { reason: 'the consumer shut the engine down', sessionId: 'engine-1' });
        await until('Your desktop ended this session');
        expectPlain(status());
    });

    it('never shows the bridge address or its token while the desktop is unreachable', async () => {
        bridge = 'unreachable';
        await mount();
        await until('Can’t reach your desktop. Reconnecting…');
        expectPlain(status());
        // Every reopen fails the same way until the budget runs out.
        await until('Can’t reach your desktop.', 120_000);
        expect(sockets.length).toBeGreaterThan(2);
        expectPlain(status());
    });

    it('shows a refusal plainly, even when its message names the address', async () => {
        bridge = 'no-screen';
        await mount();
        await until('Your desktop has no screen to show.');
        expectPlain(status());
    });

    it('keeps every status and failure code free of the failure message', () => {
        const codes = ['permission', 'consent', 'no-screen', 'unsupported-codec', 'incompatible-version',
            'source-changed', 'revoked', 'transport', 'input-unavailable', 'platform'] as const;
        const statuses: SessionSnapshot['status'][] = ['idle', 'opening', 'connecting', 'live', 'reconnecting', 'ended', 'failed'];
        for (const s of statuses) {
            for (const code of codes) {
                const text = statusText({
                    status: s,
                    presented: true,
                    geometry: null,
                    diagnostics: {},
                    failure: { code, message: `cannot reach ${BRIDGE_URL}` },
                });
                expectPlain(text);
                if (s === 'failed') expect(text).not.toBe('');
            }
        }
    });
});
