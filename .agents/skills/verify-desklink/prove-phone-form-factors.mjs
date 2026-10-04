#!/usr/bin/env node
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY node <this-file> <evidence-dir>
// The phone client on a real engine: the package's own web surface (the code path
// DesktopView.web.tsx mounts) fitted to a portrait phone and a landscape phone,
// a motion recording of a tap, a pinch-zoom and a pan, and the fixture's own
// numeric button edges for the tap. Writes into the same run directory the
// desktop helper owns; never overwrites its own evidence.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../../packages/desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
const out = resolve(process.argv[2] ?? '');
assert(out && existsSync(out), 'pass the run directory the desktop helper created');
assert(!existsSync(join(out, 'phone.json')), 'refusing to overwrite phone evidence');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = join(repo, 'packages/desktop-client/src');
const cache = join(process.env.HOME, '.cache', 'desklink-verify');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'phone-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? process.env.DESKLINK_AXI_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = resolve(process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const browser = process.env.DESKLINK_CHROME ?? '/usr/lib/chromium/chromium';
const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const owned = new Map();
const proc = pid => {
    try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return { state: f[0], started: f[19] }; }
    catch { return null; }
};
const alive = (pid, started) => { const p = proc(pid); return p?.started === started && p.state !== 'Z'; };
const rememberTree = pid => {
    const p = proc(pid); if (p && pid !== process.pid && !owned.has(pid)) owned.set(pid, p.started);
    try { for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) rememberTree(Number(child)); }
    catch { /* process already exited */ }
};
const start = (cmd, args, childEnv = env) => {
    const child = spawn(cmd, args, { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { child.failure = error; }); rememberTree(child.pid); return child;
};
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });
const waitFor = async (test, label, ms = 20000) => {
    const until = Date.now() + ms;
    while (!test()) { assert(!interrupted, interrupted); assert(Date.now() < until, `timed out: ${label}`); await sleep(50); }
};
const logs = { bridge: '', fixture: '', xvfb: '' };
const result = { sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), outcome: 'FAIL', formFactors: {} };
let xvfb, bridge, target, context, page, server, port;

// The driver page mounts the package's real session hook and its real web
// surface binding — the same two calls DesktopView.web.tsx makes — in a plain
// box sized like a phone screen. RN's View is a stub, exactly as in the RN web
// build, so what is on screen is the client's own picture, pointer and gestures.
const DRIVER_TS = `
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDesktopSession } from '__SRC__/useDesktopSession';
import { attachSurface } from '__SRC__/native.web';
import type { Signaling } from '__SRC__/protocol';

const PORT = __PORT__, TOKEN = '__TOKEN__';
const probe = { status: 'boot', frames: 0, log: [] as string[] };
(window as any).__probe = probe;
let seq = 0; let opened: { sessionId: string; generation: number } | null = null;
const pending = new Map(); const handlers = new Set();
const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/desktop?token=' + TOKEN);
const socketOpen = new Promise<void>((r) => socket.addEventListener('open', () => r()));
socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
        const waiter = pending.get(msg.id); pending.delete(msg.id); if (!waiter) return;
        if (msg.error !== undefined) waiter.reject(new Error(msg.error.message)); else waiter.resolve(msg.result);
        return;
    }
    const p = msg.params ?? {}; let t = null;
    if (msg.event === 'session.description') t = { kind: 'description', description: p.description, sessionId: p.sessionId };
    else if (msg.event === 'session.candidate') t = { kind: 'candidate', candidate: p.candidate, sdpMid: p.sdpMid ?? null, sdpMLineIndex: p.sdpMLineIndex ?? null, sessionId: p.sessionId };
    else if (msg.event === 'session.state') t = { kind: 'state', capture: p.capture, transport: p.transport, firstFrame: p.firstFrame, sessionId: p.sessionId };
    else if (msg.event === 'session.restoreToken') t = { kind: 'restoreToken', token: p.token, sessionId: p.sessionId };
    else if (msg.event === 'session.revoked') t = { kind: 'revoked', reason: p.reason, code: p.code, sessionId: p.sessionId };
    if (t !== null) for (const h of handlers) h(t);
});
const signaling: Signaling = {
    request: (method, params) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve: (v: any) => { if (method === 'session.open') opened = { sessionId: v.sessionId, generation: v.generation }; resolve(v); }, reject });
        socket.send(JSON.stringify({ id, method, params }));
    }),
    subscribe: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
};

function Harness() {
    const session = useDesktopSession({
        authorize: async () => { await socketOpen; return { signaling, session: { maxWidth: 1280, maxHeight: 720, maxFps: 30 } }; },
        onStateChange: (s) => { probe.status = s.status; probe.log.push(s.status); },
    });
    React.useEffect(() => { void session.connect(); }, []);
    React.useEffect(() => {
        if (session.nativeId == null) return;
        const stage = document.getElementById('stage');
        session.setInputEnabled(true);
        attachSurface(session.nativeId, stage, 'desktop');
        const video = stage.querySelector('video');
        const tick = () => video.requestVideoFrameCallback(() => { probe.frames += 1; tick(); });
        tick();
    }, [session.nativeId]);
    return null;
}
TestRenderer.create(React.createElement(Harness));
`;
const INDEX_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>desklink phone client</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#stage{position:fixed;inset:0}</style>
<div id="stage"></div><script type="module" src="./driver.ts"></script>
`;

try {
    for (const path of [engine, fixture, browser]) assert(existsSync(path), `missing binary: ${path}`);
    Object.assign(result, { engine, engineSha256: hash(engine), fixtureSha256: hash(fixture), browser, helperSha256: hash(fileURLToPath(import.meta.url)) });
    const n = Array.from({ length: 30 }, (_, i) => 170 + i).find(i => !existsSync(`/tmp/.X11-unix/X${i}`) && !existsSync(`/tmp/.X${i}-lock`));
    assert(n, 'no unclaimed private display');
    const display = `:${n}`, authority = join(scratch, 'Xauthority'); result.display = display;
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]).status, 0, 'xauth failed');
    xvfb = start('Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp']);
    xvfb.stderr.on('data', c => { logs.xvfb += c; }); trackOwnedXvfb(xvfb, display);
    await waitFor(() => proc(xvfb.pid)?.state === 'T', 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb); xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };
    const probeOut = spawnSync(fixture, ['--probe'], { env: xenv, encoding: 'utf8', timeout: 5000 });
    assert.equal(probeOut.status, 0, probeOut.stderr);
    assert(probeOut.stdout.includes('vendor=The X.Org Foundation size=1280x720 xwayland=false'), probeOut.stdout);
    result.doctor = probeOut.stdout.trim();
    target = start(fixture, [], xenv);
    target.stdout.on('data', c => { logs.fixture += c; }); target.stderr.on('data', c => { logs.fixture += c; });
    await waitFor(() => logs.fixture.includes('"ready"'), 'fixture ready');
    const bridgeArgs = ['packages/desktop-host/bin/desklink-host.mjs', 'bridge', '--source', 'x11', '--display', display, '--listen', '127.0.0.1:0'];
    result.command = [process.execPath, ...bridgeArgs];
    bridge = start(process.execPath, bridgeArgs, xenv);
    bridge.stdout.on('data', c => { logs.bridge += c; }); bridge.stderr.on('data', c => { logs.bridge += c; });
    await waitFor(() => /^open\s+http/m.test(logs.bridge), 'bridge URL'); rememberTree(bridge.pid);
    const openUrl = new URL(/^open\s+(http\S+)/m.exec(logs.bridge)[1]);
    port = Number(openUrl.port); const token = openUrl.searchParams.get('token');
    assert(token, 'bridge printed no token');

    // ---- the client page, built from the package's own web source ----------
    const pageDir = join(scratch, 'driver');
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(pageDir, 'driver.ts'), DRIVER_TS.split('__SRC__').join(src).split('__PORT__').join(String(port)).split('__TOKEN__').join(token));
    writeFileSync(join(pageDir, 'rn-stub.js'), `export const AppState = { addEventListener: () => ({ remove() {} }) };\nexport const Platform = { OS: 'web' };\n`);
    writeFileSync(join(pageDir, 'vite.config.mjs'), `const SRC = ${JSON.stringify(src)};
const WT = ${JSON.stringify(join(repo, 'node_modules'))};
const PAGE = ${JSON.stringify(pageDir)};
export default { root: PAGE, logLevel: 'warn', define: { global: 'globalThis' },
  build: { outDir: ${JSON.stringify(join(scratch, 'dist-page'))}, emptyOutDir: true, minify: false },
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
    const build = spawnSync('npx', ['vite', 'build', '--config', join(pageDir, 'vite.config.mjs')], { cwd: repo, encoding: 'utf8', timeout: 180000 });
    assert.equal(build.status, 0, `vite build failed: ${build.stdout}\n${build.stderr}`);
    const dist = join(scratch, 'dist-page');
    server = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        const file = join(dist, path === '/' ? 'index.html' : path.slice(1));
        if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(readFileSync(file));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const pageUrl = `http://127.0.0.1:${server.address().port}/`;
    result.clientUrl = pageUrl;

    const videoDir = join(scratch, 'video'); mkdirSync(videoDir, { recursive: true });
    const PORTRAIT = { width: 390, height: 844 }, LANDSCAPE = { width: 844, height: 390 };
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), { executablePath: browser, headless: true,
        viewport: PORTRAIT, deviceScaleFactor: 2, hasTouch: true, env, timeout: 30000,
        recordVideo: { dir: videoDir, size: PORTRAIT },
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows'] });
    rememberTree(process.pid); page = context.pages()[0]; page.setDefaultTimeout(20000);
    result.browserVersion = context.browser()?.version();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => window.__probe?.status === 'live', null, { timeout: 60000 });
    await page.waitForFunction(() => (window.__probe?.frames ?? 0) > 3, null, { timeout: 60000 });
    const box = async () => page.evaluate(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const video = document.querySelector('#stage video');
        const r = video?.getBoundingClientRect();
        return { viewport: { width: innerWidth, height: innerHeight }, stage: { width: stage.width, height: stage.height },
            picture: r ? { x: r.x, y: r.y, width: r.width, height: r.height, videoWidth: video.videoWidth, videoHeight: video.videoHeight } : null,
            pointerShown: (document.querySelector('#stage > div') ?? {}).style?.display };
    });

    // ---- landscape: the whole 1280x720 desktop fits the short axis ---------
    await page.setViewportSize(LANDSCAPE);
    await page.waitForFunction(() => { const r = document.querySelector('#stage video')?.getBoundingClientRect(); return r && r.width > 0; });
    await sleep(500);
    const landscape = await box(); result.formFactors.landscape = landscape;
    assert(landscape.picture, 'no picture in the landscape phone viewport');
    const landscapeScale = Math.min(landscape.stage.width / 1280, landscape.stage.height / 720);
    assert(Math.abs(landscape.picture.width - 1280 * landscapeScale) <= 2 && Math.abs(landscape.picture.height - 720 * landscapeScale) <= 2,
        `landscape picture is not the whole desktop fitted: ${JSON.stringify(landscape.picture)}`);
    await page.screenshot({ path: join(out, 'phone-landscape.png') });

    // ---- portrait: fit width, letterbox the tall axis -----------------------
    await page.setViewportSize(PORTRAIT);
    await page.waitForFunction(() => { const r = document.querySelector('#stage video')?.getBoundingClientRect(); return r && Math.abs(r.width - innerWidth) <= 2; }, null, { timeout: 10000 })
        .catch(() => { throw new Error('portrait did not fit the picture to the viewport width'); });
    await sleep(500);
    const portrait = await box(); result.formFactors.portrait = portrait;
    assert(Math.abs(portrait.picture.width - PORTRAIT.width) <= 2, `portrait picture does not fill the width: ${JSON.stringify(portrait.picture)}`);
    assert(portrait.picture.height < PORTRAIT.height, 'portrait picture is not letterboxed vertically');
    await page.screenshot({ path: join(out, 'phone-portrait.png') });

    // ---- motion: a tap, a pinch-zoom in and back out, and a pan ------------
    const fitWidth = portrait.picture.width;
    const point = { x: Math.round(PORTRAIT.width / 2), y: Math.round(PORTRAIT.height / 2) };
    await page.touchscreen.tap(point.x, point.y);
    await waitFor(() => logs.fixture.includes('"phase":"up"'), 'phone tap on the desktop');
    const tapEdges = logs.fixture.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
        .filter(e => e.kind === 'button' && e.button === 1 && e.phase === 'down');
    assert(tapEdges.length > 0, 'the phone tap never reached the desktop as button 1');
    result.tapDesktopPoint = { x: tapEdges[0].x, y: tapEdges[0].y };
    await sleep(300);
    await page.keyboard.down('Control');
    for (const delta of [-120, -120, -120, 120, 120]) { await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, delta); await sleep(120); }
    await page.keyboard.up('Control');
    await sleep(300);
    const zoomed = await box(); result.formFactors.pinchZoom = { fitWidth, zoomedWidth: zoomed.picture.width };
    assert(zoomed.picture.width > fitWidth + 20, `pinch did not zoom the picture in: ${fitWidth} -> ${zoomed.picture.width}`);
    await page.screenshot({ path: join(out, 'phone-zoom.png') });
    await sleep(500);
    result.outcome = 'PASS';
} catch (error) { result.error = String(error.stack ?? error); console.error(result.error); }
finally {
    rememberTree(process.pid);
    const failures = [];
    if (context) try { await Promise.race([context.close(), sleep(10000).then(() => { throw Error('browser close timed out'); })]); } catch (e) { failures.push(String(e)); }
    // Playwright names the recording after the page; keep it under our own name.
    const videoDir = join(scratch, 'video');
    const recording = existsSync(videoDir) ? readdirSync(videoDir).find(name => name.endsWith('.webm')) : null;
    if (recording) try { renameSync(join(videoDir, recording), join(out, 'phone-motion.webm')); } catch (e) { failures.push(String(e)); }
    if (bridge) bridge.kill('SIGTERM'); if (target) target.kill('SIGTERM');
    server?.close();
    await sleep(500);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const [pid, started] of owned) if (pid !== xvfb?.pid && alive(pid, started)) try { process.kill(pid, signal); } catch (e) { failures.push(String(e)); }
        await sleep(500);
    }
    if (xvfb) try { await stopOwnedXvfb(xvfb); } catch (e) { failures.push(String(e)); }
    await sleep(200);
    const survivors = [...owned].filter(([pid, started]) => alive(pid, started));
    const portOpen = port && await new Promise(r => { const s = connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); s.setTimeout(1000, () => { s.destroy(); r(true); }); });
    if (survivors.length || failures.length || portOpen || interrupted) result.outcome = 'FAIL';
    result.cleanup = { ownedPids: [...owned.keys()], survivors, failures, portOpen: Boolean(portOpen), interrupted };
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(out, `phone-${name}.log`), log);
    writeFileSync(join(out, 'phone-events.jsonl'), logs.fixture);
    writeFileSync(join(out, 'phone.json'), JSON.stringify(result, null, 2) + '\n');
    rmSync(scratch, { recursive: true, force: true });
}
assert.equal(result.outcome, 'PASS', `proof failed; inspect ${join(out, 'phone.json')}`);
for (const name of ['phone-portrait.png', 'phone-landscape.png', 'phone-zoom.png', 'phone-motion.webm']) {
    const file = readFileSync(join(out, name));
    assert(file.length > 1000, `incomplete capture: ${name}`);
    if (name.endsWith('.png')) assert(file.readUInt32BE(0) === 0x89504e47, `not a PNG: ${name}`);
}
console.log(`PASS: phone client fitted portrait/landscape, tap -> fixture button, pinch zoom recorded; evidence ${out}`);