#!/usr/bin/env node
/**
 * The example app on a physical iPad, without a hand and without XCUITest
 * (whose automation mode needs the owner's Touch ID). A debug build launched
 * with `-desklinkJourney` takes each step from this script and runs it through
 * DesktopView's own touch and text handlers and the app's own buttons
 * (`useJourney` in example/App.tsx): real app, network and engine; the input
 * enters at the view's gesture handlers, not the glass. Each step is measured
 * on a page on a private Xvfb, as test/ios-flow.mjs measures it, and the
 * iPad's screen is saved after it.
 *
 * The debug app loads its JS from Metro (`npx expo start` in example/) at the
 * address in its ip.txt; over a tailnet that needs NSAllowsArbitraryLoads in
 * the lane's built Info.plist. Hold the device for the whole run. Set
 * DESKLINK_IOS_MAC (ssh), _UDID (devicectl), _APP (.app on the Mac), _BUNDLE,
 * _SHOT (a Mac command writing the iPad's screen to a PNG path), _HOST_ADDR
 * (this machine as the iPad reaches it), _OUT (evidence directory).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const { DESKLINK_IOS_MAC: MAC, DESKLINK_IOS_UDID: UDID, DESKLINK_IOS_APP: APP, DESKLINK_IOS_BUNDLE: BUNDLE, DESKLINK_IOS_SHOT: SHOT, DESKLINK_IOS_HOST_ADDR: HOST } = process.env;
if (!MAC || !UDID || !APP || !BUNDLE || !SHOT || !HOST) {
    console.log('SKIPPED: set DESKLINK_IOS_MAC, _UDID, _APP, _BUNDLE, _SHOT and _HOST_ADDR to drive a physical iPad.');
    process.exit(0);
}
const repo = join(import.meta.dirname, '../../..');
const out = process.env.DESKLINK_IOS_OUT ?? mkdtempSync(join(tmpdir(), 'desklink-ios-device-'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'desklink-ios-device-host-'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms)), lines = [];
const log = (...args) => { const line = [new Date().toISOString(), ...args].join(' '); lines.push(line); console.log(line); };
const mac = (script) => {
    const run = spawnSync('ssh', ['-o', 'BatchMode=yes', MAC, 'bash -s'], { input: script, encoding: 'utf8', timeout: 180_000 });
    assert.equal(run.status, 0, `on the Mac: ${script.split('\n')[0]}\n${run.stdout}${run.stderr}`);
};
async function until(what, read, settled, deadline = Date.now() + 15_000) {
    for (let value = await read(); ; value = await read()) {
        if (settled(value)) return value;
        assert(Date.now() < deadline, `${what}: the last read was ${JSON.stringify(value)}`);
        await sleep(250);
    }
}

// The desktop: test/ios-flow.mjs's notes page, trimmed to what this journey measures.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Notes</title>
<body style="margin:0;overflow-y:scroll;background:#fbfaf7;color:#1d1d1f;font:24px/1.5 system-ui,sans-serif">
<main style="margin-left:40px;width:300px;padding-top:56px;height:3000px"><h1>Notes</h1><p><span id="line">select this line</span></p>
<textarea id="pad" style="position:fixed;left:40px;top:600px;width:280px;height:96px;font:20px system-ui"></textarea>
<button id="copy-out" style="position:fixed;left:400px;top:600px;width:170px;height:44px">Copy this line</button>
</main>
<script>
window.clicks = []; window.keys = []; window.pointer = []; window.pastes = [];
document.getElementById('pad').addEventListener('paste', (event) => pastes.push(event.clipboardData.getData('text')));
document.getElementById('copy-out').addEventListener('click', () => {
    getSelection().selectAllChildren(document.getElementById('line'));
    window.copied = document.execCommand('copy') ? getSelection().toString() : null;
});
for (const type of ['mousedown', 'mouseup']) addEventListener(type, (event) => clicks.push({ type, x: event.clientX, y: event.clientY, button: event.button }));
for (const type of ['keydown', 'keyup']) addEventListener(type, (event) => keys.push({ type, key: event.key, ctrl: event.ctrlKey }));
for (const type of ['mousemove', 'mousedown', 'mouseup', 'wheel']) addEventListener(type, (event) => pointer.push({ type, x: event.clientX, y: event.clientY,
    button: event.button, buttons: event.buttons, dy: event.deltaY ?? 0, selection: getSelection().toString() }));
</script>`;

const children = [];
let xvfb = null; let claim = null; let steps = null;
async function cleanup() {
    steps?.close();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const child of children) { try { process.kill(-child.pid, signal); } catch { /* gone */ } }
        await sleep(1000);
    }
    if (xvfb) await stopOwnedXvfb(xvfb);
    claim?.release();
    rmSync(work, { recursive: true, force: true });
    writeFileSync(join(out, 'physical-ipad-flow.log'), lines.join('\n') + '\n');
}

async function main() {
    // ---- the desktop: private Xvfb, the page, the bridge on the tailnet -----------
    claim = claimPrivateDisplay({ from: 170, count: 60 });
    const authority = join(work, 'Xauthority');
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]).status, 0);
    const env = { ...process.env, DISPLAY: claim.display, XAUTHORITY: authority, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11' };
    xvfb = spawn('Xvfb', [claim.display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { env, stdio: 'ignore' });
    trackOwnedXvfb(xvfb, claim.display);
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${claim.number}`); i++) await sleep(50);
    await verifyOwnedXvfb(xvfb);
    writeFileSync(join(work, 'page.html'), PAGE);
    children.push(spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x720', '-framerate', '15', '-i', claim.display, '-c:v', 'libx264', '-preset', 'ultrafast', join(out, 'physical-ipad-lab-desktop.mkv')], { env, stdio: 'ignore', detached: true }));
    const profile = join(work, 'profile');
    children.push(spawn(process.env.DESKLINK_CHROME ?? 'chromium', ['--ozone-platform=x11', '--force-device-scale-factor=1', '--kiosk',
        '--window-size=1280,720', '--window-position=0,0', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
        `file://${join(work, 'page.html')}`], { env: { ...env, GDK_SCALE: '' }, stdio: 'ignore', detached: true }));
    for (let i = 0; i < 300 && !existsSync(join(profile, 'DevToolsActivePort')); i++) await sleep(100);
    const port = Number.parseInt(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8'), 10);
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((candidate) => candidate.type === 'page');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((open) => socket.once('open', open));
    let seq = 0;
    const page = (expression) => new Promise((done) => {
        const id = ++seq;
        const on = (raw) => { const message = JSON.parse(String(raw)); if (message.id === id) { socket.off('message', on); done(message.result?.result?.value); } };
        socket.on('message', on);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    const token = randomBytes(24).toString('hex');
    const bridge = spawn(process.execPath, [join(repo, 'packages/desktop-host/bin/desklink-host.mjs'), 'bridge', '--listen', `${HOST}:0`,
        '--token', token, '--source', 'x11', '--display', claim.display],
    { env: { ...env, DESKLINK_ENGINE: process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host') }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
    children.push(bridge);
    let printed = '';
    const bridgePort = await new Promise((ready) => bridge.stdout.on('data', (chunk) => { printed += chunk; const url = /open\s+http:\/\/[^:]+:(\d+)\//.exec(printed); if (url) ready(Number(url[1])); }));
    // ---- the step server the app polls: each POST carries the last step's reply --
    let pending = null; let arrived = () => {};
    steps = createServer(async (request, response) => { pending = { response, body: JSON.parse(await request.toArray().then((parts) => String(Buffer.concat(parts))) || '{}') }; arrived(); }).listen(0, HOST);
    await new Promise((listening) => steps.once('listening', listening));
    const take = async (what, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (!pending) { assert(Date.now() < deadline, `the app never asked for ${what}`); await Promise.race([new Promise((done) => { arrived = done; }), sleep(500)]); }
        const taken = pending; pending = null; return taken;
    };
    const act = async (step) => {
        (await take(JSON.stringify(step), 30_000)).response.end(JSON.stringify(step));
        if (step === null) return;
        pending = await take('its next step', 30_000);
        assert(!pending.body.error, `the app failed ${JSON.stringify(step)}: ${pending.body.error}`);
    };
    // ---- launch the app on the iPad --------------------------------------------
    const url = `ws://${HOST}:${bridgePort}/desktop?token=${token}`;
    const journey = `http://${HOST}:${steps.address().port}/`;
    mac(`xcrun devicectl device install app --device ${UDID} '${APP}' >/dev/null
xcrun devicectl device process launch --device ${UDID} --terminate-existing -- ${BUNDLE} -desklinkUrl '${url}' -desklinkJourney '${journey}' >/dev/null`);
    log(`launched ${BUNDLE} on the physical iPad ${UDID}; desktop bridge ${HOST}:${bridgePort}, steps at ${journey}`);
    pending = await take('its first step (it never went live)', 120_000);
    log('the physical iPad shows the live desktop and asked for its first step');

    const evidence = async (name, note) => {
        const shot = `physical-ipad-${name}.png`;
        mac(`${SHOT} "$HOME/${shot}" >/dev/null 2>&1; true`);
        spawnSync('scp', ['-q', `${MAC}:${shot}`, join(out, shot)]);
        mac(`rm -f "$HOME/${shot}"`);
        spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x720', '-i', claim.display, '-frames:v', '1', join(out, `desktop-${shot}`)], { env });
        log(`step ${name}: ${note} (${shot})`);
    };
    await evidence('00-live', 'the iPad shows the live desktop');
    const clean = () => page('clicks.length = keys.length = pointer.length = pastes.length = 0');
    const touch = async (phase, ...points) => act({ touch: phase, points });
    const tapView = async ([x, y]) => { await touch('start', [x, y]); await touch('end'); };
    // Where a view point lands on the desktop, measured: two taps fix scale and offset per axis.
    const probes = [[300, 200], [700, 360]];
    const landed = [];
    for (const probe of probes) {
        await clean();
        await tapView(probe);
        landed.push((await until(`the probe tap at ${probe} clicked the desktop`, () => page('clicks'), (seen) => seen.length >= 2))[0]);
    }
    const [ax, ay] = ['x', 'y'].map((axis, i) => (landed[1][axis] - landed[0][axis]) / (probes[1][i] - probes[0][i]));
    const view = ({ x, y }) => [probes[0][0] + (x - landed[0].x) / ax, probes[0][1] + (y - landed[0].y) / ay];
    log(`aim: view (${probes[0]}) → desktop (${landed[0].x}, ${landed[0].y}); ${ax.toFixed(3)}, ${ay.toFixed(3)} desktop px per pt`);
    const near = (event, at) => Math.abs(event.x - at.x) <= 3 && Math.abs(event.y - at.y) <= 3;
    // 1. tap
    const press = { x: 700, y: 460 };
    await clean();
    await tapView(view(press));
    const clicked = await until('a tap is one click on the desktop', () => page('clicks'), (seen) => seen.length >= 2);
    assert.deepEqual(clicked.map((click) => click.type), ['mousedown', 'mouseup']);
    assert(near(clicked[0], press) && clicked[0].button === 0, `the click lands under the finger: ${JSON.stringify(clicked[0])}`);
    await evidence('01-tap', `tap → mousedown+mouseup at desktop (${clicked[0].x}, ${clicked[0].y}), aimed at (${press.x}, ${press.y})`);
    // 2. drag: hold past the long press, move, lift
    const [left, top, right, bottom] = await page('(() => { const b = document.getElementById("line").getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; })()');
    const [from, to] = [left + 6, right - 6].map((x) => ({ x: Math.round(x), y: Math.round((top + bottom) / 2) }));
    await clean();
    await touch('start', view(from));
    await sleep(700);
    for (let i = 1; i <= 6; i++) await touch('move', view({ x: from.x + (to.x - from.x) * i / 6, y: from.y }));
    await touch('end');
    const dragged = await until('the drag arrived', () => page('pointer'), (seen) => seen.some((event) => event.type === 'mouseup'));
    const [down, up] = ['mousedown', 'mouseup'].map((type) => dragged.find((event) => event.type === type));
    const held = dragged.filter((event) => event.type === 'mousemove' && (event.buttons & 1) === 1);
    assert(near(down, from) && Math.abs(up.x - to.x) <= 3 && held.length > 0, `the drag presses, holds and lets go under the finger: ${JSON.stringify(dragged)}`);
    assert.match(up.selection, /this/, 'the drag selected the page text');
    await evidence('02-drag', `press (${down.x}, ${down.y}) → ${held.length} held moves → release (${up.x}, ${up.y}), selected ${JSON.stringify(up.selection)}`);
    // 3. two fingers scroll the desktop's wheel
    const at = view({ x: 700, y: 300 });
    await clean();
    await touch('start', at);
    await touch('move', at, [at[0] + 60, at[1]]);
    for (let i = 1; i <= 8; i++) await touch('move', [at[0], at[1] - 30 * i], [at[0] + 60, at[1] - 30 * i]);
    await touch('end');
    const wheel = (seen) => seen.filter((event) => event.type === 'wheel').reduce((sum, event) => sum + event.dy, 0);
    const scrolled = await until('two fingers turned the wheel', () => page('pointer'), (seen) => Math.abs(wheel(seen)) >= 100);
    await evidence('03-scroll', `two-finger scroll → ${scrolled.filter((event) => event.type === 'wheel').length} wheel events, deltaY ${wheel(scrolled)}, page scrollY ${await page('scrollY')}`);
    // 4. typing reaches the desktop's focused field once per character
    const pad = { x: 150, y: 640 };
    await tapView(view(pad));
    await clean();
    await act({ text: 'desklink' });
    const typed = await until('the typed text reached the field', () => page('document.getElementById("pad").value'), (seen) => seen === 'desklink');
    const downs = (await page('keys')).filter((key) => key.type === 'keydown').map((key) => key.key);
    assert.deepEqual(downs, [...'desklink'], 'one keydown per character');
    await evidence('04-typing', `typed "desklink" → desktop field reads ${JSON.stringify(typed)}, ${downs.length} keydowns`);
    // 5. sticky modifier: the key row's Ctrl, then a key
    await clean();
    await act({ press: 'desklink-key-Control' });
    await act({ text: 'a' });
    const chord = await until('Ctrl then A reached the desktop', () => page('keys'), (seen) => seen.some((key) => key.type === 'keyup' && key.key === 'a'));
    assert(chord.find((key) => key.type === 'keydown' && key.key === 'a')?.ctrl, `Ctrl then A arrives as Control+A: ${JSON.stringify(chord)}`);
    await evidence('05-sticky-modifier', `Ctrl latched on the key row → next key arrives as Control+A: ${chord.map((key) => `${key.type}:${key.ctrl ? 'Ctrl+' : ''}${key.key}`).join(' ')}`);
    // 6. desktop → iPad: the page copies its line, the app's Copy brings it over
    await page('window.copied = undefined');
    await tapView(view({ x: 485, y: 622 }));
    const copied = await until('the page copied its line', () => page('window.copied'), (seen) => seen === 'select this line');
    await act({ press: 'desklink-copy' }).then(() => sleep(300));
    await evidence('06-clipboard-out', `desktop clipboard ${JSON.stringify(copied)} → the app's Copy; the iPad's screen shows the confirmation`);
    // 7. iPad → desktop: the app's Paste sends its clipboard, Ctrl+V pastes it
    await tapView(view(pad));
    await clean();
    await act({ press: 'desklink-paste' }).then(() => sleep(1500));
    await act({ press: 'desklink-key-Control' });
    await act({ text: 'v' });
    const pastes = await until('the desktop pasted the iPad\'s clipboard', () => page('pastes'), (seen) => seen.length > 0);
    assert.equal(pastes.at(-1), 'select this line', 'the desktop pasted what the iPad held');
    await evidence('07-clipboard-in', `the app's Paste, then Ctrl+V → the desktop field pasted ${JSON.stringify(pastes.at(-1))}`);

    await act(null);
    log('ok: physical iPad, real app, real network and engine; input injected at the view\'s gesture handlers, not physical touches');
}

main().catch((error) => { log('FAIL', error.stack ?? error); process.exitCode = 1; }).finally(cleanup);
