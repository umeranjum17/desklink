// Flow check for dl-rn-reconnect1: real engine on a private Xvfb + real
// @desklink/react-native hook and web binding in a driver page, real Chromium.
// Freezes the server side (engine + bridge, SIGSTOP) for 5 s, 25 s and
// 45 s — the host-unreachable drop: ICE, signaling and hook timers keep
// running on the viewing browser while the far end goes silent — and measures
// reconnecting latency plus time from unfreeze to the first new frame
// (target <= 3 s). Freezing both server processes together also freezes the
// bridge's wedged-engine reaper, so a 45 s outage cannot look like host death.
// Then freezes the viewing browser for 60 s — a suspended phone: the engine
// sees the path fail and revokes the session with code `transport` while the
// client cannot hear it — and requires a reopen back to live. The browser
// peer's own 'failed' is withheld from the hook there, as a resumed iOS peer
// may never send one, so the revocation alone must drive the reopen. Last, a session
// opened with a short lease must end when the lease expires, and stay ended.
// Everything it starts is task-owned and reaped by recorded PID.
// NOTE: needs TMPDIR pointing at a volume with free quota (/tmp may be full).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const worktree = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(worktree, 'packages/desktop-client/src');

// Whole-run watchdog: never wait forever. A scenario that does not recover
// is recorded as a measured failure by its own deadlines below.
setTimeout(() => {
    console.error('OVERALL TIMEOUT: flow did not finish in 12 minutes');
    process.exit(2);
}, 12 * 60 * 1000).unref?.();
const dir = mkdtempSync(join(tmpdir(), 'dl-rn-flow-'));
const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---- driver page sources (bundled with vite; the real hook + web binding) --
const DRIVER_TS = `
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDesktopSession } from '__SRC__/useDesktopSession';
import { attachSurface, nativeDesklink } from '__SRC__/native.web';
import type { Signaling } from '__SRC__/protocol';

const PORT = __PORT__;
const TOKEN = '__TOKEN__';

const probe = { status: 'boot', failure: null as string | null, opens: 0, frames: 0, lastNewFrame: 0, log: [] as Array<[number, string]>, sig: [] as Array<[number, string]> };
(window as any).__probe = probe;
let opened: { sessionId: string; generation: number } | null = null;
(window as any).__forceRestart = () => {
    if (opened == null) return false;
    signaling.request('session.restart_ice', { session_id: opened.sessionId, generation: opened.generation }).catch(() => undefined);
    return true;
};
(window as any).__pointerTest = async (x: number, y: number) => {
    const session = (window as any).__session;
    if (session == null) return 'fail: no session';
    session.setInputEnabled(true);
    session.send({ kind: 'pointer', phase: 'move', x, y });
    return 'sent';
};

// A resumed iOS peer may never report its own failure. While this is set the
// hook does not hear the browser peer's 'failed', so only the engine's
// revocation can move a dead session on.
(window as any).__silencePeerFailure = false;
const addListener = nativeDesklink.addListener.bind(nativeDesklink);
nativeDesklink.addListener = (name: any, handler: any) => addListener(name, (event: any) => {
    const failed = event.name === 'failure' || (event.name === 'ice' && String(event.payload?.state).toLowerCase() === 'failed');
    if (failed && (window as any).__silencePeerFailure) { probe.sig.push([Date.now(), 'muted-peer-' + event.name]); return; }
    handler(event);
});

let seq = 0;
const pending = new Map();
const handlers = new Set();
const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/desktop?token=' + TOKEN);
let openedResolve: (() => void) | null = null;
const socketOpen = new Promise<void>((resolve) => { openedResolve = resolve; });
socket.addEventListener('open', () => openedResolve!());
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
    let translated = null;
    if (msg.event === 'session.description') translated = { kind: 'description', description: { type: p.description.type, sdp: p.description.sdp }, sessionId: p.sessionId };
    else if (msg.event === 'session.candidate') translated = { kind: 'candidate', candidate: { candidate: p.candidate, sdpMid: p.sdpMid ?? null, sdpMLineIndex: p.sdpMLineIndex ?? null }, sessionId: p.sessionId };
    else if (msg.event === 'session.state') translated = { kind: 'state', capture: p.capture, transport: p.transport, firstFrame: p.firstFrame, sessionId: p.sessionId };
    else if (msg.event === 'session.restoreToken') translated = { kind: 'restoreToken', token: p.token, sessionId: p.sessionId };
    else if (msg.event === 'session.revoked') translated = { kind: 'revoked', reason: p.reason, code: p.code, sessionId: p.sessionId };
    if (translated !== null) { probe.sig.push([Date.now(), 'got-' + msg.event + (p.code ? ':' + p.code : '')]); for (const h of handlers) h(translated); }
});
const signaling: Signaling = {
    request: (method, params) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve: (value: any) => {
            if (method === 'session.open' && value != null && typeof value.sessionId === 'string') {
                opened = { sessionId: value.sessionId, generation: value.generation };
            }
            resolve(value);
        }, reject });
        probe.sig.push([Date.now(), 'req-' + method]);
        socket.send(JSON.stringify({ id, method, params }));
    }),
    subscribe: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
};

function Harness() {
    const session = useDesktopSession({
        authorize: async () => {
            await socketOpen;
            probe.opens += 1;
            const ttlSeconds = (window as any).__ttlSeconds;
            return { signaling, session: { maxWidth: 1280, maxHeight: 800, maxFps: 30, ttlSeconds } };
        },
        onStateChange: (snapshot) => {
            probe.status = snapshot.status;
            probe.failure = snapshot.failure?.code ?? null;
            probe.log.push([Date.now(), snapshot.status]);
        },
        onError: (failure) => {
            probe.log.push([Date.now(), 'error:' + failure.code + ':' + failure.message.slice(0, 120)]);
        },
    });
    (window as any).__session = session;
    React.useEffect(() => { void session.connect(); }, []);
    React.useEffect(() => {
        if (session.nativeId == null) return;
        const stage = document.getElementById('stage');
        attachSurface(session.nativeId, stage, 'desktop');
        const video = stage.querySelector('video');
        let last = 0;
        const tick = () => {
            const rvfc = video.requestVideoFrameCallback;
            if (typeof rvfc !== 'function') return;
            rvfc.call(video, (_now: number, meta: any) => {
                if (meta.presentedFrames > last) {
                    last = meta.presentedFrames;
                    probe.frames += 1;
                    probe.lastNewFrame = Date.now();
                }
                tick();
            });
        };
        tick();
    }, [session.nativeId]);
    return null;
}
TestRenderer.create(React.createElement(Harness));
`;
const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>driver</title>
<div id="stage" style="position:absolute;inset:0"></div>
<script type="module" src="./driver.ts"></script>
`;
const RN_STUB = `export const AppState = { addEventListener: () => ({ remove() {} }) };\nexport const Platform = { OS: 'web' };\n`;

const BRIDGE_RUNNER = `
import { Bridge } from '__HOST__/dist/bridge.js';
const [engineBin, display, token] = process.argv.slice(2);
const bridge = await Bridge.start({
    listen: '127.0.0.1:0', token, engineCommand: engineBin, engineArgs: ['serve'],
    source: { kind: 'x11', display }, serveExample: false,
});
console.log('BRIDGE_READY ' + bridge.port);
const shutdown = async () => { try { await bridge.close(); } catch {} process.exit(0); };
process.on('SIGTERM', () => void shutdown());
`;
const FIXTURE_HTML = `<!doctype html><meta charset="utf-8"><title>motion</title>
<div id="box" style="position:fixed;inset:0;font:96px monospace"></div>
<script>
let n = 0;
const box = document.getElementById('box');
function frame() {
    n += 1;
    box.textContent = 'frame ' + n;
    box.style.background = 'hsl(' + (n * 7 % 360) + ' 80% 60%)';
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>
`;

// ---- processes -------------------------------------------------------------
const owned = new Map(); // pid -> start time
function statOf(pid) {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return { state: fields[0], started: fields[19] };
    } catch { return undefined; }
}
function alive(pid) {
    const s = statOf(pid);
    return s !== undefined && s.state !== 'Z' && s.started === owned.get(pid);
}
function remember(pid) { owned.set(pid, statOf(pid)?.started); }
async function stopProcess(pid, name) {
    if (!alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
    assert(!alive(pid), `${name} ${pid} survived cleanup`);
}
/** Every live process below `root`, so a whole browser can be frozen at once. */
function descendants(root) {
    const children = new Map();
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        try {
            const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
            if (!children.has(ppid)) children.set(ppid, []);
            children.get(ppid).push(pid);
        } catch { /* vanished */ }
    }
    const found = [];
    const queue = [root];
    while (queue.length > 0) {
        const pid = queue.shift();
        found.push(pid);
        queue.push(...(children.get(pid) ?? []));
    }
    return found;
}
let frozenClient = [];
function signalClient(signal) {
    for (const pid of frozenClient) if (alive(pid)) { try { process.kill(pid, signal); } catch { /* gone */ } }
}
function findEnginePid(bridgePid) {
    const found = [];
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
            const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
            if (ppid === bridgePid && cmd.includes('desklink-host')) found.push(pid);
        } catch { /* vanished */ }
    }
    assert.equal(found.length, 1, `expected one engine child of ${bridgePid}, found ${found}`);
    return found[0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PY_QUERY = `
import ctypes
x11 = ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint)]
x11.XQueryPointer.restype = ctypes.c_int
d = x11.XOpenDisplay(None)
r = x11.XDefaultRootWindow(d)
root, child, rx, ry, wx, wy, mask = (ctypes.c_ulong(), ctypes.c_ulong(),
    ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint())
ok = x11.XQueryPointer(d, r, root, child, rx, ry, wx, wy, mask)
print(f"{rx.value} {ry.value}" if ok else "query-failed")
`;
async function pointerAt(env) {
    const out = spawnSync('python3', ['-c', PY_QUERY], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 0, `xquery failed: ${out.stderr}`);
    const [x, y] = out.stdout.trim().split(' ').map(Number);
    assert(Number.isFinite(x) && Number.isFinite(y), `bad pointer reading: ${out.stdout}`);
    return { x, y };
}
async function expectPointer(cdp, evaluate, env, x, y, what) {
    assert.equal(await evaluate(cdp, `window.__pointerTest(${x}, ${y})`), 'sent');
    const start = Date.now();
    for (;;) {
        const p = await pointerAt(env);
        if (Math.abs(p.x - x) <= 2 && Math.abs(p.y - y) <= 2) return true;
        assert(Date.now() - start < 8000, `${what}: pointer stuck at ${p.x},${p.y}, want ${x},${y}`);
        await sleep(200);
    }
}
async function expectPointerSoft(cdp, evaluate, env, x, y, what, timeoutMs = 8000) {
    assert.equal(await evaluate(cdp, `window.__pointerTest(${x}, ${y})`), 'sent');
    const start = Date.now();
    for (;;) {
        const p = await pointerAt(env);
        if (Math.abs(p.x - x) <= 2 && Math.abs(p.y - y) <= 2) return true;
        if (Date.now() - start >= timeoutMs) {
            log(`${what}: pointer stuck at ${p.x},${p.y}, want ${x},${y}`);
            return false;
        }
        await sleep(200);
    }
}

let xvfbPid = 0; let xvfb; let fixturePid = 0; let clientPid = 0; let bridgePid = 0; let enginePid = 0;
let staticServer = null; let cdpPort = 0;
async function cleanup() {
    try {
        if (clientPid) await stopProcess(clientPid, 'client chromium');
        if (fixturePid) await stopProcess(fixturePid, 'fixture chromium');
        // SIGTERM lets the bridge child close the bridge (and its engine).
        if (bridgePid) await stopProcess(bridgePid, 'bridge');
        if (enginePid && alive(enginePid)) await stopProcess(enginePid, 'engine');
        if (xvfb) await stopOwnedXvfb(xvfb);
        staticServer?.close();
    } catch (error) { log('cleanup error:', String(error)); }
    const strays = [];
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || owned.has(pid) || pid === process.pid) continue;
        try {
            const env = readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0');
            if (env.includes(`DESKLINK_RN_FLOW=${process.pid}`)) {
                strays.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 120)}`);
            }
        } catch { /* vanished */ }
    }
    assert.deepEqual(strays, [], `stray task processes: ${strays}`);
}

// ---- CDP -------------------------------------------------------------------
async function cdpConnect(port) {
    const { default: WSImpl } = await import(`file://${join(worktree, 'node_modules/ws/wrapper.mjs')}`);
    let target = null;
    for (let i = 0; i < 100 && target == null; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            target = list.find((t) => t.type === 'page');
        } catch { await sleep(300); }
    }
    assert(target, 'no page target');
    const socket = new WSImpl(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
    let id = 0;
    const waiting = new Map();
    socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id !== undefined && waiting.has(msg.id)) {
            const { resolve, reject } = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            (socket.consoleLines ??= []).push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const details = msg.params.exceptionDetails;
            (socket.consoleLines ??= []).push(`PAGE-EXCEPTION: ${(details.exception?.description ?? details.text).slice(0, 800)}`);
        }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const callId = ++id;
        waiting.set(callId, { resolve, reject });
        socket.send(JSON.stringify({ id: callId, method, params }));
        setTimeout(() => { if (waiting.delete(callId)) reject(new Error(`cdp timeout: ${method}`)); }, 15000);
    });
    await send('Runtime.enable');
    const api = async (method, params) => send(method, params);
    api.consoleLines = socket.consoleLines ?? [];
    // Keep the same array reference the socket handler appends to.
    Object.defineProperty(api, 'consoleLines', { get: () => socket.consoleLines ?? [] });
    return api;
}
async function evaluate(cdp, expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`page error: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    return result.result.value;
}
async function pollProbe(cdp, timeoutMs, want) {
    const start = Date.now();
    let last = null;
    for (;;) {
        // A frozen client cannot answer CDP either; that is also data.
        try {
            last = await evaluate(cdp, 'window.__probe ?? null');
        } catch {
            last = null;
        }
        if (last !== null && want(last)) return last;
        if (Date.now() - start >= timeoutMs) {
            try {
                last.sig = await evaluate(cdp, 'window.__probe.sig ?? []');
            } catch { /* page gone */ }
            log('last probe:', JSON.stringify(last));
            log('console:', (cdp.consoleLines ?? []).slice(-10).join('\n'));
            assert(false, `probe never satisfied want within ${timeoutMs}ms`);
        }
        await sleep(250);
    }
}

try {
    // ---- private Xvfb -------------------------------------------------------
    const number = Array.from({ length: 30 }, (_, i) => 220 + i).find((n) =>
        !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
    assert(number !== undefined, 'no unclaimed high X display');
    const display = `:${number}`;
    const authority = join(dir, 'Xauthority');
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]).status, 0);
    xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    trackOwnedXvfb(xvfb, display);
    remember(xvfb.pid); xvfbPid = xvfb.pid;
    const socketPath = `/tmp/.X11-unix/X${number}`;
    for (let i = 0; i < 100 && !existsSync(socketPath) && alive(xvfbPid); i++) await sleep(50);
    assert(alive(xvfbPid) && existsSync(socketPath), 'private Xvfb did not start');
    await verifyOwnedXvfb(xvfb);
    log('xvfb', display, 'pid', xvfbPid);

    const baseEnv = {
        ...process.env, DISPLAY: display, XAUTHORITY: authority,
        WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', DESKLINK_RN_FLOW: String(process.pid),
    };

    // ---- engine binary ------------------------------------------------------
    const engineBin = join(worktree, 'packages/desktop-host/engine/target/debug/desklink-host');
    assert(existsSync(engineBin), 'build the engine first');

    // ---- bridge (child process, so it can freeze with the engine) ---------
    const token = randomBytes(16).toString('hex');
    writeFileSync(join(dir, 'bridge-runner.mjs'),
        BRIDGE_RUNNER.split('__HOST__').join(join(worktree, 'packages/desktop-host')));
    const bridgeEnv = {
        ...process.env, DISPLAY: display, XAUTHORITY: authority,
        WAYLAND_DISPLAY: '', DESKLINK_RN_FLOW: String(process.pid),
    };
    const bridgeProc = spawn(process.execPath,
        [join(dir, 'bridge-runner.mjs'), engineBin, display, token],
        { env: bridgeEnv, stdio: ['ignore', 'pipe', 'inherit'] });
    remember(bridgeProc.pid); bridgePid = bridgeProc.pid;
    const bridgePort = await new Promise((resolve, reject) => {
        let out = '';
        const timeout = setTimeout(() => reject(new Error('bridge never reported ready')), 30000);
        bridgeProc.stdout.on('data', (chunk) => {
            out += String(chunk);
            const ready = /BRIDGE_READY (\d+)/.exec(out);
            if (ready) { clearTimeout(timeout); resolve(Number(ready[1])); }
        });
        bridgeProc.on('exit', (code) => reject(new Error(`bridge exited early: ${code}`)));
    });
    enginePid = findEnginePid(bridgePid); remember(enginePid);
    log('bridge on', bridgePort, 'pid', bridgePid, 'engine pid', enginePid);

    // ---- driver page + fixture ----------------------------------------------
    const pageDir = join(dir, 'driver');
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(pageDir, 'driver.ts'), DRIVER_TS.split('__SRC__').join(SRC).split('__PORT__').join(String(bridgePort)).split('__TOKEN__').join(token));
    writeFileSync(join(pageDir, 'rn-stub.js'), RN_STUB);
    writeFileSync(join(pageDir, 'vite.config.mjs'), `const SRC = ${JSON.stringify(SRC)};
const WT = ${JSON.stringify(join(worktree, 'node_modules'))};
const PAGE = ${JSON.stringify(pageDir)};
export default { root: PAGE, logLevel: 'warn',
  define: { global: 'globalThis' },
  build: { outDir: ${JSON.stringify(join(dir, 'dist-page'))}, emptyOutDir: true, minify: false },
  plugins: [{ name: 'native-shim', enforce: 'pre', resolveId(source, importer) {
    if (source === './native' && importer && importer.startsWith(SRC)) return SRC + '/native.web.ts';
    return null;
  } }],
  resolve: { alias: [
    { find: 'react-native', replacement: PAGE + '/rn-stub.js' },
    { find: 'react-test-renderer', replacement: WT + '/react-test-renderer' },
    { find: 'react', replacement: WT + '/react' },
  ] } };
`);
    writeFileSync(join(dir, 'fixture.html'), FIXTURE_HTML);
    const build = spawnSync('npx', ['vite', 'build', '--config', join(pageDir, 'vite.config.mjs')], { cwd: worktree, encoding: 'utf8', timeout: 120000 });
    assert.equal(build.status, 0, `vite build failed: ${build.stdout}\n${build.stderr}`);
    staticServer = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/fixture.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(readFileSync(join(dir, 'fixture.html'))); return; }
        const file = join(dir, 'dist-page', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!file.startsWith(join(dir, 'dist-page')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(readFileSync(file));
    });
    await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
    const pagePort = staticServer.address().port;
    log('static on', pagePort);

    const chromiumBin = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';
    // ---- fixture chromium (headed, on the private Xvfb) ---------------------
    const profileF = join(dir, 'profile-fixture'); mkdirSync(profileF, { recursive: true, mode: 0o700 });
    const fixture = spawn(chromiumBin, [
        '--ozone-platform=x11', '--window-size=1280,800', '--window-position=0,0',
        `--user-data-dir=${profileF}`, '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required', `http://127.0.0.1:${pagePort}/fixture.html`,
    ], { env: baseEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    remember(fixture.pid); fixturePid = fixture.pid;
    await sleep(4000);
    assert(alive(fixturePid), 'fixture chromium died');

    // ---- client chromium (headless) with CDP --------------------------------
    const profileC = join(dir, 'profile-client'); mkdirSync(profileC, { recursive: true, mode: 0o700 });
    const { default: net } = await import('node:net');
    cdpPort = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const client = spawn(chromiumBin, [
        '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileC}`,
        '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { env: { ...process.env, DESKLINK_RN_FLOW: String(process.pid) }, stdio: 'ignore' });
    remember(client.pid); clientPid = client.pid;
    const cdp = await (async () => {
        const start = Date.now();
        for (;;) {
            try { return await cdpConnect(cdpPort); }
            catch (error) {
                assert(Date.now() - start < 30000, `cdp never came up: ${error}`);
                await sleep(300);
            }
        }
    })();
    await cdp('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });

    // ---- live ---------------------------------------------------------------
    const live = await pollProbe(cdp, 45000, (p) => p.status === 'live' && p.frames > 3);
    log('live: opens=%d frames=%d', live.opens, live.frames);
    await expectPointer(cdp, evaluate, baseEnv, 400, 300, 'baseline');
    log('control channel baseline ok (pointer follows)');

    // ---- synthetic restart while healthy ------------------------------------
    const framesBefore = (await pollProbe(cdp, 5000, (p) => p.frames > live.frames)).frames;
    assert.equal(await evaluate(cdp, 'window.__forceRestart()'), true);
    await sleep(6000);
    const afterRestart = await evaluate(cdp, 'window.__probe');
    log('synthetic flap-check log:', JSON.stringify(afterRestart.log), 'sig:', JSON.stringify(afterRestart.sig));
    assert.equal(afterRestart.opens, 1, `restart reopened the session (opens=${afterRestart.opens})`);
    assert.equal(afterRestart.status, 'live');
    assert(afterRestart.frames > framesBefore, 'no frames after synthetic restart');
    assert.deepEqual(afterRestart.log.filter(([, s]) => s === 'reconnecting'), [], 'spurious reconnecting while healthy');
    await expectPointer(cdp, evaluate, baseEnv, 500, 350, 'after restart');
    log('synthetic restart: same session, frames flowing, no flapping, control alive');

    // ---- client-freeze blocks: 5 s, 25 s, 45 s ------------------------------
    // Freezing the viewing browser simulates the phone-side drop: ICE, the
    // The far end (engine + bridge) goes silent at once while the viewing
    // browser keeps running: ICE, signaling and hook timers all observe a
    // real outage. Freezing the bridge with the engine also freezes the
    // bridge's wedged-engine reaper, so a 45 s outage cannot look like host
    // death (a lone stopped engine would be reaped after 30 s).
    // Each scenario is independently measured: a scenario that does not
    // recover is recorded as a measured failure and the run continues.
    // SIGCONT is guaranteed so one failure cannot wedge the rest.
    const results = [];
    for (const seconds of [5, 25, 45]) {
        if (results.length > 0) {
            // Let the previous recovery converge (escalation, if any) so each
            // block starts from a settled session.
            log('settling 20s between blocks');
            await sleep(20000);
        }
        const rec = { seconds };
        results.push(rec);
        const stopAt = Date.now();
        log(`STOP#${seconds} at ${stopAt}`);
        process.kill(bridgePid, 'SIGSTOP');
        process.kill(enginePid, 'SIGSTOP');
        try {
            const saw = await pollProbe(cdp, 8000, (p) => p.status === 'reconnecting' || p.status === 'failed');
            rec.reconnectMs = Date.now() - stopAt;
            log(`${seconds}s block: ${saw.status} after ${rec.reconnectMs}ms`);
            assert(rec.reconnectMs <= 3500, `reconnecting took ${rec.reconnectMs}ms`);
        } catch (error) {
            rec.failed = `no reconnecting state: ${String(error).slice(0, 160)}`;
        }
        await sleep(Math.max(0, seconds * 1000 - (Date.now() - stopAt)));
        try { process.kill(enginePid, 'SIGCONT'); } catch { /* already back */ }
        try { process.kill(bridgePid, 'SIGCONT'); } catch { /* already back */ }
        const contAt = Date.now();
        log(`CONT#${seconds} at ${contAt}`);
        assert(alive(enginePid), 'the bridge reaped the engine mid-run');
        try {
            const recovered = await pollProbe(cdp, 20000, (p) => p.lastNewFrame > contAt);
            rec.recoveryMs = recovered.lastNewFrame - contAt;
            await pollProbe(cdp, 10000, (p) => p.status === 'live');
            const after = await evaluate(cdp, 'window.__probe');
            log(`status-log#${seconds}:`, JSON.stringify(after.log), 'sig-tail:', JSON.stringify(after.sig.slice(-8)));
            // Control may need the escalation path (restart cycles, then a
            // restore reopen), so allow it time to converge.
            const ok = await expectPointerSoft(cdp, evaluate, baseEnv, 400 + seconds, 300, `after ${seconds}s outage`, 30000);
            rec.control = ok ? 'ok' : 'STUCK';
            log(`${seconds}s block: first new frame ${rec.recoveryMs}ms after return, control ${rec.control}`);
            assert(rec.recoveryMs <= 3000, `recovery took ${rec.recoveryMs}ms after a ${seconds}s outage`);
            assert(rec.control === 'ok', `control dead after ${seconds}s outage`);
        } catch (error) {
            rec.failed = rec.failed ?? `no recovery: ${String(error).slice(0, 160)}`;
            log(`${seconds}s block: MEASURED FAILURE ${rec.failed}`);
        }
    }
    console.log(`FLOW-RESULT ${JSON.stringify(results)}`);
    const failed = results.filter((r) => r.failed !== undefined);
    assert(failed.length === 0, `${failed.length} scenario(s) did not recover: ${JSON.stringify(failed)}`);

    // ---- suspended viewer: 60 s, the engine revokes, the client reopens ----
    // Everything the viewing browser runs stops, as a backgrounded phone
    // does, while the engine keeps running: its ICE declares the path failed
    // and it revokes the session with code `transport`. The revocation waits
    // in the socket until the viewer resumes, and must lead to a reopen.
    log('settling 20s before the suspended-viewer block');
    await sleep(20000);
    await pollProbe(cdp, 10000, (p) => p.status === 'live');
    await evaluate(cdp, 'window.__silencePeerFailure = true');
    const beforeSuspend = await evaluate(cdp, 'window.__probe');
    assert(alive(clientPid), 'viewer PID changed before suspend');
    frozenClient = descendants(clientPid);
    for (const pid of frozenClient) remember(pid);
    const suspendAt = Date.now();
    log(`SUSPEND viewer (${frozenClient.length} processes) for 60s at ${suspendAt}`);
    signalClient('SIGSTOP');
    try {
        await sleep(60000);
    } finally {
        signalClient('SIGCONT');
    }
    const resumeAt = Date.now();
    log(`RESUME viewer at ${resumeAt}`);
    const back = await pollProbe(cdp, 30000, (p) => p.status === 'live' && p.opens > beforeSuspend.opens && p.lastNewFrame > resumeAt);
    const suspended = {
        seconds: 60,
        reopens: back.opens - beforeSuspend.opens,
        liveMs: back.log.findLast(([at, s]) => at > resumeAt && s === 'live')?.[0] - resumeAt,
        revoked: back.sig.filter(([at, s]) => at >= suspendAt && s.startsWith('got-session.revoked')).map(([, s]) => s),
        statuses: back.log.filter(([at]) => at >= suspendAt).map(([, s]) => s),
    };
    log('suspended viewer:', JSON.stringify(suspended));
    assert(!suspended.statuses.includes('ended'), `the suspended viewer ended instead of reopening: ${suspended.statuses}`);
    assert(suspended.revoked.includes('got-session.revoked:transport'), `the engine did not revoke the lost path with code transport: ${suspended.revoked}`);
    assert(await expectPointerSoft(cdp, evaluate, baseEnv, 640, 400, 'after the suspended viewer', 20000), 'control dead after the suspended viewer reopened');
    console.log(`SUSPEND-RESULT ${JSON.stringify(suspended)}`);
    await evaluate(cdp, 'window.__silencePeerFailure = false');

    // ---- pairing revocation still ends -----------------------------------
    // A session opened with an 8 s lease: its expiry is the grant ending, not
    // an outage, so the session ends and nothing reopens it.
    await evaluate(cdp, 'window.__ttlSeconds = 8; true');
    await evaluate(cdp, 'window.__session.close("lease check").then(() => true)');
    await pollProbe(cdp, 5000, (p) => p.status === 'ended');
    await evaluate(cdp, 'window.__session.connect().then(() => true)');
    const leased = await pollProbe(cdp, 30000, (p) => p.status === 'live');
    const leasedAt = Date.now();
    const expired = await pollProbe(cdp, 20000, (p) => p.status === 'ended');
    log(`lease: ended ${Date.now() - leasedAt}ms after live, failure=${expired.failure}`);
    assert.equal(expired.failure, 'revoked');
    assert(expired.sig.some(([, s]) => s === 'got-session.revoked:lease'), 'the engine did not revoke the lease with code lease');
    await sleep(12000);
    const stayed = await evaluate(cdp, 'window.__probe');
    assert.equal(stayed.status, 'ended', `a lease revocation was reopened: ${stayed.status}`);
    assert.equal(stayed.opens, leased.opens, `a lease revocation reopened the session (opens ${leased.opens} -> ${stayed.opens})`);
    console.log(`LEASE-RESULT ${JSON.stringify({ status: stayed.status, failure: stayed.failure, opens: stayed.opens })}`);
    await cleanup();
    log('done, cleaned up');
} catch (error) {
    console.error('FLOW-FAIL', error);
    signalClient('SIGCONT');
    try { if (enginePid && alive(enginePid)) process.kill(enginePid, 'SIGCONT'); } catch { /* gone */ }
    try { if (bridgePid && alive(bridgePid)) process.kill(bridgePid, 'SIGCONT'); } catch { /* gone */ }
    await cleanup();
    process.exit(1);
}
