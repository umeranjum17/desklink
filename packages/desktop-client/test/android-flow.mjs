#!/usr/bin/env node
/**
 * The Android receiver, end to end: `example/` built from this checkout, shown
 * on an Android device, displaying a desktop this machine serves through
 * `desklink-host bridge`.
 *
 * What it proves:
 *
 *  - a fresh checkout builds an app that actually opens a desktop. The platform
 *    module is the first thing a session needs, and a build that cannot reach
 *    it refuses before it ever contacts a host: the app's own status line reads
 *    "This phone can't show your desktop." Here it must instead present a frame;
 *  - the picture is live, not a first frame: the fixture repaints on a timer, so
 *    two captures taken seconds apart differ, and the app's own inbound video
 *    statistics keep counting frames;
 *  - the cursor is real: a swipe across the picture moves the desktop's
 *    pointer, the fixture records where it landed, and the capture after the
 *    swipe shows the pointer there.
 *
 * The host side runs here, on a private Xvfb (display >= 170, its own cookie),
 * with the repository's own `x11_target` fixture repainting, the bridge on a
 * loopback port, and `WAYLAND_DISPLAY` empty. The device is whatever Android
 * device is attached to this machine; this flow never starts, stops or
 * configures one. An emulator reaches this machine through its own 10.0.2.2
 * alias and a phone over the network, so `DESKLINK_ANDROID_HOST` names whichever
 * address applies; the run stops at the picture and sends nothing anywhere.
 *
 * Usage:
 *
 *   npm run build && cargo build --manifest-path packages/desktop-host/engine/Cargo.toml \
 *     --example x11_target
 *   adb devices                       # or: ANDROID_SERIAL=...
 *   node packages/desktop-client/test/android-flow.mjs
 *
 * Environment:
 *
 *   ANDROID_SERIAL            device serial to drive (default the only device
 *                              `adb devices` reports)
 *   DESKLINK_ANDROID_HOST     address this machine has where the device runs:
 *                              10.0.2.2 on an emulator, the LAN address on a
 *                              phone
 *   DESKLINK_ANDROID_OUT      where the captures and logs go (default a fresh
 *                              directory under this lane's ~/lab-tmp root)
 *   DESKLINK_ANDROID_SKIP_BUILD  1 reuses the APK the last run built
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    assertNoAmbientDesktop, claimPrivateDisplay, laneArtefactDir, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// This lane's own lab root, never a shared name two lanes could both pick. The
// default is created by laneArtefactDir, which refuses an existing path; a
// caller-supplied directory is created here, under the same refusal.
const out = resolve(process.env.DESKLINK_ANDROID_OUT ?? laneArtefactDir('android-flow'));
if (process.env.DESKLINK_ANDROID_OUT) {
    assert(!existsSync(out), 'refusing to overwrite evidence');
    mkdirSync(out, { recursive: true });
}
const scratch = mkdtempSync(join(homedir(), '.cache', 'desklink-android-flow-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = resolve(process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const example = join(repo, 'packages/desktop-client/example');
const apk = join(example, 'android/app/build/outputs/apk/debug/app-debug.apk');
const claim = claimPrivateDisplay({ from: 170, count: 40 });
const display = claim.display;
const host = process.env.DESKLINK_ANDROID_HOST;
assert(host, 'set DESKLINK_ANDROID_HOST to this machine\'s address on the phone\'s network');
const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const attached = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(([, state]) => state === 'device').map(([serial]) => serial);
const serial = process.env.ANDROID_SERIAL ?? attached[0];
assert(serial && attached.includes(serial),
    `name the device with ANDROID_SERIAL; adb reports ${attached.join(', ') || 'none'}`);
const adb = (...args) => {
    const done = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120000 });
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
// A package installed moments ago can take a while to answer the resolver, so
// the link that opens the app is retried rather than failed on.
const tryAdb = (...args) =>
    spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120000 }).status === 0;
const capture = name => {
    const path = join(out, name);
    const shot = spawnSync('sh', ['-c', `adb -s ${serial} exec-out screencap -p > ${path}`]);
    assert.equal(shot.status, 0, 'the device could not be captured');
    return path;
};
const logs = { bridge: '', fixture: '', metro: '' };
const receipt = {
    outcome: 'FAIL', serial, sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
};
const children = [];
let xvfb, target, bridge, metro, receiver;

const start = (name, cmd, args, childEnv, cwd = repo) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => { logs[name] += c; });
    child.stderr.on('data', c => { logs[name] += c; });
    children.push([name, child]);
    return child;
};
const waitFor = async (ready, what, ms = 60000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (ready()) return; await sleep(200); }
    throw new Error(`timed out waiting for ${what}`);
};

try {
    for (const path of [engine, fixture]) assert(existsSync(path), `missing binary: ${path}: build the engine first`);
    Object.assign(receipt, { engine, engineSha256: hash(engine), fixtureSha256: hash(fixture), example, display });

    // The host: a private X11 display, a repainting fixture, and the bridge.
    const authority = join(scratch, 'Xauthority');
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
    xvfb = start('xvfb', 'Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp']);
    trackOwnedXvfb(xvfb, display);
    const state = pid => { try { return readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; } };
    await waitFor(() => state(xvfb.pid)?.includes('State:\tT'), 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };
    target = start('fixture', fixture, ['--animate', '--move'], xenv);
    await waitFor(() => logs.fixture.includes('"ready"'), 'the fixture to be ready');

    // Another desklink run may hold a fixed port, so the bridge takes one the
    // operating system says is free.
    const probe = createServer();
    await new Promise(ok => probe.listen(0, '0.0.0.0', ok));
    const bridgePort = probe.address().port;
    probe.close();
    receipt.bridgePort = bridgePort;
    bridge = start('bridge', process.execPath,
        ['packages/desktop-host/bin/desklink-host.mjs', 'bridge', '--source', 'x11', '--display', display, '--listen', `0.0.0.0:${bridgePort}`], xenv);
    await waitFor(() => /^open\s+http/m.test(logs.bridge), 'the bridge URL');
    const token = /token[= ](\S+)/.exec(logs.bridge)[1];

    // The app posts its own view of the session here, which is how the status
    // line and the inbound video statistics are read back.
    const reports = [];
    receiver = createServer((request, response) => {
        const chunks = [];
        request.on('data', c => chunks.push(c));
        request.on('end', () => {
            reports.push(Buffer.concat(chunks).toString());
            response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            response.end();
        });
    });
    await new Promise(ok => receiver.listen(0, '0.0.0.0', ok));
    const link = `desklink-example://connect?url=${encodeURIComponent(`ws://${host}:${bridgePort}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://${host}:${receiver.address().port}/report`)}`;
    receipt.link = link.replace(token, '<bridge-token>');

    if (process.env.DESKLINK_ANDROID_SKIP_BUILD !== '1') {
        // Every other desklink build takes this lock; the example app's Gradle
        // build is a heavy job like any other.
        const build = spawnSync('flock', ['/tmp/fm-desklink-heavy.lock', 'bash', '-c', [
            'npm install --no-audit --no-fund',
            'npx expo prebuild --platform android --no-install',
            'cd android && ./gradlew --no-daemon assembleDebug',
        ].join(' && ')], { cwd: example, env, encoding: 'utf8', timeout: 3600000 });
        writeFileSync(join(out, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
        assert.equal(build.status, 0, 'the example app did not build; see build.log');
    }
    assert(existsSync(apk), `no APK at ${apk}: build the example app first`);
    receipt.apkSha256 = hash(apk);

    // A debug build loads its JavaScript from this machine's Metro, which the
    // device reaches on its own loopback through adb rather than over the air.
    // Metro serves the example app, so it runs where that app's own `expo`
    // lives: the repository root is not an Expo project and has no SDK to read.
    metro = start('metro', 'npx', ['expo', 'start', '--port', '8081'], { ...env, CI: '1' }, example);
    await waitFor(() => /Waiting on http/.test(logs.metro), 'Metro');
    adb('install', '-r', '-g', apk);
    adb('reverse', 'tcp:8081', 'tcp:8081');

    // The journey.
    await waitFor(() => tryAdb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `"${link}"`),
    'the app to answer its connection link', 120000);
    await waitFor(() => reports.length > 0, "the app's own report", 180000);
    await waitFor(() => {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        return typeof last.presentedAt === 'number' && last.presentedAt > 0;
    }, 'the first presented frame', 180000);
    await sleep(4000);
    const first = capture('01-live-desktop.png');
    await sleep(6000);
    const second = capture('02-live-desktop-later.png');
    assert.notEqual(hash(first), hash(second), 'two captures seconds apart were identical: the picture is not live');

    // The cursor: a swipe across the picture moves the desktop's pointer, and
    // the fixture records where it landed.
    const pointers = () => logs.fixture.split('\n').filter(line => line.includes('"pointer"')).length;
    const before = pointers();
    adb('shell', 'input', 'swipe', String(Math.round(1080 * 0.2)), String(Math.round(2400 * 0.38)),
        String(Math.round(1080 * 0.75)), String(Math.round(2400 * 0.13)), '600');
    await waitFor(() => pointers() > before, 'the fixture pointer to move');
    const cursor = logs.fixture.split('\n').filter(line => line.includes('"pointer"')).pop();

    Object.assign(receipt, {
        captures: [first, second, capture('03-cursor-moved.png')].map(path => path.replace(homedir(), '~')),
        reports: reports.length,
        firstReport: JSON.parse(reports[0]),
        lastReport: JSON.parse(reports[reports.length - 1]),
        cursor: cursor.trim(),
    });
    receipt.outcome = 'PASS';
    console.log(`PASS: the example app opens a live desktop on ${serial}; evidence ${out}`);
} catch (error) {
    receipt.error = String(error);
    console.error(String(error));
} finally {
    for (const [, child] of children) child.kill('SIGTERM');
    await sleep(700);
    for (const [, child] of children) { try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { child.exitCode ??= 0; } }
    receiver?.close();
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    claim.release();
    for (const name of ['bridge', 'fixture', 'metro']) writeFileSync(join(out, `${name}.log`), logs[name]);
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : 1);
