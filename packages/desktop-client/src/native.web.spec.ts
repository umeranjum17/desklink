import { beforeEach, expect, it, vi } from 'vitest';

const listeners = new Set<(event: { sessionId: string; name: string; payload: Record<string, unknown> }) => void>();
const peers: Array<Record<string, unknown>> = [];

function fakeElement(): Record<string, unknown> {
    return {
        style: {} as Record<string, string>,
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        appendChild: vi.fn(),
        remove: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        value: '',
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
}

class StubPeer {
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    ontrack: ((event: { streams: unknown[] }) => void) | null = null;
    ondatachannel: ((event: { channel: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    iceConnectionState = 'new';
    connectionState = 'new';
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }));
    createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }));
    setLocalDescription = vi.fn(async () => undefined);
    setRemoteDescription = vi.fn(async () => undefined);
    addIceCandidate = vi.fn(async () => undefined);
    close = vi.fn();
    constructor() {
        peers.push(this as unknown as Record<string, unknown>);
    }
}

vi.stubGlobal('document', { createElement: () => fakeElement() });
vi.stubGlobal('RTCPeerConnection', StubPeer);

beforeEach(() => {
    listeners.clear();
    peers.length = 0;
});

it('emits ICE connection states as they happen', async () => {
    const { nativeDesklink } = await import('./native.web');
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
        events.push({ name: event.name, payload: event.payload });
    });
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)! as unknown as StubPeer;

    peer.iceConnectionState = 'disconnected';
    peer.oniceconnectionstatechange?.();
    expect(events).toContainEqual({ name: 'ice', payload: { state: 'DISCONNECTED' } });

    peer.iceConnectionState = 'connected';
    peer.oniceconnectionstatechange?.();
    expect(events).toContainEqual({ name: 'ice', payload: { state: 'CONNECTED' } });

    listener.remove();
    nativeDesklink.closeSession(id);
});

it('returns receiver and codec diagnostics without ICE addresses or credentials', async () => {
    const { nativeDesklink } = await import('./native.web');
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)!;
    peer.getStats = vi.fn(async () => new Map([
        ['video', { id: 'video', type: 'inbound-rtp', framesDecoded: 42, codecId: 'codec', decoderImplementation: 'hardware', token: 'private' }],
        ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP9', payloadType: 96 }],
        ['candidate', { id: 'candidate', type: 'local-candidate', address: '192.0.2.1' }],
    ]));
    expect(JSON.parse(await nativeDesklink.getStats!(id))).toEqual([
        { id: 'video', type: 'inbound-rtp', framesDecoded: 42, codecId: 'codec', decoderImplementation: 'hardware' },
        { id: 'codec', type: 'codec', mimeType: 'video/VP9', payloadType: 96 },
    ]);
    nativeDesklink.closeSession(id);
    expect(await nativeDesklink.getStats!(id)).toBe('[]');
});
