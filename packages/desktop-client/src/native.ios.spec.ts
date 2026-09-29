import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// The bundler's inline require, standing in: it goes through the stubbed global so the spec sees when it runs.
vi.mock('./webrtc.ios', () => ({ requireWebRTC: () => (globalThis as unknown as { require: (id: string) => unknown }).require('react-native-webrtc') }));

const peers: MockPeer[] = [];
class MockStream {
    addTrack = vi.fn();
    toURL() { return 'stream'; }
}
class MockPeer {
    onicecandidate?: (event: any) => void;
    ontrack?: (event: any) => void;
    ondatachannel?: (event: any) => void;
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

/** What the bundler's lazy require handed out, in order. */
const required: string[] = [];
beforeEach(() => {
    peers.length = 0;
    required.length = 0;
    // The device bundler evaluates `react-native-webrtc` on first require;
    // nothing in this package may require it at import time.
    vi.stubGlobal('require', (id: string) => {
        required.push(id);
        if (id === 'react-native-webrtc') return { MediaStream: MockStream, RTCPeerConnection: MockPeer };
        throw new Error(`unexpected require: ${id}`);
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('keeps WebRTC out of the import and loads it on the first session', async () => {
    vi.resetModules();
    const fresh = await import('./native.ios');
    expect(required).not.toContain('react-native-webrtc');
    expect(fresh.nativeDesklink.createSession('[]')).not.toBeNull();
    expect(required).toContain('react-native-webrtc');
});

it('buffers ICE until offer, emits answer and gates/stamps control input per session', async () => {
    const { nativeDesklink } = await import('./native.ios');
    const events: string[] = [];
    const replies: string[] = [];
    const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
        events.push(event.name);
        if (event.name === 'control') replies.push(String(event.payload.message));
    });
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)!;
    const sent: string[] = [];
    const channel: { readyState: string; send: (value: string) => void; close: ReturnType<typeof vi.fn>; onmessage?: (event: { data: string }) => void } = {
        readyState: 'open', send: (value) => { sent.push(value); }, close: vi.fn(),
    };
    peer.ondatachannel!({ channel });
    nativeDesklink.addRemoteCandidate(id, 'candidate', '0', 1);
    expect(peer.addIceCandidate).not.toHaveBeenCalled();
    nativeDesklink.setRemoteDescription(id, 'offer', 'offer');
    await vi.waitFor(() => expect(events).toContain('answer'));
    expect(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: 'candidate', sdpMid: '0', sdpMLineIndex: 1 });
    expect(nativeDesklink.sendControl(id, '{"kind":"pointer","phase":"down","x":3,"y":4}')).toBe(false);
    nativeDesklink.setInputEnabled(id, true);
    nativeDesklink.sendControl(id, '{"kind":"pointer","phase":"down","x":3,"y":4}');
    nativeDesklink.sendControl(id, '{"kind":"clipboard_read","request":"r"}');
    nativeDesklink.sendControl(id, '{"kind":"clipboard_write","request":"w","text":"paste me"}');
    expect(JSON.parse(sent[0])).toEqual({ kind: 'pointer', phase: 'down', x: 3, y: 4, seq: 1 });
    expect(JSON.parse(sent[1])).toEqual({ kind: 'clipboard_read', request: 'r', seq: 2 });
    expect(JSON.parse(sent[2])).toEqual({ kind: 'clipboard_write', request: 'w', text: 'paste me', seq: 3 });
    channel.onmessage?.({ data: '{"kind":"clipboard","request":"r","text":"copied","truncated":false}' });
    expect(replies).toEqual(['{"kind":"clipboard","request":"r","text":"copied","truncated":false}']);
    nativeDesklink.setInputEnabled(id, false);
    expect(JSON.parse(sent[3])).toEqual({ kind: 'release_all', seq: 4 });
    nativeDesklink.closeSession(id);
    expect(peer.close).toHaveBeenCalled();
    expect(nativeDesklink.sendControl(id, '{"kind":"release_all"}')).toBe(false);
    listener.remove();
});

it('declines the playout-delay extension so RTCView draws every frame', async () => {
    const { nativeDesklink } = await import('./native.ios');
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)!;
    const offer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=extmap:1 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
        'a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:3/sendonly http://www.webrtc.org/experiments/rtp-hdrext/playout-delay', 'a=rtpmap:96 VP9/90000', ''].join('\r\n');
    nativeDesklink.setRemoteDescription(id, 'offer', offer);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:sdes:mid', 'a=rtpmap:96 VP9/90000', ''].join('\r\n') });
    nativeDesklink.closeSession(id);
});

it('emits ICE connection states as they happen', async () => {
    const { nativeDesklink } = await import('./native.ios');
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
        events.push({ name: event.name, payload: event.payload });
    });
    const id = nativeDesklink.createSession('[]')!;
    const peer = peers.at(-1)!;
    peer.iceConnectionState = 'disconnected';
    (peer.oniceconnectionstatechange as (() => void) | undefined)?.();
    expect(events).toContainEqual({ name: 'ice', payload: { state: 'DISCONNECTED' } });
    expect(id).not.toBeNull();
    listener.remove();
    nativeDesklink.closeSession(id);
});

it('marks presented once: a resize or remount must not re-mark', async () => {
    const { markDesktopPresented, nativeDesklink } = await import('./native.ios');
    const events: string[] = [];
    const id = nativeDesklink.createSession('[]')!;
    const listener = nativeDesklink.addListener!('onSessionEvent', (event) => {
        if (event.sessionId === id) events.push(event.name);
    });
    markDesktopPresented(id);
    markDesktopPresented(id);
    expect(events).toEqual(['presented']);
    listener.remove();
    nativeDesklink.closeSession(id);
});
