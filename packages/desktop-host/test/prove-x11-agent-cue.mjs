#!/usr/bin/env node
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY node <this-file> <new-evidence-dir>
//
// One private X11 lab proves the Linux desktop product end to end:
//   1. live picture - the reference client renders this lab desktop;
//   2. input        - an agent session's click and typed text reach an X client;
//   3. cue          - the cue drawn for the agent's click is on the lab screen
//                     and absent from the captured picture at the same moment.
// The recording beside the stills puts the lab screen and the captured picture
// side by side for the same run.
//
// Every process runs in this task's own Xvfb (own display, PID, lock and
// socket); nothing here reads or drives an ambient desktop. Free tools only:
// Xvfb, Chromium, ffmpeg and the engine this checkout builds.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { chromium } from 'playwright-core';
import { Bridge, EngineClient } from '@desklink/host';
import { PeerConnection, cleanup as cleanupPeers } from 'node-datachannel';
import { assertNoAmbientDesktop, claimPrivateDisplay, scrubToken, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from './lab-safety.mjs';
import { recordSteps } from './step-record.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
assert(process.argv[2], 'provide a new evidence directory');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2]);
assert(!existsSync(out), 'refusing to overwrite evidence');
mkdirSync(out, { recursive: true });
const cache = join(process.env.HOME, '.cache', 'desklink-verify');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'x11-agent-cue-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = resolve(process.env.DESKLINK_X11_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const browser = process.env.DESKLINK_CHROME ?? '/usr/lib/chromium/chromium';
const WIDTH = 1280, HEIGHT = 720;
const env = { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const owned = new Set();
const start = (cmd, args, childEnv = env) => {
    const child = spawn(cmd, args, { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    owned.add(child);
    return child;
};
const stop = async (child, signal = 'SIGTERM', grace = 3000) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill(signal);
    await Promise.race([done, sleep(grace)]);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([done, sleep(2000)]);
    }
};
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });
const waitFor = async (test, label, ms = 20000) => {
    const until = Date.now() + ms;
    while (!test()) {
        assert(!interrupted, interrupted);
        assert(Date.now() < until, `timed out: ${label}`);
        await sleep(50);
    }
};
const rawPng = (raw, name) => {
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
        png.data[i * 4] = raw[i * 4 + 2];
        png.data[i * 4 + 1] = raw[i * 4 + 1];
        png.data[i * 4 + 2] = raw[i * 4];
        png.data[i * 4 + 3] = 255;
    }
    writeFileSync(join(out, name), PNG.sync.write(png));
};
let captureEnv = env;
const screenGrab = (path, args = []) => spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', ...args, '-video_size', `${WIDTH}x${HEIGHT}`, '-i', display, '-frames:v', '1', path], { env: captureEnv, timeout: 15000 });
const logs = { bridge: '', fixture: '', xvfb: '' };
const result = {
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    outcome: 'FAIL',
};
let claim, display, xvfb, target, reference, context, client, peer, recorder, sampler;
let samplingNow = false, lastRaw, lastSeq;
try {
    for (const path of [engine, fixture, browser]) assert(existsSync(path), `missing binary: ${path}`);
    Object.assign(result, { engine, engineSha256: hash(engine), fixtureSha256: hash(fixture), browser, helperSha256: hash(fileURLToPath(import.meta.url)) });
    claim = claimPrivateDisplay({ from: 170, count: 30 });
    display = claim.display;
    const authority = join(scratch, 'Xauthority');
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]).status, 0, 'xauth failed');
    result.display = display;
    xvfb = start('Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp']);
    xvfb.stderr.on('data', chunk => { logs.xvfb += chunk; });
    trackOwnedXvfb(xvfb, display);
    await waitFor(() => {
        try { return readFileSync(`/proc/${xvfb.pid}/stat`, 'utf8').split(') ')[1].startsWith('T'); }
        catch { return false; }
    }, 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };
    captureEnv = xenv;
    const probe = spawnSync(fixture, ['--probe'], { env: xenv, encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert(probe.stdout.includes(`size=${WIDTH}x${HEIGHT}`), probe.stdout);
    const typedPath = join(scratch, 'typed.txt');
    target = start(fixture, ['--record-text', typedPath, '--paint-text'], xenv);
    target.stdout.on('data', chunk => { logs.fixture += chunk; });
    target.stderr.on('data', chunk => { logs.fixture += chunk; });
    await waitFor(() => logs.fixture.includes('"ready"'), 'fixture ready');
    result.fixture = probe.stdout.trim();

    // 1. The reference client renders this lab desktop over the bridge. The
    //    bridge owns its engine child, so closing it closes the live session.
    const token = randomBytes(24).toString('base64url');
    // Bridge.start spawns its engine with this process's environment; the lab
    // display is authenticated, so the bridge engine inherits DISPLAY and
    // XAUTHORITY for this one spawn and the ambient values come straight back.
    const ambient = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
    process.env.DISPLAY = display;
    process.env.XAUTHORITY = authority;
    try {
        reference = await Bridge.start({
            listen: '127.0.0.1:0', token,
            engineCommand: engine, engineArgs: ['serve'],
            source: { kind: 'x11', display },
            engineOptions: { onDiagnostic: line => { logs.bridge += line + '\n'; } },
        });
    } finally {
        if (ambient.DISPLAY === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = ambient.DISPLAY;
        if (ambient.XAUTHORITY === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = ambient.XAUTHORITY;
    }
    result.pictureCommand = [engine, 'serve'];
    result.bridgePort = reference.port;
    const url = `http://127.0.0.1:${reference.port}/?token=${token}`;
    const port = reference.port;
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
        executablePath: browser, headless: true,
        viewport: { width: 1340, height: 860 }, env, timeout: 20000,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows'],
    });
    const page = context.pages()[0];
    page.setDefaultTimeout(15000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => {
        const video = document.querySelector('#video');
        return video?.videoWidth === 1280 && video.videoHeight === 720 && video.readyState >= 2;
    }, null, { timeout: 45000 });
    await sleep(1200);
    const live = await page.evaluate(() => {
        const video = document.querySelector('#video');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const context = canvas.getContext('2d');
        context.drawImage(video, 640, 270, 2, 2, 0, 0, 2, 2);
        return { pixels: Array.from(context.getImageData(0, 0, 2, 2).data), status: document.querySelector('#status')?.textContent, visible: !document.hidden };
    });
    // The green band's pixel proves the client decoded the fixture, not a blank video.
    assert(live.visible, 'reference client is not showing its page');
    assert(live.pixels.some((value, index) => index % 4 !== 3 && value > 60), 'reference client picture is black');
    await page.screenshot({ path: join(out, '01-live-picture.png'), timeout: 15000 });
    result.livePicture = { urlStatus: live.status, viewport: { width: 1340, height: 860 }, videoPixels: live.pixels };
    await context.close();
    context = undefined;
    await reference.close();
    reference = undefined;
    const portOpen = await new Promise(done => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); done(true); });
        socket.once('error', () => done(false));
        socket.setTimeout(1000, () => { socket.destroy(); done(true); });
    });
    assert(!portOpen, 'the bridge still listens after its client closed');

    // 2. An agent session drives this same desktop and owns the local cue.
    const events = [];
    client = await EngineClient.start(engine, ['serve'], { onEvent: event => events.push(event), onDiagnostic: line => { logs.engine = (logs.engine ?? '') + line + '\n'; } }, xenv);
    const opened = await client.openSession({ source: { kind: 'x11', display }, loopbackTcp: true, agentIndicator: true, localFrames: true });
    assert.equal(opened.agentIndicator, true, 'the X11 agent cue did not start');
    assert.deepEqual(opened.geometry.source, { width: WIDTH, height: HEIGHT });
    result.opened = opened;
    peer = new PeerConnection('x11-agent-cue', { iceServers: [], bindAddress: '127.0.0.1', enableIceTcp: true });
    const replies = [];
    let channel, channelReady;
    const channelOpen = new Promise(resolve => { channelReady = resolve; });
    peer.onDataChannel(control => {
        if (control.getLabel() !== 'control') return;
        channel = control;
        control.onOpen(() => channelReady());
        control.onMessage(raw => {
            try { replies.push(JSON.parse(String(raw))); }
            catch { /* unrelated notification */ }
        });
    });
    peer.onLocalCandidate((candidate, mid) => void client.addCandidate(opened.sessionId, opened.generation, candidate, mid, Number(mid) || 0));
    peer.onLocalDescription(sdp => void client.acceptAnswer(opened.sessionId, opened.generation, sdp));
    await waitFor(() => events.some(event => event.event === 'session.description'), 'transport offer');
    peer.setRemoteDescription(events.find(event => event.event === 'session.description').params.description.sdp, 'offer');
    for (const event of events.filter(event => event.event === 'session.candidate')) peer.addRemoteCandidate(event.params.candidate, event.params.sdpMid || '0');
    await Promise.race([channelOpen, sleep(10000).then(() => { throw Error('control channel did not open'); })]);
    let nextSeq = 1;
    const send = async action => {
        const seq = nextSeq++;
        channel.sendMessage(JSON.stringify({ ...action, seq }));
        const until = Date.now() + 5000;
        while (!replies.some(reply => reply.seq === seq) && Date.now() < until) await sleep(5);
        const reply = replies.find(reply => reply.seq === seq);
        assert(reply, `control action ${seq} was not answered`);
        assert.equal(reply.kind, 'ack', `control action ${seq} refused: ${reply.code}: ${reply.message}`);
    };
    const frame = async (afterSeq = 0, timeout = 3000) => {
        const path = join(scratch, 'frame.raw');
        const frame = await client.request('session.frame', { session_id: opened.sessionId, path, after_seq: afterSeq, timeout_ms: timeout });
        return { ...frame, raw: readFileSync(path) };
    };
    const baseline = await frame();
    assert(baseline.seq > 0, 'the session has no first frame');
    rawPng(baseline.raw, '00-captured-baseline.png');

    // 3. Record the lab screen and sample the captured frame at the same time.
    const screenVideo = join(scratch, 'screen.mp4');
    recorder = start('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', `${WIDTH}x${HEIGHT}`, '-i', display, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', screenVideo], captureEnv);
    recorder.stderr.on('data', chunk => { logs.recorder = (logs.recorder ?? '') + chunk; });
    const recorderStarted = Date.now();
    await sleep(600);
    const t0 = Date.now();
    const lead = (t0 - recorderStarted) / 1000;
    const samples = [];
    samplingNow = true;
    sampler = (async () => {
        let after = baseline.seq;
        while (samplingNow) {
            let current;
            try {
                current = await frame(after, 250);
            } catch (error) {
                if (error.code === 'frame-timeout') { await sleep(50); continue; }
                throw error;
            }
            after = current.seq;
            lastRaw = current.raw;
            lastSeq = current.seq;
            samples.push({ ms: Date.now() - t0, seq: current.seq, raw: Buffer.from(current.raw) });
        }
    })();
    result.actionStart = new Date(t0).toISOString();

    await sleep(500);
    await send({ kind: 'pointer', phase: 'move', x: 700, y: 500, button: 1 });
    await send({ kind: 'pointer', phase: 'down', x: 700, y: 500, button: 1 });
    await send({ kind: 'pointer', phase: 'up', x: 700, y: 500, button: 1 });
    await sleep(700);
    await send({ kind: 'text', text: 'X11 input proof' });
    await sleep(900);
    // Move the cue away from the click so the marker underneath is fully live.
    await send({ kind: 'pointer', phase: 'move', x: 900, y: 600, button: 1 });
    await sleep(1000);

    samplingNow = false;
    if (sampler) await Promise.race([sampler, sleep(5000)]).catch(() => {});
    sampler = undefined;
    const captured = await frame(0);
    assert(captured.seq >= (lastSeq ?? 0), 'the captured picture moved backwards');
    rawPng(captured.raw, '03-captured-without-cue.png');
    // The screen still is taken immediately after the captured frame while the
    // cue is settled: both describe the same unchanged moment.
    const screenPath = join(out, '02-screen-with-cue.png');
    let grab = screenGrab(screenPath);
    assert.equal(grab.status, 0, String(grab.stderr ?? ''));
    await sleep(800);
    const secondScreen = join(scratch, 'screen-second.png');
    assert.equal(screenGrab(secondScreen).status, 0);
    await sleep(1000);
    await stop(recorder, 'SIGINT', 8000);
    recorder = undefined;

    // 4. Judged pixels.
    const baselineRaw = baseline.raw, capturedRaw = captured.raw;
    const pixel = (raw, x, y) => { const at = (y * WIDTH + x) * 4; return [raw[at], raw[at + 1], raw[at + 2]]; };
    const marker = { x0: 688, y0: 488, x1: 713, y1: 513 };
    const text = { x0: 44, y0: 138, x1: 280, y1: 176 };
    const inside = (x, y, box) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    let outside = 0;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            if (inside(x, y, marker) || inside(x, y, text)) continue;
            const before = pixel(baselineRaw, x, y), after = pixel(capturedRaw, x, y);
            if (before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2]) outside++;
        }
    }
    assert.equal(outside, 0, `the captured picture changed ${outside} pixels outside the app's own click and text, so the agent cue leaked into it`);
    assert.deepEqual(pixel(capturedRaw, 700, 500), [255, 255, 255], 'the click marker did not reach the captured picture');
    const screen = PNG.sync.read(readFileSync(screenPath));
    const screenRgb = (x, y) => { const at = (y * screen.width + x) * 4; return [screen.data[at], screen.data[at + 1], screen.data[at + 2]]; };
    const screenSecond = PNG.sync.read(readFileSync(secondScreen));
    let cuePixels = 0, cueMoved = 0;
    for (let y = 540; y <= 660; y++) {
        for (let x = 840; x <= 960; x++) {
            const before = pixel(baselineRaw, x, y);
            const now = screenRgb(x, y);
            if (Math.abs(now[0] - before[2]) + Math.abs(now[1] - before[1]) + Math.abs(now[2] - before[0]) > 90) cuePixels++;
            const repeatAt = (y * screenSecond.width + x) * 4;
            const repeat = [screenSecond.data[repeatAt], screenSecond.data[repeatAt + 1], screenSecond.data[repeatAt + 2]];
            if (Math.abs(now[0] - repeat[0]) + Math.abs(now[1] - repeat[1]) + Math.abs(now[2] - repeat[2]) <= 30) cueMoved++;
        }
    }
    assert(cuePixels > 300, `the agent cue is not visible on the lab screen (${cuePixels} changed pixels)`);
    assert(cueMoved > 10000, 'the agent cue or the app kept changing between the two screen stills');
    const clickMarker = screenRgb(700, 500);
    assert(clickMarker.every(value => value > 200), `the click marker is not visible on the lab screen: ${clickMarker}`);
    const textChanged = (() => {
        let changed = 0;
        for (let y = text.y0; y <= text.y1; y++) for (let x = text.x0; x <= text.x1; x++) {
            const before = pixel(baselineRaw, x, y), after = pixel(capturedRaw, x, y);
            if (before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2]) changed++;
        }
        return changed;
    })();
    assert(textChanged > 80, `typed text did not reach the captured picture (${textChanged} changed pixels)`);
    result.pixels = { cueOnScreen: cuePixels, cueAbsentFromCapture: outside, clickMarkerInCapture: pixel(capturedRaw, 700, 500), typedTextPixels: textChanged };
    const eventsLog = logs.fixture.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    result.input = {
        buttonDown: eventsLog.some(event => event.kind === 'button' && event.phase === 'down' && event.x === 700 && event.y === 500),
        buttonUp: eventsLog.some(event => event.kind === 'button' && event.phase === 'up' && event.x === 700 && event.y === 500),
        moved: eventsLog.some(event => event.kind === 'pointer' && event.x === 900 && event.y === 600),
        typed: existsSync(typedPath) ? readFileSync(typedPath, 'utf8') : null,
    };
    assert(result.input.buttonDown && result.input.buttonUp, 'the fixture did not receive the agent click');
    assert.equal(result.input.typed, 'X11 input proof', 'the fixture did not receive the typed text');
    assert(result.input.moved, 'the fixture did not receive the cue-moving pointer move');

    // 5. One recording: lab screen beside the captured picture, same run.
    const rawScreen = join(out, 'lab-screen.mp4');
    renameSync(screenVideo, rawScreen);
    const concat = join(scratch, 'captures.txt');
    writeFileSync(concat, 'ffconcat version 1.0\n');
    // The screen recording starts before the first sample; hold the baseline for
    // that lead-in so both sides describe the same wall-clock moment.
    writeFileSync(concat, `file '${join(out, '00-captured-baseline.png')}'\nduration ${Math.max(0.08, lead).toFixed(3)}\n`, { flag: 'a' });
    writeFileSync(concat, samples.map((sample, index) => {
        const next = samples[index + 1]?.ms ?? sample.ms + 600;
        const duration = Math.max(0.08, (next - sample.ms) / 1000);
        const file = join(scratch, `capture-${String(index).padStart(3, '0')}.png`);
        const png = new PNG({ width: WIDTH, height: HEIGHT });
        for (let i = 0; i < WIDTH * HEIGHT; i++) { png.data[i * 4] = sample.raw[i * 4 + 2]; png.data[i * 4 + 1] = sample.raw[i * 4 + 1]; png.data[i * 4 + 2] = sample.raw[i * 4]; png.data[i * 4 + 3] = 255; }
        writeFileSync(file, PNG.sync.write(png));
        return `file '${file}'\nduration ${duration.toFixed(3)}\n`;
    }).join(''), { flag: 'a' });
    const durationProbe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', rawScreen], { encoding: 'utf8' }).stdout);
    const duration = Number(durationProbe.format.duration);
    assert(duration > 2, `the screen recording is too short: ${duration}`);
    const capturedVideo = join(scratch, 'captured.mp4');
    const capturedBuild = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=30,scale=960:540,tpad=stop_mode=clone:stop_duration=30', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', capturedVideo], { encoding: 'utf8', timeout: 120000 });
    assert.equal(capturedBuild.status, 0, capturedBuild.stderr);
    const font = spawnSync('fc-match', ['-f', '%{file}', 'sans'], { encoding: 'utf8' }).stdout.trim() || '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
    const recording = join(out, '05-agent-cue.mp4');
    const compose = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', rawScreen, '-i', capturedVideo, '-filter_complex',
        `[0:v]scale=960:540,pad=960:600:0:60:color=0x101418,drawtext=fontfile=${font}:text='lab screen — agent cue visible':fontcolor=white:fontsize=20:x=20:y=18[l];`
        + `[1:v]scale=960:540,pad=960:600:0:60:color=0x101418,drawtext=fontfile=${font}:text='captured picture sent to clients — no cue':fontcolor=white:fontsize=20:x=20:y=18[r];`
        + '[l][r]hstack=inputs=2[v]', '-map', '[v]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', recording], { encoding: 'utf8', timeout: 120000 });
    assert.equal(compose.status, 0, compose.stderr);
    assert(existsSync(recording) && readFileSync(recording).length > 10000, 'the recording is missing or empty');
    result.recording = { file: '05-agent-cue.mp4', durationSeconds: Math.round(duration * 10) / 10, leadSeconds: Math.round(lead * 1000) / 1000, sampledFrames: samples.length, samples: samples.map(sample => ({ ms: sample.ms, seq: sample.seq })) };
    result.outcome = 'PASS';
    await stop(target);
    target = undefined;
} catch (error) {
    result.error = String(error.stack ?? error);
    console.error(result.error);
} finally {
    samplingNow = false;
    if (sampler) await Promise.race([sampler, sleep(3000)]).catch(() => {});
    if (peer) try { peer.close(); } catch { /* already closed */ }
    try { cleanupPeers(); } catch { /* nothing left */ }
    if (client) await client.stop().catch(() => {});
    if (recorder) await stop(recorder, 'SIGINT', 8000);
    if (context) await context.close().catch(() => {});
    if (reference) await reference.close().catch(() => {});
    if (target) await stop(target);
    for (const child of owned) if (child !== xvfb) await stop(child);
    if (xvfb) await stopOwnedXvfb(xvfb).catch(error => { result.cleanupError = String(error); });
    if (claim) claim.release();
    const survivors = [...owned].filter(child => child !== xvfb && child.exitCode === null && child.signalCode === null);
    if (survivors.length || interrupted) result.outcome = 'FAIL';
    result.cleanup = { spawned: owned.size, survivors: survivors.map(child => child.pid), interrupted };
    for (const [name, log] of Object.entries(logs)) if (log !== undefined) writeFileSync(join(out, `${name}.log`), scrubToken(log));
    writeFileSync(join(out, 'run.json'), scrubToken(JSON.stringify(result, null, 2)) + '\n');
    rmSync(scratch, { recursive: true, force: true });
}
assert.equal(result.outcome, 'PASS', `proof failed; inspect ${join(out, 'run.json')}`);
for (const name of ['01-live-picture.png', '02-screen-with-cue.png', '03-captured-without-cue.png', '05-agent-cue.mp4']) {
    const file = readFileSync(join(out, name));
    assert(file.length > 1000, `incomplete capture: ${name}`);
    if (name.endsWith('.png')) assert(file.readUInt32BE(0) === 0x89504e47, `not a PNG: ${name}`);
}
writeFileSync(join(out, 'README.md'), [
    '# Linux X11 agent-cue proof',
    '',
    `Engine ${result.engineSha256.slice(0, 12)} at ${result.sourceHead.slice(0, 12)}, private display ${result.display}.`,
    '',
    '- `01-live-picture.png` - the reference client rendering this lab desktop over the bridge.',
    '- `02-screen-with-cue.png` - the lab screen: typed text, the click marker, and the agent cue at the moved pointer.',
    '- `03-captured-without-cue.png` - the captured picture the same session serves at that moment: text and marker, no cue.',
    `- \`05-agent-cue.mp4\` - the same run: lab screen (left) beside the captured picture (right), ${result.recording.durationSeconds}s.`,
    '- `run.json` and the `.log` files - every assertion, hash, command and process cleanup record.',
    '',
    `Cue on screen: ${result.pixels.cueOnScreen} changed pixels. Captured pixels changed outside the app's own click and text: ${result.pixels.cueAbsentFromCapture}.`,
].join('\n') + '\n');
recordSteps(out, {
    start: `a private X11 lab (${WIDTH}x${HEIGHT}) running a fixture app that paints four colour bands, records input, and draws what it types`,
    steps: [
        `Open the desklink reference client over the bridge; it shows the live lab desktop as "${result.livePicture.urlStatus}".`,
        'An agent session clicks the lab desktop at 700,500 and types "X11 input proof" over the control channel.',
        'The fixture receives the click and the keys, paints the marker and the text, and the captured picture shows both.',
        'The agent cue follows the pointer to 900,600; it is visible on the lab screen and absent from the captured picture.',
    ],
    result: 'A user sees the live desktop, their agent\'s click and typing arrive, and the agent cue stays out of the picture sent to clients.',
});
console.log(`PASS: live picture, click, typed text, and an agent cue on screen but not in the captured picture; evidence ${out}`);
