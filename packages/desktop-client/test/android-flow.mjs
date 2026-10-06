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
 *  - the picture is live, not a first frame: the app's own inbound video
 *    statistics keep counting decoded frames across the capture window;
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
 * `--transport usb` runs the same journey over `adb reverse`, which carries TCP
 * only: the engine's own addresses are UDP, so the app asks for the loopback
 * route (`session.loopbackTcp`) and this flow follows the engine's ephemeral
 * loopback port, forwarding it to the device exactly as a tunnel operator would.
 * A tap is asserted on this leg too, because a tap that arrives proves the
 * input channel rode the same forward as the picture. `--no-forward-loopback`
 * is its counterfactual: the same leg with the forward withheld, which must
 * fail to present a frame.
 *
 * `--wifi-off` is what makes the `usb` leg really TCP only: the phone's Wi-Fi
 * is turned off for the run (and restored afterwards), so the engine's own UDP
 * candidates are unreachable and the loopback forward is the only route left.
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
const transport = process.argv.includes('--transport') ? process.argv[process.argv.indexOf('--transport') + 1] : 'wifi';
const host = process.env.DESKLINK_ANDROID_HOST;
assert(transport === 'usb' || host, 'set DESKLINK_ANDROID_HOST to this machine\'s address on the device\'s network');
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
    transport,
    media_path: transport === 'usb'
        ? 'TCP only, over adb reverse: the engine\'s loopback ICE port forwarded to the device'
        : 'this host to the device over the network',
};
const children = [];
let xvfb, target, bridge, metro, receiver;
// This machine leaves the device's own Wi-Fi exactly as it found it.
const wifiOff = process.argv.includes('--wifi-off');
let wifiWasOn = false;

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
    if (wifiOff) {
        wifiWasOn = adb('shell', 'settings', 'get', 'global', 'wifi_on').trim() === '1';
        adb('shell', 'svc', 'wifi', 'disable');
        await sleep(3000);
        receipt.wifi = wifiWasOn ? 'turned off for this run, restored at the end' : 'already off';
    }
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
    const phoneHost = transport === 'usb' ? '127.0.0.1' : host;
    if (transport === 'usb') {
        // The signalling socket and the receiver ride `adb reverse`; the media
        // forward is the engine's loopback port, which it picks per session and
        // the app reports as it sees the candidate.
        adb('reverse', `tcp:${bridgePort}`, `tcp:${bridgePort}`);
        adb('reverse', `tcp:${receiver.address().port}`, `tcp:${receiver.address().port}`);
    }
    const link = `desklink-example://connect?url=${encodeURIComponent(`ws://${phoneHost}:${bridgePort}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://${phoneHost}:${receiver.address().port}/report`)}`;
    receipt.link = link.replace(token, '<bridge-token>');
    // Every loopback ICE port the app sees, forwarded as it appears. ICE's
    // throwaway port 9 is not a listener and cannot be bound.
    const forwarded = new Set();
    receipt.loopback_tcp_ports = [];
    const noForward = process.argv.includes('--no-forward-loopback');
    const forwardLoopback = report => {
        const port = report?.loopbackTcpPort;
        if (!Number.isInteger(port) || port < 1024 || forwarded.has(port)) return;
        forwarded.add(port);
        if (noForward) {
            receipt.loopback_tcp_ports.push(`${port} (withheld)`);
            return;
        }
        adb('reverse', `tcp:${port}`, `tcp:${port}`);
        receipt.loopback_tcp_ports.push(port);
    };

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
    // Another lane may hold 8081, so Metro takes a port the operating system
    // says is free and the device's own 8081 is reversed onto it.
    const metroProbe = createServer();
    await new Promise(ok => metroProbe.listen(0, '127.0.0.1', ok));
    const metroPort = metroProbe.address().port;
    metroProbe.close();
    receipt.metroPort = metroPort;
    metro = start('metro', 'npx', ['expo', 'start', '--port', String(metroPort)], { ...env, CI: '1' }, example);
    await waitFor(() => /Waiting on http/.test(logs.metro), 'Metro');
    adb('install', '-r', '-g', apk);
    adb('reverse', 'tcp:8081', `tcp:${metroPort}`);

    // The journey. Another desklink app may answer the same `desklink-example`
    // link on this device, so the run names this build's own activity instead
    // of letting the resolver choose whose desktop opens.
    adb('shell', 'am', 'force-stop', 'dev.desklink.example');
    await sleep(1000);
    await waitFor(() => tryAdb('shell', 'am', 'start', '-n', 'dev.desklink.example/.MainActivity',
        '-a', 'android.intent.action.VIEW', '-d', `"${link}"`),
    'the app to answer its connection link', 120000);
    await waitFor(() => reports.length > 0, "the app's own report", 180000);
    // The forward follows the engine's loopback port, so it is in place before
    // the session can finish connecting.
    await waitFor(() => {
        for (const report of reports) forwardLoopback(JSON.parse(report));
        return transport !== 'usb' || forwarded.size > 0;
    }, 'the engine\'s loopback ICE port to forward', 120000);
    await waitFor(() => {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        return typeof last.presentedAt === 'number' && last.presentedAt > 0;
    }, 'the first presented frame', 180000);
    await sleep(4000);
    const first = capture('01-live-desktop.png');
    await sleep(6000);
    const second = capture('02-live-desktop-later.png');

    // Liveness comes from the app's own inbound video statistics, which keep
    // counting decoded frames while the picture is live. Comparing the two
    // captures pixel-by-pixel cannot prove this: the fixture's only motion
    // is a 32-pixel square blinking every 80ms, so captures seconds apart
    // land on the same blink phase about one time in six and fail by luck.
    const decoded = report => (JSON.parse(report).stats ?? [])
        .filter(stat => stat.type === 'inbound-rtp')
        .reduce((total, stat) => total + (stat.framesDecoded ?? 0), 0);
    await waitFor(() => reports.length > 1 && decoded(reports[reports.length - 1]) > decoded(reports[0]),
        'the app to decode further video frames', 60000);

    // The click: input has to ride the same forward as the picture, so a tap
    // inside the picture must reach the fixture, which records it and repaints
    // a marker there.
    const buttons = () => logs.fixture.split('\n').filter(line => line.includes('"button"')).length;
    const beforeButtons = buttons();
    adb('shell', 'input', 'tap', String(Math.round(1080 * 0.5)), String(Math.round(2400 * 0.25)));
    await sleep(1500);

    // The cursor: a swipe across the picture moves the desktop's pointer, and
    // the fixture records where it landed. Both ends must start inside the
    // picture: on SDK 57 the fit-width picture is top-anchored (about y 110-717
    // on a 1080x2400 screen), so a swipe beginning below it never reaches the
    // desktop and the fixture sees nothing.
    const pointers = () => logs.fixture.split('\n').filter(line => line.includes('"pointer"')).length;
    const before = pointers();
    adb('shell', 'input', 'swipe', String(Math.round(1080 * 0.2)), String(Math.round(2400 * 0.2)),
        String(Math.round(1080 * 0.75)), String(Math.round(2400 * 0.13)), '600');
    await waitFor(() => pointers() > before, 'the fixture pointer to move', 120000);
    const cursor = logs.fixture.split('\n').filter(line => line.includes('"pointer"')).pop();
    // The tap is read after the swipe, because the fixture's own stdout is
    // block-buffered: a swipe's flood of events is what flushes the tap line.
    await waitFor(() => buttons() > beforeButtons, 'the tap to reach the desktop', 30000);
    const button = logs.fixture.split('\n').filter(line => line.includes('"button"')).pop();

    Object.assign(receipt, {
        captures: [first, second, capture('03-tap-received.png'), capture('04-cursor-moved.png')].map(path => path.replace(homedir(), '~')),
        reports: reports.length,
        firstReport: JSON.parse(reports[0]),
        lastReport: JSON.parse(reports.at(-1)),
        cursor: cursor.trim(),
        tap: button.trim(),
    });
    receipt.outcome = 'PASS';
    console.log(`PASS: the example app opens a live desktop on ${serial}; evidence ${out}`);
} catch (error) {
    receipt.error = String(error);
    // What the person holding the phone sees is part of a failed run's evidence.
    try { capture('00-failure.png'); } catch { /* the device may be gone */ }
    console.error(String(error));
} finally {
    for (const [, child] of children) child.kill('SIGTERM');
    await sleep(700);
    for (const [, child] of children) { try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { child.exitCode ??= 0; } }
    receiver?.close();
    if (wifiOff && wifiWasOn) {
        try { adb('shell', 'svc', 'wifi', 'enable'); } catch (error) { receipt.wifi_restore = String(error); }
    }
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    claim.release();
    for (const name of ['bridge', 'fixture', 'metro']) writeFileSync(join(out, `${name}.log`), logs[name]);
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : 1);
