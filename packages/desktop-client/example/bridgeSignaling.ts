import type { SessionEvent, Signaling } from '@desklink/react-native';

/** The bridge re-serves the engine's local protocol; this unwraps its events for the hook. */
export function bridgeSignaling(address: string, onEvent?: (event: SessionEvent) => void, filter?: (event: SessionEvent) => SessionEvent | null, onRequest?: (method: string, params: Record<string, unknown>) => void, requestFilter?: (method: string, params: Record<string, unknown>) => Record<string, unknown> | null): Signaling & { open: Promise<void>; close: () => void } {
    const socket = new WebSocket(address);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const handlers = new Set<(event: SessionEvent) => void>();
    // The address carries the pairing token, so no error ever names it.
    const transportError = () => Object.assign(new Error('cannot reach the desktop host'), { code: 'transport' });
    let closed = false, seq = 0;
    let rejectOpen!: (error: Error) => void;
    const emit = (event: SessionEvent) => {
        // `null` is the filter's drop, so it must not fall back to the event.
        const kept = filter ? filter(event) : event;
        if (kept === null) return;
        onEvent?.(kept);
        for (const handler of handlers) handler(kept);
    };
    const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        rejectOpen(transportError());
        for (const waiter of pending.values()) waiter.reject(transportError());
        pending.clear();
        emit({ kind: 'carrier-closed' });
    };
    const open = new Promise<void>((resolve, reject) => {
        rejectOpen = reject;
        socket.onopen = () => { if (!closed) { clearTimeout(timeout); resolve(); } };
    });
    // close() can run before authorize() starts awaiting this promise.
    void open.catch(() => undefined);
    const timeout = setTimeout(() => { finish(); socket.close(); }, 5000);
    socket.onerror = () => { finish(); socket.close(); };
    socket.onclose = finish;
    socket.onmessage = (message) => {
        if (closed) return;
        const msg = JSON.parse(String(message.data));
        if (msg.id !== undefined) {
            const waiter = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error !== undefined) waiter?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            else waiter?.resolve(msg.result);
            return;
        }
        const p = msg.params ?? {};
        let event: SessionEvent | null = null;
        if (msg.event === 'session.description') event = { kind: 'description', description: p.description, geometry: p.geometry, sessionId: p.sessionId };
        else if (msg.event === 'session.candidate') event = { kind: 'candidate', candidate: { candidate: p.candidate, sdpMid: p.sdpMid ?? null, sdpMLineIndex: p.sdpMLineIndex ?? null }, sessionId: p.sessionId };
        else if (msg.event === 'session.state') event = { kind: 'state', capture: p.capture, transport: p.transport, firstFrame: p.firstFrame, sessionId: p.sessionId };
        else if (msg.event === 'session.revoked') event = { kind: 'revoked', reason: p.reason, code: p.code, sessionId: p.sessionId };
        if (event !== null) emit(event);
    };
    return {
        open,
        request: async <T,>(method: string, params?: Record<string, unknown>) => {
            if (closed) throw transportError();
            await open;
            if (closed) throw transportError();
            onRequest?.(method, params ?? {});
            const filtered = requestFilter === undefined ? (params ?? {}) : requestFilter(method, params ?? {});
            // A filtered-out request never leaves: the hook ignores the
            // result and only hears failures, so an empty answer stands in.
            if (filtered === null) return {} as T;
            return new Promise<T>((resolve, reject) => {
                const id = ++seq;
                pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
                try { socket.send(JSON.stringify({ id, method, params: filtered })); }
                catch { finish(); socket.close(); }
            });
        },
        subscribe: (handler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        close: () => { finish(); socket.close(); handlers.clear(); },
    };
}
