/**
 * A consumer-facing transport for the engine's local protocol.
 *
 * The engine speaks newline-delimited JSON on stdio, which is the right shape
 * for a consumer that already holds the process. A consumer whose client is on
 * another machine needs something to carry that protocol further, and inventing
 * one is exactly the work this package is supposed to remove. `Bridge` re-serves
 * the same protocol over a WebSocket, so a browser, a phone or a script connects
 * with nothing but a WebSocket.
 *
 * This is a *consumer-side* convenience, not engine surface: the engine still
 * has no listener, and the bridge is started by whoever owns the machine.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

import { EngineClient, type EngineClientOptions } from './engineProcess.js';
import type { EngineEvent, SourceRequest } from './protocol.js';

export interface BridgeOptions {
    /** Address to listen on, e.g. `127.0.0.1:19400` or `0.0.0.0:19400`. */
    listen: string;
    /**
     * Pairing credential: holding it grants all available view, input and
     * clipboard access. Stop the bridge to revoke live and future access.
     * Required, not optional; `ws://` is plaintext.
     */
    token: string;
    engineCommand: string;
    engineArgs: string[];
    /** Serve the reference client page at `/?token=…` so the bridge is usable at once. */
    serveExample?: boolean;
    /**
     * Which desktop this bridge offers. A bridge is bound to one machine and one
     * desktop, and the client on the other end has no way to know whether that
     * machine has a working screen-cast portal, so the choice belongs here.
     */
    source?: SourceRequest;
    engineOptions?: EngineClientOptions;
    /** Keep a detached session in memory for this long; 0 closes immediately. */
    reattachMs?: number;
}

/** The path a client connects to: `/desktop?token=…`. */
export const BRIDGE_PATH = '/desktop';

/**
 * The reference client, served as one file with no build step. It is the
 * smallest thing that shows a desktop in a browser, and it doubles as the worked
 * example an application can read instead of reverse-engineering the protocol.
 */
function examplePage(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', 'examples', 'reference-client.html'), 'utf8');
}

export class Bridge {
    private closing = false;
    private reattachTimer: ReturnType<typeof setTimeout> | undefined;
    private revoked: Extract<EngineEvent, { event: 'session.revoked' }> | undefined;
    /** The session the engine holds, so a consumer that vanishes can release it. */
    private session: { sessionId: string; generation?: number } | undefined;

    private constructor(
        private readonly server: Server,
        private readonly sockets: WebSocketServer,
        private readonly engine: EngineClient,
        private readonly defaultSource: SourceRequest | undefined,
        private readonly localFrames: boolean,
        private readonly reattachMs: number,
    ) {}

    static async start(options: BridgeOptions): Promise<Bridge> {
        if (!Number.isFinite(options.reattachMs ?? 30_000) || (options.reattachMs ?? 30_000) < 0) throw new Error('reattachMs must be a nonnegative finite number');
        if (options.token.trim() === '') throw new Error('the bridge token must not be blank');
        let bridge: Bridge | undefined;
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            // The page is served only to a caller that already has the token: an
            // unauthenticated page that connects to a desktop would be a worse
            // secret than the socket itself.
            if (!bridge?.closing && options.serveExample !== false && url.pathname === '/' && url.searchParams.get('token') === options.token) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                response.end(examplePage());
                return;
            }
            response.writeHead(404);
            response.end('not found');
        });
        const sockets = new WebSocketServer({
            server,
            path: BRIDGE_PATH,
            // The token in the URL is the whole authorisation for this socket.
            // It is deliberately checked here rather than in the first message:
            // an unauthenticated socket must not be able to reach the engine at
            // all, not merely be refused an answer.
            verifyClient: ((info: { req: IncomingMessage }) => {
                const url = new URL(info.req.url ?? '/', 'http://localhost');
                return !bridge?.closing && url.searchParams.get('token') === options.token;
            }) as VerifyClientCallbackSync<IncomingMessage>,
        });

        const engine = await EngineClient.start(options.engineCommand, options.engineArgs, {
            ...(options.engineOptions ?? {}),
            // Grant credentials stay with the host; session notifications go
            // to the attached controllers watching this session.
            onEvent: (event) => {
                bridge?.rememberEvent(event);
                options.engineOptions?.onEvent?.(event);
                if (event.event === 'session.restoreToken' || event.event === 'session.frame.changed') return;
                const line = JSON.stringify(event);
                for (const socket of sockets.clients) {
                    if (socket.readyState === socket.OPEN) socket.send(line);
                }
            },
        });

        bridge = new Bridge(server, sockets, engine, options.source, options.engineOptions?.onEvent !== undefined, options.reattachMs ?? 30_000);
        sockets.on('connection', (socket) => bridge?.attach(socket));

        const address = splitAddress(options.listen);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(address.port, address.host, () => resolve());
        });
        return bridge;
    }

    /** The port actually bound, which matters when the caller asked for `:0`. */
    get port(): number {
        const address = this.server.address();
        return typeof address === 'object' && address !== null ? address.port : 0;
    }

    private attach(socket: WebSocket): void {
        this.clearReattachTimer();
        if (this.revoked !== undefined) {
            socket.send(JSON.stringify(this.revoked));
            this.revoked = undefined;
        }
        socket.on('message', (raw) => {
            if (this.closing) return;
            let request: { id?: number; method?: string; params?: Record<string, unknown> };
            try {
                request = JSON.parse(String(raw)) as typeof request;
            } catch {
                socket.send(JSON.stringify({ error: { code: 'malformed', message: 'not JSON' } }));
                return;
            }
            if (request === null || typeof request !== 'object' || Array.isArray(request)) {
                socket.send(JSON.stringify({ error: { code: 'malformed', message: 'expected a request object' } }));
                return;
            }
            const method = request.method;
            if (typeof method !== 'string') return;
            if (method === 'session.frame') {
                socket.send(JSON.stringify({ id: request.id, error: { code: 'operation', message: 'session.frame is local-only' } }));
                return;
            }
            if (method === 'session.open' && request.params != null && Object.prototype.hasOwnProperty.call(request.params, 'source')) {
                socket.send(JSON.stringify({ id: request.id, error: { code: 'source', message: 'the client cannot choose the desktop source' } }));
                return;
            }
            // Nothing past the socket can read local frames, so the engine keeps
            // them only for a host that listens to its events.
            const params = method === 'session.open'
                ? {
                    ...(request.params ?? {}),
                    ...(this.defaultSource !== undefined ? { source: this.defaultSource } : {}),
                    local_frames: this.localFrames,
                }
                : request.params;
            void this.engine
                .request<Record<string, unknown>>(method, params)
                .then((result) => {
                    this.rememberSession(method, result);
                    const forwarded = this.defaultSource?.kind === 'x11'
                        && (method === 'hello' || method === 'capabilities')
                        && result !== null && result.clipboard !== null && typeof result.clipboard === 'object'
                        ? { ...result, clipboard: { ...result.clipboard, read: true, write: true } }
                        : result;
                    if (method === 'session.open' && socket.readyState !== socket.OPEN) {
                        this.releaseSessionIfDetached(true);
                        return;
                    }
                    if (request.id !== undefined && socket.readyState === socket.OPEN) {
                        socket.send(JSON.stringify({ id: request.id, result: forwarded }));
                    }
                })
                .catch((error: unknown) => {
                    if (request.id === undefined || socket.readyState !== socket.OPEN) return;
                    socket.send(JSON.stringify({
                        id: request.id,
                        error: {
                            code: (error as { code?: string }).code ?? 'engine',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    }));
                });
        });

        // Carrier loss keeps the session briefly for reattachment. Input release
        // is independent: the private 12s outage proof measured release within
        // 4.6s on peer disconnect; control-channel loss also releases input.
        // Neither waits for the bridge's 30s retention deadline.
        const release = (): void => this.releaseSessionIfDetached();
        socket.on('close', release);
        socket.on('error', release);
    }

    private rememberSession(method: string, result: unknown): void {
        if (method === 'session.close') {
            this.clearReattachTimer();
            this.revoked = undefined;
            this.session = undefined;
            return;
        }
        if (method !== 'session.open') return;
        const opened = result as { sessionId?: unknown; generation?: unknown } | null;
        if (typeof opened?.sessionId !== 'string') return;
        this.clearReattachTimer();
        this.revoked = undefined;
        this.session = typeof opened.generation === 'number'
            ? { sessionId: opened.sessionId, generation: opened.generation }
            : { sessionId: opened.sessionId };
    }

    private clearReattachTimer(): void {
        clearTimeout(this.reattachTimer);
        this.reattachTimer = undefined;
    }

    private rememberEvent(event: EngineEvent): void {
        if (event.params.sessionId !== this.session?.sessionId) return;
        if (event.event === 'session.revoked') {
            if (this.sockets.clients.size === 0) this.revoked = event;
        } else if (event.event !== 'session.state' || event.params.capture !== 'ended') {
            return;
        }
        this.clearReattachTimer();
        this.session = undefined;
    }

    private releaseSessionIfDetached(force = false): void {
        if (this.closing || (!force && this.sockets.clients.size > 0)) return;
        const session = this.session;
        if (session === undefined) return;
        if (!force && this.reattachMs > 0) {
            if (this.reattachTimer !== undefined) return;
            this.reattachTimer = setTimeout(() => {
                this.reattachTimer = undefined;
                if (this.sockets.clients.size === 0 && this.session?.sessionId === session.sessionId) {
                    this.releaseSessionIfDetached(true);
                }
            }, this.reattachMs);
            return;
        }
        this.clearReattachTimer();
        this.revoked = undefined;
        this.session = undefined;
        void this.engine
            .request('session.close', {
                session_id: session.sessionId,
                ...(session.generation !== undefined ? { generation: session.generation } : {}),
            })
            .catch(() => undefined);
    }

    async close(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        this.clearReattachTimer();
        this.revoked = undefined;
        const listenerClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
        await this.engine.stop().catch(() => undefined);
        this.session = undefined;
        for (const socket of this.sockets.clients) socket.close();
        const timer = setTimeout(() => {
            for (const socket of this.sockets.clients) socket.terminate();
        }, 1000);
        await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
        clearTimeout(timer);
        this.server.closeAllConnections();
        await listenerClosed;
    }
}

function splitAddress(listen: string): { host: string; port: number } {
    const index = listen.lastIndexOf(':');
    if (index <= 0) return { host: '127.0.0.1', port: Number(listen) || 0 };
    return { host: listen.slice(0, index), port: Number(listen.slice(index + 1)) || 0 };
}
