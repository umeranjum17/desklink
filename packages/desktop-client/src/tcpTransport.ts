import type { NativeDesklinkModule } from './native';

/**
 * A relay-only route for the desktop picture: ICE over TCP carried on the
 * application's own link.
 *
 * A phone that reaches the computer only through the app's own relay link (no
 * shared LAN, no tailnet) gets no picture: signaling crosses the link, but
 * WebRTC media needs its own path. With this transport the kit opens the
 * session with `loopback_tcp`, listens on the phone's own 127.0.0.1, and
 * pipes every accepted connection through the application's stream to the
 * engine's loopback TCP port. The native peer then dials the listener instead
 * of the engine, so the picture and the control channel ride the application's
 * link, still inside DTLS. A client with a UDP path keeps it: ICE prefers UDP
 * whenever it has one.
 *
 * Product-neutral by construction: the kit never names the link, the relay or
 * the app. The consumer supplies a byte stream factory and nothing else.
 */

/**
 * One side of one relayed TCP connection: bytes in either direction.
 *
 * `onData` registers the receiver for bytes from the engine; the returned
 * function unregisters it. `write` queues bytes toward the engine; the kit
 * batches them across the JS bridge. `close` ends this connection; the kit
 * also closes it when the phone's socket or the session goes away.
 */
export interface TcpTransportStream {
    write(data: Uint8Array): void;
    onData(handler: (data: Uint8Array) => void): () => void;
    close(): void;
}

/** Where one relayed connection goes on the computer. */
export interface TcpTransportTarget {
    /**
     * The engine's loopback TCP port this connection is for: the port its
     * candidate offers. The engine picks it per session, so a new session
     * after a failed one names a new port; dial this one, not a remembered one.
     */
    port: number;
}

/**
 * The application's byte stream factory. `open` runs once per TCP connection
 * the phone's listener accepts — usually one per session — and returns its
 * duplex, connected to the engine's loopback TCP port that `target` names. It
 * may be async; while it is pending, bytes from the phone wait in the kit
 * rather than being dropped.
 */
export interface TcpTransport {
    open(target: TcpTransportTarget): TcpTransportStream | Promise<TcpTransportStream>;
}

/** Counters for one relayed session, for evidence and throughput. */
export interface TcpTransportStats {
    /** The phone listener's port, the one the rewritten candidate names. */
    port: number;
    /** Connections the listener has accepted so far. */
    connections: number;
    /** Connections still open. */
    open: number;
    /** Bytes the phone's sockets sent toward the engine. */
    bytesToEngine: number;
    /** Bytes the phone's sockets received from the engine. */
    bytesFromEngine: number;
    /** JS-to-native crossings toward the engine (batched, not per packet). */
    bridgeWrites: number;
    /** Native-to-JS crossings from the engine (batched, not per packet). */
    bridgeEvents: number;
}

/** Bytes after which a JS-to-native batch flushes even before its deadline. */
const BATCH_BYTES = 16384;
/** How long a JS-to-native batch waits for more bytes before flushing. */
const BATCH_MS = 15;

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without dependencies: the kit adds no polyfill for one crossing. */
export function base64Encode(bytes: Uint8Array): string {
    let out = '';
    for (let at = 0; at < bytes.length; at += 3) {
        const a = bytes[at]!;
        const b = at + 1 < bytes.length ? bytes[at + 1]! : 0;
        const c = at + 2 < bytes.length ? bytes[at + 2]! : 0;
        out += BASE64_CHARS[a >> 2] + BASE64_CHARS[((a & 3) << 4) | (b >> 4)];
        out += at + 1 < bytes.length ? BASE64_CHARS[((b & 15) << 2) | (c >> 6)] : '=';
        out += at + 2 < bytes.length ? BASE64_CHARS[c & 63] : '=';
    }
    return out;
}

/** Inverse of `base64Encode`; stray characters are ignored, not rejected. */
export function base64Decode(text: string): Uint8Array {
    const values = new Uint8Array(128).fill(255);
    for (let index = 0; index < BASE64_CHARS.length; index += 1) values[BASE64_CHARS.charCodeAt(index)] = index;
    const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
    const length = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
    const out = new Uint8Array(Math.max(0, length));
    let at = 0;
    for (let index = 0; index + 3 < clean.length + 1; index += 4) {
        const a = values[clean.charCodeAt(index)] ?? 0;
        const b = values[clean.charCodeAt(index + 1)] ?? 0;
        const c = clean[index + 2] === '=' ? 0 : (values[clean.charCodeAt(index + 2)] ?? 0);
        const d = clean[index + 3] === '=' ? 0 : (values[clean.charCodeAt(index + 3)] ?? 0);
        if (at < out.length) out[at] = ((a << 2) | (b >> 4)) & 0xff;
        if (at + 1 < out.length) out[at + 1] = ((b << 4) | (c >> 2)) & 0xff;
        if (at + 2 < out.length) out[at + 2] = ((c << 6) | d) & 0xff;
        at += 3;
    }
    return out;
}

/**
 * Whether this candidate line is the engine's loopback TCP offer: TCP to its
 * own 127.0.0.1. Only that line is ever rewritten; anything else — UDP host
 * candidates, relay candidates — passes through untouched.
 */
export function isLoopbackTcpCandidate(candidate: string): boolean {
    const fields = candidate.trim().replace(/^a=/, '').trim().split(/\s+/);
    if (fields.length < 6 || !fields[0]?.startsWith('candidate:')) return false;
    return fields[2]?.toLowerCase() === 'tcp' && fields[4] === '127.0.0.1';
}

/**
 * The engine port a loopback TCP candidate offers, or 0 for any other line and
 * for ICE's throwaway discard port, which nothing listens on.
 */
function loopbackTcpPort(candidate: string): number {
    if (!isLoopbackTcpCandidate(candidate)) return 0;
    const port = Number(candidate.trim().replace(/^a=/, '').trim().split(/\s+/)[5]);
    return Number.isInteger(port) && port >= 1024 ? port : 0;
}

/**
 * Point one loopback TCP candidate at the phone listener's port. A line that
 * is not the engine's loopback TCP offer is returned unchanged, as is ICE's
 * throwaway discard port: rewriting it would dial the listener for a
 * candidate nothing listens on.
 */
export function rewriteLoopbackTcpCandidate(candidate: string, port: number): string {
    if (!Number.isInteger(port) || port <= 0) return candidate;
    const enginePort = loopbackTcpPort(candidate);
    if (enginePort === 0 || enginePort === port) return candidate;
    const prefixed = candidate.startsWith('a=');
    const fields = candidate.trim().replace(/^a=/, '').trim().split(/\s+/);
    const rewritten = [...fields.slice(0, 5), String(port), ...fields.slice(6)].join(' ');
    return prefixed ? `a=${rewritten}` : rewritten;
}

/**
 * Point every loopback TCP candidate in an SDP offer at the phone listener's
 * port. The engine's offer carries its own loopback port, so without this the
 * peer would dial the engine's port on the phone's loopback and never connect.
 */
export function rewriteLoopbackTcpSdp(sdp: string, port: number): string {
    if (!(port > 0)) return sdp;
    return sdp
        .split(/\r?\n/)
        .map((line) => (line.startsWith('a=candidate:') ? `a=${rewriteLoopbackTcpCandidate(line.slice(2), port)}` : line))
        .join('\r\n');
}

interface BridgeConnection {
    stream: TcpTransportStream | null;
    release: (() => void) | null;
    pending: Uint8Array[];
    pendingBytes: number;
    timer: ReturnType<typeof setTimeout> | null;
    open: boolean;
    /** Bytes from the phone that arrived while `open()` was still pending. */
    early: Uint8Array[];
}

/**
 * The JS side of the relay: one phone listener per session, one consumer
 * stream per accepted connection, batched crossings in both directions.
 *
 * Native-to-JS batches arrive already batched (the native reader flushes by
 * size or deadline), so `receive` delivers at once. JS-to-native batches are
 * assembled here: every `tcpWrite` crossing carries up to `BATCH_BYTES`, so a
 * video stream that would otherwise call the bridge per packet crosses in a
 * handful of calls per second instead.
 */
export class TcpBridge {
    private readonly native: NativeDesklinkModule;
    private readonly sessionId: string;
    private readonly transport: TcpTransport;
    private readonly connections = new Map<number, BridgeConnection>();
    private stopped = false;
    /** The engine port this session's candidate offers, for `open`. */
    private enginePort = 0;
    /** JS-to-native crossings so far. */
    private writes = 0;
    /** Native-to-JS crossings so far. */
    private events = 0;
    readonly port: number;

    private constructor(native: NativeDesklinkModule, sessionId: string, transport: TcpTransport, port: number) {
        this.native = native;
        this.sessionId = sessionId;
        this.transport = transport;
        this.port = port;
    }

    /**
     * Bind the phone listener. Null when this build cannot carry it — the
     * caller then refuses the session rather than opening one with no path.
     */
    static start(native: NativeDesklinkModule, sessionId: string, transport: TcpTransport): TcpBridge | null {
        if (native.startTcpBridge == null) return null;
        const port = native.startTcpBridge(sessionId);
        if (port == null || !(port > 0)) return null;
        return new TcpBridge(native, sessionId, transport, port);
    }

    /**
     * The engine's offer for the phone: its loopback TCP candidates point at
     * this listener, and the engine port they named is what `open` dials.
     */
    rewriteSdp(sdp: string): string {
        for (const line of sdp.split(/\r?\n/)) {
            if (line.startsWith('a=candidate:')) this.enginePort = loopbackTcpPort(line) || this.enginePort;
        }
        return rewriteLoopbackTcpSdp(sdp, this.port);
    }

    /** One trickled engine candidate for the phone, as `rewriteSdp` does. */
    rewriteCandidate(candidate: string): string {
        this.enginePort = loopbackTcpPort(candidate) || this.enginePort;
        return rewriteLoopbackTcpCandidate(candidate, this.port);
    }

    /** A phone socket was accepted: open its consumer stream. */
    accept(connection: number): void {
        if (this.stopped || this.connections.has(connection)) return;
        const entry: BridgeConnection = { stream: null, release: null, pending: [], pendingBytes: 0, timer: null, open: true, early: [] };
        this.connections.set(connection, entry);
        void (async () => {
            try {
                const stream = await this.transport.open({ port: this.enginePort });
                if (this.stopped || !entry.open) {
                    stream.close();
                    return;
                }
                for (const bytes of entry.early.splice(0)) stream.write(bytes);
                entry.stream = stream;
                entry.release = stream.onData((data) => this.send(connection, data));
            } catch {
                this.drop(connection);
            }
        })();
    }

    /** Bytes from the phone's socket, already batched natively: deliver. */
    receive(connection: number, data: string): void {
        if (this.stopped) return;
        const entry = this.connections.get(connection);
        if (entry == null || !entry.open) return;
        this.events += 1;
        const bytes = base64Decode(data);
        if (entry.stream == null) entry.early.push(bytes);
        else entry.stream.write(bytes);
    }

    /** The phone's socket closed: end its consumer stream. */
    remoteClosed(connection: number): void {
        const entry = this.connections.get(connection);
        if (entry == null) return;
        this.connections.delete(connection);
        this.flush(connection, entry);
        entry.open = false;
        entry.release?.();
        entry.stream?.close();
    }

    /** Queue bytes toward the engine, flushing in batches, not per packet. */
    private send(connection: number, data: Uint8Array): void {
        if (this.stopped || data.length === 0) return;
        const entry = this.connections.get(connection);
        if (entry == null || !entry.open) return;
        entry.pending.push(data);
        entry.pendingBytes += data.length;
        if (entry.pendingBytes >= BATCH_BYTES) {
            this.flush(connection, entry);
            return;
        }
        entry.timer ??= setTimeout(() => {
            const live = this.connections.get(connection);
            if (live != null) this.flush(connection, live);
        }, BATCH_MS);
    }

    private flush(connection: number, entry: BridgeConnection): void {
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        if (entry.pending.length === 0) return;
        const joined = new Uint8Array(entry.pendingBytes);
        let at = 0;
        for (const chunk of entry.pending.splice(0)) {
            joined.set(chunk, at);
            at += chunk.length;
        }
        entry.pendingBytes = 0;
        if (this.stopped || !entry.open) return;
        this.writes += 1;
        this.native.tcpWrite?.(this.sessionId, connection, base64Encode(joined));
    }

    private drop(connection: number): void {
        const entry = this.connections.get(connection);
        if (entry != null) {
            this.connections.delete(connection);
            entry.open = false;
        }
        this.native.tcpClose?.(this.sessionId, connection);
    }

    /** End every stream and the listener; the session is going away. */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const entry of this.connections.values()) {
            if (entry.timer !== null) clearTimeout(entry.timer);
            entry.open = false;
            entry.release?.();
            entry.stream?.close();
        }
        this.connections.clear();
        this.native.stopTcpBridge?.(this.sessionId);
    }

    /** Merge the native socket counters with this side's crossing counts. */
    async stats(): Promise<TcpTransportStats> {
        let remote: { connections?: number; open?: number; bytesToEngine?: number; bytesFromEngine?: number } = {};
        try {
            remote = JSON.parse((await this.native.getTcpBridgeStats?.(this.sessionId)) ?? '{}') as typeof remote;
        } catch {
            remote = {};
        }
        return {
            port: this.port,
            connections: typeof remote.connections === 'number' ? remote.connections : this.connections.size,
            open: typeof remote.open === 'number' ? remote.open : this.connections.size,
            bytesToEngine: typeof remote.bytesToEngine === 'number' ? remote.bytesToEngine : 0,
            bytesFromEngine: typeof remote.bytesFromEngine === 'number' ? remote.bytesFromEngine : 0,
            bridgeWrites: this.writes,
            bridgeEvents: this.events,
        };
    }
}
