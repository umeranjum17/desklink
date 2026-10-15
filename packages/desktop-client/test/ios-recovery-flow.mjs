// The `live` baseline slice on a Mac simulator: this checkout's example app on
// one of the Mac's own fm-iPhone simulators, against a bridge on this Linux
// host. It proves the transport seed; the recovery legs (a 5 s engine silence
// and a 60 s backgrounding) are the proof legs this file already carried; the
// `cut` leg is the owned path cut (retire the app's tuple, discard both native
// UDP directions and signalling, restore on generation 2 against a 12 s
// outage) that the dl-roam-mac-cut slice adds, with a `cut` negative control
// that restores signalling but leaves the media cut.
//
// The path: the app reaches a userspace-shaped relay running ON THE MAC
// (`mac-relay.mjs`, the same ShapedLink the browser journeys use) over the Mac's
// own LAN address, which is always present — never an intermittent Tailscale
// candidate, and never a shared-network change. The relay reaches this host's
// loopback bridge over a task-owned SSH reverse-forward; the engine captures the
// repository's animated x11_target on a private Xvfb on this host. Roam media
// candidates in trickle AND SDP are rewritten through the relay. The 5 s drop is
// SIGSTOP on the bridge and the engine together (host-unreachable silence,
// signalling relay included — harsher than a radio drop, and user-space only).
// The 60 s backgrounding is the simulator's own home gesture.
//
// Each case measures, on the simulator's own screen: the human Reconnecting
// state through the accessibility tree and in stills, the picture advancing
// again (screenshot hashes off the animated fixture), a tap after every
// recovery landing in the fixture's button log as down AND up, and a motion
// recording of the whole case (`<name>.mov`) showing the picture returning
// full-screen (the demo launches with cover, the PR 118 bar on iOS). Nothing is
// tapped during a recovery, so a blocking consent prompt would stall it past
// its deadline. (X11 captures have no consent UI; the legs prove a reopen
// completes with zero user action.)
//
// The `cut` leg is THIS PR's subject. First it holds the landed stable baseline
// (picture advancing in the default portrait cover crop, pointer and key
// down+up landing in the fixture), then it retires the app's UDP tuple, adopts
// the discard shape on BOTH native directions and cuts signalling, holds a
// 12 s outage, and restores on generation 2. The same session must survive
// under one open, no close or revoke, the picture must advance within 2000 ms
// of the path returning, and after it a key down+up and a pointer down+up must
// again land in the fixture. `DESKLINK_IOS_CUT_NEGATIVE=1` runs the same cut but
// restores signalling with the media left cut: the picture verdict must fail.
// The `live` leg is the opt-in plain baseline; drop5/background60 are unchanged
// from main.
//
// The simulators are the Mac's own fm-iPhones: they are reused and left in
// place, never created or deleted here. Only this lane's build directory
// (DESKLINK_IOS_DIR/DESKLINK_IOS_LANE) is removed when done.
//
// The cut leg's evidence is four streams, because a recovery number on its own
// cannot say whose time it was:
//
//   engine.log  — this host. The bridge forwards its engine child's diagnostics
//                 to its own stderr, so with DESKLINK_ICE_TRACE=1 the whole
//                 stream is the vendored ICE agent's request / nomination /
//                 state timeline on this host's clock.
//   wire.log    — this host. The bridge -> engine protocol tap, so
//                 `session.restart_ice` is timestamped where the engine reads
//                 it and not where the app typed it.
//   link.log    — the Mac. `shaped-link.mjs` logs every STUN request, success,
//                 error and indication in each direction with its transaction
//                 id, its USE-CANDIDATE flag and its USERNAME, and one
//                 txn-matched line per response naming the request it answers
//                 and the round trip. Retransmissions are visible rather than
//                 collapsed to the first of each kind.
//   receipt     — every named signalling frame (session id, method, offered
//                 credentials) with the timestamp it arrived on this host, so
//                 stage A (path back -> `session.restart_ice`) and stage B
//                 (that -> `transport=connected`) are read from one array.
//
// The relay's own clock is the Mac's, so it differs from this host's by a
// constant the leg records; only the relay's cadences need that offset.
//
// Usage (from the repo root):
//   DESKLINK_IOS_MAC=umerfaroq@100.97.31.92 DESKLINK_IOS_LANE=dl-pm-8 \
//     DESKLINK_IOS_OUT=~/evidence/ios-j3 node packages/desktop-client/test/ios-recovery-flow.mjs
//
// Environment: DESKLINK_IOS_MAC (required), DESKLINK_IOS_LANE (required),
// DESKLINK_IOS_DIR (default fm-desklink-ios), DESKLINK_IOS_OUT (required fresh
// dir), DESKLINK_IOS_DEVICE (simulator name, default fm-iPhone 17),
// DESKLINK_IOS_SKIP_BUILD (1 reuses the lane's last build),
// DESKLINK_IOS_ONLY (a comma-separated leg subset, e.g. `cut` or
// `background60`; unset runs the proof legs, drop5 and background60),
// DESKLINK_IOS_CUT_NEGATIVE (1 restores signalling but leaves the media cut:
// the cut leg's picture verdict must then fail),
// DESKLINK_ENGINE, DESKLINK_VERIFY_TARGET (x11_target),
// DESKLINK_ICE_TRACE (1 records the engine's ICE timeline into engine.log).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { macLane, CLEAN_SCRIPT } from './mac-lane.mjs';
import { pictureBox } from './picture-box.mjs';
import {
    assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const MAC = process.env.DESKLINK_IOS_MAC ?? '';
assert(MAC !== '', 'set DESKLINK_IOS_MAC to user@mac');
const LANE = macLane({ DESKLINK_IOS_DIR: process.env.DESKLINK_IOS_DIR ?? 'fm-desklink-ios', DESKLINK_IOS_LANE: process.env.DESKLINK_IOS_LANE ?? '' });
assert(LANE.lane !== '', 'set DESKLINK_IOS_LANE to this lane name');
const out = resolve(process.env.DESKLINK_IOS_OUT ?? '');
assert(out !== '' && !existsSync(out), 'set DESKLINK_IOS_OUT to a fresh evidence directory');
mkdirSync(out, { recursive: true });
const SIM = process.env.DESKLINK_IOS_DEVICE ?? 'fm-iPhone 17';
const BUILD = process.env.DESKLINK_IOS_SKIP_BUILD !== '1';
// The bridge runs as its own process, so its bridge -> engine traffic is
// tapped by loading engine-tap.cjs into it; a socket-close or a session
// replacement can then be told from the wire instead of inferred.
const engineTap = join(here, 'engine-tap.cjs');
const tapLog = join(out, 'bridge-engine.log');
const engineBin = process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host');
const x11Bin = process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target');
for (const path of [engineBin, x11Bin]) assert(existsSync(path), `missing binary: ${path}`);
const BUNDLE = 'dev.desklink.example';
const DESKTOP = { width: 1280, height: 720 };
const log = (...args) => console.log(new Date().toISOString(), ...args);
setTimeout(() => { console.error('OVERALL TIMEOUT'); process.exit(2); }, 90 * 60_000).unref?.();

const PRELUDE = `set -euo pipefail
R="$HOME/${LANE.base}"
D="$R/${LANE.lane}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export TMPDIR="$D/tmp/" npm_config_cache="$R/.npm" CP_HOME_DIR="$R/.cocoapods" EXPO_NO_TELEMETRY=1 CI=1
`;
function mac(script, timeout = 120_000) {
    const run = spawnSync('ssh', ['-o', 'BatchMode=yes', MAC, 'bash -s'], {
        input: `${PRELUDE}\n${script}\n`, encoding: 'utf8', timeout,
    });
    if (run.status !== 0) {
        throw new Error(`on the Mac: ${script.trim().split('\n')[0]} → ${run.status ?? run.signal}\n${(run.stdout + run.stderr).slice(-2000)}`);
    }
    return run.stdout;
}
const scpFrom = (remote, local) => {
    assert.equal(spawnSync('scp', ['-q', '-o', 'BatchMode=yes', `${MAC}:${LANE.dir}/${remote}`, local]).status, 0, `copy ${remote} back`);
};

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt = { journey: 'ios-recovery-j3', deviceKind: 'simulator', mac: MAC, lane: `${LANE.base}/${LANE.lane}`, simulator: SIM, out,
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    engineSha256: sha(engineBin), fixtureSha256: sha(x11Bin), harnessSha256: sha(fileURLToPath(import.meta.url)),
    macRelaySha256: sha(join(here, 'mac-relay.mjs')), shapedLinkSha256: sha(join(here, 'shaped-link.mjs')) };
const saveReceipt = () => writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

let claim = null; let xvfb = null; let xvfbPid = 0; let bridgePid = 0; let enginePid = 0;
let forward = null; let macRelay = null; let udid = ''; let bootedByMe = false; let authority = ''; let recording = null;
const owned = new Map();
const statOf = (pid) => {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return { state: fields[0], started: fields[19] };
    } catch { return undefined; }
};
const alive = (pid) => { const s = statOf(pid); return s !== undefined && s.state !== 'Z' && s.started === owned.get(pid); };
const remember = (pid) => owned.set(pid, statOf(pid)?.started);
async function stopProcess(pid, name) {
    if (!alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(25);
    assert(!alive(pid), `${name} ${pid} survived cleanup`);
}

function describeTree() {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return JSON.parse(mac(`axe describe-ui --udid ${udid}`)); } catch (error) { last = error; }
    }
    throw last;
}
function kidsOf(node) {
    return Object.values(node).find((v) => Array.isArray(v) && v.length > 0 && v.every((i) => i && typeof i === 'object')) ?? [];
}
function screenStatus() {
    let status = null;
    const walk = (node) => {
        if (node.AXUniqueId === 'desklink-status') status = node.AXLabel ?? node.AXValue ?? '';
        for (const child of kidsOf(node)) walk(child);
    };
    for (const root of describeTree()) walk(root);
    return status;
}
async function waitStatus(word, ms) {
    const until = Date.now() + ms;
    for (;;) {
        let status = null;
        try { status = screenStatus(); } catch { /* axe flickers; retry */ }
        if (status !== null && status.toLowerCase().includes(word)) return status;
        if (Date.now() >= until) throw new Error(`the simulator never read ${word} (last: ${status})`);
        await sleep(1000);
    }
}
function shot(local) {
    mac(`xcrun simctl io ${udid} screenshot "$D/tmp/ios-shot.png" > /dev/null`);
    scpFrom('tmp/ios-shot.png', local);
    return PNG.sync.read(readFileSync(local));
}
const hashShot = (png) => {
    let h = 0;
    // Only decoded picture, not the status bar or reconnecting/deck chrome: the
    // fixture's animated marker lands in this window under portrait cover.
    for (let y = Math.floor(png.height * 0.15); y < png.height * 0.55; y += 4) {
        for (let x = Math.floor(png.width * 0.2); x < png.width * 0.8; x += 8) {
            const i = (y * png.width + x) * 4;
            h = (h * 31 + png.data[i] + png.data[i + 1] * 2 + png.data[i + 2] * 3) >>> 0;
        }
    }
    return h;
};
async function waitAdvancing(frozen, ms) {
    const until = Date.now() + ms;
    let movedAt = null; let last = frozen;
    for (;;) {
        const hash = hashShot(shot(join(out, 'probe.png')));
        if (hash !== last) {
            if (movedAt !== null) return movedAt;
            movedAt = Date.now();
        }
        last = hash;
        if (Date.now() >= until) throw new Error('the picture never advanced again');
        await sleep(500);
    }
}

async function main() {
    const hostAddr = process.env.DESKLINK_IOS_HOST_ADDR ?? mac('echo "${SSH_CONNECTION%% *}"').trim();
    assert(hostAddr !== '', 'cannot tell which address the Mac reaches this machine on');
    receipt.hostAddr = hostAddr;
    const devices = JSON.parse(mac('xcrun simctl list devices -j'));
    outer: for (const runtime of Object.values(devices.devices)) {
        for (const device of runtime) {
            if (device.name === SIM) { udid = device.udid; receipt.udid = udid; break outer; }
        }
    }
    assert(udid !== '', `no simulator named ${SIM} on the Mac`);
    const state = mac(`xcrun simctl list devices -j | python3 -c "import json,sys; print([d['state'] for r in json.load(sys.stdin)['devices'].values() for d in r if d['udid']=='${udid}'][0])"`).trim();
    if (state !== 'Booted') { mac(`xcrun simctl boot ${udid} && xcrun simctl bootstatus ${udid} -b > /dev/null`, 180_000); bootedByMe = true; }
    log(`simulator ${SIM} ${udid}`);

    if (BUILD) {
        mac('mkdir -p "$D/tmp" "$R/.cocoapods" && printf "cache_root: %s\\n" "$R/.cocoapods-cache" > "$R/.cocoapods/config.yaml"');
        const copy = spawnSync('rsync', ['-a', '--delete',
            '--exclude', 'node_modules', '--exclude', 'example/ios', '--exclude', 'example/.expo',
            '--exclude', 'android', '--exclude', 'test', '--exclude', '*.spec.ts',
            `${join(repo, 'packages/desktop-client')}/`, `${MAC}:${LANE.dir}/desktop-client/`],
            { encoding: 'utf8', timeout: 180_000 });
        assert.equal(copy.status, 0, `rsync to the Mac failed: ${copy.stderr}`);
        mac(`cd "$D/desktop-client/example"
[ node_modules/.package-lock.json -nt package.json ] || npm install --no-audit --no-fund
PACKED="$D/tmp/$(cd .. && npm pack --silent --pack-destination "$D/tmp")"
rm -rf node_modules/@desklink/react-native && mkdir node_modules/@desklink/react-native
tar -xzf "$PACKED" -C node_modules/@desklink/react-native --strip-components=1 && rm "$PACKED"
if [ ! -f ios/Podfile.lock ] || [ -n "$(find package.json app.json ../expo-module.config.json ../app.plugin.js ../ios -newer ios/Podfile.lock)" ]; then
    rm -rf ios
    npx expo prebuild --platform ios --no-install
    (cd ios && pod install)
fi
cd ios
WS="$(ls -d *.xcworkspace | head -1)"
xcodebuild -workspace "$WS" -scheme "$(basename "$WS" .xcworkspace)" -configuration Release \
    -destination "platform=iOS Simulator,id=${udid}" -derivedDataPath "$D/DerivedData" \
    CODE_SIGNING_ALLOWED=NO build > "$D/build.log" 2>&1 || { tail -60 "$D/build.log"; exit 1; }`, 40 * 60_000);
        receipt.built = true;
    }
    const app = mac('ls -d "$D/DerivedData/Build/Products/Release-iphonesimulator/"*.app | head -1').trim();
    mac(`test -d "${app}"`);

    claim = claimPrivateDisplay({ from: 170, count: 60 });
    authority = join(tmpdir(), `dl-ios-rec-${process.pid}-Xauthority`);
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]).status, 0);
    const xenv = { ...process.env, DISPLAY: claim.display, XAUTHORITY: authority, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11' };
    xvfb = spawn('Xvfb', [claim.display, '-auth', authority, '-screen', '0', `${DESKTOP.width}x${DESKTOP.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    trackOwnedXvfb(xvfb, claim.display);
    remember(xvfb.pid); xvfbPid = xvfb.pid;
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${claim.number}`) && alive(xvfbPid); i++) await sleep(50);
    assert(alive(xvfbPid), 'the private Xvfb did not start');
    await verifyOwnedXvfb(xvfb);

    let fixtureLog = '';
    const fixture = spawn(x11Bin, ['--animate', '--move'], { env: xenv, stdio: ['ignore', 'pipe', 'pipe'] });
    fixture.stdout.on('data', (c) => { fixtureLog += c; });
    fixture.stderr.on('data', (c) => { fixtureLog += c; });
    remember(fixture.pid);
    const fixtureLines = () => fixtureLog.split('\n').filter((line) => line.startsWith('{'));
    {
        const until = Date.now() + 30000;
        while (!fixtureLog.includes('"ready"') && Date.now() < until) await sleep(100);
        assert(fixtureLog.includes('"ready"'), 'the x11_target fixture never reported ready');
    }

    const token = randomBytes(24).toString('hex');
    const bridge = spawn(process.execPath, [join(repo, 'packages/desktop-host/bin/desklink-host.mjs'), 'bridge',
        '--listen', '127.0.0.1:0', '--token', token, '--source', 'x11', '--display', claim.display],
        { env: { ...xenv, DESKLINK_ENGINE: engineBin, DESKLINK_IOS_TAP_LOG: tapLog,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${engineTap}`.trim() }, stdio: ['ignore', 'pipe', 'pipe'] });
    remember(bridge.pid); bridgePid = bridge.pid;
    let engineLog = '';
    // The bridge forwards the engine child's diagnostics to its own stderr, and
    // the in-memory tail is only there for a failure message. The whole stream
    // is the leg's engine-side evidence — the ICE trace, when DESKLINK_ICE_TRACE
    // is set — so it is kept beside the receipt instead of being dropped.
    bridge.stderr.on('data', (chunk) => {
        engineLog = (engineLog + chunk).slice(-8000);
        try { appendFileSync(join(out, 'engine.log'), chunk); } catch { /* evidence best-effort */ }
    });
    const bridgePort = await new Promise((ready, fail) => {
        let printed = '';
        const timer = setTimeout(() => fail(new Error(`the bridge never printed its URL: ${printed}${engineLog}`)), 30_000);
        bridge.stdout.on('data', (chunk) => {
            printed += chunk;
            const url = /open\s+http:\/\/[^:]+:(\d+)\//.exec(printed);
            if (url) { clearTimeout(timer); ready(Number(url[1])); }
        });
        bridge.on('exit', (code) => fail(new Error(`the bridge exited (${code}): ${engineLog}`)));
    });
    for (const entry of (await import('node:fs')).readdirSync('/proc')) {
        try {
            const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ');
            if (Number(fields[1]) === bridgePid && readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes('desklink-host')) {
                enginePid = Number(entry); remember(enginePid);
            }
        } catch { /* vanished */ }
    }
    assert(enginePid !== 0, 'the bridge started no engine');

    // --- the relay runs on the Mac, reached on its own always-present LAN ---
    const macLan = mac('ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1').trim();
    const macTail = mac("ifconfig 2>/dev/null | awk '/inet 100[.]/{print $2}' | head -1").trim();
    // The app's own package carries `ws`; put the relay beside it so its imports
    // resolve the same way on the Mac as they do in this checkout.
    assert.equal(spawnSync('scp', ['-q', '-o', 'BatchMode=yes', join(here, 'shaped-link.mjs'), join(here, 'mac-relay.mjs'), `${MAC}:${LANE.dir}/desktop-client/example/`]).status, 0, 'copy the relay modules to the Mac');

    // A task-owned reverse-forward keeps the Linux bridge on loopback: only this
    // ssh process can reach it, from the Mac's own loopback.
    const seenSessionIds = [];
    // Every wire frame the relay names (session id, open/close/restart_ice,
    // ICE credentials) is collected here, and the relay's answers to the cut
    // commands resolve the waits below, so a stalled cut names what the relay
    // said rather than hanging.
    const wire = [];
    const relayWaiters = [];
    const awaitRelay = (type, ms) => new Promise((resolve, reject) => {
        const entry = { type };
        const timer = setTimeout(() => {
            const at = relayWaiters.indexOf(entry);
            if (at >= 0) relayWaiters.splice(at, 1);
            reject(new Error(`the Mac relay never answered ${type}: ${relayError}`));
        }, ms);
        entry.resolve = (message) => {
            clearTimeout(timer);
            const at = relayWaiters.indexOf(entry);
            if (at >= 0) relayWaiters.splice(at, 1);
            resolve(message);
        };
        relayWaiters.push(entry);
    });
    let forwardPort = 0;
    for (let attempt = 0; attempt < 5 && forwardPort === 0; attempt++) {
        const port = 41000 + Math.floor(Math.random() * 18000);
        forward = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${port}:127.0.0.1:${bridgePort}`, MAC], { stdio: 'ignore' });
        await sleep(1500);
        if (forward.exitCode === null) forwardPort = port; else forward = null;
    }
    assert(forwardPort !== 0, 'no SSH reverse-forward to the bridge on the Mac');
    macRelay = spawn('ssh', ['-o', 'BatchMode=yes', MAC,
        `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; cd "$HOME/${LANE.dir}/desktop-client/example" && exec node mac-relay.mjs --bridge-port ${forwardPort} --token ${token} --app-address ${macLan} --engine-address ${macTail}`],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    let relayError = '';
    macRelay.stderr.on('data', (chunk) => { relayError = (relayError + chunk).slice(-4000); });
    let ready = null;
    createInterface({ input: macRelay.stdout }).on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'log') appendFileSync(join(out, 'link.log'), `${Date.now()} ${message.line}\n`);
        if (message.type === 'report') receipt.macRelay = message.link;
        if (message.type === 'error') relayError = message.message;
        if (message.type === 'ready') ready = message;
        if (message.type === 'wire') wire.push({ ...message.wire, at: Date.now() });
        const waiter = relayWaiters.find((entry) => entry.type === message.type);
        if (waiter) waiter.resolve(message);
    });
    for (let waited = 0; ready === null && waited < 20000 && macRelay.exitCode === null; waited += 200) await sleep(200);
    assert(ready !== null, `the Mac relay never reported ready: ${relayError}`);
    const relayUrl = `ws://127.0.0.1:${ready.relayPort}/desktop?token=${token}`;
    log(`Mac-local relay on 127.0.0.1:${ready.relayPort} (app ${macLan}, engine ${macTail})`);

    mac(`xcrun simctl install ${udid} "${app}"
xcrun simctl terminate ${udid} ${BUNDLE} 2>/dev/null || true
xcrun simctl launch ${udid} ${BUNDLE} -desklinkUrl '${relayUrl}' -desklinkCover 1`, 300_000);
    {
        // The app reads `live` from its first stats sample, so it can show
        // "Connected" a beat before the engine has sent a frame, then fall back
        // to "Reconnecting" when none arrives inside its freeze window. The
        // engine's first frame can trail the ICE connect by ten seconds or more,
        // so a single "Connected" is not a live desktop: wait until it holds.
        const until = Date.now() + 180_000;
        let status = null; let heldSince = null;
        for (;;) {
            if (Date.now() > until) throw new Error(`the simulator never held a live desktop (last: ${status})${engineLog ? `\nengine: ${engineLog}` : ''}`);
            try { status = screenStatus(); } catch { status = 'unreadable'; }
            if (status === 'Connected') { heldSince ??= Date.now(); if (Date.now() - heldSince >= 6_000) break; } else heldSince = null;
            await sleep(1000);
        }
    }
    const tapPicture = async () => {
        // The fixture paints saturated primaries, not near-white, so the band
        // is found with a low floor; the aim sits in the band's upper third,
        // above the deck's own controls (as the reference proof quarter-points).
        const png = shot(join(out, 'tap-aim.png'));
        const box = pictureBox(png, screenPoints(), 200);
        assert(box.bottom - box.top > 50, 'no picture on the simulator screen to tap');
        assert(box.right > box.left, 'no picture width on the simulator screen to tap');
        const at = { x: (box.left + box.right) / 2, y: box.top + (box.bottom - box.top) * 0.35 };
        const before = fixtureLines().length;
        mac(`axe tap -x ${at.x.toFixed(1)} -y ${at.y.toFixed(1)} --udid ${udid}`);
        const until = Date.now() + 10000;
        for (;;) {
            const fresh = fixtureLines().slice(before);
            const downs = fresh.filter((l) => l.includes('"button"') && l.includes('"down"')).length;
            const ups = fresh.filter((l) => l.includes('"button"') && l.includes('"up"')).length;
            if (downs > 0 && ups > 0) return { downs, ups, at };
            if (Date.now() >= until) {
                writeFileSync(join(out, 'fixture.log'), fixtureLog);
                throw new Error(`the tap left ${downs} down(s) and ${ups} up(s) at ${JSON.stringify(at)}`);
            }
            await sleep(300);
        }
    };
    // A hardware key pressed on the simulator reaches the app's native input
    // view and the desktop as itself, exactly as the ios-flow keyboard proof
    // does; HID usage 0x52 is the up arrow.
    const tapKey = async () => {
        const before = fixtureLines().length;
        mac(`axe key 82 --udid ${udid}`);
        const until = Date.now() + 10000;
        for (;;) {
            const fresh = fixtureLines().slice(before);
            const downs = fresh.filter((l) => l.includes('"key"') && l.includes('"down"')).length;
            const ups = fresh.filter((l) => l.includes('"key"') && l.includes('"up"')).length;
            if (downs > 0 && ups > 0) return { downs, ups };
            if (Date.now() >= until) throw new Error(`the key left ${downs} down(s) and ${ups} up(s)`);
            await sleep(300);
        }
    };

    receipt.cases = {};
    // Simulator screenshots are physical pixels while `axe tap` takes points,
    // so the tap geometry needs the screen's point width, read once from the
    // widest top-level accessibility frame (SpringBoard and the app both span it).
    let pointsWidth = 0;
    const screenPoints = () => {
        if (pointsWidth <= 0) {
            for (const root of describeTree()) {
                const frame = /\{\{[^}]*\}, \{([\d.]+), ([\d.]+)\}\}/.exec(root.AXFrame ?? '');
                if (frame) pointsWidth = Math.max(pointsWidth, Number(frame[1]));
            }
            assert(pointsWidth > 0, 'the accessibility tree names no screen frame');
        }
        return pointsWidth;
    };
    // One `.mov` per case, recorded on the Mac itself: the proof is motion,
    // not stills. `recordVideo` writes its file only when it is interrupted,
    // so the stop sends SIGINT and waits for the exit.
    const startRecording = (name) => {
        recording = name;
        mac(`rm -f "$D/tmp/rec-${name}.mov" "$D/tmp/rec-${name}.pid"
nohup xcrun simctl io ${udid} recordVideo --codec=h264 "$D/tmp/rec-${name}.mov" > "$D/tmp/rec-${name}.log" 2>&1 & echo $! > "$D/tmp/rec-${name}.pid"
for i in $(seq 1 50); do grep -q 'Recording started' "$D/tmp/rec-${name}.log" && break; sleep 0.2; done
grep -q 'Recording started' "$D/tmp/rec-${name}.log"
kill -0 "$(cat "$D/tmp/rec-${name}.pid")" 2>/dev/null || { cat "$D/tmp/rec-${name}.log"; exit 1; }`);
    };
    const stopRecording = (name) => {
        mac(`kill -INT "$(cat "$D/tmp/rec-${name}.pid")"
for i in $(seq 1 50); do kill -0 "$(cat "$D/tmp/rec-${name}.pid")" 2>/dev/null || break; sleep 0.2; done
test -s "$D/tmp/rec-${name}.mov"`);
        scpFrom(`tmp/rec-${name}.mov`, join(out, `${name}.mov`));
        recording = null;
    };
    // The longest run of dark pixels down three screen columns, 8–70% of the
    // height: with cover the picture runs to the deck, so only overlaid
    // controls break the run; a fit-width band would leave a letterbox run.
    // Points, for the receipt.
    const longestDarkRun = (png, width) => {
        const density = png.width / width;
        const dark = (x, y) => {
            const i = (y * png.width + x) * 4;
            return png.data[i] + png.data[i + 1] + png.data[i + 2] < 200;
        };
        const columns = [0.35, 0.5, 0.65].map((share) => Math.floor(png.width * share));
        let longest = 0;
        for (const x of columns) {
            let run = 0;
            for (let y = Math.floor(png.height * 0.08); y < png.height * 0.70; y += 2) {
                run = dark(x, y) ? run + 2 : 0;
                longest = Math.max(longest, run);
            }
        }
        return longest / density;
    };
    // A suspended app cannot repaint, so the background case cannot show a
    // Reconnecting state mid-outage; its proof is the recovery, not the middle.
    const runCase = async (name, outageMs, outage, restore, background = false, reconnectMs = 20000) => {
        const leg = { name, sessionIdBefore: seenSessionIds.at(-1) ?? null };
        const startedAt = Date.now();
        startRecording(name);
        try {
            leg.preTap = await tapPicture();
            const tDrop0 = Date.now();
            await outage();
            if (!background) {
                const t = Date.now();
                await waitStatus('econnecting', reconnectMs);
                leg.reconnectingAt = Date.now() - t;
                shot(join(out, `screen-${name}-reconnecting.png`));
            }
            await sleep(Math.max(0, outageMs - (Date.now() - tDrop0)));
            const pathBack = await restore();
            leg.pathAt = pathBack?.pathAt ?? null;
            leg.outageMs = Date.now() - tDrop0;
            const frozen = hashShot(shot(join(out, `screen-${name}-frozen.png`)));
            const t0 = Date.now();
            let firstMove = null;
            try {
                firstMove = await waitAdvancing(frozen, 30000);
            } finally {
                // Record the measurement even when the picture never advanced,
                // so a RED receipt still names the time and the session.
                const advancedAt = firstMove ?? Date.now();
                leg.recoveryMs = advancedAt - t0;
                leg.recoveryFromPathMs = leg.pathAt === null ? null : advancedAt - leg.pathAt;
                leg.sessionIdAfter = seenSessionIds.at(-1) ?? null;
            }
            {
                const t = Date.now();
                await waitStatus('connected', 20000);
                leg.statusAt = Date.now() - t;
            }
            const recovered = shot(join(out, `screen-${name}-recovered.png`));
            // The PR 118 bar applies to iOS too: with cover there is no
            // letterbox between the picture and the deck. An overlaid
            // control breaks the run for ~50 pt; empty space would run ~300.
            leg.letterboxPt = longestDarkRun(recovered, screenPoints());
            assert(leg.letterboxPt < 130, `a ${leg.letterboxPt.toFixed(0)} pt black run splits the recovered picture: letterboxed, not cover`);
            await sleep(1500);
            const c = hashShot(shot(join(out, `screen-${name}-recovered-b.png`)));
            assert(c !== frozen, 'the picture stuck on the outage frame after the recovery');
            leg.postTap = await tapPicture();
            assert(leg.recoveryMs <= 2000, `the picture took ${leg.recoveryMs}ms to advance again (J3 allows 2000)`);
            stopRecording(name);
            leg.recording = `${name}.mov`;
        } finally {
            receipt.cases[name] = { ...leg, elapsedMs: Date.now() - startedAt };
            saveReceipt();
        }
        log(`${name}: recovery ${leg.recoveryMs}ms`);
    };

    // A 5 s engine silence: the whole far end frozen, the relay and the
    // simulator's own timers running. SIGCONT always runs: one failure cannot
    // wedge the rest of the journey.
    const unstop = () => {
        try { process.kill(enginePid, 'SIGCONT'); } catch { /* gone */ }
        try { process.kill(bridgePid, 'SIGCONT'); } catch { /* gone */ }
    };
    // A baseline leg that cuts nothing: the app holds Connected through the
    // Mac-local relay, the decoded picture keeps advancing in the default
    // portrait cover crop, and a pointer down+up and a key down+up land in the
    // fixture. This is the seed the roam follow-up builds on, not a recovery.
    const liveCase = async () => {
        const leg = { name: 'live' };
        const startedAt = Date.now();
        startRecording('live');
        try {
            const samples = [];
            for (let i = 0; i < 6; i++) { samples.push(hashShot(shot(join(out, `screen-live-${i}.png`)))); await sleep(1200); }
            leg.pictureDistinct = new Set(samples).size;
            assert(leg.pictureDistinct >= 3, `the settled picture did not keep advancing: ${leg.pictureDistinct} distinct frames of ${samples.length}`);
            leg.pointer = await tapPicture();
            leg.key = await tapKey();
            stopRecording('live');
            leg.recording = 'live.mov';
        } finally {
            receipt.cases.live = { ...leg, elapsedMs: Date.now() - startedAt };
            saveReceipt();
        }
        log(`live: ${leg.pictureDistinct} distinct picture frames; pointer ${JSON.stringify(leg.pointer)}; key ${JSON.stringify(leg.key)}`);
    };

    // The owned path cut, and the slice's subject. One leg holds the landed
    // stable baseline first, then retires the app's old UDP tuple, discards BOTH
    // native UDP directions and cuts signalling, holds a 12 s outage, and
    // restores on generation 2: the relay closes the advertised browser-facing
    // tuple and re-advertises a new one only on the fresh ICE offer, so a
    // resumed old pair is impossible and the proof requires a new generation.
    // `negative` restores signalling but leaves the media cut, so the same
    // picture verdict must fail.
    const CUT_OFF_MS = 12000;
    const cutCase = async (negative) => {
        const name = 'cut';
        const leg = { name, negative };
        const startedAt = Date.now();
        startRecording(name);
        try {
            // The landed stable baseline on this candidate, before any cut: the
            // picture keeps advancing in the default portrait cover crop, and a
            // pointer down+up and a key down+up reach the fixture.
            const baseline = [];
            for (let i = 0; i < 6; i++) { baseline.push(hashShot(shot(join(out, `screen-${name}-live-${i}.png`)))); await sleep(1200); }
            leg.pictureDistinctBefore = new Set(baseline).size;
            assert(leg.pictureDistinctBefore >= 3, `the settled picture did not keep advancing before the cut: ${leg.pictureDistinctBefore} of ${baseline.length}`);
            leg.preTap = await tapPicture();
            leg.preKey = await tapKey();
            const idsBefore = [...new Set(wire.filter((w) => w.sessionId).map((w) => w.sessionId))];
            assert(idsBefore.length === 1, `before the cut the wire named ${idsBefore.length} session id(s)`);
            leg.sessionIdBefore = idsBefore[0];

            // Cut: both native UDP directions discarded and signalling down.
            assert(macRelay && macRelay.exitCode === null, 'the Mac relay is not running to cut');
            const waitCut = awaitRelay('cut', 10000);
            const tCut = Date.now();
            macRelay.stdin.write('cut\n');
            const cut = await waitCut;
            assert(cut.link.counters.toEngine > 0 && cut.link.counters.toBrowser > 0, 'native traffic did not traverse both relay directions before the cut');
            leg.cutAt = tCut;
            leg.cutCounters = { ...cut.link.counters };
            {
                const t = Date.now();
                await waitStatus('econnecting', 20000);
                leg.reconnectingAt = Date.now() - t;
                shot(join(out, `screen-${name}-reconnecting.png`));
            }
            await sleep(Math.max(0, CUT_OFF_MS - (Date.now() - tCut)));

            // Both directions must actually have been dropped during the cut: a
            // single shared total cannot prove a real cut, so each direction has
            // a counter of its own.
            const waitPath = awaitRelay('report', 10000);
            macRelay.stdin.write('report\n');
            const atPath = await waitPath;
            leg.atPathCounters = { ...atPath.link.counters };
            assert(atPath.link.counters.discardedToEngine > leg.cutCounters.discardedToEngine,
                `the cut discarded no toEngine datagrams (${leg.cutCounters.discardedToEngine} → ${atPath.link.counters.discardedToEngine})`);
            assert(atPath.link.counters.discardedToBrowser > leg.cutCounters.discardedToBrowser,
                `the cut discarded no toBrowser datagrams (${leg.cutCounters.discardedToBrowser} → ${atPath.link.counters.discardedToBrowser})`);

            // Restore, timed from the harness sending it: the 2000 ms bar is
            // measured from the path returning, with no observer or load cost
            // compensated away.
            const frozen = hashShot(shot(join(out, `screen-${name}-frozen.png`)));
            const waitRestored = awaitRelay('restored', 15000);
            const pathAt = Date.now();
            macRelay.stdin.write(negative ? 'restore negative\n' : 'restore\n');
            const restored = await waitRestored;
            leg.pathAt = pathAt;
            leg.restoredAt = Date.now();
            leg.restoreCounters = { ...restored.link.counters };

            let firstMove = null;
            try { firstMove = await waitAdvancing(frozen, 30000); }
            finally {
                const advancedAt = firstMove ?? Date.now();
                leg.recoveryMs = advancedAt - pathAt;
                leg.sessionIdAfter = [...new Set(wire.filter((w) => w.sessionId).map((w) => w.sessionId))].at(-1) ?? null;
                leg.wire = wire.slice();
            }
            await waitStatus('connected', 20000);
            const recovered = shot(join(out, `screen-${name}-recovered.png`));
            leg.letterboxPt = longestDarkRun(recovered, screenPoints());
            assert(leg.letterboxPt < 130, `a ${leg.letterboxPt.toFixed(0)} pt black run splits the recovered picture: letterboxed, not cover`);
            await sleep(1500);
            assert(hashShot(shot(join(out, `screen-${name}-recovered-b.png`))) !== frozen, 'the picture stuck on the outage frame after the recovery');
            leg.postTap = await tapPicture();
            leg.postKey = await tapKey();
            assert(leg.recoveryMs <= 2000, `the picture took ${leg.recoveryMs}ms to advance again (J3 allows 2000)`);

            // A final snapshot names the generation and the endpoints the
            // recovery actually used.
            const waitFinal = awaitRelay('report', 10000);
            macRelay.stdin.write('report\n');
            const final = (await waitFinal).link;
            leg.finalCounters = { ...final.counters };
            leg.generation = final.generation;
            leg.routes = final.routes;

            // Same session, one open, no close and no revoke, a new ICE
            // generation (new ufrag and media endpoint) on the same DTLS peer.
            const opens = wire.filter((w) => w.dir === 'app>' && w.method === 'session.open').length;
            const restartIce = wire.filter((w) => w.dir === 'app>' && w.method === 'session.restart_ice');
            const closes = wire.filter((w) => w.dir === 'app>' && w.method === 'session.close');
            const revoked = wire.filter((w) => w.event === 'session.revoked');
            const offers = wire.filter((w) => w.dir === 'engine>' && w.event === 'session.description' && w.descriptionType === 'offer' && w.ufrag);
            const ufrags = [...new Set(offers.map((w) => w.ufrag))];
            const fingerprints = [...new Set(offers.map((w) => w.fingerprint).filter(Boolean))];
            leg.wireOps = { opens, restartIce: restartIce.length, closes: closes.length, revoked: revoked.length };
            leg.iceUfrags = ufrags;
            leg.peerFingerprints = fingerprints.length;
            assert.equal(opens, 1, `the cut journey opened ${opens} sessions; it must stay on the one open`);
            assert.equal(closes.length, 0, 'a session.close crossed during the cut');
            assert.equal(revoked.length, 0, 'a session.revoked crossed during the outage');
            assert(leg.sessionIdBefore !== null && leg.sessionIdAfter === leg.sessionIdBefore,
                `the session changed over the cut (${leg.sessionIdBefore} → ${leg.sessionIdAfter})`);
            assert(restartIce.length >= 1, 'no native session.restart_ice after the path returned');
            assert(ufrags.length >= 2, `the offer never turned over its ICE credentials: ${JSON.stringify(ufrags)}`);
            assert(leg.generation >= 2, `the relay only reached generation ${leg.generation}`);
            const gen1 = leg.routes.find((r) => r.generation === 1);
            const gen2 = leg.routes.find((r) => r.generation === 2);
            assert(gen2 && gen2.mediaSeen, 'no generation-2 media traversed the relay');
            assert(gen1 && gen2 && gen1.appPort !== gen2.appPort, 'the restored media endpoint is the old tuple relabelled');
            if (fingerprints.length > 0) {
                assert.equal(fingerprints.length, 1, `the DTLS peer identity changed across the cut: ${JSON.stringify(fingerprints)}`);
                leg.peerProof = 'same DTLS fingerprint across both generations';
            } else {
                leg.peerProof = 'not available: the offer named no DTLS fingerprint; peer identity rests on the unchanged session id and one open';
            }
            stopRecording(name);
            leg.recording = `${name}.mov`;
        } finally {
            receipt.cases[name] = { ...leg, elapsedMs: Date.now() - startedAt };
            saveReceipt();
        }
        log(`${name}: recovery ${leg.recoveryMs}ms, generation ${leg.generation}; counters ${JSON.stringify(leg.finalCounters)}`);
    };

    // DESKLINK_IOS_ONLY names a leg subset for diagnosis; unset runs the proof
    // legs (drop5 and background60). The `live` and `cut` legs are opt-in.
    const only = (process.env.DESKLINK_IOS_ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    receipt.only = only.length === 0 ? 'drop5,background60' : only;
    const runLeg = (name) => only.length === 0 ? !['live', 'cut'].includes(name) : only.includes(name);
    if (runLeg('live')) await liveCase();
    if (runLeg('cut')) await cutCase(process.env.DESKLINK_IOS_CUT_NEGATIVE === '1');
    if (runLeg('drop5')) await runCase('drop5', 5000,
        async () => { process.kill(bridgePid, 'SIGSTOP'); process.kill(enginePid, 'SIGSTOP'); },
        async () => { unstop(); });
    // A 60 s backgrounding on the simulator's own home gesture; launching the
    // bundle again foregrounds it.
    if (runLeg('background60')) await runCase('background60', 60000,
        async () => {
            mac(`axe button home --udid ${udid} 2>/dev/null || axe gesture home --udid ${udid}`);
            await sleep(2000);
        },
        async () => { mac(`xcrun simctl launch ${udid} ${BUNDLE}`); },
        true);

    receipt.outcome = 'PASS';
    console.log(`PASS: simulator recovered ${Object.keys(receipt.cases).join(', ')} [${receipt.only}]; evidence ${out}`);
}

try {
    await main();
} catch (error) {
    receipt.error = String(error?.message ?? error);
    console.error('FLOW-FAIL', error);
    // A case that died mid-outage leaves the far end stopped: wake it before
    // anything tries to stop it, or the teardown hangs on a SIGTERM it cannot hear.
    try { if (enginePid) process.kill(enginePid, 'SIGCONT'); } catch { /* gone */ }
    try { if (bridgePid) process.kill(bridgePid, 'SIGCONT'); } catch { /* gone */ }
    process.exitCode = 1;
} finally {
    receipt.outcome ??= 'FAIL';
    saveReceipt();
    try {
        // The bridge -> engine tap log is written by the bridge process; append
        // it so one file carries the whole session's signalling evidence.
        const tapped = existsSync(tapLog) ? readFileSync(tapLog, 'utf8') : '';
        appendFileSync(join(out, 'wire.log'), tapped);
    } catch { /* evidence best-effort */ }
    // Stop only this lane's recording, and preserve a RED clip before cleanup.
    if (recording) {
        try {
            mac(`kill -INT "$(cat "$D/tmp/rec-${recording}.pid")"
for i in $(seq 1 50); do kill -0 "$(cat "$D/tmp/rec-${recording}.pid")" 2>/dev/null || break; sleep 0.2; done
test -s "$D/tmp/rec-${recording}.mov"`);
            scpFrom(`tmp/rec-${recording}.mov`, join(out, `${recording}.mov`));
        } catch (error) { receipt.recordingError = error.message; }
    }
    try { mac(`xcrun simctl uninstall ${udid} ${BUNDLE} 2>/dev/null || true`); } catch { /* already gone */ }
    if (udid && bootedByMe) { try { mac(`xcrun simctl shutdown ${udid}`); } catch { /* already down */ } }
    // Ask the Mac relay to flush its counters and quit; fall back to a signal.
    if (macRelay) {
        try { macRelay.stdin.write('quit\n'); } catch { /* gone */ }
        for (let i = 0; i < 50 && macRelay.exitCode === null; i++) await sleep(100);
        if (macRelay.exitCode === null) macRelay.kill('SIGTERM');
    }
    if (forward) forward.kill('SIGTERM');
    if (bridgePid) await stopProcess(bridgePid, 'bridge');
    if (enginePid && alive(enginePid)) await stopProcess(enginePid, 'engine');
    if (xvfb) await stopOwnedXvfb(xvfb);
    claim?.release();
    if (authority && existsSync(authority)) unlinkSync(authority);
    // A failed run keeps its lane directory for forensics; a passed run
    // reclaims it. DESKLINK_IOS_KEEP=1 keeps it either way.
    if (process.env.DESKLINK_IOS_KEEP !== '1' && receipt.outcome === 'PASS') {
        try { mac(CLEAN_SCRIPT); } catch (error) { log('lane cleanup:', error.message); }
    } else {
        log(`lane directory kept at ${LANE.dir}`);
    }
    saveReceipt();
}
