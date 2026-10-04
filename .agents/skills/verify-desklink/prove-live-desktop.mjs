#!/usr/bin/env node
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY node <this-file> <new-evidence-dir>
// Real reference-client click -> private X11 fixture -> returned marker pixels.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../../packages/desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
assert(process.argv[2], 'provide a new evidence directory');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2]);
assert(!existsSync(out), 'refusing to overwrite evidence');
mkdirSync(out, { recursive: true });
const cache = join(process.env.HOME, '.cache', 'desklink-verify');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'run-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
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
const waitFor = async (test, label, ms = 15000) => {
    const until = Date.now() + ms;
    while (!test()) { assert(!interrupted, interrupted); assert(Date.now() < until, `timed out: ${label}`); await sleep(50); }
};
const logs = { bridge: '', fixture: '', xvfb: '' };
const result = { sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), outcome: 'FAIL' };
let xvfb, bridge, target, context, page, port;
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
    const probe = spawnSync(fixture, ['--probe'], { env: xenv, encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert(probe.stdout.includes('vendor=The X.Org Foundation size=1280x720 xwayland=false'), probe.stdout);
    result.doctor = probe.stdout.trim();
    target = start(fixture, [], xenv);
    target.stdout.on('data', c => { logs.fixture += c; }); target.stderr.on('data', c => { logs.fixture += c; });
    await waitFor(() => logs.fixture.includes('"ready"'), 'fixture ready');
    const bridgeArgs = ['packages/desktop-host/bin/desklink-host.mjs', 'bridge', '--source', 'x11', '--display', display, '--listen', '127.0.0.1:0'];
    result.command = [process.execPath, ...bridgeArgs];
    bridge = start(process.execPath, bridgeArgs, xenv);
    bridge.stdout.on('data', c => { logs.bridge += c; }); bridge.stderr.on('data', c => { logs.bridge += c; });
    await waitFor(() => /^open\s+http/m.test(logs.bridge), 'bridge URL'); rememberTree(bridge.pid);
    const url = /^open\s+(http\S+)/m.exec(logs.bridge)[1]; port = Number(new URL(url).port);
    const beforeRefusal = logs.fixture;
    result.wrongTokenRefused = await new Promise(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/desktop?token=wrong`, { handshakeTimeout: 3000 });
        ws.once('error', () => resolve(true)); ws.once('open', () => { ws.close(); resolve(false); });
    });
    await sleep(100); assert(result.wrongTokenRefused && logs.fixture === beforeRefusal, 'wrong-token connection accepted or mutated fixture');
    const caps = spawnSync(process.execPath, ['packages/desktop-host/bin/desklink-host.mjs', 'capabilities'], { env: xenv, encoding: 'utf8', timeout: 10000 });
    assert.equal(caps.status, 0, caps.stderr); writeFileSync(join(out, 'capabilities.json'), caps.stdout);
    assert(JSON.parse(caps.stdout).input.pointer, 'private lab pointer unavailable');
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), { executablePath: browser, headless: true,
        viewport: { width: 1340, height: 860 }, env, timeout: 20000,
        recordVideo: { dir: join(scratch, 'video'), size: { width: 1340, height: 860 } },
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows'] });
    rememberTree(process.pid); page = context.pages()[0]; page.setDefaultTimeout(15000);
    result.browserVersion = context.browser()?.version();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => { const v = document.querySelector('#video'); return v?.videoWidth === 1280 && v.readyState >= 2; }, null, { timeout: 45000 });
    result.target = await page.evaluate(() => {
        const v = document.querySelector('#video'), r = v.getBoundingClientRect();
        window.__verifyEvents = []; for (const name of ['pointerdown', 'pointerup']) v.addEventListener(name, e => window.__verifyEvents.push({ name, trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
        return { url: location.href, visible: !document.hidden, hit: document.elementFromPoint(r.x + r.width / 4, r.y + r.height / 4)?.id,
            status: document.querySelector('#status').textContent, viewport: { width: innerWidth, height: innerHeight }, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    });
    assert(result.target.url === url && result.target.visible && result.target.hit === 'video', 'wrong selected target/hit-test');
    assert.deepEqual(result.target.viewport, { width: 1340, height: 860 }, 'actual viewport differs');
    const patch = () => { const v = document.querySelector('#video'), c = document.createElement('canvas'); c.width = c.height = 2;
        const ctx = c.getContext('2d'); ctx.drawImage(v, 323, 179, 2, 2, 0, 0, 2, 2); return Array.from(ctx.getImageData(0, 0, 2, 2).data); };
    const before = await page.evaluate(patch); assert(before.some((v, i) => i % 4 !== 3 && v > 60), 'baseline patch already black');
    await page.screenshot({ path: join(out, '01-before.png'), timeout: 15000 });
    // The invisible keyboard sits at center; choose a hit-tested picture pixel.
    await page.locator('#video').click({ position: { x: result.target.rect.width / 4, y: result.target.rect.height / 4 } });
    result.browserEvents = await page.evaluate(() => window.__verifyEvents);
    assert(['pointerdown', 'pointerup'].every(name => result.browserEvents.some(e => e.name === name && e.trusted)), 'no trusted pointer edges');
    await waitFor(() => logs.fixture.includes('"phase":"up"'), 'desktop button release');
    const events = logs.fixture.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    for (const phase of ['down', 'up']) assert(events.some(e => e.kind === 'button' && e.button === 1 && e.phase === phase && Math.abs(e.x - 320) <= 2 && Math.abs(e.y - 180) <= 2), `missing numeric button 1 ${phase}`);
    let after;
    for (let i = 0; i < 100; i++) { after = await page.evaluate(patch); if (after.every((v, j) => j % 4 === 3 || v < 30)) break; await sleep(100); }
    assert(after.every((v, i) => i % 4 === 3 || v < 30), 'fixture black marker did not return in decoded pixels');
    result.pixels = { before, after }; await page.screenshot({ path: join(out, '02-after.png'), timeout: 15000 });
    // Theme coverage: the client's own chrome, under both schemes the browser can
    // offer. Recorded either way, so the reviewer sees the reading, not a claim.
    const chrome = () => page.evaluate(() => ({ declared: getComputedStyle(document.documentElement).colorScheme,
        background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color }));
    await page.emulateMedia({ colorScheme: 'dark' }); const darkChrome = await chrome();
    await page.emulateMedia({ colorScheme: 'light' }); const lightChrome = await chrome();
    await page.screenshot({ path: join(out, '03-theme-light-emulated.png'), timeout: 15000 });
    result.theme = { dark: darkChrome, lightEmulated: lightChrome, clientShipsLightTheme: darkChrome.background !== lightChrome.background };
    await page.emulateMedia({ colorScheme: 'dark' });
    result.outcome = 'PASS';
} catch (error) { result.error = String(error.stack ?? error); console.error(result.error); }
finally {
    rememberTree(process.pid);
    const failures = [];
    if (context) try { await Promise.race([context.close(), sleep(10000).then(() => { throw Error('browser close timed out'); })]); } catch (e) { failures.push(String(e)); }
    const videoDir = join(scratch, 'video');
    const recording = existsSync(videoDir) ? readdirSync(videoDir).find(name => name.endsWith('.webm')) : null;
    if (recording) try { renameSync(join(videoDir, recording), join(out, 'desktop-motion.webm')); } catch (e) { failures.push(String(e)); }
    if (bridge) bridge.kill('SIGTERM'); if (target) target.kill('SIGTERM'); await sleep(500);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const [pid, started] of owned) if (pid !== xvfb?.pid && alive(pid, started)) try { process.kill(pid, signal); } catch (e) { failures.push(String(e)); }
        await sleep(500);
    }
    if (xvfb) try { await stopOwnedXvfb(xvfb); } catch (e) { failures.push(String(e)); }
    await sleep(200);
    const survivors = [...owned].filter(([pid, started]) => alive(pid, started));
    const portOpen = port && await new Promise(resolve => { const s = connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(true); }); });
    if (survivors.length || failures.length || portOpen || interrupted) result.outcome = 'FAIL';
    result.cleanup = { ownedPids: [...owned.keys()], survivors, failures, portOpen: Boolean(portOpen), interrupted };
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(out, `${name}.log`), log);
    writeFileSync(join(out, 'events.jsonl'), logs.fixture); rmSync(scratch, { recursive: true, force: true });
    writeFileSync(join(out, 'run.json'), JSON.stringify(result, null, 2) + '\n');
}
assert.equal(result.outcome, 'PASS', `proof failed; inspect ${join(out, 'run.json')}`);
for (const name of ['01-before.png', '02-after.png', '03-theme-light-emulated.png', 'desktop-motion.webm']) { const file = readFileSync(join(out, name)); assert(file.length > 1000, `incomplete capture: ${name}`); if (name.endsWith('.png')) assert(file.readUInt32BE(0) === 0x89504e47, `not a PNG: ${name}`); }
console.log(`PASS: trusted browser click -> fixture edges -> decoded marker; evidence ${out}`);
