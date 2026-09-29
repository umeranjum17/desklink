#!/usr/bin/env node
/**
 * Glass-to-glass latency/fps lab (lane L0).
 *
 * A repeatable measurement every later lane cites: on a private Xvfb the Rust
 * `stamp_target` example paints a wall-clock stamp the harness reads back from
 * every presented frame in headless Chromium, end to end through the bridge
 * and the engine's X11 source. One JSON line per scenario goes to stdout; the
 * run fails on a regression threshold only when `--gate` is set.
 *
 * Usage (from the repo root):
 *
 *   node packages/desktop-host/test/g2g-flow.mjs [--size 1920x1080] [--max-fps 60]
 *     [--seconds 15] [--scenarios typing,scroll,still] [--gate]
 *     [--baseline <file>] [--require-load-gate]
 *
 * Scenarios: `typing` (stamp only), `scroll` (full-screen motion) and `still`
 * (the stamp freezes 2 s after mapping, to check the refine pass still runs).
 *
 * Environment:
 *
 *   DESKLINK_ENGINE       engine binary (default: this checkout's debug build;
 *                         MUXR_DESKLINK_ENGINE still works as a deprecated
 *                         fallback for one release, DESKLINK_AXI_ENGINE is
 *                         also honoured, so one variable serves every
 *                         engine flow)
 *   DESKLINK_CHROME       browser binary (default: google-chrome-stable,
 *                         google-chrome, chromium). With no Chrome the browser
 *                         half is skipped with a printed reason, like
 *                         `encoded-flow.mjs`.
 *   G2G_TASKSET_ENGINE / G2G_TASKSET_CHROME
 *                         optional `taskset` CPU lists pinning the engine and
 *                         the browser on a loaded host (the plan's load gate
 *                         allows pinning instead of a quiet machine).
 *
 * Safety (AGENTS.md): an explicit display >= 170 claimed only when both its
 * socket and lock file are absent, a fresh xauth cookie, the lock PID verified
 * against the spawned Xvfb, WAYLAND_DISPLAY empty for every capture-side
 * process, and every task-owned PID reaped on exit. The bridge is stopped with
 * SIGTERM so it shuts its engine child down; the engine PID the bridge records
 * is reaped too, never orphaned by a SIGKILLed bridge (the scout's pitfall).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const [sizeW, sizeH] = (flag('size', '1920x1080') ?? '').split('x').map(Number);
assert(Number.isInteger(sizeW) && sizeW > 0 && Number.isInteger(sizeH) && sizeH > 0, '--size must be WxH');
const maxFps = Number(flag('max-fps', '60'));
assert(Number.isInteger(maxFps) && maxFps > 0, '--max-fps must be a positive integer');
const seconds = Number(flag('seconds', '15'));
assert(Number.isInteger(seconds) && seconds >= 5, '--seconds must be at least 5');
const scenarios = (flag('scenarios', 'typing,scroll,still') ?? '').split(',').filter(Boolean);
assert(scenarios.length > 0 && scenarios.every((s) => ['typing', 'scroll', 'still'].includes(s)), '--scenarios must be typing,scroll,still');
const gate = args.includes('--gate');
const baselinePath = flag('baseline', null);
const requireLoadGate = args.includes('--require-load-gate');
const baselineText = baselinePath === null ? null : readFileSync(baselinePath, 'utf8');
const baselineEntries = (() => {
    if (baselineText === null) return null;
    try {
        const parsed = JSON.parse(baselineText);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        const entries = [];
        for (const ln of baselineText.split('\n')) {
            const t = ln.trim();
            if (t === '') continue;
            try { entries.push(JSON.parse(t)); } catch { }
        }
        return entries;
    }
})();
const baselineByScenario = (() => {
    if (baselineEntries === null) return null;
    const map = {};
    for (const entry of baselineEntries) {
        if (entry !== null && typeof entry === 'object' && typeof entry.scenario === 'string') map[entry.scenario] = entry;
    }
    return map;
})();
assert(baselineByScenario === null || Object.keys(baselineByScenario).length > 0, `--baseline ${baselinePath} holds no scenario lines`);

const dir = mkdtempSync(join(tmpdir(), 'desklink-g2g-flow-'));
const enginePidFile = join(dir, 'engines.pid');
const sessionMarker = `DESKLINK_G2G_SESSION=g2g-${process.pid}`;

// --- task-owned process tracking: PID -> /proc start time, never a reused PID.
const owned = new Map();
function proc(pid) {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return { state: fields[0], started: fields[19] };
    } catch { return undefined; }
}
function remember(pid, command) {
    assert(Number.isSafeInteger(pid) && pid > 1, `invalid recorded PID: ${pid}`);
    if (owned.has(pid)) return;
    const state = proc(pid);
    if (!state || state.state === 'Z') { owned.set(pid, undefined); return; }
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { owned.set(pid, undefined); return; }
    // Launcher shims (e.g. distro chromium wrappers) exit and zombify between
    // the stat and cmdline reads, leaving an empty cmdline: already gone.
    if (cmdline === '') { owned.set(pid, undefined); return; }
    // Distro launchers may re-exec under a different path (e.g. /usr/bin/chromium
    // re-execs /usr/lib/chromium/chromium); accept the basename so the harness
    // runs against those shims. PID-reuse safety still rests on the start-time
    // check in alive().
    assert(cmdline.includes(command) || cmdline.includes(basename(command)), `unexpected child ${pid}`);
    owned.set(pid, state.started);
}
function alive(pid) {
    const started = owned.get(pid);
    if (started === undefined) return false;
    const state = proc(pid);
    return state?.started === started && state.state !== 'Z';
}
async function stopProcess(pid, signal = 'SIGTERM') {
    if (!alive(pid)) return;
    try { process.kill(pid, signal); } catch { /* already gone */ }
    for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    if (alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
    assert(!alive(pid), `task-owned process ${pid} survived cleanup`);
}
function sessionStrays() {
    const strays = [];
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1 || owned.has(pid) || pid === process.pid) continue;
        try {
            if (!readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(sessionMarker)) continue;
            strays.push({ pid, cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') });
        } catch { /* vanished or not readable */ }
    }
    return strays;
}

// --- display ownership: explicit high display, own cookie, lock-PID verified.
// The range runs past flow.mjs's 170-199 because sibling lanes hold live
// servers there on this shared host; the plan's bound is >= 170 either way.
const number = Array.from({ length: 80 }, (_, i) => 170 + i).find(
    (n) => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`),
);
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir, 'Xauthority');
assert.equal(
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' }).status,
    0, 'xauth failed',
);
const xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', `${sizeW}x${sizeH}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
remember(xvfb.pid, 'Xvfb');

function which(name) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    const path = found.status === 0 ? found.stdout.trim() : '';
    return path === '' ? null : path;
}
function findEngine() {
    const candidates = [
        process.env.DESKLINK_ENGINE,
        process.env.MUXR_DESKLINK_ENGINE,
        process.env.DESKLINK_AXI_ENGINE,
        join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'),
    ].filter((c) => typeof c === 'string' && c !== '');
    const binary = candidates.find((c) => existsSync(c));
    if (binary === undefined) throw new Error(`no engine binary found (tried ${candidates.join(', ')})`);
    return binary;
}
function findChrome() {
    const candidates = [process.env.DESKLINK_CHROME, 'google-chrome-stable', 'google-chrome', 'chromium'].filter(
        (c) => typeof c === 'string' && c !== '',
    );
    for (const candidate of candidates) {
        const path = candidate.includes('/') ? (existsSync(candidate) ? candidate : null) : which(candidate);
        if (path !== null) return path;
    }
    return null;
}
function load() {
    const one = Number(readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0]);
    const nproc = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout.trim());
    return { one, nproc, gate_ok: one <= nproc / 4 };
}
function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** Chrome over CDP: launch, attach to a page target, evaluate in it. */
async function startChrome(binary, pageUrl) {
    const profile = mkdtempSync(join(tmpdir(), 'desklink-g2g-chrome-'));
    const taskset = (process.env.G2G_TASKSET_CHROME ?? '').trim().split(/\s+/).filter(Boolean);
    const chrome = spawn(
        binary,
        [
            '--headless=new',
            `--user-data-dir=${profile}`,
            '--remote-debugging-port=0',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--mute-audio',
            '--autoplay-policy=no-user-gesture-required',
            `--window-size=${Math.min(sizeW, 1600)},${Math.min(sizeH, 1000)}`,
            'about:blank',
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            // Headless Chromium needs no display; keep it off both servers so
            // it can never paint onto the captured Xvfb or the live desktop.
            env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
        },
    );
    if (taskset.length > 0) {
        spawnSync('taskset', ['-pc', taskset.join(','), String(chrome.pid)], { stdio: 'ignore' });
    }
    remember(chrome.pid, binary);
    chrome.stderr.setEncoding('utf8');
    let stderr = '';
    chrome.stderr.on('data', (chunk) => { stderr += chunk; });

    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    let port = null;
    while (Date.now() < deadline && port === null) {
        if (existsSync(portFile)) port = Number.parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10) || null;
        if (port === null) await sleep(100);
    }
    if (port === null) throw new Error(`Chrome never opened a debugging port: ${stderr.slice(-400)}`);

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdpsocket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((open, fail) => {
        cdpsocket.once('open', open);
        cdpsocket.once('error', fail);
    });
    let next = 0;
    const pending = new Map();
    cdpsocket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.id === undefined) return;
        const waiting = pending.get(message.id);
        if (waiting === undefined) return;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`${message.error.message}`));
        else waiting.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const id = ++next;
            pending.set(id, { resolve, reject });
            cdpsocket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
        });
    const target = await send('Target.createTarget', { url: pageUrl });
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;
    const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
        if (result.exceptionDetails !== undefined) {
            throw new Error(`the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        }
        return result.result.value;
    };
    const until = async (expression, timeoutMs, what) => {
        const limit = Date.now() + timeoutMs;
        while (Date.now() < limit) {
            const value = await evaluate(expression).catch(() => false);
            if (value) return value;
            await sleep(150);
        }
        throw new Error(`timed out waiting for ${what}`);
    };
    let closed = false;
    return {
        evaluate,
        until,
        close: async () => {
            if (closed) return;
            closed = true;
            try { await send('Target.closeTarget', { targetId: target.targetId }); } catch { /* already gone */ }
            try { cdpsocket.close(); } catch { /* already closed */ }
            await stopProcess(chrome.pid, 'SIGKILL');
            rmSync(profile, { recursive: true, force: true });
        },
    };
}

async function startVite() {
    const { createServer: createVite } = await import('vite');
    const server = await createVite({ root: repo, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

const engineBinary = findEngine();
const chromeBinary = findChrome();

// The stamp example, built once; every scenario spawns it with its own MODE.
assert.equal(
    spawnSync('cargo', ['build', '-q', '--manifest-path', 'packages/desktop-host/engine/Cargo.toml', '--example', 'stamp_target'], { cwd: repo, stdio: 'ignore' }).status,
    0, 'stamp_target does not build',
);
const stampBinary = join(process.env.CARGO_TARGET_DIR ?? 'packages/desktop-host/engine/target', 'debug', 'examples', 'stamp_target');

async function verifyXvfb() {
    for (let i = 0; i < 100 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(50);
    assert(xvfb.pid && xvfb.exitCode === null && existsSync(socket), 'private Xvfb did not start');
    assert.equal(Number(readFileSync(`/tmp/.X${number}-lock`, 'utf8').trim()), xvfb.pid, 'X lock belongs to another server');
    const line = readFileSync('/proc/net/unix', 'utf8').split('\n').find((l) => l.endsWith(` ${socket}`));
    assert(line, 'X socket missing from proc socket table');
    const inode = line.trim().split(/\s+/)[6];
    assert(readdirSync(`/proc/${xvfb.pid}/fd`).some((fd) => {
        try { return readlinkSync(`/proc/${xvfb.pid}/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
    }), 'X server socket is not held by the spawned Xvfb PID');
    const info = spawnSync(stampBinary, ['--probe'], {
        env: { ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '' },
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(info.status, 0, `stamp could not verify ${display}: ${info.stderr}`);
    assert.match(info.stdout, new RegExp(`size=${sizeW}x${sizeH} xwayland=false`), 'unexpected server geometry');
}

/** The stamp target: the only X client on the private display. */
async function startStamp(mode) {
    const stamp = spawn(stampBinary, [], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
            ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '',
            MODE: mode, RATE: '120', STILL_AFTER_MS: '2000', DESKLINK_G2G_SESSION: `g2g-${process.pid}`,
        },
    });
    remember(stamp.pid, stampBinary);
    let ready = '';
    const stampDeadline = Date.now() + 10_000;
    await new Promise((resolve, reject) => {
        stamp.stdout.setEncoding('utf8');
        stamp.stdout.on('data', (chunk) => {
            ready += chunk;
            if (ready.includes('ready')) resolve();
        });
        const timer = setInterval(() => {
            if (Date.now() > stampDeadline) {
                clearInterval(timer);
                reject(new Error(`stamp never painted on ${display}`));
            }
        }, 100);
        timer.unref?.();
    });
    return stamp;
}

async function runScenario(scenario, vite) {
    const mode = scenario === 'scroll' ? 'scroll' : scenario === 'still' ? 'still' : 'typing';
    const loadBefore = load();
    // The bridge serves the engine's protocol; the engine child PID it records
    // is what lets this harness reap the engine even if the bridge dies first.
    const port = await freePort();
    const token = randomBytes(24).toString('base64url');
    const taskset = (process.env.G2G_TASKSET_ENGINE ?? '').trim();
    const bridgeCommand = taskset !== '' ? 'taskset' : process.execPath;
    const bridgeArgs = taskset !== ''
        ? ['-c', taskset, process.execPath, resolve(repo, 'packages/desktop-host/bin/desklink-host.mjs')]
        : [resolve(repo, 'packages/desktop-host/bin/desklink-host.mjs')];
    const bridge = spawn(bridgeCommand, [...bridgeArgs,
        'bridge', '--listen', `127.0.0.1:${port}`, '--token', token, '--source', 'x11', '--display', display], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '',
            DESKLINK_ENGINE: engineBinary,
            MUXR_DESKLINK_ENGINE: engineBinary,
            DESKLINK_AXI_ENGINE_PID_FILE: enginePidFile,
            DESKLINK_G2G_SESSION: `g2g-${process.pid}`,
        },
    });
    remember(bridge.pid, 'desklink-host.mjs');
    let bridgeOut = '';
    bridge.stderr.setEncoding('utf8');
    bridge.stderr.on('data', (chunk) => { bridgeOut += chunk; });
    const bridgeUrl = `ws://127.0.0.1:${port}/desktop?token=${encodeURIComponent(token)}`;
    const bridgeDeadline = Date.now() + 20_000;
    let bridgeUp = false;
    while (Date.now() < bridgeDeadline && !bridgeUp) {
        if (bridge.exitCode !== null) throw new Error(`bridge exited during startup: ${bridgeOut.slice(-500)}`);
        try {
            await new Promise((resolve, reject) => {
                const probe = new WebSocket(bridgeUrl);
                probe.once('open', () => { probe.close(); resolve(); });
                probe.once('error', reject);
            });
            bridgeUp = true;
        } catch { await sleep(150); }
    }
    assert(bridgeUp, `bridge never listened: ${bridgeOut.slice(-500)}`);

    const pageUrl = `${vite.url}packages/desktop-host/test/g2g-flow.html?engine=${encodeURIComponent(bridgeUrl)}&width=${sizeW}&height=${sizeH}`;
    const chrome = await startChrome(chromeBinary, pageUrl);
    let stamp = null;
    try {
        await chrome.until('window.__flow?.ready === true', 20_000, 'the page to load');
        stamp = await startStamp(mode);
        const opened = await chrome.evaluate(`window.__flow.open(${maxFps})`);
        assert.equal(typeof opened.sessionId, 'string', 'session.open returned no session');
        await chrome.until('window.__flow.state.presented === true', 25_000, 'a first decoded frame');
        const startedAt = Date.now();
        await sleep(seconds * 1000);
        const elapsed = (Date.now() - startedAt) / 1000;
        const result = await chrome.evaluate(`(async () => ({
            frames: window.__flow.state.frames,
            g2g: window.__flow.state.g2g,
            discarded: window.__flow.state.discarded,
            intervals: window.__flow.state.intervals,
            stats: await window.__flow.stats(),
            metrics: await window.__flow.metrics(window.__flow.state.sessionId),
            geometry: window.__flow.state.geometry,
            rejection: window.__flow.state.rejection,
        }))()`);
        await chrome.evaluate('window.__flow.close()').catch(() => undefined);
        const loadAfter = load();

        const g2g = [...result.g2g].sort((a, b) => a - b);
        const intervals = [...result.intervals].sort((a, b) => a - b);
        const inbound = result.stats.inbound[0] ?? {};
        const decodeMean = inbound.framesDecoded > 0 && inbound.totalDecodeTime != null
            ? (inbound.totalDecodeTime / inbound.framesDecoded) * 1000 : null;
        const jitterMean = inbound.jitterBufferEmittedCount > 0 && inbound.jitterBufferDelay != null
            ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000 : null;
        const m = result.metrics;
        const line = {
            scenario,
            size: `${sizeW}x${sizeH}`,
            max_fps: maxFps,
            seconds: Math.round(elapsed * 10) / 10,
            presented_fps: Math.round((result.frames / elapsed) * 10) / 10,
            frame_interval_p95_ms: percentile(intervals, 95),
            g2g_ms: {
                p50: percentile(g2g, 50),
                p95: percentile(g2g, 95),
                max: g2g.length > 0 ? g2g[g2g.length - 1] : null,
                n: g2g.length,
                discarded: result.discarded,
            },
            engine: {
                ...m,
                captured_fps: Math.round((m.captured_frames / elapsed) * 10) / 10,
                encoded_fps: Math.round((m.encoded_frames / elapsed) * 10) / 10,
                capture_ms_mean: m.captured_frames > 0 ? Math.round((m.capture_micros / m.captured_frames / 1000) * 100) / 100 : null,
                convert_ms_mean: m.captured_frames > 0 ? Math.round((m.convert_micros / m.captured_frames / 1000) * 100) / 100 : null,
                queue_ms_mean: m.motion_frames > 0 ? Math.round((m.queue_micros / m.motion_frames / 1000) * 100) / 100 : null,
                encode_ms_mean: m.encoded_frames > 0 ? Math.round((m.encode_micros / m.encoded_frames / 1000) * 100) / 100 : null,
                send_ms_mean: m.encoded_frames > 0 ? Math.round((m.send_micros / m.encoded_frames / 1000) * 100) / 100 : null,
            },
            receiver: {
                decoded: inbound.framesDecoded ?? result.stats.decoded,
                dropped: inbound.framesDropped ?? result.stats.droppedDecoded,
                decode_ms_mean: decodeMean !== null ? Math.round(decodeMean * 100) / 100 : null,
                jitter_buffer_ms_mean: jitterMean !== null ? Math.round(jitterMean * 100) / 100 : null,
            },
            load: { before: loadBefore.one, after: loadAfter.one, nproc: loadAfter.nproc, gate_ok: loadBefore.gate_ok && loadAfter.gate_ok },
        };
        console.log(JSON.stringify(line));
        return line;
    } finally {
        await chrome.close().catch(() => undefined);
        // SIGTERM lets the bridge shut its engine child down gracefully; the
        // recorded engine PID is reaped either way, never orphaned.
        await stopProcess(bridge.pid, 'SIGTERM');
        recordPidFiles();
        for (const pid of [...owned.keys()]) {
            if (pid === xvfb.pid) continue;
            await stopProcess(pid, 'SIGKILL');
        }
        if (stamp !== null) await stopProcess(stamp.pid, 'SIGTERM');
    }
}

function recordPidFiles() {
    if (!existsSync(enginePidFile)) return;
    for (const pid of readFileSync(enginePidFile, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
        try { remember(pid, engineBinary); } catch { /* a reused PID is not ours to signal */ }
    }
}

function checkGate(lines) {
    const failures = [];
    // A still desktop honestly presents ~1 fps of keepalives and refinements,
    // and every one of them carries the frozen stamp, so its glass samples
    // only prove the path is live; rate and latency gates belong to typing
    // and scroll.
    const minSamples = { typing: 10, scroll: 10, still: 1 };
    for (const line of lines) {
        if (line.g2g_ms.n < (minSamples[line.scenario] ?? 10)) failures.push(`${line.scenario}: only ${line.g2g_ms.n} glass samples`);
        const total = line.g2g_ms.n + line.g2g_ms.discarded;
        // Still keepalives carry the frozen stamp, so late ones are stale by
        // design; the ratio gate only means something while the stamp moves.
        if (line.scenario !== 'still' && total > 0 && line.g2g_ms.discarded / total >= 0.5) {
            failures.push(`${line.scenario}: ${line.g2g_ms.discarded}/${total} stamps unreadable`);
        }
        if (line.scenario === 'still' && !(line.engine.refined_frames >= 1)) {
            failures.push(`still: no refinement pass (refined_frames=${line.engine.refined_frames})`);
        }
        const expected = baselineByScenario?.[line.scenario];
        if (expected !== undefined && expected !== null) {
            if (expected.presented_fps != null && line.presented_fps < expected.presented_fps * 0.8) {
                failures.push(`${line.scenario}: presented ${line.presented_fps} fps, baseline ${expected.presented_fps} (-20% gate)`);
            }
            if (line.g2g_ms.p50 !== null && expected.g2g_ms?.p50 != null && line.g2g_ms.p50 > expected.g2g_ms.p50 * 1.2) {
                failures.push(`${line.scenario}: g2g p50 ${line.g2g_ms.p50} ms, baseline ${expected.g2g_ms.p50} (+20% gate)`);
            }
        }
        if (requireLoadGate && !line.load.gate_ok) {
            failures.push(`${line.scenario}: load gate breached (before ${line.load.before}, after ${line.load.after}, nproc ${line.load.nproc})`);
        }
    }
    assert.equal(failures.length, 0, `gate failed:\n${failures.join('\n')}`);
}

let vite = null;
try {
    await verifyXvfb();
    if (chromeBinary === null) {
        console.log('SKIPPED the browser half: no Chrome found (set DESKLINK_CHROME).');
        console.log(`engine ${engineBinary}; Xvfb ${display} at ${sizeW}x${sizeH} verified`);
        process.exitCode = 0;
    } else {
        console.log(`engine ${engineBinary}`);
        console.log(`chrome ${chromeBinary}`);
        vite = await startVite();
        const lines = [];
        for (const scenario of scenarios) lines.push(await runScenario(scenario, vite));
        if (gate) checkGate(lines);
        console.log(`ok: ${lines.length} scenario(s), bridge stopped with SIGTERM, engine reaped`);
    }
} finally {
    recordPidFiles();
    for (const pid of [...owned.keys()]) {
        if (pid === xvfb.pid) continue;
        await stopProcess(pid, 'SIGKILL').catch(() => undefined);
    }
    const strays = sessionStrays();
    assert.equal(strays.length, 0, `task-owned strays survived: ${JSON.stringify(strays)}`);
    // Graceful Xvfb exit unlinks the X socket; SIGKILL leaves it behind.
    if (alive(xvfb.pid)) {
        try { process.kill(xvfb.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 40 && alive(xvfb.pid); i++) await sleep(50);
        if (alive(xvfb.pid)) await stopProcess(xvfb.pid, 'SIGKILL');
    }
    assert(!alive(xvfb.pid), 'the private Xvfb survived cleanup');
    await vite?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
}
