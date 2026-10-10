import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
    EngineRefused,
    PROTOCOL_VERSION,
    type EngineCapabilities,
    type EngineEvent,
    type OpenedSession,
    type PointRequest,
    type OpenSessionRequest,
    type SessionMetrics,
} from './protocol.js';

export function windowsEngineStartupError(code: number | null, error?: Error): EngineRefused | null {
    if (process.platform !== 'win32') return null;
    if (code !== null && (code >>> 0) === 0xc0000135) {
        return new EngineRefused('missing-system-library', 'The Windows desktop engine could not load a required DLL (0xC0000135); use a complete Windows engine build with its required runtime libraries.');
    }
    if (error !== undefined) {
        return new EngineRefused('engine-spawn-failed', `The Windows desktop engine could not start: ${error.message}. Check the engine path and Windows application-control policy.`);
    }
    return null;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export interface EngineClientOptions {
    /**
     * Request timeout: an engine that does not answer in time is killed, not
     * waited on. A portal open that may wait on a consent prompt passes its
     * own, longer one to `openSession`.
     */
    requestTimeoutMs?: number;
    /**
     * Push consumer, called with every event as it arrives. Supplying it turns
     * off the `drainEvents` queue, so events are not retained for a reader that
     * never comes.
     */
    onEvent?: (event: EngineEvent) => void;
    /** Called when the engine process goes away, with whatever it said first. */
    onExit?: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void;
    onDiagnostic?: (line: string) => void;
}

/**
 * A consumer of the engine's local control protocol.
 *
 * The engine is this process's child and speaks newline-delimited JSON on
 * stdin/stdout, so the channel inherits this process's own access control: same
 * user, same session, no socket to protect and no second authorization scheme.
 */
export class EngineClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, Pending>();
    private readonly queue: EngineEvent[] = [];
    private nextId = 1;
    private closed = false;
    private stopping = false;
    private readonly timeoutMs: number;

    private constructor(child: ChildProcessWithoutNullStreams, options: EngineClientOptions) {
        this.child = child;
        this.timeoutMs = options.requestTimeoutMs ?? 30_000;

        // A failed write also emits an error on the pipe, independently of
        // its callback. Consume both paths and retire the unusable engine.
        child.stdin.on('error', (error) => this.controlStreamFailed(error));

        const stdout = createInterface({ input: child.stdout });
        stdout.on('line', (line) => this.handleLine(line, options));
        const stderr = createInterface({ input: child.stderr });
        stderr.on('line', (line) => options.onDiagnostic?.(line));
        child.on('exit', (code, signal) => {
            this.closed = true;
            for (const [id, pending] of this.pending) {
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(windowsEngineStartupError(code) ?? new Error('the desktop engine exited'));
            }
            if (!this.stopping) options.onExit?.({ code, signal });
        });
        child.on('error', (error) => {
            this.closed = true;
            options.onDiagnostic?.(`engine process error: ${error.message}`);
            if (process.platform !== 'win32') return;
            for (const [id, pending] of this.pending) {
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(windowsEngineStartupError(null, error) ?? error);
            }
        });
    }

    /** Start an engine process and complete the protocol handshake. */
    static async start(
        command: string,
        args: string[],
        options: EngineClientOptions = {},
        env: NodeJS.ProcessEnv = process.env,
    ): Promise<EngineClient> {
        if (process.platform === 'linux' && args[0] === 'serve') {
            const probe = spawnSync(command, ['version'], { env, encoding: 'utf8', timeout: 3000 });
            const missing = /error while loading shared libraries: ([^:\s]+): cannot open shared object file/.exec(probe.stderr ?? '')?.[1];
            if (missing !== undefined && [
                'libpipewire-0.3.so.0', 'libxkbcommon.so.0', 'libevdev.so.2', 'libstdc++.so.6',
                'libXcursor.so.1', 'libX11.so.6', 'libXext.so.6', 'libwayland-client.so.0', 'libfontconfig.so.1', 'libfreetype.so.6',
            ].includes(missing)) {
                throw new EngineRefused('missing-system-library', `missing system library: ${missing}`);
            }
        }
        const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        if (env.DESKLINK_AXI_ENGINE_PID_FILE && child.pid) {
            try { appendFileSync(env.DESKLINK_AXI_ENGINE_PID_FILE, `${child.pid}\n`); }
            catch (error) { child.kill('SIGKILL'); throw error; }
        }
        const client = new EngineClient(child, options);
        try {
            await client.request('hello', { protocol: PROTOCOL_VERSION });
        } catch (error) {
            // A refused or timed-out handshake must not leave a child running
            // with its exit still wired to the caller's state.
            await client.stop().catch(() => undefined);
            throw error;
        }
        return client;
    }

    private handleLine(line: string, options: EngineClientOptions): void {
        const trimmed = line.trim();
        if (trimmed === '') return;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            options.onDiagnostic?.(`engine sent a line that is not JSON: ${trimmed.slice(0, 200)}`);
            return;
        }
        if (typeof parsed.event === 'string') {
            const event = parsed as unknown as EngineEvent;
            // A consumer that passed `onEvent` is fed every event as it arrives
            // and never reads the queue; retaining them would grow it without
            // bound. The queue exists only for the pull-based `drainEvents`
            // consumer, which opts in by omitting `onEvent`.
            if (options.onEvent === undefined) this.queue.push(event);
            options.onEvent?.(event);
            return;
        }
        const id = typeof parsed.id === 'number' ? parsed.id : undefined;
        if (id === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = parsed.error as { code?: string; message?: string } | undefined;
        if (error !== undefined) {
            pending.reject(new EngineRefused(error.code ?? 'engine', error.message ?? 'the engine refused the request'));
            return;
        }
        pending.resolve(parsed.result);
    }

    /**
     * One request on the engine's protocol.
     *
     * Public because the protocol *is* the contract: a consumer that wants to
     * add a capability the typed helpers do not cover should send it rather than
     * patch this package.
     */
    request<T>(method: string, params?: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error('the desktop engine is not running'));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => this.abandon(timedOut(method, params, timeoutMs)), timeoutMs);
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`, (error) => {
                if (error !== null && error !== undefined) {
                    this.controlStreamFailed(error);
                }
            });
        });
    }

    capabilities(): Promise<EngineCapabilities> {
        return this.request<EngineCapabilities>('capabilities');
    }

    /**
     * `timeoutMs` overrides the client's request timeout for this open alone:
     * a portal open may be waiting on a person at the computer, which takes
     * longer than any other request should.
     */
    openSession(request: OpenSessionRequest, timeoutMs?: number): Promise<OpenedSession> {
        return this.request<OpenedSession>('session.open', {
            ...(request.source === undefined ? {} : { source: request.source }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            ...(request.maxWidth === undefined ? {} : { max_width: request.maxWidth }),
            ...(request.maxHeight === undefined ? {} : { max_height: request.maxHeight }),
            ...(request.bitrateKbps === undefined ? {} : { bitrate_kbps: request.bitrateKbps }),
            ...(request.maxFps === undefined ? {} : { max_fps: request.maxFps }),
            ...(request.iceServers === undefined ? {} : { ice_servers: request.iceServers }),
            ...(request.restoreToken === undefined ? {} : { restore_token: request.restoreToken }),
            ...(request.ttlSeconds === undefined ? {} : { ttl_seconds: request.ttlSeconds }),
            ...(request.loopbackTcp === true ? { loopback_tcp: true } : {}),
            ...(request.agentIndicator === true ? { agent_indicator: true } : {}),
            ...(request.localFrames === false ? { local_frames: false } : {}),
        }, timeoutMs);
    }

    acceptAnswer(sessionId: string, generation: number, sdp: string): Promise<{ accepted: boolean }> {
        return this.request('session.description', {
            session_id: sessionId,
            generation,
            description: { type: 'answer', sdp },
        });
    }

    addCandidate(
        sessionId: string,
        generation: number,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
    ): Promise<{ accepted: boolean }> {
        return this.request('session.candidate', {
            session_id: sessionId,
            generation,
            candidate,
            sdp_mid: sdpMid,
            sdp_m_line_index: sdpMLineIndex,
        });
    }

    metrics(): Promise<SessionMetrics> {
        return this.request<SessionMetrics>('session.metrics');
    }

    readClipboard(sessionId: string): Promise<{ text: string; truncated: boolean }> {
        return this.request('session.clipboard.read', { session_id: sessionId });
    }

    writeClipboard(sessionId: string, text: string): Promise<{ written: boolean }> {
        return this.request('session.clipboard.write', { session_id: sessionId, text });
    }

    /** Show or clear a transient cue on the host, without moving its pointer. */
    point(sessionId: string, request: PointRequest): Promise<{ shown: boolean }> {
        return this.request('session.point', {
            session_id: sessionId,
            ...(request.clear === true ? { clear: true } : {
                x: request.x, y: request.y,
                ...(request.label === undefined ? {} : { label: request.label }),
                ...(request.timeoutMs === undefined ? {} : { timeout_ms: request.timeoutMs }),
            }),
        });
    }

    closeSession(sessionId: string): Promise<{ closed: boolean }> {
        return this.request('session.close', { session_id: sessionId });
    }

    /** Drain notifications received so far, in order. */
    drainEvents(sessionId?: string): EngineEvent[] {
        if (sessionId === undefined) return this.queue.splice(0);
        const selected: EngineEvent[] = [];
        for (const event of this.queue.splice(0)) {
            if (event.params.sessionId === sessionId) selected.push(event);
            else this.queue.push(event);
        }
        return selected;
    }

    private controlStreamFailed(error: NodeJS.ErrnoException): void {
        const reason = new EngineRefused(error.code ?? 'engine-control-stream', error.message);
        reason.cause = error;
        this.abandon(reason);
    }

    /**
     * A broken control pipe leaves no usable request channel. On timeout, the
     * engine answers one request at a time, so the unanswered one is still
     * running inside it — typically a `session.open` waiting on a consent
     * prompt nobody at the desktop is answering. Everything sent after it would
     * queue behind it, and a late answer would open a session nobody owns, so
     * the engine is killed and every waiting request fails with the reason.
     * Its exit is also what withdraws a pending portal prompt: the portal
     * closes every request whose sender left the session bus.
     */
    private abandon(reason: Error): void {
        this.closed = true;
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(reason);
        }
        this.child.kill('SIGKILL');
    }

    async stop(): Promise<void> {
        // Set even for an engine already abandoned: a caller that stops a client
        // is done with it, so its exit is no longer news.
        this.stopping = true;
        if (this.closed && this.child.pid === undefined) return;
        if (!this.closed) {
            // The documented graceful stop: the engine exits without answering,
            // so EOF/timeout below still brings a stuck engine down.
            void this.request('shutdown').catch(() => undefined);
            this.closed = true;
            this.child.stdin.end();
        }
        // Even an abandoned engine remains our child until its exit is reaped.
        const child = this.child;
        await new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

/**
 * A portal `session.open` that runs out of time is waiting on the desktop's
 * consent prompt, so it is refused as `consent-timeout`: a client can tell the
 * user to approve screen sharing on the computer rather than show a raw timeout.
 */
function timedOut(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Error {
    const message = `the desktop engine did not answer ${method} in ${timeoutMs}ms`;
    const source = params?.source as { kind?: unknown } | undefined;
    if (method === 'session.open' && (source === undefined || source.kind === 'portal')) {
        return new EngineRefused('consent-timeout', `${message}; screen sharing was not approved on the computer`);
    }
    return new Error(message);
}
