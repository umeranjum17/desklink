// J3 recovery on a Mac simulator: this checkout's example app on one of the
// Mac's own fm-iPhone simulators, driven through a 5 s engine silence and a
// 60 s backgrounding against a bridge on this Linux host.
//
// The path: the simulator reaches a WebSocket relay on this host (the Mac's
// route back here), which taps the loopback bridge; the engine captures the
// repository's animated x11_target on a private Xvfb. Media is ordinary host
// candidates between the simulator and this host. The 5 s drop is SIGSTOP on
// the bridge and the engine together (host-unreachable silence, signalling
// relay included — harsher than a radio drop, and user-space only). The 60 s
// backgrounding is the simulator's own home gesture.
//
// Each case measures, on the simulator's own screen: the human Reconnecting
// state through the accessibility tree and in stills, the picture advancing
// again (screenshot hashes off the animated fixture), and a tap after every
// recovery landing in the fixture's button log as down AND up. Nothing is
// tapped during a recovery, so a blocking consent prompt would stall it past
// its deadline. (X11 captures have no consent UI; the legs prove a reopen
// completes with zero user action.)
//
// The simulators are the Mac's own fm-iPhones: they are reused and left in
// place, never created or deleted here. Only this lane's build directory
// (DESKLINK_IOS_DIR/DESKLINK_IOS_LANE) is removed when done.
//
// Usage (from the repo root):
//   DESKLINK_IOS_MAC=umerfaroq@100.97.31.92 DESKLINK_IOS_LANE=dl-pm-8 \
//     DESKLINK_IOS_OUT=~/evidence/ios-j3 node packages/desktop-client/test/ios-recovery-flow.mjs
//
// Environment: DESKLINK_IOS_MAC (required), DESKLINK_IOS_LANE (required),
// DESKLINK_IOS_DIR (default fm-desklink-ios), DESKLINK_IOS_OUT (required fresh
// dir), DESKLINK_IOS_DEVICE (simulator name, default fm-iPhone 17),
// DESKLINK_IOS_SKIP_BUILD (1 reuses the lane's last build),
// DESKLINK_ENGINE, DESKLINK_VERIFY_TARGET (x11_target).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { WebSocketServer } from 'ws';
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

const receipt = { journey: 'ios-recovery-j3', mac: MAC, lane: `${LANE.base}/${LANE.lane}`, simulator: SIM, out };
const saveReceipt = () => writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

let claim = null; let xvfb = null; let xvfbPid = 0; let bridgePid = 0; let enginePid = 0;
let relay = null; let udid = ''; let bootedByMe = false;
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
    for (let y = 0; y < png.height; y += 4) {
        for (let x = 0; x < png.width; x += 8) {
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
        log('building the example app on the Mac');
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
    const authority = join(tmpdir(), `dl-ios-rec-${process.pid}-Xauthority`);
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
        { env: { ...xenv, DESKLINK_ENGINE: engineBin }, stdio: ['ignore', 'pipe', 'pipe'] });
    remember(bridge.pid); bridgePid = bridge.pid;
    let engineLog = '';
    bridge.stderr.on('data', (chunk) => { engineLog = (engineLog + chunk).slice(-8000); });
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
    log(`bridge 127.0.0.1:${bridgePort} pid ${bridgePid}, engine pid ${enginePid}`);

    relay = new WebSocketServer({ host: hostAddr, port: 0, path: '/desktop' });
    const { WebSocket } = await import('ws');
    relay.on('connection', (client, request) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${bridgePort}${request.url}`);
        const queued = [];
        upstream.on('open', () => { for (const line of queued.splice(0)) upstream.send(line); });
        upstream.on('message', (raw) => { if (client.readyState === 1) client.send(String(raw)); });
        client.on('message', (raw) => { if (upstream.readyState === 1) upstream.send(String(raw)); else queued.push(String(raw)); });
        client.on('close', () => upstream.close());
        upstream.on('close', () => client.close());
        upstream.on('error', () => client.close());
    });
    await new Promise((listening) => relay.once('listening', listening));
    const relayUrl = `ws://${hostAddr}:${relay.address().port}/desktop?token=${token}`;
    log(`relay on ${hostAddr}:${relay.address().port}`);

    mac(`xcrun simctl install ${udid} "${app}"
xcrun simctl terminate ${udid} ${BUNDLE} 2>/dev/null || true
xcrun simctl launch ${udid} ${BUNDLE} -desklinkUrl '${relayUrl}'`, 300_000);
    log('launched');
    {
        const until = Date.now() + 120_000;
        let status = null;
        while (status !== 'Connected') {
            if (Date.now() > until) throw new Error(`the simulator never showed the desktop: ${status}`);
            await sleep(2000);
            try { status = screenStatus(); } catch { status = 'unreadable'; }
        }
    }
    log('simulator Connected');
    // The fixture animates, or later "advancing" checks are meaningless.
    {
        const a = hashShot(shot(join(out, 'screen-live.png')));
        await sleep(1500);
        const b = hashShot(shot(join(out, 'screen-live-b.png')));
        assert(a !== b, 'the simulator picture never changes');
    }
    const tapPicture = async () => {
        const png = shot(join(out, 'tap-aim.png'));
        const box = pictureBox(png, png.width);
        assert(box.bottom - box.top > 50, 'no picture on the simulator screen to tap');
        const at = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        const before = fixtureLines().length;
        mac(`axe tap -x ${at.x.toFixed(1)} -y ${at.y.toFixed(1)} --udid ${udid}`);
        const until = Date.now() + 10000;
        for (;;) {
            const fresh = fixtureLines().slice(before);
            const downs = fresh.filter((l) => l.includes('"button"') && l.includes('"down"')).length;
            const ups = fresh.filter((l) => l.includes('"button"') && l.includes('"up"')).length;
            if (downs > 0 && ups > 0) return { downs, ups };
            if (Date.now() >= until) throw new Error(`the tap left ${downs} down(s) and ${ups} up(s)`);
            await sleep(300);
        }
    };

    receipt.cases = {};
    // A suspended app cannot repaint, so the background case cannot show a
    // Reconnecting state mid-outage; its proof is the recovery, not the middle.
    const runCase = async (name, outageMs, outage, restore, background = false) => {
        const leg = { name };
        const startedAt = Date.now();
        try {
            leg.preTap = await tapPicture();
            const tDrop0 = Date.now();
            await outage();
            if (!background) {
                const t = Date.now();
                await waitStatus('econnecting', 20000);
                leg.reconnectingAt = Date.now() - t;
                shot(join(out, `screen-${name}-reconnecting.png`));
            }
            await sleep(Math.max(0, outageMs - (Date.now() - tDrop0)));
            await restore();
            leg.outageMs = Date.now() - tDrop0;
            const frozen = hashShot(shot(join(out, `screen-${name}-frozen.png`)));
            const t0 = Date.now();
            const firstMove = await waitAdvancing(frozen, 30000);
            leg.recoveryMs = firstMove - t0;
            {
                const t = Date.now();
                await waitStatus('connected', 20000);
                leg.statusAt = Date.now() - t;
            }
            shot(join(out, `screen-${name}-recovered.png`));
            await sleep(1500);
            const c = hashShot(shot(join(out, `screen-${name}-recovered-b.png`)));
            assert(c !== frozen, 'the picture stuck on the outage frame after the recovery');
            leg.postTap = await tapPicture();
            assert(leg.recoveryMs <= 2000, `the picture took ${leg.recoveryMs}ms to advance again (J3 allows 2000)`);
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
    await runCase('drop5', 5000,
        async () => { process.kill(bridgePid, 'SIGSTOP'); process.kill(enginePid, 'SIGSTOP'); },
        async () => { unstop(); });
    // A 60 s backgrounding on the simulator's own home gesture; launching the
    // bundle again foregrounds it.
    await runCase('background60', 60000,
        async () => {
            mac(`axe button home --udid ${udid} 2>/dev/null || axe gesture home --udid ${udid}`);
            await sleep(2000);
        },
        async () => { mac(`xcrun simctl launch ${udid} ${BUNDLE}`); },
        true);

    receipt.outcome = 'PASS';
    console.log(`PASS: simulator recovered drop and background; evidence ${out}`);
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
    saveReceipt();
    try { mac(`xcrun simctl uninstall ${udid} ${BUNDLE} 2>/dev/null || true`); } catch { /* already gone */ }
    if (udid && bootedByMe) { try { mac(`xcrun simctl shutdown ${udid}`); } catch { /* already down */ } }
    if (bridgePid) await stopProcess(bridgePid, 'bridge');
    if (enginePid && alive(enginePid)) await stopProcess(enginePid, 'engine');
    if (xvfb) await stopOwnedXvfb(xvfb);
    claim?.release();
    // A failed run keeps its lane directory for forensics; a passed run
    // reclaims it. DESKLINK_IOS_KEEP=1 keeps it either way.
    if (process.env.DESKLINK_IOS_KEEP !== '1' && receipt.outcome === 'PASS') {
        try { mac(CLEAN_SCRIPT); } catch (error) { log('lane cleanup:', error.message); }
    } else {
        log(`lane directory kept at ${LANE.dir}`);
    }
    relay?.close();
}
