import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import type { NativeDesklinkModule, NativeSessionEvent } from './native';

/**
 * The WebRTC stack, loaded the first time a session opens rather than with
 * this module: importing the package must not pull the native WebRTC
 * libraries into the application's first paint. `globalThis.require` is the
 * bundler's lazy require on device; under test the spec stubs it.
 */
function loadWebRTC(): { RTCPeerConnection: new (config: unknown) => RTCPeerConnection; MediaStream: new () => MediaStream } | null {
    try {
        const lazyRequire = (globalThis as { require?: (id: string) => unknown }).require;
        if (typeof lazyRequire !== 'function') return null;
        return lazyRequire('react-native-webrtc') as {
            RTCPeerConnection: new (config: unknown) => RTCPeerConnection;
            MediaStream: new () => MediaStream;
        };
    } catch {
        return null;
    }
}

type Session = {
    peer: RTCPeerConnection;
    channel: ReturnType<RTCPeerConnection['createDataChannel']> | null;
    stream: MediaStream | null;
    input: boolean;
    seq: number;
    closed: boolean;
    presented: boolean;
    candidates: Array<{ candidate: string; sdpMid: string | null; sdpMLineIndex: number }>;
    remoteSet: boolean;
};

const sessions = new Map<string, Session>();
const listeners = new Set<(event: NativeSessionEvent) => void>();
const surfaces = new Set<() => void>();
const sizes = new Map<string, { width: number; height: number }>();
let nextId = 0;

function emit(sessionId: string, name: NativeSessionEvent['name'], payload: Record<string, unknown> = {}) {
    if (!sessions.has(sessionId) && name !== 'closed') return;
    for (const listener of listeners) listener({ sessionId, name, payload });
}

function notifySurface() {
    for (const listener of surfaces) listener();
}

export function getDesktopStream(id: string | null): MediaStream | null {
    return id == null ? null : sessions.get(id)?.stream ?? null;
}

export function getDesktopSize(id: string | null) {
    return id == null ? null : sizes.get(id) ?? null;
}

export function observeDesktopSurface(listener: () => void): () => void {
    surfaces.add(listener);
    return () => surfaces.delete(listener);
}

export function markDesktopPresented(id: string) {
    // A resize or a remount must not re-mark: readiness is the first frame,
    // and a second mark during `reconnecting` would wrongly read as `live`.
    const session = sessions.get(id);
    if (!session || session.presented) return;
    session.presented = true;
    emit(id, 'presented');
}

export function desktopInputEnabled(id: string | null): boolean {
    return id != null && sessions.get(id)?.input === true;
}

function failure(id: string, error: unknown) {
    emit(id, 'failure', { code: 'transport', message: error instanceof Error ? error.message : String(error) });
}

export const nativeDesklink: NativeDesklinkModule = {
    createSession(iceServersJson) {
        const id = `desklink-${++nextId}`;
        try {
            const webrtc = loadWebRTC();
            if (!webrtc) return null;
            const peer = new webrtc.RTCPeerConnection({ iceServers: JSON.parse(iceServersJson) });
            const session: Session = { peer, channel: null, stream: null, input: false, seq: 0, closed: false, presented: false, candidates: [], remoteSet: false };
            sessions.set(id, session);
            peer.onicecandidate = (event) => {
                if (event.candidate) emit(id, 'candidate', {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                });
            };
            peer.oniceconnectionstatechange = () => {
                emit(id, 'ice', { state: peer.iceConnectionState.toUpperCase() });
                if (peer.iceConnectionState === 'failed') failure(id, 'the connection to the desktop was lost');
            };
            peer.ontrack = (event) => {
                if (session.closed || event.track.kind !== 'video') return;
                const stream = event.streams[0] ?? new webrtc.MediaStream();
                if (event.streams.length === 0) stream.addTrack(event.track);
                session.stream = stream;
                notifySurface();
                emit(id, 'track');
            };
            peer.ondatachannel = (event) => {
                if (session.closed) return;
                const channel = event.channel;
                session.channel = channel;
                channel.onopen = () => emit(id, 'channel', { state: 'OPEN' });
                channel.onclose = () => emit(id, 'channel', { state: 'CLOSED' });
                channel.onmessage = (message) => emit(id, 'control', { message: message.data });
            };
            queueMicrotask(() => emit(id, 'ready'));
            return id;
        } catch {
            return null;
        }
    },
    setRemoteDescription(id, type, sdp) {
        const session = sessions.get(id);
        if (!session) return false;
        if (type !== 'offer') { failure(id, 'the engine must send an offer'); return false; }
        void (async () => {
            try {
                await session.peer.setRemoteDescription({ type: 'offer', sdp });
                if (session.closed) return;
                session.remoteSet = true;
                for (const candidate of session.candidates.splice(0)) await session.peer.addIceCandidate(candidate);
                const answer = await session.peer.createAnswer();
                await session.peer.setLocalDescription(answer);
                if (!session.closed) emit(id, 'answer', { sdp: session.peer.localDescription?.sdp ?? answer.sdp });
            } catch (error) { if (!session.closed) failure(id, error); }
        })();
        return true;
    },
    addRemoteCandidate(id, candidate, sdpMid, sdpMLineIndex) {
        const session = sessions.get(id);
        if (!session) return false;
        const ice = { candidate, sdpMid, sdpMLineIndex: sdpMLineIndex ?? 0 };
        if (!session.remoteSet) session.candidates.push(ice);
        else void session.peer.addIceCandidate(ice).catch((error) => failure(id, error));
        return true;
    },
    sendControl(id, message) {
        const session = sessions.get(id);
        if (!session || session.closed || session.channel?.readyState !== 'open') return false;
        try {
            const control = JSON.parse(message) as Record<string, unknown>;
            if (!session.input && ['pointer', 'wheel', 'key', 'text', 'clipboard_read', 'clipboard_write'].includes(String(control.kind))) return false;
            session.channel.send(JSON.stringify({ ...control, seq: ++session.seq }));
            return true;
        } catch (error) { failure(id, error); return false; }
    },
    setInputEnabled(id, enabled) {
        const session = sessions.get(id);
        if (!session) return false;
        session.input = enabled;
        if (!enabled) nativeDesklink.sendControl(id, '{"kind":"release_all"}');
        notifySurface();
        return true;
    },
    showKeyboard(id) { keyboardActions.get(id)?.show(); return true; },
    hideKeyboard(id) { keyboardActions.get(id)?.hide(); return true; },
    captureKeyboard(id, captured) { keyboardActions.get(id)?.capture(captured); return true; },
    // iOS rotation belongs to the application's supported orientations; this
    // receiver cannot override its Info.plist at runtime.
    setOrientation() { return false; },
    setSurfaceSize(id, width, height) {
        if (!sessions.has(id) || width <= 0 || height <= 0) return false;
        sizes.set(id, { width, height });
        surfaceActions.get(id)?.size(width, height);
        return true;
    },
    fitToView(id) { surfaceActions.get(id)?.fit(); return true; },
    closeSession(id) {
        const session = sessions.get(id);
        if (!session) return true;
        session.closed = true;
        session.channel?.close();
        session.peer.close();
        sessions.delete(id);
        sizes.delete(id);
        keyboardActions.delete(id);
        surfaceActions.delete(id);
        notifySurface();
        for (const listener of listeners) listener({ sessionId: id, name: 'closed', payload: {} });
        return true;
    },
    isAvailable() { return true; },
    addListener(_name, handler) { listeners.add(handler); return { remove: () => { listeners.delete(handler); } }; },
};

export const desktopAvailable = true;

type KeyboardActions = { show: () => void; hide: () => void; capture: (value: boolean) => void };
type SurfaceActions = { size: (width: number, height: number) => void; fit: () => void };
const keyboardActions = new Map<string, KeyboardActions>();
const surfaceActions = new Map<string, SurfaceActions>();
export function registerDesktopView(id: string, keyboard: KeyboardActions, surface: SurfaceActions): () => void {
    keyboardActions.set(id, keyboard);
    surfaceActions.set(id, surface);
    const size = sizes.get(id);
    if (size) surface.size(size.width, size.height);
    return () => {
        if (keyboardActions.get(id) === keyboard) keyboardActions.delete(id);
        if (surfaceActions.get(id) === surface) surfaceActions.delete(id);
        nativeDesklink.sendControl(id, '{"kind":"release_all"}');
    };
}
export function emitDesktopKeyboard(id: string, payload: Record<string, unknown>) { emit(id, 'keyboard', payload); }
