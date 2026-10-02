import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { SessionEvent, Signaling } from './protocol';
import {
    REOPEN_BACKOFF_MS,
    RESTART_BACKOFF_MS,
    backoffDelay,
    connectionStatusFor,
    useDesktopSession,
    type DesktopSession,
    type DesktopSessionOptions,
} from './useDesktopSession';

/** `act` refuses to flush state updates unless React is told this is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The lifecycle promises the package makes on its own: held input is released
 * when the phone leaves the foreground, and a transport failure the automatic
 * reconnect cannot fix still leaves the user able to try again.
 */

type NativeSessionEvent = { sessionId: string; name: string; payload: Record<string, unknown> };

const appStateListeners = new Set<(status: string) => void>();
const nativeListeners = new Set<(event: NativeSessionEvent) => void>();
const signalingHandlers = new Set<(event: SessionEvent) => void>();
const sent: string[] = [];
const remoteDescriptions: Array<{ id: string; type: string; sdp: string }> = [];
const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
let createdSessions = 0;
let nativeCreation: 'ok' | 'null' | 'throw' = 'ok';

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: (_event: string, handler: (status: string) => void) => {
            appStateListeners.add(handler);
            return { remove: () => { appStateListeners.delete(handler); } };
        },
    },
}));

vi.mock('./native', () => ({
    nativeDesklink: {
        createSession: () => {
            if (nativeCreation === 'throw') throw new Error('native creation failed');
            if (nativeCreation === 'null') return null;
            return `native-${++createdSessions}`;
        },
        setRemoteDescription: (id: string, type: string, sdp: string) => {
            remoteDescriptions.push({ id, type, sdp });
            if (type === 'offer' && sdp !== '') {
                // The binding answers on its own; the event is what the
                // hook sends back, like the real one but synchronously so
                // tests stay deterministic.
                for (const listener of [...nativeListeners]) {
                    listener({ sessionId: id, name: 'answer', payload: { sdp: 'mock-answer-sdp' } });
                }
            }
            return true;
        },
        addRemoteCandidate: () => true,
        sendControl: (_id: string, message: string) => {
            sent.push(message);
            return true;
        },
        setInputEnabled: () => true,
        showKeyboard: () => true,
        hideKeyboard: () => true,
        setSurfaceSize: () => true,
        closeSession: () => true,
        isAvailable: () => true,
        addListener: (_name: string, handler: (event: NativeSessionEvent) => void) => {
            nativeListeners.add(handler);
            return { remove: () => { nativeListeners.delete(handler); } };
        },
    },
}));

/** Every mounted harness, torn down after each test so no timers leak. */
const mounted: Array<ReturnType<typeof TestRenderer.create>> = [];

afterEach(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
});

beforeEach(() => {
    appStateListeners.clear();
    nativeListeners.clear();
    signalingHandlers.clear();
    sent.length = 0;
    remoteDescriptions.length = 0;
    requests.length = 0;
    createdSessions = 0;
    nativeCreation = 'ok';
});

function signaling(): Signaling {
    return {
        async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
            requests.push({ method, params });
            if (method === 'session.open') {
                return {
                    sessionId: 'engine-1',
                    generation: 1,
                    source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                    geometry: {
                        source: { width: 2560, height: 1440 },
                        encoded: { width: 1280, height: 720 },
                        origin: { x: 0, y: 0 },
                    },
                } as T;
            }
            if (method === 'session.restart_ice') {
                // The engine re-offers through the usual description event,
                // like the real one.
                setTimeout(() => {
                    for (const handler of [...signalingHandlers]) {
                        handler({ kind: 'description', description: { type: 'offer', sdp: 'restart-engine-offer' } });
                    }
                }, 10);
                return { accepted: true } as T;
            }
            return { accepted: true } as T;
        },
        subscribe: (handler: (event: SessionEvent) => void) => {
            signalingHandlers.add(handler);
            return () => { signalingHandlers.delete(handler); };
        },
    };
}

async function connectedSession(onCursor?: DesktopSessionOptions['onCursor']): Promise<{ current: DesktopSession }> {
    const held: { current: DesktopSession | null } = { current: null };
    function Harness() {
        held.current = useDesktopSession({
            authorize: async () => ({ signaling: signaling(), session: {} }),
            onCursor,
        });
        return null;
    }
    await TestRenderer.act(async () => {
        mounted.push(TestRenderer.create(React.createElement(Harness)));
    });
    await TestRenderer.act(async () => {
        await held.current?.connect();
    });
    if (held.current === null) throw new Error('the hook did not mount');
    // The hook returns a new object per render, so tests read the live one.
    return held as { current: DesktopSession };
}

function nativeEvent(name: string, sessionId: string | null, payload: Record<string, unknown> = {}): void {
    TestRenderer.act(() => {
        for (const listener of [...nativeListeners]) {
            listener({ sessionId: sessionId ?? '', name, payload });
        }
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function liveSession(): Promise<{ current: DesktopSession }> {
    const session = await connectedSession();
    nativeEvent('presented', session.current.nativeId);
    expect(session.current.snapshot.status).toBe('live');
    return session;
}

function sentKinds(): string[] {
    return sent.map((message) => (JSON.parse(message) as { kind: string }).kind);
}

describe('session.open on the wire', () => {
    // Pairing is the boundary, so the app's own permissions are ignored. The
    // full set still goes on the wire because a 0.3 engine refuses an open
    // without view.
    it('always carries the full permission set, whatever the app asked for', async () => {
        await connectedSession();
        const legacy: { current: DesktopSession | null } = { current: null };
        function Legacy() {
            legacy.current = useDesktopSession({
                authorize: async () => ({ signaling: signaling(), session: { permissions: ['view'] } }),
            });
            return null;
        }
        await TestRenderer.act(async () => {
            mounted.push(TestRenderer.create(React.createElement(Legacy)));
        });
        await TestRenderer.act(async () => {
            await legacy.current?.connect();
        });

        const opens = requests.filter((request) => request.method === 'session.open');
        expect(opens.map((open) => open.params?.permissions)).toEqual([
            ['view', 'control', 'clipboard'],
            ['view', 'control', 'clipboard'],
        ]);
    });
});

describe('control messages', () => {
    it('leaves the sequence to the platform so input and app messages share one counter', async () => {
        const session = await connectedSession();
        session.current.setInputEnabled(true);
        sent.length = 0;

        TestRenderer.act(() => {
            session.current.send({ kind: 'pointer', phase: 'down', x: 10, y: 10, button: 1 });
        });
        TestRenderer.act(() => {
            session.current.releaseHeld();
        });

        const messages = sent.map((message) => JSON.parse(message) as Record<string, unknown>);
        expect(messages.map((message) => message.kind)).toEqual(['pointer', 'release_all']);
        // A seq stamped here would collide with the native input counter the
        // engine already holds.
        expect(messages.every((message) => message.seq === undefined)).toBe(true);
    });
});

describe('held input across a background transition', () => {
    it('releases a pointer that is still down when the app leaves the foreground', async () => {
        const session = await connectedSession();
        session.current.setInputEnabled(true);
        sent.length = 0;

        // A drag in progress: the button is down on the desktop.
        TestRenderer.act(() => {
            session.current.send({ kind: 'pointer', phase: 'down', x: 100, y: 120, button: 1 });
        });
        expect(sentKinds()).toEqual(['pointer']);

        // Still in the foreground: nothing is released.
        TestRenderer.act(() => {
            for (const listener of appStateListeners) listener('active');
        });
        expect(sentKinds()).toEqual(['pointer']);

        // Backgrounded: the desktop must not keep the button held.
        TestRenderer.act(() => {
            for (const listener of appStateListeners) listener('background');
        });
        expect(sentKinds()).toEqual(['pointer', 'release_all']);
    });
});

describe('a transport failure the automatic reconnect cannot fix at once', () => {
    it('keeps reopening with backoff and never holds a dead session', async () => {
        const session = await connectedSession();
        const first = session.current.nativeId;
        expect(first).not.toBeNull();

        // First failure: the hook reopens on its own after the first backoff.
        nativeEvent('failure', first);
        await TestRenderer.act(async () => {
            await sleep(1300);
        });
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(first);

        // Second failure: the dead handle is dropped at once and the hook
        // reopens again after the next backoff step.
        const second = session.current.nativeId;
        nativeEvent('failure', second);
        await TestRenderer.act(async () => {});
        expect(session.current.snapshot.status).toBe('reconnecting');
        expect(session.current.nativeId).toBeNull();
        await TestRenderer.act(async () => {
            await sleep(2300);
        });
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(second);

        // And the user can still retry by hand on top of the budget.
        await TestRenderer.act(async () => {
            await session.current.close('left the desktop');
        });
        await TestRenderer.act(async () => {
            await session.current.connect();
        });
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.snapshot.status).not.toBe('failed');
    }, 20_000);
});

describe('a refusal the host makes', () => {
    // An unanswered screen-sharing prompt is a refusal too: retrying on its own
    // would only raise another prompt on a computer nobody is looking at.
    it.each([
        ['input-unavailable', 'input-unavailable'],
        ['consent-timeout', 'consent'],
    ])('surfaces %s as %s and does not spend the reconnect on it', async (hostCode, failureCode) => {
        const held: { current: DesktopSession | null } = { current: null };
        let authorizations = 0;
        const refusal = Object.assign(new Error('the host refused'), { code: hostCode });

        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => {
                    authorizations += 1;
                    return {
                        signaling: {
                            async request<T>(): Promise<T> {
                                throw refusal;
                            },
                            subscribe: () => () => undefined,
                        },
                        session: {},
                    };
                },
            });
            return null;
        }

        await TestRenderer.act(async () => {
            mounted.push(TestRenderer.create(React.createElement(Harness)));
        });
        await TestRenderer.act(async () => {
            await held.current?.connect();
        });

        expect(held.current?.snapshot.status).toBe('failed');
        expect(held.current?.snapshot.failure).toMatchObject({ code: failureCode });

        // A refusal a reconnect cannot fix must not consume the retry.
        await TestRenderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
        });
        expect(authorizations).toBe(1);
    }, 20_000);
});

describe('an opened host session whose native creation fails', () => {
    it('closes capture for null and thrown creation, then allows a new connection', async () => {
        const requests: string[] = [];
        const channel = signaling();
        const request = channel.request;
        channel.request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
            requests.push(method);
            return request<T>(method, params);
        };
        const held: { current: DesktopSession | null } = { current: null };
        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => ({ signaling: channel, session: {} }),
            });
            return null;
        }
        let renderer!: ReturnType<typeof TestRenderer.create>;
        await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
        mounted.push(renderer);

        nativeCreation = 'null';
        await TestRenderer.act(async () => { await held.current!.connect(); });
        expect(requests).toEqual(['session.open', 'session.close']);
        expect(held.current?.nativeId).toBeNull();

        nativeCreation = 'throw';
        await TestRenderer.act(async () => { await held.current!.connect(); });
        expect(requests).toEqual(['session.open', 'session.close', 'session.open', 'session.close']);
        expect(held.current?.nativeId).toBeNull();

        nativeCreation = 'ok';
        await TestRenderer.act(async () => { await held.current!.connect(); });
        expect(held.current?.nativeId).not.toBeNull();
        await TestRenderer.act(async () => { renderer.unmount(); });
        expect(requests).toEqual(['session.open', 'session.close', 'session.open', 'session.close', 'session.open', 'session.close']);
    }, 20_000);
});

describe('a session that finishes opening after the screen was torn down', () => {
    it('closes what the host opened instead of leaving it capturing', async () => {
        const requests: string[] = [];
        let releaseOpen: (() => void) | null = null;
        const held: { current: DesktopSession | null } = { current: null };
        const signaling: Signaling = {
            async request<T>(method: string): Promise<T> {
                requests.push(method);
                if (method === 'session.open') {
                    await new Promise<void>((resolve) => { releaseOpen = resolve; });
                    return {
                        sessionId: 'engine-1',
                        generation: 1,
                        source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                        geometry: {
                            source: { width: 2560, height: 1440 },
                            encoded: { width: 1280, height: 720 },
                            origin: { x: 0, y: 0 },
                        },
                    } as T;
                }
                return { accepted: true } as T;
            },
            subscribe: () => () => undefined,
        };

        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => ({ signaling, session: {} }),
            });
            return null;
        }

        await TestRenderer.act(async () => {
            mounted.push(TestRenderer.create(React.createElement(Harness)));
        });

        let opening: Promise<void> | undefined;
        await TestRenderer.act(async () => {
            opening = held.current!.connect();
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(releaseOpen).not.toBeNull();

        await TestRenderer.act(async () => {
            await held.current!.close('left the desktop');
        });
        releaseOpen!();
        await TestRenderer.act(async () => { await opening; });

        expect(requests).toContain('session.close');
    }, 20_000);
});

describe('connectionStatusFor', () => {
    it.each([
        ['disconnected', 'live', true, 'reconnecting'],
        ['disconnected', 'live', false, 'reconnecting'],
        ['disconnected', 'connecting', false, 'reconnecting'],
        ['disconnected', 'reconnecting', true, null],
        ['disconnected', 'failed', true, null],
        ['disconnected', 'idle', false, null],
        ['connected', 'reconnecting', true, 'live'],
        ['completed', 'reconnecting', true, 'live'],
        // Frames were never shown: still the first connection, not a recovery.
        ['connected', 'reconnecting', false, 'connecting'],
        ['connected', 'connecting', false, null],
        ['connected', 'live', true, null],
        ['checking', 'live', true, null],
        ['closed', 'reconnecting', true, null],
        ['failed', 'live', true, null],
    ])('maps %s from %s (presented %s) to %s', (state, status, presented, next) => {
        expect(connectionStatusFor(state, status as never, presented as boolean)).toBe(next);
    });
});

describe('backoffDelay', () => {
    it('walks the schedule and reports when it is spent', () => {
        expect(backoffDelay([1000, 2000], 0)).toBe(1000);
        expect(backoffDelay([1000, 2000], 1)).toBe(2000);
        expect(backoffDelay([1000, 2000], 2)).toBeNull();
        expect(backoffDelay(REOPEN_BACKOFF_MS, REOPEN_BACKOFF_MS.length)).toBeNull();
        expect(backoffDelay(RESTART_BACKOFF_MS, RESTART_BACKOFF_MS.length)).toBeNull();
    });
});

describe('an ICE disconnection after frames were shown', () => {
    it('reads reconnecting at once, restarts ICE on the same session, and goes live on recovery', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        expect(id).not.toBeNull();
        requests.length = 0;
        remoteDescriptions.length = 0;

        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('reconnecting');
        // The session is untouched: no reopen, no close.
        expect(session.current.nativeId).toBe(id);
        expect(requests.map((request) => request.method)).not.toContain('session.open');

        // Brief blips heal alone; the restart waits them out.
        await TestRenderer.act(async () => {
            await sleep(500);
        });
        expect(requests.map((request) => request.method)).not.toContain('session.restart_ice');

        await TestRenderer.act(async () => {
            await sleep(2000);
        });
        // The restart asks the engine to re-offer on the same peer; the
        // offer arrives as the usual description event and is answered as
        // usual, all without reopening the session.
        const restart = requests.find((request) => request.method === 'session.restart_ice');
        expect(restart?.params).toMatchObject({ session_id: 'engine-1', generation: 1 });
        await TestRenderer.act(async () => {
            await sleep(100);
        });
        expect(remoteDescriptions).toContainEqual({ id, type: 'offer', sdp: 'restart-engine-offer' });
        const answer = requests.find((request) => request.method === 'session.description');
        expect(answer?.params).toMatchObject({
            session_id: 'engine-1',
            generation: 1,
            description: { type: 'answer' },
        });
        expect(requests.map((request) => request.method)).not.toContain('session.open');
        expect(session.current.nativeId).toBe(id);

        nativeEvent('ice', id, { state: 'CONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
    }, 20_000);

    it('reports a duplicate failure once instead of spending the budget twice', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;

        nativeEvent('ice', id, { state: 'FAILED' });
        // The peer's failure event for the same outage is not a second outage.
        nativeEvent('failure', id);
        await TestRenderer.act(async () => {
            await sleep(1300);
        });
        await TestRenderer.act(async () => {});
        // Exactly one reopen: the duplicate did not consume a second attempt.
        expect(createdSessions).toBe(2);
    }, 20_000);
});

describe('an ICE disconnection before any frame', () => {
    it('reads reconnecting but does not restart a path that never worked', async () => {
        const session = await connectedSession();
        const id = session.current.nativeId;

        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('reconnecting');

        await TestRenderer.act(async () => {
            await sleep(2600);
        });
        expect(requests.map((request) => request.method)).not.toContain('session.restart_ice');
    }, 20_000);
});

describe('a terminal failure that outlasts one attempt', () => {
    it('backs the reopens off instead of spending them while the outage lasts', async () => {
        const session = await liveSession();

        nativeEvent('failure', session.current.nativeId);
        await TestRenderer.act(async () => {
            await sleep(1300);
        });
        await TestRenderer.act(async () => {});
        const second = session.current.nativeId;
        expect(second).not.toBeNull();

        // The next failure waits out the second backoff step before reopening.
        nativeEvent('failure', second);
        const started = Date.now();
        await TestRenderer.act(async () => {
            for (let waited = 0; waited < 5000 && session.current.nativeId === null; waited += 100) {
                await sleep(100);
            }
        });
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(second);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
    }, 20_000);
});

describe('the engine heartbeat', () => {
    function ping(sessionId: string | null): void {
        nativeEvent('control', sessionId, { message: '{"kind":"ping"}' });
    }

    it('leaves an engine that predates heartbeats alone', async () => {
        const session = await liveSession();
        await TestRenderer.act(async () => {
            await sleep(1800);
        });
        expect(session.current.snapshot.status).toBe('live');
        expect(requests.map((request) => request.method)).not.toContain('session.restart_ice');
    }, 20_000);

    it('reads a stalled path as reconnecting and a resumed one as live', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;

        ping(id);
        await TestRenderer.act(async () => {
            await sleep(400);
        });
        expect(session.current.snapshot.status).toBe('live');
        expect(requests.map((request) => request.method)).not.toContain('session.restart_ice');

        // No heartbeat for longer than the stall threshold: reconnecting,
        // without waiting for ICE consent timers.
        await TestRenderer.act(async () => {
            await sleep(1400);
        });
        expect(session.current.snapshot.status).toBe('reconnecting');

        // The path works again: heartbeats clear the stall.
        ping(id);
        expect(session.current.snapshot.status).toBe('live');
    }, 20_000);
});

describe('an offer that beats the open result back', () => {
    it('is answered instead of leaving the session connecting forever', async () => {
        const answers: unknown[] = [];
        let emit: ((event: SessionEvent) => void) | null = null;
        const held: { current: DesktopSession | null } = { current: null };
        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => ({
                    signaling: {
                        async request<T>(method: string): Promise<T> {
                            if (method === 'session.open') {
                                // The engine's offer and candidates beat the
                                // result back; the subscription is already up.
                                emit?.({ kind: 'description', description: { type: 'offer', sdp: 'early-offer' } });
                                return {
                                    sessionId: 'engine-1',
                                    generation: 1,
                                    source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                                    geometry: {
                                        source: { width: 2560, height: 1440 },
                                        encoded: { width: 1280, height: 720 },
                                        origin: { x: 0, y: 0 },
                                    },
                                } as T;
                            }
                            if (method === 'session.description') answers.push(true);
                            return { accepted: true } as T;
                        },
                        subscribe: (handler: (event: SessionEvent) => void) => {
                            emit = handler;
                            return () => { emit = null; };
                        },
                    },
                    session: {},
                }),
            });
            return null;
        }
        await TestRenderer.act(async () => {
            mounted.push(TestRenderer.create(React.createElement(Harness)));
        });
        await TestRenderer.act(async () => {
            await held.current?.connect();
        });
        const id = held.current?.nativeId;
        expect(id).not.toBeNull();
        // The stashed offer is replayed into the native session, which answers.
        expect(remoteDescriptions).toContainEqual({ id, type: 'offer', sdp: 'early-offer' });
        await TestRenderer.act(async () => {});
        expect(answers).toHaveLength(1);
    }, 20_000);
});

describe('a restart the session asked for itself', () => {
    it('rides out renegotiation transients without flapping or re-asking', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        requests.length = 0;

        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('reconnecting');
        await TestRenderer.act(async () => {
            await sleep(2300);
        });
        // The restart was asked; the engine re-offered and was answered.
        const restarts = () => requests.filter((request) => request.method === 'session.restart_ice');
        expect(restarts()).toHaveLength(1);

        // Recovery lands live inside the grace window…
        nativeEvent('ice', id, { state: 'CONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
        // …and a renegotiation transient inside the same window is expected,
        // not a new outage: no flap, no second restart.
        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
        await TestRenderer.act(async () => {
            await sleep(300);
        });
        expect(restarts()).toHaveLength(1);

        // Past the grace window a drop reads as reconnecting again. The
        // window is wall-clock, so poll rather than assume exact timing.
        let status = session.current.snapshot.status;
        for (let i = 0; i < 10 && status !== 'reconnecting'; i++) {
            nativeEvent('ice', id, { state: 'DISCONNECTED' });
            await TestRenderer.act(async () => {
                await sleep(500);
            });
            status = session.current.snapshot.status;
        }
        expect(status).toBe('reconnecting');
    }, 20_000);
});

describe('a mid-session re-offer asked for outside the policy', () => {
    it('still rides out the renegotiation without flapping', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        // An engine re-offer while live: a restart asked for directly.
        TestRenderer.act(() => {
            for (const handler of [...signalingHandlers]) {
                handler({ kind: 'description', description: { type: 'offer', sdp: 'direct-reoffer' } });
            }
        });
        expect(remoteDescriptions).toContainEqual({ id, type: 'offer', sdp: 'direct-reoffer' });
        // Renegotiation transients are expected, not a new outage.
        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
        nativeEvent('ice', id, { state: 'CONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
    }, 20_000);
});

describe('the engine restore token', () => {
    it('reopens with the live session token instead of asking again', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        requests.length = 0;

        // The engine grants a restore token while the session is live.
        TestRenderer.act(() => {
            for (const handler of [...signalingHandlers]) {
                handler({ kind: 'restoreToken', token: 'restore-123' });
            }
        });

        nativeEvent('failure', id);
        await TestRenderer.act(async () => {
            await sleep(1300);
        });
        await TestRenderer.act(async () => {});
        const reopen = requests.find((request) => request.method === 'session.open');
        expect(reopen?.params).toMatchObject({ restore_token: 'restore-123' });
        expect(session.current.nativeId).not.toBeNull();
    }, 20_000);
});

describe('a live transport that stays quiet', () => {
    it('rechecks for heartbeats on recovery, then reopens after clean restarts fail', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        requests.length = 0;

        // ICE is up and a heartbeat was seen: the watchdog is armed.
        nativeEvent('ice', id, { state: 'CONNECTED' });
        TestRenderer.act(() => {
            nativeEvent('control', id, { message: '{"kind":"ping"}' });
        });
        // A drop and fast recovery with no further heartbeats…
        nativeEvent('ice', id, { state: 'DISCONNECTED' });
        expect(session.current.snapshot.status).toBe('reconnecting');
        nativeEvent('ice', id, { state: 'CONNECTED' });
        expect(session.current.snapshot.status).toBe('live');
        // …reads as stalled again once the recovery arm expires.
        await TestRenderer.act(async () => {
            await sleep(1600);
        });
        expect(session.current.snapshot.status).toBe('reconnecting');

        // Clean restarts on a live transport do not heal it: the session
        // escalates to a reopen instead of asking forever. `failed` itself is
        // transient on the way there and `act` can hide it, so prove the path
        // by its requests: the effect closes the dead session, then reopens.
        // Only a transport failure reopens at all.
        let reopened = false;
        for (let i = 0; i < 40 && !reopened; i++) {
            const methods = requests.map((request) => request.method);
            const closedAt = methods.indexOf('session.close');
            reopened = closedAt >= 0 && methods.slice(closedAt + 1).includes('session.open');
            if (!reopened) {
                await TestRenderer.act(async () => {
                    await sleep(500);
                });
            }
        }
        expect(reopened).toBe(true);
    }, 30_000);
});

describe('events naming another session', () => {
    function emitSignaling(event: SessionEvent): void {
        TestRenderer.act(() => {
            for (const handler of [...signalingHandlers]) handler(event);
        });
    }

    it('ignores a previous generation revocation, offer and state', async () => {
        const session = await liveSession();
        const id = session.current.nativeId;
        expect(id).not.toBeNull();
        const described = remoteDescriptions.length;

        // A previous session's queued leftovers arrive beside the live one.
        emitSignaling({ kind: 'revoked', reason: 'the connection to the phone was lost', sessionId: 'dead-session' });
        emitSignaling({ kind: 'description', description: { type: 'offer', sdp: 'stale-offer' }, sessionId: 'dead-session' });
        emitSignaling({ kind: 'state', capture: 'streaming', transport: 'disconnected', firstFrame: true, sessionId: 'dead-session' });
        expect(session.current.snapshot.status).toBe('live');
        expect(session.current.nativeId).toBe(id);
        expect(remoteDescriptions.length).toBe(described);

        // The live session's own events still apply.
        emitSignaling({ kind: 'state', capture: 'streaming', transport: 'disconnected', firstFrame: true, sessionId: 'engine-1' });
        expect(session.current.snapshot.status).toBe('reconnecting');
        emitSignaling({ kind: 'description', description: { type: 'offer', sdp: 'fresh-offer' }, sessionId: 'engine-1' });
        expect(remoteDescriptions).toContainEqual({ id, type: 'offer', sdp: 'fresh-offer' });
        emitSignaling({ kind: 'revoked', reason: 'done', sessionId: 'engine-1' });
        expect(session.current.snapshot.status).toBe('ended');
    }, 20_000);

    it('delivers cursor samples for the live session and ignores stale samples', async () => {
        const onCursor = vi.fn();
        const session = await connectedSession(onCursor);
        const sample = { kind: 'cursor' as const, sessionId: 'engine-1', x: 31, y: 47, visible: true, timestamp_us: 1234 };

        emitSignaling({ ...sample, sessionId: 'dead-session' });
        emitSignaling(sample);

        expect(onCursor).toHaveBeenCalledTimes(1);
        expect(onCursor).toHaveBeenCalledWith(sample);
        expect(session.current.nativeId).not.toBeNull();
    }, 20_000);

    it('still ends on a revocation without an id', async () => {
        const session = await liveSession();
        emitSignaling({ kind: 'revoked', reason: 'done' });
        expect(session.current.snapshot.status).toBe('ended');
    }, 20_000);
});

describe('a session the engine revokes', () => {
    function emitSignaling(event: SessionEvent): void {
        TestRenderer.act(() => {
            for (const handler of [...signalingHandlers]) handler(event);
        });
    }

    async function settle(ms: number): Promise<void> {
        await TestRenderer.act(async () => {
            await sleep(ms);
        });
        await TestRenderer.act(async () => {});
    }

    function opens(): number {
        return requests.filter((request) => request.method === 'session.open').length;
    }

    it('reopens after a lost path instead of ending', async () => {
        const session = await liveSession();
        const first = session.current.nativeId;

        emitSignaling({ kind: 'revoked', reason: 'the connection to the phone was lost', code: 'transport', sessionId: 'engine-1' });
        expect(session.current.snapshot.status).toBe('reconnecting');
        await settle(1300);
        expect(opens()).toBe(2);
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(first);
        expect(session.current.snapshot.status).not.toBe('ended');
    }, 20_000);

    it('reopens after a lost path the control channel reports', async () => {
        const session = await liveSession();
        nativeEvent('control', session.current.nativeId, {
            message: '{"kind":"revoked","reason":"the connection to the phone was lost","code":"transport"}',
        });
        await settle(1300);
        expect(opens()).toBe(2);
        expect(session.current.nativeId).not.toBeNull();
    }, 20_000);

    it('still ends when the session authority ends', async () => {
        for (const code of ['lease', 'closed', 'error']) {
            requests.length = 0;
            const session = await liveSession();
            emitSignaling({ kind: 'revoked', reason: 'the session lease expired', code, sessionId: 'engine-1' });
            expect(session.current.snapshot.status).toBe('ended');
            expect(session.current.snapshot.failure).toMatchObject({ code: 'revoked' });
            await settle(1300);
            expect(opens()).toBe(1);
            expect(session.current.nativeId).toBeNull();
        }
        const session = await liveSession();
        nativeEvent('control', session.current.nativeId, { message: '{"kind":"revoked","reason":"replaced","code":"closed"}' });
        expect(session.current.snapshot.status).toBe('ended');
    }, 20_000);

    it('reopens when the restart schedule is spent and the peer never says failed', async () => {
        const session = await liveSession();
        const first = session.current.nativeId;
        requests.length = 0;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            nativeEvent('ice', first, { state: 'DISCONNECTED' });
            expect(session.current.snapshot.status).toBe('reconnecting');
            await TestRenderer.act(async () => {
                await vi.advanceTimersByTimeAsync(120_000);
            });
            await TestRenderer.act(async () => {
                await vi.advanceTimersByTimeAsync(2_000);
            });
        } finally {
            vi.useRealTimers();
        }
        const methods = requests.map((request) => request.method);
        expect(methods.filter((method) => method === 'session.restart_ice').length).toBe(RESTART_BACKOFF_MS.length + 1);
        expect(methods).toContain('session.open');
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(first);
    }, 20_000);
});

describe('returning to the foreground', () => {
    function appState(status: string): void {
        TestRenderer.act(() => {
            for (const listener of [...appStateListeners]) listener(status);
        });
    }

    it('reopens at once after an absence long enough for the path to lapse', async () => {
        const session = await liveSession();
        const first = session.current.nativeId;
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            appState('background');
            clock.mockReturnValue(now + 31_000);
            appState('active');
        } finally {
            clock.mockRestore();
        }
        await TestRenderer.act(async () => {
            await sleep(900);
        });
        expect(session.current.snapshot.status).toBe('reconnecting');
        await TestRenderer.act(async () => {
            await sleep(1300);
        });
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(first);
    }, 20_000);

    it('leaves a short absence, or a long inactive spell, to the restart path', async () => {
        const session = await liveSession();
        const first = session.current.nativeId;
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            appState('background');
            clock.mockReturnValue(now + 5_000);
            appState('active');
            appState('inactive');
            clock.mockReturnValue(now + 60_000);
            appState('active');
        } finally {
            clock.mockRestore();
        }
        await TestRenderer.act(async () => {
            await sleep(900);
        });
        expect(session.current.snapshot.status).toBe('live');
        expect(session.current.nativeId).toBe(first);
    }, 20_000);

    it('lets a revocation queued behind the return end the session instead', async () => {
        const session = await liveSession();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            appState('background');
            clock.mockReturnValue(now + 31_000);
            appState('active');
        } finally {
            clock.mockRestore();
        }
        // The lease ran out while the app was suspended; its notice lands
        // just after the app hears it is active again.
        TestRenderer.act(() => {
            for (const handler of [...signalingHandlers]) {
                handler({ kind: 'revoked', reason: 'the session lease expired', code: 'lease', sessionId: 'engine-1' });
            }
        });
        await TestRenderer.act(async () => {
            await sleep(2200);
        });
        expect(session.current.snapshot.status).toBe('ended');
        expect(requests.filter((request) => request.method === 'session.open').length).toBe(1);
    }, 20_000);

    it('stops waiting out a pending reopen', async () => {
        const session = await liveSession();
        nativeEvent('failure', session.current.nativeId);
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).toBeNull();
        expect(session.current.snapshot.status).toBe('reconnecting');

        appState('background');
        await TestRenderer.act(async () => {
            appState('active');
        });
        await TestRenderer.act(async () => {});
        // No backoff wait: the reopen ran on the return itself.
        expect(session.current.nativeId).not.toBeNull();
    }, 20_000);
});

describe('classifyOpenFailure', () => {
    it('treats an unanswering engine as transport, and refusals as refusals', async () => {
        const { classifyOpenFailure } = await import('./useDesktopSession');
        expect(classifyOpenFailure(Object.assign(new Error('the desktop engine did not answer session.open in 30000ms'), { code: 'engine' }))).toBe('transport');
        expect(classifyOpenFailure(new Error('boom'))).toBe('transport');
        expect(classifyOpenFailure(Object.assign(new Error('refused'), { code: 'consent-timeout' }))).toBe('consent');
        expect(classifyOpenFailure(Object.assign(new Error('refused'), { code: 'no-screen' }))).toBe('no-screen');
        expect(classifyOpenFailure(Object.assign(new Error('refused'), { code: 'permission' }))).toBe('permission');
    });
});
