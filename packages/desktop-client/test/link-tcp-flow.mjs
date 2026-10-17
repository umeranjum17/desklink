#!/usr/bin/env node
/**
 * The relay-only leg: the example app carries the desktop over its own link.
 *
 * The phone has no route to the computer but the app's relay: the journey link
 * carries `tcpRelay=<ws-url>` and `relayOnly=1`, so the app opens its session with
 * `tcpTransport`, the kit listens on the phone's 127.0.0.1, and every accepted
 * connection is piped through a lab WebSocket relay on the host to the engine's
 * loopback TCP port. The guest's own uplink is switched off, so it has no IP
 * route to the host at all — every socket the app opens rides `adb reverse`
 * (TCP only), and an in-app allowlist keeps only the relayed TCP candidate,
 * so ICE can only use the bridged TCP route. The host firewall is never
 * touched.
 *
 * What it proves:
 *
 *  - a live picture over the bridge: the app's inbound video statistics keep
 *    counting decoded frames while the fixture repaints its far corner and the
 *    phone's captures show each new colour;
 *  - the bytes rode the bridge: the app's relay counters (`tcp` in its
 *    reports) and the relay's own byte totals both advance in both directions,
 *    and the JS-to-native crossings stay batched (a handful a second, not one
 *    per packet);
 *  - input rode the same path: a tap inside the picture reaches the fixture,
 *    and two mapping taps land on the desktop points the fingers cover.
 *
 * The host side runs here, on a private Xvfb (display >= 170, its own cookie),
 * with the repository's own `x11_target` fixture repainting, the bridge on a
 * loopback port, and `WAYLAND_DISPLAY` empty. The device is an attached
 * emulator (ANDROID_SERIAL); this flow never starts, stops or configures one.
 *
 * Usage:
 *
 *   npm run build && cargo build --manifest packages/desktop-host/engine/Cargo.toml \
 *     --example x11_target
 *   node packages/desktop-client/test/link-tcp-flow.mjs
 *
 * Environment:
 *
 *   ANDROID_SERIAL            device serial to drive (default the only device
 *                             `adb devices` reports)
 *   DESKLINK_LINK_TCP_OUT     where the captures and logs go (default
 *                             /home/umer/lab-tmp/dl-kit-link-tcp)
 *   DESKLINK_ANDROID_SKIP_BUILD  1 reuses the APK the last run built
 *   DESKLINK_METRO_PORT       host port for Metro (default 8081); the phone's
 *                             8081 is reversed to it
 */
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PNG } from 'pngjs';
import {
    assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';
import { captureClip, spawnAsync } from './clip-capture.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.env.DESKLINK_LINK_TCP_OUT ?? '/home/umer/lab-tmp/dl-kit-link-tcp');
mkdirSync(out, { recursive: true });
// Per-run files, never appended across runs.
for (const stale of ['reports.jsonl', 'relay.log', 'phone-tcp.txt', 'logcat-desklink.txt']) {
    try { rmSync(join(out, stale), { force: true }); } catch { /* fresh run */ }
}
const scratch = mkdtempSync(join(homedir(), '.cache', 'desklink-link-tcp-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = resolve(process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const example = join(repo, 'packages/desktop-client/example');
const apk = join(example, 'android/app/build/outputs/apk/debug/app-debug.apk');
const claim = claimPrivateDisplay({ from: 170, count: 40 });
const display = claim.display;
const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const attached = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(([, state]) => state === 'device').map(([serial]) => serial);
const serial = process.env.ANDROID_SERIAL ?? attached[0];
// The host port Metro serves on; the phone's 8081 is reversed to it.
const metroPort = Number(process.env.DESKLINK_METRO_PORT ?? 8081);
assert(serial && attached.includes(serial),
    `name the device with ANDROID_SERIAL; adb reports ${attached.join(', ') || 'none'}`);
// The relay shares this process's event loop, so every adb call that can run
// while media is relayed is async: a blocking spawnSync here stalls the relay,
// and the engine's pings with it, which the app reads as a lost connection.
const execFileAsync = promisify(execFile);
const adbRun = (args, timeout = 120000) => spawnAsync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
const adb = async (...args) => {
    const done = await adbRun(args);
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
const tryAdb = async (...args) => (await adbRun(args)).status === 0;
const capture = async name => {
    const path = join(out, name);
    const shot = await execFileAsync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 120000, maxBuffer: 256 * 1024 * 1024 }).catch(() => null);
    assert(shot, 'the device could not be captured');
    writeFileSync(path, shot.stdout);
    return path;
};
const logs = { bridge: '', fixture: '', metro: '' };
const receipt = {
    outcome: 'FAIL', serial, sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    media_path: 'TCP only, through the relay: the phone listener piped over a lab WebSocket relay to the engine loopback port; UDP candidates discarded in the app',
};
const children = [];
let xvfb, target, bridge, metro, receiver, relayServer;
// The relay's engine port, its byte counters, and every app report: declared
// out here so the failure receipt can summarise them too.
let enginePort = 0;
const relayBytes = { wsToTcp: 0, tcpToWs: 0, streams: 0 };
const reports = [];
// Every session status the app reports, in the order it changed.
const statuses = [];
// Corner-file handshake evidence, for the same reason.
let cornerDebug = null;
const reverses = [];
const reverse = async (...args) => {
    await adb('reverse', ...args);
    reverses.push(args[0]);
};

const start = (name, cmd, args, childEnv, cwd = repo) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => { logs[name] += c; });
    child.stderr.on('data', c => { logs[name] += c; });
    children.push([name, child]);
    return child;
};
const waitFor = async (ready, what, ms = 60000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await ready()) return; await sleep(200); }
    throw new Error(`timed out waiting for ${what}`);
};

try {
    for (const path of [engine, fixture]) assert(existsSync(path), `missing binary: ${path}: build the engine first`);
    Object.assign(receipt, { engine, engineSha256: hash(engine), fixtureSha256: hash(fixture), example, display });

    const authority = join(scratch, 'Xauthority');
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
    xvfb = start('xvfb', 'Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp']);
    trackOwnedXvfb(xvfb, display);
    const state = pid => { try { return readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; } };
    await waitFor(() => state(xvfb.pid)?.includes('State:\tT'), 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };
    const corner = join(scratch, 'corner');
    target = start('fixture', fixture, ['--animate', '--move', '--corner', corner], xenv);
    await waitFor(() => logs.fixture.includes('"ready"'), 'the fixture to be ready');
    // The far corner is painted before the app launches, so the session's
    // opening keyframe already carries it: asserting a repaint mid-session
    // would race the emulator's slow software decoder, whose dropped frames
    // can lose a one-shot change forever.
    writeFileSync(corner, 'ff00ff');

    const probe = createServer();
    await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
    const bridgePort = probe.address().port;
    probe.close();
    bridge = start('bridge', process.execPath,
        ['packages/desktop-host/bin/desklink-host.mjs', 'bridge', '--source', 'x11', '--display', display, '--listen', `127.0.0.1:${bridgePort}`],
        // The engine's own ICE nomination trace (stderr): the selected pair's
        // local/remote addresses prove which path the media took.
        { ...xenv, DESKLINK_ICE_TRACE: '1' });
    await waitFor(() => /^open\s+http/m.test(logs.bridge), 'the bridge URL');
    const token = /token[= ](\S+)/.exec(logs.bridge)[1];

    // The relay: each WebSocket connection is one relayed TCP connection. The
    // engine's loopback port is ephemeral and learned from the app's reports;
    // streams that open before it is known wait for it (bounded), then dial.
    // The relay, like every other socket the app opens, is reached over `adb
    // reverse` (TCP only), because the guest's own uplink goes away below.
    const relayLog = join(out, 'relay.log');
    const relayNote = (line) => writeFileSync(relayLog, `${Date.now()} ${line}\n`, { flag: 'a' });
    relayNote('relay up');
    relayServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(ok => relayServer.on('listening', ok));
    const relayPort = relayServer.address().port;
    receipt.relayPort = relayPort;
    const relay = relayServer;
    relay.on('connection', (ws) => {
        relayBytes.streams += 1;
        relayNote(`stream #${relayBytes.streams} open`);
        let socket = null, closed = false;
        const queued = [];
        const finish = () => {
            if (closed) return;
            closed = true;
            relayNote(`stream #${relayBytes.streams} close (wsToTcp=${relayBytes.wsToTcp} tcpToWs=${relayBytes.tcpToWs})`);
            try { ws.close(); } catch { /* already gone */ }
            try { socket?.destroy(); } catch { /* already gone */ }
        };
        const pump = () => {
            relayNote(`stream dialing 127.0.0.1:${enginePort}`);
            socket = connect(enginePort, '127.0.0.1', () => {
                relayNote('stream dial ok');
                for (const chunk of queued.splice(0)) socket.write(chunk);
            });
            socket.on('data', (chunk) => {
                relayBytes.tcpToWs += chunk.length;
                if (ws.readyState === ws.OPEN) ws.send(chunk);
            });
            socket.on('error', finish);
            socket.on('close', finish);
        };
        const deadline = Date.now() + 60000;
        const dialWhenReady = () => {
            if (closed) return;
            if (enginePort > 0) { pump(); return; }
            if (Date.now() > deadline) { finish(); return; }
            setTimeout(dialWhenReady, 100);
        };
        dialWhenReady();
        ws.on('message', (data) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            relayBytes.wsToTcp += chunk.length;
            if (socket !== null) socket.write(chunk);
            else if (queued.reduce((n, c) => n + c.length, 0) < 1048576) queued.push(chunk);
        });
        ws.on('error', finish);
        ws.on('close', finish);
    });

    const reportsLog = join(out, 'reports.jsonl');
    receiver = createServer((request, response) => {
        const chunks = [];
        request.on('data', c => chunks.push(c));
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            writeFileSync(reportsLog, `${text}\n`, { flag: 'a' });
            let report = null;
            try { report = JSON.parse(text); } catch { /* not JSON; kept raw */ }
            // A status change is kept apart from the samples: every sample reads
            // the last report as the app's current state.
            if (report?.statusChange !== undefined) statuses.push(report);
            else reports.push(text);
            if (Number.isInteger(report?.loopbackTcpPort) && report.loopbackTcpPort >= 1024 && enginePort === 0) {
                enginePort = report.loopbackTcpPort;
            }
            response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            response.end();
        });
    });
    await new Promise(ok => receiver.listen(0, '127.0.0.1', ok));

    if (process.env.DESKLINK_ANDROID_SKIP_BUILD !== '1') {
        const build = spawnSync('flock', ['/tmp/fm-desklink-heavy.lock', 'bash', '-c', [
            'rm -rf node_modules/@desklink',
            'npm install --no-audit --no-fund',
            'npx expo prebuild --platform android --no-install',
            'cd android && ./gradlew --no-daemon assembleDebug',
        ].join(' && ')], { cwd: example, env, encoding: 'utf8', timeout: 3600000 });
        writeFileSync(join(out, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
        assert.equal(build.status, 0, 'the example app did not build; see build.log');
    }
    assert(existsSync(apk), `no APK at ${apk}: build the example app first`);
    receipt.apkSha256 = hash(apk);

    // Metro serves the bundle; the app reaches it over `adb reverse`, the same
    // TCP-only road every other socket in this run takes. The guest's uplink
    // goes away below, so 10.0.2.2 is dead and the bundle must come through
    // the phone's own loopback.
    // Metro may answer on either loopback, so both are probed: a Metro on
    // `::1` alone would pass a 127.0.0.1-only check and then fail inside Expo.
    for (const host of ['127.0.0.1', '::1']) {
        const metroProbe = createServer();
        await new Promise((ok, failed) => {
            metroProbe.once('error', failed);
            metroProbe.listen(metroPort, host, ok);
        }).then(() => metroProbe.close(), error => {
            if (host === '::1' && error.code === 'EADDRNOTAVAIL') return;
            throw new Error(`Metro needs host port ${metroPort}, which is already held on ${host} (another Metro on this host?): ${error.message}`);
        });
    }
    metro = start('metro', 'npx', ['expo', 'start', '--port', String(metroPort)], { ...env, CI: '1' }, example);
    await waitFor(() => /Waiting on http/.test(logs.metro), 'Metro');
    await adb('install', '-r', '-g', apk);
    // Route surgery below needs privilege; the emulator's userdebug build
    // grants it. Restarting adbd drops nothing this run needs yet.
    await adb('root');
    await adb('wait-for-device');
    // Every socket the app opens rides `adb reverse` (TCP only): signaling,
    // reports, the relay, and the bundle.
    // The device's own 8081 is what the app asks for; the reverse carries it to
    // the host port Metro took.
    await reverse('tcp:8081', `tcp:${metroPort}`);
    await reverse(`tcp:${bridgePort}`, `tcp:${bridgePort}`);
    await reverse(`tcp:${receiver.address().port}`, `tcp:${receiver.address().port}`);
    await reverse(`tcp:${relayPort}`, `tcp:${relayPort}`);
    receipt.media_path = 'TCP only, through adb-reverse forwards: the guest uplink is off, so the emulator has no IP route to the host; the phone listener is piped over a reverse to the engine loopback port';
    receipt.reverses = reverses.slice();

    const link = `desklink-example://connect?url=${encodeURIComponent(`ws://127.0.0.1:${bridgePort}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://127.0.0.1:${receiver.address().port}/report`)}`
        + `&tcpRelay=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/tcp`)}&relayOnly=1`;
    receipt.link = link.replace(token, '<bridge-token>');
    await adb('shell', 'am', 'force-stop', 'dev.desklink.example');
    await sleep(1000);
    await tryAdb('shell', 'logcat', '-c');
    await waitFor(() => tryAdb('shell', 'am', 'start', '-n', 'dev.desklink.example/.MainActivity',
        '-a', 'android.intent.action.VIEW', '-d', `"${link}"`),
    'the app to answer its connection link', 120000);
    // The dev client loads its bundle over the network, and the kit fetches
    // its native module on first use, so the guest route stays up for the
    // launch and goes away on the app's authorize mark — after both fetches
    // resolved. The app then waits out the kill before opening the session,
    // so the race is closed on both ends. Everything after rides `adb
    // reverse`. Route surgery (not `svc`): the per-interface tables are
    // flushed while the interfaces keep their addresses, so ICE still gathers
    // but no UDP packet can leave — and no gatherer hangs on interfaces
    // vanishing mid-enumeration. Loopback and the reverses are all that is
    // left.
    await waitFor(() => /Android Bundled/.test(logs.metro), 'Metro to serve the bundle', 180000);
    await waitFor(() => reports.some(text => {
        try { return JSON.parse(text).authorizing === true; } catch { return false; }
    }), 'the app to authorize', 180000);
    await adb('shell', 'ip', 'route', 'flush', 'table', 'eth0');
    await adb('shell', 'ip', 'route', 'flush', 'table', 'wlan0');
    await adb('shell', 'ip', '-6', 'route', 'flush', 'table', 'eth0');
    await adb('shell', 'ip', '-6', 'route', 'flush', 'table', 'wlan0');
    await sleep(1000);
    const guestRoutes = await adbRun(['shell', 'ip', 'route', 'get', '10.0.2.2'], 30000);
    const guestAddrs = await adb('shell', 'ip', 'addr', 'show', 'eth0');
    writeFileSync(join(out, 'guest-routes.txt'), `get 10.0.2.2:\n${guestRoutes.stdout}${guestRoutes.stderr}\neth0:\n${guestAddrs}\n`);
    assert(guestRoutes.status !== 0 || /unreachable/i.test(guestRoutes.stdout), 'the guest has no route to the host');
    assert(/inet 10\.0\.2\.15\/24/.test(guestAddrs), 'the guest keeps its address so ICE still gathers');
    const guestRoutes6 = await adbRun(['shell', 'ip', '-6', 'route', 'get', 'fd7a:115c:a1e0::4137:a101'], 30000);
    writeFileSync(join(out, 'guest-routes.txt'), `get 10.0.2.2:\n${guestRoutes.stdout}${guestRoutes.stderr}\neth0:\n${guestAddrs}\nget fd7a:115c:a1e0::4137:a101:\n${guestRoutes6.stdout}${guestRoutes6.stderr}\n`, { flag: 'a' });
    assert(guestRoutes6.status !== 0 || /unreachable/i.test(guestRoutes6.stdout), 'the guest has no IPv6 route off-host either');
    const pingHost = await adbRun(['shell', 'ping', '-c1', '-W3', '10.0.2.2'], 30000);
    assert(!/1 received|1 packets received/.test(pingHost.stdout), 'the host is unreachable from the guest');
    const pingLoopback = await adbRun(['shell', 'ping', '-c1', '-W3', '127.0.0.1'], 30000);
    assert(/1 received|1 packets received/.test(pingLoopback.stdout), 'the guest loopback is up');
    await waitFor(() => reports.length > 0, "the app's own report", 180000);
    {
        const first = JSON.parse(reports[0]);
        assert(!first.terminal, `the app ended before opening: ${JSON.stringify(first.failure)}`);
    }
    await waitFor(() => enginePort > 0, "the engine's loopback ICE port", 120000);
    receipt.loopback_tcp_port = enginePort;
    await waitFor(() => {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        return typeof last.presentedAt === 'number' && last.presentedAt > 0;
    }, 'the first presented frame', 180000);

    // Liveness from the app's own inbound video statistics, over the bridge.
    const decoded = report => (JSON.parse(report).stats ?? [])
        .filter(stat => stat.type === 'inbound-rtp')
        .reduce((total, stat) => total + (stat.framesDecoded ?? 0), 0);
    await waitFor(() => reports.length > 1 && decoded(reports[reports.length - 1]) > decoded(reports[0]),
        'the app to decode further video frames', 60000);
    // Whose sockets carried it: every TCP socket on the phone (127.0.0.1 is
    // 0100007F), plus the native session's own receive stats from logcat.
    const netLog = join(out, 'phone-tcp.txt');
    const dumpSockets = async (tag) => {
        try {
            const tcp = await adb('shell', 'cat', '/proc/net/tcp');
            const udp = await adb('shell', 'cat', '/proc/net/udp');
            writeFileSync(netLog, `\n### ${tag} /proc/net/tcp\n${tcp}\n\n### ${tag} /proc/net/udp\n${udp}\n`, { flag: 'a' });
        } catch { /* evidence only */ }
    };
    await dumpSockets('presented');
    try {
        const logcat = (await adbRun(['logcat', '-d', '-s', 'DesklinkSession:I', 'DesklinkTcpBridge:I'], 60000)).stdout;
        writeFileSync(join(out, 'logcat-desklink.txt'), logcat);
    } catch { /* evidence only */ }
    try {
        const hostUdp = (await execFileAsync('ss', ['-unp'], { encoding: 'utf8', timeout: 30000 })).stdout;
        writeFileSync(join(out, 'host-ss-udp.txt'), hostUdp);
    } catch { /* evidence only */ }
    const lastReport = () => JSON.parse(reports[reports.length - 1]);
    const firstTcp = lastReport().tcp;
    assert(firstTcp && firstTcp.port > 0, 'the relay reports its listener port');
    await dumpSockets('pre-assert');
    assert(firstTcp.bytesFromEngine > 0, 'bytes crossed the bridge from the engine');
    const droppedNonRelay = () => Number(lastReport().droppedNonRelay ?? 0);
    await waitFor(() => droppedNonRelay() > 0, 'the app to discard non-relay candidates', 60000);
    const droppedNonRelayOut = () => Number(lastReport().droppedNonRelayOut ?? 0);
    await waitFor(() => droppedNonRelayOut() > 0, 'the app to withhold non-relay locals', 60000);
    // A clip of the live picture: the device's own screenrecord, or a screencap timelapse when it is unavailable.
    const clip = await captureClip({
        serial, seconds: 10, devicePath: '/sdcard/link-tcp-clip.mp4',
        outPath: join(out, 'clip-relayed-desktop.mp4'), scratch,
    });
    receipt.clip = clip;
    console.log(clip.mode === 'timelapse'
        ? `clip-relayed-desktop.mp4 is a TIMELAPSE: screenrecord unavailable; ${clip.frames} screencap frames at ${clip.fps} fps`
        : 'clip-relayed-desktop.mp4 is a screenrecord clip');
    await sleep(2000);
    const first = await capture('01-relayed-desktop.png');
    await sleep(6000);
    const second = await capture('02-relayed-desktop-later.png');

    // Input rode the same path: a tap inside the picture reaches the fixture,
    // proved by the engine log (instant, no video lag involved), before any
    // pixel assertions below.
    const buttons = () => logs.fixture.split('\n').filter(line => line.includes('"button"')).length;
    const beforeButtons = buttons();
    await adb('shell', 'input', 'tap', String(Math.round(1080 * 0.5)), String(Math.round(2400 * 0.25)));
    await sleep(1500);
    await waitFor(() => buttons() > beforeButtons, 'the tap to reach the desktop', 30000);
    const button = logs.fixture.split('\n').filter(line => line.includes('"button"')).pop();

    // Every change, wherever on the desktop: the fixture repaints its far
    // corner in place, and the app's own picture must show each new colour.
    // A one-shot repaint can vanish on this path (the emulator's software
    // decoder drops a third of its frames), so the corner toggles until seen;
    // a toggle that never shows is a dead path, not a lost frame.
    const shows = (path, rgb) => {
        const { data } = PNG.sync.read(readFileSync(path));
        const want = [rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff];
        let near = 0;
        for (let at = 0; at < data.length; at += 4) {
            if (want.every((value, channel) => Math.abs(data[at + channel] - value) < 48)) near++;
        }
        return near;
    };
    const corners = [];
    // The fixture reports its own command line through /proc, so a run can
    // prove which corner file the painter was told to watch.
    const fixturePid = target.pid;
    cornerDebug = null;
    // The corner was painted before launch, so the opening keyframe already
    // carries it: a missing magenta here is a dead path, not a lost frame,
    // since every rendered frame descends from a keyframe that contained it.
    // (Mid-session repaints were tried first; the emulator's software decoder
    // drops a third of frames and a one-shot repaint can vanish forever.)
    // What the host display itself shows, bypassing encode/relay/decode: if
    // the corner is missing here, the painter never painted it.
    try {
        await execFileAsync('import', ['-window', 'root', '-display', display, join(out, 'xvfb-root.png')],
            { timeout: 30000, env: { ...process.env, DISPLAY: display, XAUTHORITY: authority } });
    } catch { /* evidence only */ }
    {
        const name = 'magenta', rgb = 0xff00ff;
        const shot = `05-corner-${name}.png`;
        let seen = 0;
        for (const until = Date.now() + 60000; seen < 1000 && Date.now() < until;) {
            await sleep(2000);
            seen = shows(await capture(shot), rgb);
        }
        let fixtureCmd = null;
        try { fixtureCmd = readFileSync(`/proc/${fixturePid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* gone */ }
        cornerDebug = { readback: readFileSync(corner, 'utf8'), fixtureCmd, corner };
        assert(seen >= 1000, `the desktop's far corner turned ${name}, but the app's picture shows ${seen} pixels of it`);
        corners.push({ colour: name, pixels: seen, capture: join(shot).replace(homedir(), '~') });
    }

    // Bridge capacity under real video load: repaint the corner as fast as
    // the lab loop allows and measure what the bridge carries. The idle
    // desktop above costs the bridge nothing, so only a driven source says
    // what the batching can hold.
    const markTcp = () => {
        const last = JSON.parse(reports[reports.length - 1]);
        return { at: last.at, ...(last.tcp ?? {}) };
    };
    const blastStart = markTcp();
    const blastUntil = Date.now() + 15000;
    for (let flip = 0; Date.now() < blastUntil; flip += 1) {
        writeFileSync(corner, (flip % 2 === 0 ? 'ff00ff' : '00ffff'));
        await sleep(400);
    }
    await waitFor(() => reports.length > 2 && JSON.parse(reports[reports.length - 1]).at > blastStart.at + 12000, 'post-blast samples', 60000);
    const blastEnd = markTcp();
    const blastSeconds = (blastEnd.at - blastStart.at) / 1000;
    const blastCrossings = (blastEnd.bridgeEvents ?? 0) - (blastStart.bridgeEvents ?? 0);
    const blastWrites = (blastEnd.bridgeWrites ?? 0) - (blastStart.bridgeWrites ?? 0);
    // bytesToEngine counts phone-to-engine bytes (uplink); bytesFromEngine counts engine-to-phone bytes (downlink, the video).
    const blastBytesOf = (counter, direction) => {
        const bytes = (blastEnd[counter] ?? 0) - (blastStart[counter] ?? 0);
        return { direction, bytes, mbPerSecond: bytes / Math.max(1, blastSeconds) / 1048576 };
    };
    const uplink = blastBytesOf('bytesToEngine', 'uplink (phone to engine)');
    const downlink = blastBytesOf('bytesFromEngine', 'downlink (engine to phone)');
    const capacity = {
        seconds: blastSeconds,
        uplink,
        downlink,
        bridgeEventsPerSecond: blastCrossings / Math.max(1, blastSeconds),
        bridgeWritesPerSecond: blastWrites / Math.max(1, blastSeconds),
        bytesPerCrossing: blastCrossings > 0 ? (uplink.bytes + downlink.bytes) / blastCrossings : 0,
    };

    // bytesToEngine is phone-to-engine (uplink); bytesFromEngine is engine-to-phone (downlink, the video).
    const timed = reports.map(text => { try { return JSON.parse(text); } catch { return null; } })
        .filter(sample => sample && sample.tcp && typeof sample.at === 'number');
    const lastTimed = timed[timed.length - 1];
    const throughputOf = (counter, direction) => {
        const firstTimed = timed.find(sample => (sample.tcp[counter] ?? 0) > 0);
        if (!firstTimed || !lastTimed || lastTimed.at <= firstTimed.at) return null;
        const bytes = (lastTimed.tcp[counter] ?? 0) - (firstTimed.tcp[counter] ?? 0);
        const seconds = (lastTimed.at - firstTimed.at) / 1000;
        return { direction, bytes, seconds, mbPerSecond: bytes / seconds / 1048576 };
    };
    const throughput = {
        uplink: throughputOf('bytesToEngine', 'uplink (phone to engine)'),
        downlink: throughputOf('bytesFromEngine', 'downlink (engine to phone)'),
    };

    // The picture never fell to `reconnecting` from its first live status to
    // the end of the run. The captures and the screenrecord above run while the
    // relay carries media, so a blocking call in this process shows up here.
    const statusSeqs = statuses.map(report => report.seq);
    assert(statusSeqs.length > 0, 'the app posted no status report');
    const missingSeqs = [...Array(Math.max(...statusSeqs)).keys()].map(index => index + 1).filter(seq => !statusSeqs.includes(seq));
    assert.deepEqual(missingSeqs, [], `status reports never arrived: ${missingSeqs.join(', ')}`);
    const statusSequence = [...statuses].sort((a, b) => a.seq - b.seq).map(report => report.statusChange);
    const firstLive = statusSequence.indexOf('live');
    assert(firstLive >= 0, `the app never reported live: ${statusSequence.join(' -> ')}`);
    const frozen = statusSequence.slice(firstLive).filter(status => status === 'reconnecting').length;
    assert.equal(frozen, 0, `the picture reported reconnecting ${frozen} time(s) after going live: ${statusSequence.join(' -> ')}`);

    Object.assign(receipt, {
        statusSequence,
        captures: [first, second, await capture('03-tap-received.png')].map(path => path.replace(homedir(), '~')),
        reports: reports.length,
        droppedNonRelay: droppedNonRelay(),
        droppedNonRelayOut: droppedNonRelayOut(),
        lastTcp: lastTimed?.tcp ?? lastReport().tcp,
        relayBytes,
        enginePort,
        throughput,
        capacity,
        corners,
        tap: button.trim(),
    });
    receipt.outcome = 'PASS';
    console.log(`PASS: the example app shows a live desktop over its own relay on ${serial}; evidence ${out}`);
} catch (error) {
    receipt.error = String(error);
    try {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        const frames = text => ((JSON.parse(text).stats ?? []).filter(stat => stat.type === 'inbound-rtp')
            .reduce((total, stat) => total + (stat.framesDecoded ?? 0), 0));
        receipt.lastTcp = last.tcp ?? null;
        receipt.droppedNonRelay = Number(last.droppedNonRelay ?? 0);
        receipt.droppedNonRelayOut = Number(last.droppedNonRelayOut ?? 0);
        receipt.relayBytes = relayBytes;
        receipt.enginePort = enginePort;
        receipt.loopback_tcp_port = enginePort || undefined;
        receipt.framesFirst = reports.length > 0 ? frames(reports[0]) : 0;
        receipt.framesLast = reports.length > 0 ? frames(reports[reports.length - 1]) : 0;
        receipt.cornerDebug = cornerDebug ?? undefined;
    } catch { /* the receipt carries what it can */ }
    try { await capture('00-failure.png'); } catch { /* the device may be gone */ }
    console.error(String(error));
} finally {
    for (const [, child] of children) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    await sleep(700);
    for (const [, child] of children) {
        try {
            if (child.pid > 0) { process.kill(child.pid, 0); child.kill('SIGKILL'); }
        } catch { child.exitCode ??= 0; }
    }
    for (const spec of reverses.splice(0)) { await tryAdb('reverse', '--remove', spec); }
    // The guest's routes belong to the device: hand them back however the run ends.
    for (const restore of [
        ['shell', 'ip', 'route', 'add', '10.0.2.0/24', 'dev', 'eth0', 'table', 'eth0', 'proto', 'static', 'scope', 'link'],
        ['shell', 'ip', 'route', 'add', 'default', 'via', '10.0.2.2', 'dev', 'eth0', 'table', 'eth0', 'proto', 'static', 'mtu', '1500'],
        ['shell', 'ip', 'route', 'add', '10.0.2.0/24', 'dev', 'wlan0', 'table', 'wlan0', 'proto', 'static', 'scope', 'link'],
        ['shell', 'ip', 'route', 'add', 'default', 'via', '10.0.2.2', 'dev', 'wlan0', 'table', 'wlan0', 'proto', 'static'],
        // The guest's IPv6 uplink is rebuilt by the platform itself.
        ['shell', 'svc', 'wifi', 'disable'],
        ['shell', 'svc', 'data', 'disable'],
        ['shell', 'svc', 'wifi', 'enable'],
        ['shell', 'svc', 'data', 'enable'],
    ]) await tryAdb(...restore);
    try { receiver?.close(); } catch { /* already gone */ }
    try { relayServer?.close(); } catch { /* already gone */ }
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    claim.release();
    rmSync(scratch, { recursive: true, force: true });
    for (const name of ['bridge', 'fixture', 'metro']) writeFileSync(join(out, `${name}.log`), logs[name]);
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : 1);
