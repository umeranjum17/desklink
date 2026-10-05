#!/usr/bin/env node
/**
 * The `encoded` source, end to end: a recorded Annex-B stream fed to the engine,
 * shown in Chrome through the client package's own web implementation, and a
 * real click coming back as a `session.input` event.
 *
 * What each side proves:
 *
 *  - the engine accepts `{"kind":"encoded"}` with no capture backend and no
 *    input device, offers H.264 only after the fed stream's own SPS names its
 *    profile, packetizes access units, and forwards control messages instead of
 *    applying them;
 *  - `packages/desktop-client/src/native.web.ts` decodes the stream in a real
 *    browser (frames counted by `requestVideoFrameCallback`, and the rendered
 *    picture is sampled to prove it is not a black rectangle), and turns a
 *    browser mouse click into the client's own `pointer` control messages.
 *
 * Usage:
 *
 *   node packages/desktop-host/test/encoded-flow.mjs
 *
 * Environment:
 *
 *   DESKLINK_ENCODED_ENGINE  engine binary (default: the debug build in this
 *                            checkout; DESKLINK_AXI_ENGINE is also honoured, so
 *                            CI sets one variable for every engine flow)
 *   DESKLINK_CHROME          browser binary (default: the first of
 *                            google-chrome-stable, google-chrome, chromium)
 *
 *   DESKLINK_REQUIRE_CHROME  1 makes a missing browser fail instead of skip
 *
 * A machine with no Chrome skips the browser half with a printed reason and a
 * passing exit: the fixture is still parsed, but no session opens and nothing
 * decodes.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { Bridge, BRIDGE_PATH } from '../dist/index.js';

import { assertNoAmbientDesktop } from './lab-safety.mjs';

assertNoAmbientDesktop();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const fixture = join(here, 'fixtures/encoded-486x1080.h264');
/** The stream's own size, and what the consumer declares in `session.open`. */
const SIZE = { width: 486, height: 1080 };
/** How long the whole flow may take before it is a failure, not a hang. */
const DEADLINE_MS = 90_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function which(name) {
    const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        for (const binary of names) {
            const path = join(directory, binary);
            if (existsSync(path)) return path;
        }
    }
    return null;
}

function findEngine() {
    const candidates = [
        process.env.DESKLINK_ENCODED_ENGINE,
        process.env.DESKLINK_AXI_ENGINE,
        join(repo, `packages/desktop-host/engine/target/debug/desklink-host${process.platform === 'win32' ? '.exe' : ''}`),
    ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
    const binary = candidates.find((candidate) => existsSync(candidate));
    if (binary === undefined) {
        throw new Error(
            `no engine binary found; build it and set DESKLINK_ENCODED_ENGINE (tried ${candidates.join(', ')})`,
        );
    }
    return binary;
}

function findChrome() {
    const candidates = [
        process.env.DESKLINK_CHROME, 'google-chrome-stable', 'google-chrome', 'chromium',
        ...(process.platform === 'win32' ? [
            join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
            join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
        ] : []),
    ].filter(
        (candidate) => typeof candidate === 'string' && candidate !== '',
    );
    for (const candidate of candidates) {
        const isPath = isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\');
        const path = isPath ? (existsSync(candidate) ? candidate : null) : which(candidate);
        if (path !== null) return path;
    }
    return null;
}

/** The engine's local protocol, over the process's own stdin and stdout. */
class Engine {
    constructor(binary) {
        this.next = 0;
        this.pending = new Map();
        this.events = [];
        this.waiters = [];
        this.subscribers = new Set();
        this.onClosed = new Set();
        this.exited = false;
        this.stderr = '';
        this.connected = (async () => {
            this.bridge = await Bridge.start({
                listen: '127.0.0.1:0', token: 'encoded-lab-pairing',
                engineCommand: binary, engineArgs: ['serve'], serveExample: false,
                source: { kind: 'encoded', codec: 'h264', ...SIZE },
                engineOptions: {
                    onEvent: event => this.#line(JSON.stringify(event)),
                    onDiagnostic: line => { this.stderr += line; },
                    onExit: () => { this.exited = true; },
                },
            });
            this.socket = new WebSocket(`ws://127.0.0.1:${this.bridge.port}${BRIDGE_PATH}?token=encoded-lab-pairing`);
            this.socket.on('message', raw => {
                if (JSON.parse(String(raw)).id !== undefined) this.#line(String(raw));
            });
            this.socket.on('close', () => {
                for (const handler of this.onClosed) handler();
            });
            await new Promise((resolve, reject) => {
                this.socket.once('open', resolve);
                this.socket.once('error', reject);
            });
        })();
        this.opened = this.request('hello', { protocol: 3 });
    }

    #line(line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
            const waiting = this.pending.get(message.id);
            if (waiting === undefined) return;
            this.pending.delete(message.id);
            if (message.error) waiting.reject(new Error(`${message.error.code}: ${message.error.message}`));
            else waiting.resolve(message.result);
            return;
        }
        this.events.push(message);
        for (const subscriber of this.subscribers) subscriber(message);
        for (const waiter of this.waiters.splice(0)) waiter(message);
    }

    async request(method, params) {
        await this.connected;
        if (method === 'session.open') this.openPermissions = params?.permissions;
        const id = ++this.next;
        if (this.exited) return Promise.reject(new Error('the engine exited'));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            if (method === 'session.open') {
                params = { ...params };
                delete params.source;
            }
            this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
        });
    }

    /** Wait for one event by name, from the ones already seen onwards. */
    async event(name, timeoutMs = 20_000) {
        const seen = this.events.find((message) => message.event === name);
        if (seen !== undefined) return seen;
        return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => rejectEvent(new Error(`no ${name} within ${timeoutMs} ms`)), timeoutMs);
            const waiter = (message) => {
                if (message.event !== name) {
                    this.waiters.push(waiter);
                    return;
                }
                clearTimeout(timer);
                resolveEvent(message);
            };
            this.waiters.push(waiter);
        });
    }

    /** Every event, until the returned function runs. */
    subscribe(handler) {
        this.subscribers.add(handler);
        return () => this.subscribers.delete(handler);
    }

    eventsNamed(name) {
        return this.events.filter((message) => message.event === name);
    }

    async close() {
        await this.connected;
        await this.bridge.close();
    }
}

/** Annex-B start codes, for splitting the fixture into access units. */
function startCodes(buffer) {
    const starts = [];
    for (let index = 0; index + 3 <= buffer.length; index += 1) {
        if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1) {
            starts.push(index);
            index += 2;
        }
    }
    return starts;
}

/**
 * Access units, with the keyframe flag an encoder would declare.
 *
 * A picture can arrive as several slice NAL units — an encoder with sliced
 * threads emits one per thread — so "a slice after a slice" is not a boundary.
 * The boundary is the slice whose `first_mb_in_slice` is zero, which is exactly
 * the first bit of the slice header: a `ue(v)` of 0 is a single set bit.
 */
function accessUnits(buffer) {
    const starts = startCodes(buffer);
    assert.ok(starts.length > 3, 'the fixture has NAL units');
    const units = [];
    let unitStart = starts[0];
    let keyframe = false;
    let seenSlice = false;
    for (const start of starts) {
        const type = buffer[start + 3] & 0x1f;
        const slice = type === 1 || type === 5;
        const firstSliceOfPicture = slice && (buffer[start + 4] & 0x80) !== 0;
        if (slice && seenSlice && firstSliceOfPicture) {
            units.push({ data: buffer.subarray(unitStart, start), keyframe });
            unitStart = start;
            keyframe = false;
            seenSlice = false;
        }
        if (slice) {
            seenSlice = true;
            if (type === 5) keyframe = true;
        }
    }
    units.push({ data: buffer.subarray(unitStart), keyframe });
    assert.ok(
        units.some((unit) => unit.keyframe),
        'the fixture has a keyframe access unit',
    );
    return units;
}

async function startVite() {
    const { createServer: createVite } = await import('vite');
    const server = await createVite({
        root: repo,
        configFile: false,
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await server.listen();
    const url = server.resolvedUrls.local[0];
    return { url, close: () => server.close() };
}

/** The relay the page's browser module talks to, standing in for an app's own channel. */
function startRelay(engine) {
    return new Promise((ready) => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        server.on('connection', (socket) => {
            const push = (message) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
            };
            for (const message of engine.events) push(message);
            const unsubscribe = engine.subscribe(push);
            const closed = () => socket.close();
            engine.onClosed.add(closed);
            socket.on('close', () => { unsubscribe(); engine.onClosed.delete(closed); });
            socket.on('message', (raw) => {
                const request = JSON.parse(raw.toString());
                engine
                    .request(request.method, request.params)
                    .then((result) => push({ id: request.id, result }))
                    .catch((error) => push({ id: request.id, error: { code: 'relay', message: String(error.message) } }));
            });
        });
        server.on('listening', () => {
            const { port } = server.address();
            ready({ url: `ws://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

/** The browser build behind the binary, so a failure names what actually ran. */
function chromeVersion(binary) {
    try {
        const line = String(execFileSync(binary, ['--version'], { timeout: 5000, encoding: 'utf8' })).trim().split('\n').pop()?.trim();
        if (line) return line;
    } catch {
    }
    try {
        return realpathSync(binary);
    } catch {
        return 'unknown version';
    }
}

/** Chrome over CDP: launch, attach to a page target, evaluate in it. */
async function startChrome(binary, pageUrl) {
    const profile = mkdtempSync(join(tmpdir(), 'desklink-encoded-chrome-'));
    const chrome = spawn(
        binary,
        [
            '--headless=new',
            ...(process.platform === 'linux' && process.env.DISPLAY ? ['--ozone-platform=x11'] : []),
            `--user-data-dir=${profile}`,
            '--remote-debugging-port=0',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            // A page Chrome considers occluded stops painting frames, which
            // would look exactly like a stream that does not decode.
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--mute-audio',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=900,1200',
            'about:blank',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    chrome.stderr.setEncoding('utf8');
    let stderr = '';
    chrome.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    // The browser's own lifetime is the only signal that separates a slow
    // start from a browser that never started: without it both read as a
    // silent timeout, which is exactly what the runner hands us.
    let stopped = null;
    const exited = new Promise((done) => {
        chrome.once('exit', (code, signal) => { stopped = `the browser exited, code ${code}, signal ${signal}`; done(); });
        chrome.once('error', (error) => { stopped = `the browser never started: ${error.message}`; done(); });
    });

    const portFile = join(profile, 'DevToolsActivePort');
    const started = Date.now();
    const deadline = started + 20_000;
    let port = null;
    while (Date.now() < deadline && port === null && stopped === null) {
        if (existsSync(portFile)) {
            port = Number.parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10) || null;
        }
        if (port === null) await sleep(100);
    }
    const fate = () => stopped
        ?? (chrome.exitCode !== null || chrome.signalCode !== null
            ? `the browser exited, code ${chrome.exitCode}, signal ${chrome.signalCode}`
            : 'it was still running and said nothing');
    if (port === null) {
        try {
            chrome.kill('SIGKILL');
        } catch {
        }
        rmSync(profile, { recursive: true, force: true });
        throw new Error(
            `Chrome never opened a debugging port in ${Date.now() - started}ms from ${binary} `
            + `(${chromeVersion(binary)}): ${fate()}; `
            + `stderr: ${stderr.slice(-400)}`,
        );
    }
    console.log(`debug port ${port} after ${Date.now() - started}ms`);

    let socket = null;
    let session = null;
    const pending = new Map();
    let next = 0;
    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const id = ++next;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
        });
    try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        socket = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((open, fail) => {
            socket.once('open', open);
            socket.once('error', fail);
        });
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.id === undefined) return;
            const waiting = pending.get(message.id);
            if (waiting === undefined) return;
            pending.delete(message.id);
            if (message.error) waiting.reject(new Error(`${message.error.message}`));
            else waiting.resolve(message.result);
        });
        const target = await send('Target.createTarget', { url: pageUrl });
        session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    } catch (error) {
        try {
            socket?.close();
        } catch {
        }
        try {
            chrome.kill('SIGKILL');
        } catch {
        }
        rmSync(profile, { recursive: true, force: true });
        throw new Error(
            `Chrome's debugging handshake failed from ${binary} (${chromeVersion(binary)}): ${error.message}; ${fate()}; `
            + `stderr: ${stderr.slice(-400)}`,
        );
    }
    const evaluate = async (expression) => {
        const result = await send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            session,
        );
        if (result.exceptionDetails !== undefined) {
            throw new Error(
                `the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
            );
        }
        return result.result.value;
    };
    const until = async (expression, timeoutMs, what) => {
        const limit = Date.now() + timeoutMs;
        while (Date.now() < limit) {
            const value = await evaluate(expression);
            if (value) return value;
            await sleep(120);
        }
        const state = await evaluate('JSON.stringify(window.__flow.state)').catch(() => '{}');
        throw new Error(`timed out waiting for ${what}; page state ${state}`);
    };

    const closed = { done: false };
    return {
        evaluate,
        send: (method, params) => send(method, params, session),
        until,
        close: async () => {
            if (closed.done) return;
            closed.done = true;
            try {
                socket.close();
            } catch {
                // An already-closed socket is not a failure to clean up after.
            }
            chrome.kill('SIGKILL');
            // The profile is the browser's, not ours: remove it only once the
            // process is gone, so a restart of the flow never inherits it. A
            // browser that already exited will not fire 'exit' a second time.
            if (stopped === null) await exited;
            rmSync(profile, { recursive: true, force: true });
        },
    };
}

async function main() {
    const engine = new Engine(findEngine());
    const capabilities = await engine.opened;
    assert.deepEqual(capabilities.encoded.codecs, ['h264']);
    assert.deepEqual(await engine.request('capabilities'), capabilities);
    const units = accessUnits(readFileSync(fixture));
    const keyframes = units.filter((unit) => unit.keyframe).length;

    const vite = await startVite();
    const relay = await startRelay(engine);
    const chromeBinary = findChrome();
    let chrome = null;
    let cursor = 0;
    let feeding = false;
    let fed = 0;
    let feedError = null;
    const cleanup = [];
    cleanup.push(() => relay.close());
    cleanup.push(() => vite.close());
    cleanup.push(() => engine.close());

    try {
        if (chromeBinary === null) {
            if (process.env.DESKLINK_REQUIRE_CHROME === '1') throw new Error('Chrome is required for this proof (set DESKLINK_CHROME).');
            console.log('SKIPPED the browser half: no Chrome found (set DESKLINK_CHROME).');
            console.log(`the ${units.length}-unit fixture parses (${keyframes} keyframe units)`);
            return;
        }
        console.log(`engine ${findEngine()}`);
        console.log(`chrome ${chromeBinary}`);
        const page = `${vite.url}packages/desktop-host/test/encoded-flow.html?engine=${encodeURIComponent(relay.url)}`;
        chrome = await startChrome(chromeBinary, page);
        cleanup.push(() => chrome.close());

        const opened = await chrome.until('window.__flow?.ready === true', 20_000, 'the page to load')
            .then(() => chrome.evaluate('window.__flow.open({ width: 486, height: 1080 })'));
        assert.equal(opened.source.kind, 'encoded', 'the source the engine reports back is the encoded one');
        assert.deepEqual(opened.geometry.encoded, SIZE, 'the fed stream is not scaled');
        console.log(`session.open → ${opened.source.kind} ${opened.source.width}x${opened.source.height}, no offer yet`);
        assert.equal(
            engine.eventsNamed('session.description').length,
            0,
            'the offer must wait for the stream to say what it is',
        );

        // Feed at the stream's own rate, cycling the recording, and take the
        // keyframe request the engine raises when the transport connects as the
        // signal to start again from an IDR — exactly what a device helper does.
        const requests = engine.eventsNamed('session.keyframeRequest').length;
        feeding = true;
        const feeder = (async () => {
            while (feeding) {
                const index = cursor % units.length;
                const unit = units[index];
                cursor = index + 1;
                fed += 1;
                await engine
                    .request('session.feed', {
                        session_id: opened.sessionId,
                        keyframe: unit.keyframe,
                        data_b64: unit.data.toString('base64'),
                    })
                    .catch((error) => {
                        // A refused hand-off is a failure, not a hiccup: record it
                        // and stop, so the wait for a picture reports why.
                        feedError = error.message;
                        feeding = false;
                    });
                await sleep(33);
            }
        })();
        cleanup.push(() => {
            feeding = false;
        });

        const seen = (name) => engine.eventsNamed(name).length;
        let keyframeRequests = requests;
        const keyframeWatch = setInterval(() => {
            if (seen('session.keyframeRequest') > keyframeRequests) {
                keyframeRequests = seen('session.keyframeRequest');
                cursor = 0;
            }
        }, 50);
        keyframeWatch.unref?.();
        cleanup.push(() => clearInterval(keyframeWatch));

        const offer = await engine.event('session.description', 20_000).catch((error) => {
            if (feedError !== null) throw new Error(`${error.message}; the engine refused a feed: ${feedError}`);
            throw error;
        });
        assert.match(offer.params.description.sdp, /H264\/90000/, 'the offer carries the fed track as H.264');
        assert.match(
            offer.params.description.sdp,
            /packetization-mode=1;profile-level-id=42c029/,
            'the offer names the profile the fed stream actually is',
        );
        console.log('session.description → H.264 packetization-mode=1, profile-level-id=42c029');

        await chrome.until('window.__flow.state.presented === true', 25_000, 'a first decoded frame');
        const first = await chrome.evaluate('window.__flow.sample()');
        assert.deepEqual(
            { width: first.width, height: first.height },
            SIZE,
            'Chrome decoded the stream at its own size',
        );
        await sleep(1200);
        const second = await chrome.evaluate('window.__flow.sample()');
        assert.ok(
            second.frames - first.frames >= 8,
            `the picture must keep arriving: ${second.frames - first.frames} frames in 1.2 s;` +
                ` first ${JSON.stringify(first)} second ${JSON.stringify(second)}`,
        );
        assert.ok(
            second.meanLuminance > 8 && second.litFraction > 0.05,
            `the picture must not be black: mean ${second.meanLuminance}, lit ${second.litFraction}`,
        );
        console.log(
            `browser → ${first.width}x${first.height}, ${second.frames - first.frames} frames in 1.2 s,` +
                ` mean luminance ${second.meanLuminance.toFixed(1)}`,
        );
        if (process.env.DESKLINK_ENCODED_SCREENSHOT) {
            const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(process.env.DESKLINK_ENCODED_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
        }

        // A real click, through the client's own gestures: the picture's centre.
        const rect = await chrome.evaluate('window.__flow.pictureRect()');
        const at = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        await chrome.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: at.x,
            y: at.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
        });
        await chrome.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: at.x,
            y: at.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
        });
        const down = await engine.event('session.input', 10_000).catch((error) => {
            throw new Error(`${error.message}; page state ${JSON.stringify(engine.events.slice(-4))}`);
        });
        assert.equal(down.params.input.kind, 'pointer');
        assert.ok(
            ['down', 'up'].includes(down.params.input.phase),
            `a click arrives as a pointer message: ${JSON.stringify(down.params.input)}`,
        );
        await sleep(200);
        const inputs = engine.eventsNamed('session.input').map((message) => message.params.input);
        const pressed = inputs.find((input) => input.kind === 'pointer' && input.phase === 'down');
        const released = inputs.find((input) => input.kind === 'pointer' && input.phase === 'up');
        assert.ok(pressed !== undefined && released !== undefined, `a click is a press and a release: ${JSON.stringify(inputs)}`);
        for (const input of [pressed, released]) {
            assert.ok(
                input.x >= 0 && input.x < SIZE.width && input.y >= 0 && input.y < SIZE.height,
                `the click lands on the stream's own pixels: ${JSON.stringify(input)}`,
            );
        }
        assert.equal(
            await chrome.evaluate('window.__flow.state.rejection'),
            null,
            'the engine acknowledged the forwarded messages instead of refusing them',
        );
        assert.deepEqual(engine.openPermissions, ['view'], 'the real click came from a legacy view-only open');
        console.log(`legacy permissions=[view] session.input → pointer ${pressed.phase} at (${pressed.x}, ${pressed.y}), up at (${released.x}, ${released.y})`);

        feeding = false;
        await feeder;
        const metrics = await engine.request('session.metrics', {});
        assert.ok(metrics.fed_frames >= 30, `the fixture was fed: ${metrics.fed_frames} units`);
        assert.ok(metrics.encoded_frames > 0, 'access units reached the transport');
        assert.ok(metrics.input_forwarded >= 2, 'both click messages were forwarded');
        assert.equal(metrics.input_applied, 0, 'nothing was applied to this machine');
        assert.ok(
            engine.eventsNamed('session.keyframeRequest').length >= 1,
            'the engine asks for a keyframe the moment the transport connects',
        );
        console.log(
            `session.metrics → fed ${metrics.fed_frames}, sent ${metrics.encoded_frames},` +
                ` dropped ${metrics.dropped_frames}, forwarded ${metrics.input_forwarded}, applied ${metrics.input_applied}`,
        );
        const port = engine.bridge.port;
        await engine.close();
        await chrome.until('window.__flow.state.signalingClosed === true', 5000, 'signaling closure');
        assert.deepEqual(await chrome.evaluate('window.__flow.state.revocation'), {kind:'revoked', code:'closed', signalingOpen:true});
        await assert.rejects(new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}?token=encoded-lab-pairing`);
            socket.once('open', () => { socket.close(); resolve(); });
            socket.once('error', reject);
        }));
        console.log('ok: decoded video, legacy input, and revoked/closed before signaling teardown');
    } finally {
        // Every step runs even if an earlier one fails: a browser left behind
        // holds a profile directory and an engine process, and the failure that
        // caused the teardown must not be replaced by the teardown's own error.
        for (const step of cleanup.reverse()) {
            try {
                await step();
            } catch (error) {
                console.error(`cleanup: ${error instanceof Error ? error.message : error}`);
            }
        }
    }
}

const timer = setTimeout(() => {
    console.error(`the flow did not finish within ${DEADLINE_MS} ms`);
    process.exit(1);
}, DEADLINE_MS);
timer.unref();

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    },
);
