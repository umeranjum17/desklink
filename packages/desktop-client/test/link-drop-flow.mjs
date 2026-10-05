// Flow check for a network drop mid-session: a real engine on a private Xvfb,
// the real `@desklink/react-native` hook and web binding in a driver page, real
// Chromium, and the WebRTC link between them shaped by a userspace UDP relay
// that throttles, cuts and restores it.
//
// How the link is shaped, stated plainly because it matters: the drop is a
// **userspace-shaped link** — a `dgram` relay this flow owns, sitting between
// the browser's ICE agent and the engine's, forwarding every datagram itself
// and choosing what to do with it (forward now, forward after a delay, or
// discard). It is NOT kernel netem, NOT tc, NOT an iptables or nftables rule,
// and nothing is privileged: no sudo, no root, no firewall rule, no change to
// the host's own firewall. Every shape the run reports was produced by this
// process dropping or delaying its own datagrams, and the receipt carries the
// relay's own counters as the evidence of that.
//
// What each side proves:
//
//  - the client notices: when the link stops carrying anything, the hook's
//    status leaves `live` within seconds while the page stays alive and keeps
//    the last picture mounted — it does not hang, and it does not die;
//  - the client recovers: once the relay forwards again, decoded frames
//    advance again, the status returns to `live`, and the rendered picture is
//    the live desktop again (its moving marker came back, and it is not black);
//  - the control channel: a pointer the page sends after the recovery lands on
//    the real X display, read from the fixture app's own event log.
//
// The signalling channel (the WebSocket an app would hold) is deliberately NOT
// cut: it is the application's channel, and the client's recovery surface is
// the ICE restart and reopen it drives over it. What is cut is the WebRTC link
// itself — media and data channel both — which is what a dropped network means
// for a desktop already being shown.
//
// Usage:
//
//   node packages/desktop-client/test/link-drop-flow.mjs [evidence-dir]
//
// Environment:
//
//   DESKLINK_AXI_ENGINE   engine binary (default: the debug build here)
//   DESKLINK_VERIFY_TARGET
//                        the x11_target fixture (default: the debug example)
//   DESKLINK_CHROME       browser binary (default: /usr/lib/chromium/chromium,
//                        then /usr/bin/chromium)
//   DESKLINK_REQUIRE_CHROME=1
//                        make a missing browser fail instead of skip
//
// Needs `npm run build` (packages/desktop-host/dist) and the x11_target example
// built. A machine with no Chromium skips with a printed reason and a passing
// exit: this proof shapes a real ICE agent, so it cannot run without one.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

import {
    assertNoAmbientDesktop,
    claimPrivateDisplay,
    stopOwnedXvfb,
    trackOwnedXvfb,
    verifyOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(worktree, 'packages/desktop-client/src');
const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * How long the link stays cut.
 *
 * Long enough that the client cannot mistake it for a blip — it notices, it
 * starts recovering, and it is still recovering when the link comes back —
 * short enough that the engine has not yet declared the path lost and revoked
 * the session, which is the hard case the reopen path covers and which this
 * proof leaves to the existing host-silence flow.
 */
const CUT_MS = 8_000;

/** The whole run may take this long before it is a failure, not a hang. */
setTimeout(() => {
    console.error('OVERALL TIMEOUT: the flow did not finish');
    process.exit(2);
}, 6 * 60_000).unref?.();

// ---------------------------------------------------------------- binaries ---
const firstExisting = (...candidates) =>
    candidates.filter((candidate) => candidate !== undefined && candidate !== '').find((path) => existsSync(path)) ?? null;

function engineBinary() {
    const found = firstExisting(process.env.DESKLINK_AXI_ENGINE, join(worktree, 'packages/desktop-host/engine/target/debug/desklink-host'));
    assert(found, 'no engine binary; build it or set DESKLINK_AXI_ENGINE');
    return found;
}
function fixtureBinary() {
    const found = firstExisting(process.env.DESKLINK_VERIFY_TARGET, join(worktree, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
    assert(found, 'no x11_target fixture; cargo build --example x11_target or set DESKLINK_VERIFY_TARGET');
    return found;
}
const browserBinary = () => firstExisting(process.env.DESKLINK_CHROME, '/usr/lib/chromium/chromium', '/usr/bin/chromium');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// ------------------------------------------------------- the shaped link ----
/**
 * One candidate line, as the fields this relay needs.
 *
 * `candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type>`
 * — everything after `typ` is carried through untouched, so an extension this
 * flow has never heard of cannot cost the candidate.
 */
function parseCandidate(line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || !parts[0].startsWith('candidate:') || parts[6] !== 'typ') return null;
    const port = Number(parts[5]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { foundation: parts[0], component: parts[1], proto: parts[2], priority: parts[3], ip: parts[4], port, type: parts[7], rest: parts.slice(8) };
}

const renderCandidate = (candidate, ip, port) =>
    [candidate.foundation, candidate.component, candidate.proto, candidate.priority, ip, String(port), 'typ', candidate.type, ...candidate.rest].join(' ');

/** Loopback and every local IPv4 address, so a candidate can be checked before it is trusted. */
function localAddresses() {
    const found = new Set(['127.0.0.1']);
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address);
        }
    }
    return found;
}

/**
 * The userspace link: a datagram relay this process owns, in the middle of the
 * browser's ICE agent and the engine's.
 *
 * It touches no kernel traffic control, no firewall and no privileged path. It
 * holds the sockets, so it decides per datagram and per direction whether the
 * datagram is forwarded now, forwarded after `delayMs`, or discarded. That is
 * the whole of the shaping, and `counters` is the record of what it did.
 *
 * Two sockets, and why each one can only ever carry one direction is worth
 * writing down, because the obvious design is wrong in a way that only shows up
 * after a drop. An advertised address is where its peer sends, and the far end
 * then treats whatever comes back from that address as that peer's answer. So a
 * socket that both receives from one peer and sends to it, out of itself, will
 * eventually receive that peer's own packets and have no way to tell them from
 * the other peer's. Before a cut the session is already established and the
 * mistake costs nothing; after a cut it bounces the browser's traffic back to
 * the browser and the recovery can never complete.
 *
 * So each direction has a socket of its own and every datagram leaves from the
 * *other* one:
 *
 *   `toEngine` — advertised to the BROWSER as the engine's candidate. Only the
 *                browser ever learns this address, so only the browser's packets
 *                arrive here. They go to the engine, out of `toBrowser`.
 *   `toBrowser` — advertised to the ENGINE as the browser's candidate. Only the
 *                engine ever learns this address, so only the engine's packets
 *                arrive here — both its own checks and its replies to what this
 *                relay forwarded for it. They go to the browser, out of
 *                `toEngine`.
 *
 * Nothing is told which of the two belongs to it, so nothing can be answered
 * on the wrong socket and no direction has to be guessed from a source address.
 *
 * Both peers' real addresses are read at send time, never captured when a
 * socket was made: an ICE restart makes the engine rebind, and a relay that
 * remembered the old port would forward into nothing after a recovery, failing
 * this proof for a reason that has nothing to do with the client.
 */
class ShapedLink {
    /** The socket each direction is sent from, and the ports they are advertised on. */
    #out = { toEngine: null, toBrowser: null };
    #ports = null;
    /** Candidates are taken one at a time, in arrival order. */
    #queue = Promise.resolve();
    /** How many packets running the latest browser address has sent. */
    #seen = null;

    constructor() {
        this.counters = { toEngine: 0, toBrowser: 0, delayed: 0, discarded: 0, unroutable: 0 };
        /** `{}` forwards at once, `{ delayMs }` slows it, `{ discard: true }` drops it. */
        this.shape = {};
        /** The engine candidate the relay forwards to, per generation. */
        this.host = null;
        /** Where the browser really is, learned from the packets it sends. */
        this.browser = null;
        this.sockets = new Set();
        /** Every shape change, with the counters it started from. */
        this.marks = [];
        /** Delayed sends still waiting for their delay when the run ends. */
        this.timers = new Set();
        this.local = localAddresses();
    }

    /** A one-line account of what the link is doing, for a run that stalls. */
    report(why) {
        log(`link ${why}: ${JSON.stringify(this.counters)}; host ${this.host?.ip ?? '-'}:${this.host?.port ?? '-'} browser ${this.browser?.ip ?? '-'}:${this.browser?.port ?? '-'}`);
    }

    /**
     * A new `session.open` from the client.
     *
     * A session is the unit the engine commits its peers within, so this is
     * where the one-candidate-per-session counters go back to their start. The
     * engine's own candidate is not reset: an ICE restart inside a session is
     * not a new session, and the relay must keep following the same socket.
     */
    newSession() {
        this.browserAdvertised = false;
        this.#seen = null;
    }

    /** Adopt a shape and record when it happened, so the receipt shows the order. */
    set(shape, why) {
        this.marks.push({ at: Date.now(), why, shape: { ...shape }, countersBefore: { ...this.counters } });
        this.shape = shape;
        log(`link → ${JSON.stringify(shape)} (${why})`);
    }

    #listen(socket) {
        return new Promise((ready) => socket.bind(0, '127.0.0.1', () => ready(socket.address().port)));
    }

    #open() {
        const socket = createSocket('udp4');
        this.sockets.add(socket);
        socket.on('error', (error) => log(`link socket error: ${error.message}`));
        return socket;
    }

    async #ready() {
        if (this.#ports !== null) return this.#ports;
        const toEngine = this.#open();
        const toBrowser = this.#open();
        this.#out = { toEngine, toBrowser };
        toEngine.on('message', (payload, from) => {
            // Only the browser is ever told this address, so this is the
            // browser's traffic and its address, whatever else arrives here.
            this.#remember(from);
            this.#forward(payload, this.host, toBrowser);
        });
        toBrowser.on('message', (payload) => this.#forward(payload, this.browser, toEngine));
        this.#ports = await Promise.all([this.#listen(toEngine), this.#listen(toBrowser)]);
        return this.#ports;
    }

    /**
     * Note where the browser really is, without flapping between its sockets.
     *
     * Chrome keeps more than one ICE socket alive across a restart, and both go
     * on sending for a while. Following the most recent one alone would send the
     * desktop's picture back and forth between a live socket and a dead one and
     * no session would ever settle, so a new address has to earn the switch by
     * arriving several times running.
     */
    #remember(from) {
        const seen = { ip: from.address, port: from.port };
        const same = this.browser !== null && this.browser.ip === seen.ip && this.browser.port === seen.port;
        this.#seen = same ? { address: seen, runs: 0 } : this.#seen?.address?.port === seen.port && this.#seen.address.ip === seen.ip
            ? { address: seen, runs: this.#seen.runs + 1 }
            : { address: seen, runs: 1 };
        if (this.browser === null) {
            this.browser = seen;
            return;
        }
        if (same || this.#seen.runs < 3) return;
        log(`link browser moved from ${this.browser.ip}:${this.browser.port} to ${seen.ip}:${seen.port}`);
        this.browser = seen;
    }

    /** Forward one datagram in one direction, out of that direction's socket. */
    #forward(payload, to, socket) {
        if (this.shape.discard === true) {
            this.counters.discarded += 1;
            return;
        }
        const delay = this.shape.delayMs ?? 0;
        const send = () => {
            // Re-checked when the delay is up: a shape may have changed, or the
            // run may have torn the link down, in between.
            if (this.shape.discard === true || socket.closed) {
                this.counters.discarded += 1;
                return;
            }
            if (to === null || to === undefined) {
                this.counters.unroutable += 1;
                return;
            }
            this.counters[socket === this.#out.toEngine ? 'toEngine' : 'toBrowser'] += 1;
            try {
                socket.send(payload, to.port, to.ip);
            } catch {
                // A datagram still inside a delay when the run ended. Nothing is
                // waiting on it, and a closed relay is not a failure.
                this.counters.discarded += 1;
            }
        };
        if (delay > 0) {
            this.counters.delayed += 1;
            const timer = setTimeout(send, delay);
            this.timers.add(timer);
            timer.unref?.();
            return;
        }
        send();
    }

    /**
     * The engine's candidate for this generation, as the browser should be told
     * about it: the real address, replaced by the relay's `browserIn` socket.
     *
     * Only the first usable candidate of each generation is advertised. One
     * reachable candidate is what a session needs, and advertising every
     * interface would mean a relay per interface and no single "the path" to
     * shape.
     */
    async down(line, generation) {
        const candidate = parseCandidate(line);
        if (candidate === null || candidate.type !== 'host') return null;
        if (!this.local.has(candidate.ip)) {
            log(`link engine candidate ${candidate.ip}:${candidate.port} is not a local address; dropping it`);
            return null;
        }
        // One generation's candidates arrive as a burst and are handled here
        // concurrently, so they are taken in order: exactly one is advertised,
        // and the rest are dropped rather than each opening a relay.
        const answer = this.#queue.then(async () => {
            if (this.host !== null && this.host.generation === generation) return null;
            const [toEngine] = await this.#ready();
            this.host = { ip: candidate.ip, port: candidate.port, generation };
            log(`link engine candidate ${candidate.ip}:${candidate.port} (generation ${generation}) → browser through 127.0.0.1:${toEngine}`);
            return renderCandidate(candidate, '127.0.0.1', toEngine);
        });
        this.#queue = answer.then(() => undefined, () => undefined);
        return answer;
    }

    /**
     * The browser's candidate, as the engine should be told about it.
     *
     * Only the first of a session, for the same reason the engine's side keeps
     * only one: the engine picks a remote candidate and commits to it, and
     * giving it several makes it run two browser sockets at once.
     */
    async up(line) {
        const candidate = parseCandidate(line);
        if (candidate === null || candidate.type !== 'host') return null;
        if (!this.local.has(candidate.ip)) {
            log(`link browser candidate ${candidate.ip}:${candidate.port} is not a local address; dropping it`);
            return null;
        }
        if (this.browserAdvertised) return null;
        this.browserAdvertised = true;
        const [, toBrowser] = await this.#ready();
        // A hint only, and taken over by the first packet the browser sends,
        // which is how ICE itself finds a peer.
        log(`link browser candidate ${candidate.ip}:${candidate.port} → engine through 127.0.0.1:${toBrowser}`);
        return renderCandidate(candidate, '127.0.0.1', toBrowser);
    }

    /** The same rewrite for candidates carried inside an SDP instead of trickled. */
    async rewriteSdp(sdp, direction, generation) {
        const out = [];
        for (const line of sdp.split(/\r\n|\n/)) {
            if (!line.startsWith('a=candidate:')) {
                out.push(line);
                continue;
            }
            const bare = line.slice('a='.length);
            const rewritten = direction === 'down' ? await this.down(bare, generation) : await this.up(bare);
            if (rewritten !== null) out.push(`a=${rewritten}`);
        }
        return out.join('\r\n');
    }

    close() {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        for (const socket of this.sockets) {
            try {
                socket.close();
            } catch {
                // Already closed is not a teardown failure.
            }
        }
        this.sockets.clear();
    }
}

// ------------------------------------------------------- signalling relay ----
/**
 * The protocol channel, with the link rewriting applied to what crosses it.
 *
 * Everything else passes through untouched, in both directions: this is the
 * app's signalling channel, and the flow deliberately does not cut it.
 */
function startSignalling(link, bridgePort, token) {
    const upstream = `ws://127.0.0.1:${bridgePort}/desktop?token=${token}`;
    let generation = 0;
    return new Promise((ready) => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        server.on('connection', (client) => {
            const host = new WebSocket(upstream);
            const send = (socket, message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
            host.on('message', async (raw) => {
                const message = JSON.parse(String(raw));
                if (message.event === 'session.description') {
                    // A re-offer is a new ICE generation; its candidates need
                    // their own relay socket, so the count advances here.
                    generation += 1;
                    message.params.description.sdp = await link.rewriteSdp(message.params.description.sdp, 'down', generation);
                }
                if (message.event === 'session.candidate') {
                    const rewritten = await link.down(String(message.params.candidate), generation);
                    if (rewritten === null) return;
                    message.params.candidate = rewritten;
                }
                send(client, message);
            });
            client.on('message', async (raw) => {
                const message = JSON.parse(String(raw));
                if (message.method === 'session.open') link.newSession();
                if (message.method === 'session.candidate' && typeof message.params?.candidate === 'string') {
                    const rewritten = await link.up(message.params.candidate);
                    if (rewritten === null) return;
                    message.params.candidate = rewritten;
                }
                if (message.method === 'session.description' && typeof message.params?.description?.sdp === 'string') {
                    message.params.description.sdp = await link.rewriteSdp(message.params.description.sdp, 'up', generation);
                }
                send(host, message);
            });
            host.on('close', () => client.close());
            host.on('error', (error) => log(`signalling upstream error: ${error.message}`));
            client.on('close', () => host.close());
            client.on('error', () => host.close());
        });
        server.on('listening', () => ready({ port: server.address().port, close: () => server.close() }));
    });
}

// ----------------------------------------------------- the driver page ------
// The real hook and the real web binding, mounted the way an app mounts them.
// Nothing here re-implements negotiation, recovery or gestures.
const DRIVER_TS = `
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDesktopSession } from '__SRC__/useDesktopSession';
import { attachSurface, nativeDesklink } from '__SRC__/native.web';
import type { Signaling } from '__SRC__/protocol';

const PORT = __PORT__;
const TOKEN = '__TOKEN__';

const probe = {
    status: 'boot', failure: null as string | null, opens: 0, frames: 0,
    lastNewFrame: 0, presented: false, log: [] as Array<[number, string]>,
    sig: [] as Array<[number, string]>, pageErrors: [] as string[],
};
(window as any).__probe = probe;
window.addEventListener('error', (event) => probe.pageErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => probe.pageErrors.push('rejection: ' + String(event.reason)));

/** A pointer the way the phone sends one, so control after a recovery is real. */
(window as any).__pointer = async (x: number, y: number) => {
    const session = (window as any).__session;
    if (session == null) return 'fail: no session';
    session.setInputEnabled(true);
    session.send({ kind: 'pointer', phase: 'move', x, y });
    return 'sent';
};

let seq = 0;
const pending = new Map();
const handlers = new Set();
const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/desktop?token=' + TOKEN);
socket.addEventListener('open', () => { (window as any).__ready = true; });
socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (waiter == null) return;
        if (msg.error !== undefined) waiter.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else waiter.resolve(msg.result);
        return;
    }
    const p = msg.params ?? {};
    let translated: any = null;
    if (msg.event === 'session.description') translated = { kind: 'description', description: { type: p.description.type, sdp: p.description.sdp }, sessionId: p.sessionId };
    else if (msg.event === 'session.candidate') translated = { kind: 'candidate', candidate: { candidate: p.candidate, sdpMid: p.sdpMid ?? null, sdpMLineIndex: p.sdpMLineIndex ?? null }, sessionId: p.sessionId };
    else if (msg.event === 'session.state') translated = { kind: 'state', capture: p.capture, transport: p.transport, firstFrame: p.firstFrame, sessionId: p.sessionId };
    else if (msg.event === 'session.restoreToken') translated = { kind: 'restoreToken', token: p.token, sessionId: p.sessionId };
    else if (msg.event === 'session.revoked') translated = { kind: 'revoked', reason: p.reason, code: p.code, sessionId: p.sessionId };
    if (translated !== null) {
        probe.sig.push([Date.now(), 'got-' + msg.event + (p.code ? ':' + p.code : '')]);
        for (const handler of handlers) handler(translated);
    }
});
const signaling: Signaling = {
    request: (method, params) => new Promise((resolveRequest, reject) => {
        const id = ++seq;
        pending.set(id, {
            resolve: (value: any) => {
                if (method === 'session.open' && value != null && typeof value.sessionId === 'string') probe.opens += 1;
                resolveRequest(value);
            },
            reject,
        });
        probe.sig.push([Date.now(), 'req-' + method]);
        socket.send(JSON.stringify({ id, method, params }));
    }),
    subscribe: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
};

function Harness() {
    const session = useDesktopSession({
        authorize: async () => ({
            signaling,
            session: { maxWidth: 1280, maxHeight: 720, maxFps: 30 },
        }),
        onStateChange: (snapshot) => {
            probe.status = snapshot.status;
            probe.failure = snapshot.failure?.code ?? null;
            probe.presented = snapshot.presented;
            probe.log.push([Date.now(), snapshot.status]);
        },
        onError: (failure) => { probe.log.push([Date.now(), 'error:' + failure.code]); },
    });
    (window as any).__session = session;
    React.useEffect(() => { void session.connect(); }, []);
    React.useEffect(() => {
        if (session.nativeId == null) return;
        const stage = document.getElementById('stage');
        attachSurface(session.nativeId, stage, 'desktop');
        const video = stage.querySelector('video');
        if (video == null) return;
        video.play?.().catch(() => undefined);
        const tick = () => {
            if (typeof video.requestVideoFrameCallback !== 'function') return;
            video.requestVideoFrameCallback((_now: number, meta: any) => {
                if (meta.presentedFrames > 0) { probe.frames += 1; probe.lastNewFrame = Date.now(); }
                tick();
            });
        };
        tick();
    }, [session.nativeId]);
    return null;
}
TestRenderer.create(React.createElement(Harness));

/** The picture the user is looking at: how far it played, and how much of it is not black. */
const readRegion = (video, x, y, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const inRegion = (px: number, py: number) =>
        px >= x * canvas.width / video.videoWidth && px < (x + width) * canvas.width / video.videoWidth
        && py >= y * canvas.height / video.videoHeight && py < (y + height) * canvas.height / video.videoHeight;
    let luminance = 0; let lit = 0; let samples = 0;
    for (let py = 0; py < canvas.height; py += 1) {
        for (let px = 0; px < canvas.width; px += 1) {
            if (!inRegion(px, py)) continue;
            const index = (py * canvas.width + px) * 4;
            const value = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
            luminance += value;
            if (value > 24) lit += 1;
            samples += 1;
        }
    }
    return { meanLuminance: samples === 0 ? 0 : luminance / samples, litFraction: samples === 0 ? 0 : lit / samples, samples };
};

(window as any).__sample = () => {
    const video = document.querySelector('#stage video');
    if (video == null) return { error: 'no video element' };
    return {
        mounted: true,
        currentTime: video.currentTime,
        readyState: video.readyState,
        ...readRegion(video, 0, 0, video.videoWidth, video.videoHeight),
        // The fixture's animated marker lives at (1200,48) in desktop pixels.
        marker: readRegion(video, 1195, 43, 45, 42),
        frames: probe.frames,
        status: probe.status,
    };
};
`;
const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>desklink link drop</title>
<div id="stage" style="position:absolute;inset:0;background:#000"></div>
<script type="module" src="./driver.ts"></script>
`;
const RN_STUB = `export const AppState = { addEventListener: () => ({ remove() {} }) };\nexport const Platform = { OS: 'web' };\n`;

// --------------------------------------------------------------- the run ----
const owned = new Map();
const statOf = (pid) => {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return { state: fields[0], started: fields[19] };
    } catch {
        return undefined;
    }
};
const alive = (pid) => {
    const stat = statOf(pid);
    return stat !== undefined && stat.state !== 'Z' && stat.started === owned.get(pid);
};
const remember = (pid) => { owned.set(pid, statOf(pid)?.started); };

async function stopProcess(pid, name) {
    if (!alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (let attempt = 0; attempt < 60 && alive(pid); attempt += 1) await sleep(50);
    if (alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    for (let attempt = 0; attempt < 40 && alive(pid); attempt += 1) await sleep(25);
    assert(!alive(pid), `${name} ${pid} survived cleanup`);
}

async function main() {
    const browser = browserBinary();
    if (browser === null) {
        if (process.env.DESKLINK_REQUIRE_CHROME === '1') throw new Error('Chromium is required for this proof (set DESKLINK_CHROME).');
        console.log('SKIPPED: no Chromium found (set DESKLINK_CHROME). This proof shapes a real ICE agent, so it cannot run without one.');
        return;
    }
    const engine = engineBinary();
    const fixture = fixtureBinary();
    const evidence = resolve(process.argv[2] ?? join(process.env.HOME ?? tmpdir(), 'lab-tmp', 'dl-pm-8-recovery', `run-${Date.now()}`));
    mkdirSync(evidence, { recursive: true });
    const scratch = mkdtempSync(join(tmpdir(), 'dl-link-drop-'));
    const receipt = {
        what: 'a network drop mid-session, shaped by a userspace UDP relay this flow owns',
        linkShape: 'userspace-shaped link: a dgram relay between the browser ICE agent and the engine. NOT kernel netem, NOT tc, NOT iptables/nftables, no sudo, no root, no firewall rule, no change to the host firewall.',
        signallingCut: false,
        engine, engineSha256: sha256(engine),
        fixture, fixtureSha256: sha256(fixture),
        browser,
        head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim(),
        stages: [],
    };

    let claim = null;
    let xvfb = null;
    let fixturePid = 0;
    let browserContext = null;
    let bridge = null;
    let viteServer = null;
    let signalling = null;
    const link = new ShapedLink();

    const teardown = async () => {
        const failures = [];
        // Every step runs even if an earlier one fails: a browser left behind
        // holds a profile and a video writer, and the failure that caused the
        // teardown must not be replaced by the teardown's own error.
        for (const [what, step] of [
            ['browser', async () => { await browserContext?.close(); }],
            ['link', () => link.close()],
            ['signalling', () => signalling?.close()],
            ['vite', async () => { await viteServer?.close(); }],
            ['bridge', async () => { await bridge?.close(); }],
            ['fixture', () => stopProcess(fixturePid, 'x11_target')],
            ['xvfb', async () => { if (xvfb !== null) await stopOwnedXvfb(xvfb); }],
            ['display', () => claim?.release()],
        ]) {
            try {
                await step();
            } catch (error) {
                failures.push(`${what}: ${error instanceof Error ? error.message : error}`);
            }
        }
        const strays = [];
        for (const entry of readdirSync('/proc')) {
            const pid = Number(entry);
            if (!Number.isInteger(pid) || owned.has(pid) || pid === process.pid) continue;
            try {
                if (readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(`DESKLINK_LINK_DROP=${process.pid}`)) {
                    strays.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 100)}`);
                }
            } catch { /* vanished */ }
        }
        assert.deepEqual(strays, [], `stray task processes: ${strays}`);
        assert.deepEqual(failures, [], `cleanup failures: ${failures.join('; ')}`);
    };

    try {
        // ---- the private display the desktop is captured from ----------------
        claim = claimPrivateDisplay({ from: 240, count: 30 });
        const authority = join(scratch, 'Xauthority');
        assert.equal(spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]).status, 0);
        xvfb = spawn('Xvfb', [claim.display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
        trackOwnedXvfb(xvfb, claim.display);
        remember(xvfb.pid);
        for (let attempt = 0; attempt < 100 && !existsSync(`/tmp/.X11-unix/X${claim.number}`) && alive(xvfb.pid); attempt += 1) await sleep(50);
        assert(alive(xvfb.pid), 'the private Xvfb did not start');
        await verifyOwnedXvfb(xvfb);
        log('xvfb', claim.display, 'pid', xvfb.pid);

        // ---- the desktop being shown ---------------------------------------
        const xenv = {
            ...process.env,
            DISPLAY: claim.display,
            XAUTHORITY: authority,
            WAYLAND_DISPLAY: '',
            XDG_SESSION_TYPE: 'x11',
            DESKLINK_LINK_DROP: String(process.pid),
        };
        const target = spawn(fixture, ['--animate', '--move'], { env: xenv, stdio: ['ignore', 'pipe', 'pipe'] });
        remember(target.pid); fixturePid = target.pid;
        let targetLog = '';
        const collect = (chunk) => { targetLog += chunk; };
        target.stdout.setEncoding('utf8');
        target.stdout.on('data', collect);
        target.stderr.setEncoding('utf8');
        target.stderr.on('data', collect);
        for (let attempt = 0; attempt < 100 && !targetLog.includes('"ready"') && alive(fixturePid); attempt += 1) await sleep(50);
        assert(alive(fixturePid) && targetLog.includes('"ready"'), `the x11_target fixture never reported ready: ${targetLog.slice(-300)}`);
        log('fixture', fixture, 'pid', fixturePid);
        const fixtureEvents = () => targetLog.split('\n').filter((line) => line.startsWith('{')).flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });

        // ---- the engine, in this process, on that display -------------------
        process.env.DISPLAY = claim.display;
        process.env.XAUTHORITY = authority;
        process.env.WAYLAND_DISPLAY = '';
        const { Bridge } = await import(join(worktree, 'packages/desktop-host/dist/index.js'));
        bridge = await Bridge.start({
            listen: '127.0.0.1:0',
            token: 'link-drop-lab',
            engineCommand: engine,
            engineArgs: ['serve'],
            serveExample: false,
            source: { kind: 'x11', display: claim.display },
            engineOptions: { onDiagnostic: (line) => log(`engine: ${line.trim()}`) },
        });
        log('bridge on', bridge.port);

        // ---- the driver page -----------------------------------------------
        const pageDir = join(scratch, 'driver');
        mkdirSync(pageDir, { recursive: true });
        writeFileSync(join(pageDir, 'index.html'), INDEX_HTML);
        writeFileSync(join(pageDir, 'rn-stub.js'), RN_STUB);
        signalling = await startSignalling(link, bridge.port, 'link-drop-lab');
        writeFileSync(
            join(pageDir, 'driver.ts'),
            DRIVER_TS.replaceAll('__SRC__', SRC).replaceAll('__PORT__', String(signalling.port)).replaceAll('__TOKEN__', 'link-drop-lab'),
        );
        const { createServer: createVite } = await import('vite');
        viteServer = await createVite({
            root: pageDir,
            configFile: false,
            logLevel: 'error',
            define: { global: 'globalThis' },
            resolve: {
                alias: [
                    { find: 'react-native', replacement: join(pageDir, 'rn-stub.js') },
                    { find: 'react-test-renderer', replacement: join(worktree, 'node_modules/react-test-renderer') },
                    { find: 'react', replacement: join(worktree, 'node_modules/react') },
                ],
            },
            plugins: [{
                name: 'native-shim',
                enforce: 'pre',
                resolveId(source, importer) {
                    if (source === './native' && importer !== undefined && importer.startsWith(SRC)) return join(SRC, 'native.web.ts');
                    return null;
                },
            }],
            server: { host: '127.0.0.1', port: 0, strictPort: false },
        });
        await viteServer.listen();
        const pageUrl = viteServer.resolvedUrls.local[0];
        log('page on', pageUrl, 'signalling on', signalling.port);

        // ---- the real browser ----------------------------------------------
        const { chromium } = await import('playwright-core');
        const videoDir = join(evidence, 'video');
        mkdirSync(videoDir, { recursive: true });
        browserContext = await chromium.launchPersistentContext(join(scratch, 'profile'), {
            executablePath: browser,
            headless: true,
            viewport: { width: 1280, height: 720 },
            recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
            args: [
                '--no-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                // Chrome hides its own candidates behind an mDNS name by
                // default; this relay has to forward to a real address.
                '--disable-features=WebRtcHideLocalIpsWithMdns',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
            ],
            env: { ...process.env, DESKLINK_LINK_DROP: String(process.pid) },
        });
        const page = browserContext.pages()[0] ?? await browserContext.newPage();
        const consoleErrors = [];
        page.on('pageerror', (error) => consoleErrors.push(String(error.message)));
        await page.goto(pageUrl);
        await page.waitForFunction('window.__ready === true', null, { timeout: 20_000 });

        const probe = () => page.evaluate('window.__probe');
        const sample = () => page.evaluate('window.__sample()');
        /** The probe once the predicate holds: the condition itself is only a gate. */
        const until = async (what, expression, timeoutMs, value = 'window.__probe') => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                let held;
                try {
                    held = await page.evaluate(expression);
                } catch (error) {
                    // A page that cannot answer is itself the measurement.
                    throw new Error(`the client stopped answering while waiting for ${what}: ${String(error).slice(0, 200)}`);
                }
                if (held) return value === expression ? held : await page.evaluate(value);
                if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; probe ${JSON.stringify(await probe())}`);
                await sleep(250);
            }
        };
        const shot = async (name, why) => {
            await page.screenshot({ path: join(evidence, `${name}.png`) });
            log(`capture ${name}.png — ${why}`);
            return `${name}.png`;
        };

        // ---- stage 1: the desktop is being shown ----------------------------
        const live = await until('the session to go live', 'window.__probe.status === "live" && window.__probe.frames > 5', 45_000);
        assert(live.presented, `the session went live without a presented frame: ${JSON.stringify(live)}`);
        const healthy = await sample();
        assert(healthy.mounted === true, 'no picture is mounted');
        assert(healthy.meanLuminance > 8, `the shown desktop is a black rectangle: ${JSON.stringify(healthy)}`);
        const framesAtBaseline = live.frames;
        const baselineAt = Date.now();
        await sleep(2000);
        const baselineRate = ((await probe()).frames - framesAtBaseline) / ((Date.now() - baselineAt) / 1000);
        log(`live: ${live.frames} frames, ${baselineRate.toFixed(1)}/s, luminance ${healthy.meanLuminance.toFixed(1)}`);
        assert(baselineRate > 10, `frames are not advancing on a healthy link: ${baselineRate.toFixed(1)}/s`);
        receipt.stages.push({
            stage: 'live',
            frameRatePerSecond: round2(baselineRate),
            meanLuminance: round2(healthy.meanLuminance),
            markerLuminance: round2(healthy.marker.meanLuminance),
            status: live.status,
            capture: await shot('01-live', 'the desktop showing, before any shaping'),
        });

        // ---- stage 2: throttle ----------------------------------------------
        // What this stage can honestly measure is worth saying out loud. The
        // client's `getStats` deliberately withholds network addresses, and the
        // round trip with them, so a latency number is not available from the
        // client. What is available is that the delay was applied to real
        // datagrams on the real link — the relay's own count — that the picture
        // kept arriving, and that it arrived more slowly than it had.
        const beforeDelay = link.counters.delayed;
        link.set({ delayMs: 400 }, 'throttle: 400ms added to every datagram in both directions');
        const throttledFrames = (await probe()).frames;
        const throttledAt = Date.now();
        await sleep(5000);
        const throttled = await probe();
        const throttledRate = (throttled.frames - throttledFrames) / ((Date.now() - throttledAt) / 1000);
        const throttledSample = await sample();
        const delayedDatagrams = link.counters.delayed - beforeDelay;
        log(`throttled: ${throttledRate.toFixed(1)}/s (was ${baselineRate.toFixed(1)}), ${delayedDatagrams} datagrams delayed, status ${throttled.status}`);
        assert(delayedDatagrams > 100, `the delay was not applied to the link's own traffic: ${delayedDatagrams} datagrams`);
        assert(throttledRate > 0, 'the picture stopped entirely under throttle instead of slowing');
        assert(throttledRate < baselineRate, `a 400ms delay per datagram did not slow the picture: ${throttledRate.toFixed(1)}/s vs ${baselineRate.toFixed(1)}/s`);
        assert(throttledSample.meanLuminance > 8, `the throttled picture went black: ${JSON.stringify(throttledSample)}`);
        assert(throttled.status !== 'failed', `a slow link killed the session: ${JSON.stringify(throttled.failure)}`);
        receipt.stages.push({
            stage: 'throttled',
            shape: { delayMs: 400 },
            frameRatePerSecond: round2(throttledRate),
            baselineFrameRatePerSecond: round2(baselineRate),
            datagramsDelayed: delayedDatagrams,
            meanLuminance: round2(throttledSample.meanLuminance),
            status: throttled.status,
            capture: await shot('02-throttled', 'the link throttled: the desktop still shown, slower'),
        });

        // ---- stage 3: cut ----------------------------------------------------
        link.set({}, 'unshape, so the cut starts from a healthy path');
        await until('the link to settle after the throttle', `window.__probe.frames > ${throttled.frames + 20}`, 20_000);
        link.set({ discard: true }, 'cut: every datagram discarded in both directions');
        const cutAt = Date.now();
        const watch = setInterval(() => link.report(`cut +${Date.now() - cutAt}ms`), 2000);
        watch.unref?.();
        const during = await until('the client to notice the drop', '["reconnecting","failed"].includes(window.__probe.status)', 8000);
        const noticedMs = Date.now() - cutAt;
        log(`cut: ${during.status} after ${noticedMs}ms; ${link.counters.discarded} datagrams discarded so far`);
        const held = await sample();
        assert(held.mounted === true, 'the picture was torn down during the drop instead of being held');
        await sleep(CUT_MS);
        const frozen = await sample();
        const aliveDuringCut = await probe();
        assert(aliveDuringCut !== null && typeof aliveDuringCut.status === 'string', 'the client stopped answering during the drop');
        assert(frozen.frames - held.frames <= 2, `the picture kept advancing through a cut link: ${frozen.frames - held.frames} frames`);
        assert(consoleErrors.length === 0, `the page threw during the drop: ${consoleErrors.join(' | ')}`);
        assert(aliveDuringCut.pageErrors.length === 0, `the page threw during the drop: ${aliveDuringCut.pageErrors.join(' | ')}`);
        assert(frozen.meanLuminance > 8, `the held picture went black: ${JSON.stringify(frozen)}`);
        log(`cut: still answering ${Date.now() - cutAt}ms in, ${frozen.frames - held.frames} frames through the cut, status ${aliveDuringCut.status}`);
        receipt.stages.push({
            stage: 'dropped',
            noticedMs,
            status: aliveDuringCut.status,
            framesThroughCut: frozen.frames - held.frames,
            pageStillAnswering: true,
            pageErrors: 0,
            meanLuminance: round2(frozen.meanLuminance),
            capture: await shot('03-dropped', 'the link cut: the client is reconnecting, still holding the last picture'),
        });

        // ---- stage 4: restore ------------------------------------------------
        const outageMs = Date.now() - cutAt;
        clearInterval(watch);
        link.set({}, 'restore: forwarding again');
        const restoreWatch = setInterval(() => link.report(`restored +${Date.now() - cutAt}ms`), 3000);
        restoreWatch.unref?.();
        const restoredAt = Date.now();
        const framesAtRestore = (await sample()).frames;
        await until('frames to advance again', `window.__probe.frames > ${framesAtRestore + 3}`, 90_000);
        const firstFrameMs = Date.now() - restoredAt;
        await until('the status to be live again', 'window.__probe.status === "live"', 30_000);
        clearInterval(restoreWatch);
        const after = await probe();
        const afterSample = await sample();
        log(`restored: frames again ${firstFrameMs}ms after the link came back (outage ${outageMs}ms), status ${after.status}`);
        assert(after.failure === null, `the session recovered with a failure recorded: ${JSON.stringify(after.failure)}`);
        assert(!after.log.some(([, status]) => status === 'ended'), `the session ended instead of recovering: ${JSON.stringify(after.log.slice(-12))}`);
        assert(afterSample.meanLuminance > 8, `the recovered picture is black: ${JSON.stringify(afterSample)}`);
        // The fixture's marker moves. A picture that is showing the desktop
        // again has that marker alive; a stale last frame cannot.
        await until(
            'the fixture marker to move again',
            `window.__sample().marker.meanLuminance !== ${frozen.marker.meanLuminance}`,
            15_000,
            'true',
        );
        const path = after.log.map(([, status]) => status);
        log(`recovery path: ${path.slice(-10).join(' → ')}; ${after.opens} session open(s)`);

        // Control is alive too: the pointer the page sends lands on the real display.
        const beforePointer = fixtureEvents().length;
        assert.equal(await page.evaluate('window.__pointer(900, 600)'), 'sent');
        let landed = false;
        for (let attempt = 0; attempt < 40 && !landed; attempt += 1) {
            await sleep(250);
            landed = fixtureEvents().slice(beforePointer).some((event) => event.x === 900 && event.y === 600);
        }
        assert(landed, `control did not reach the desktop after the recovery: ${JSON.stringify(fixtureEvents().slice(-6))}`);
        log('after recovery: the desktop itself reported the pointer at (900,600)');
        receipt.stages.push({
            stage: 'recovered',
            outageMs,
            firstFrameAfterRestoreMs: firstFrameMs,
            status: after.status,
            recoveryPath: path.slice(-10),
            sessionOpens: after.opens,
            markerMovingAgain: true,
            controlLanded: true,
            capture: await shot('04-recovered', 'the link restored: the desktop is live again and control works'),
        });

        // ---- the receipt, and the motion that spans the drop and the recovery -
        receipt.link = {
            shaping: 'userspace-shaped link (a dgram relay in this process), NOT kernel netem, NOT tc, NOT a firewall rule',
            counters: link.counters,
            marks: link.marks,
            hostCandidate: link.host,
        };
        receipt.consoleErrors = consoleErrors;
        receipt.finalProbe = after;
        await browserContext.close();
        browserContext = null;
        await sleep(1500);
        const videos = readdirSync(videoDir).filter((name) => name.endsWith('.webm'));
        assert(videos.length > 0, 'no motion recording spanning the drop and the recovery');
        receipt.video = videos.map((name) => join('video', name));
        writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
        writeFileSync(join(evidence, 'fixture-events.jsonl'), fixtureEvents().map((event) => JSON.stringify(event)).join('\n'));
        console.log(`PASS: throttle, cut and restore on a userspace-shaped link; evidence ${evidence}`);
        console.log(`LINK-RESULT ${JSON.stringify({
            stages: receipt.stages.map(({ stage, frameRatePerSecond, datagramsDelayed, noticedMs, framesThroughCut, firstFrameAfterRestoreMs, status }) => ({ stage, frameRatePerSecond, datagramsDelayed, noticedMs, framesThroughCut, firstFrameAfterRestoreMs, status })),
            counters: link.counters,
        })}`);
    } finally {
        await teardown();
    }
}

const round2 = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);

main().then(
    () => process.exit(0),
    (error) => {
        console.error('FLOW-FAIL', error);
        process.exit(1);
    },
);
