#!/usr/bin/env node
// The owned path cut on an Android device: this checkout's example app on the
// attached phone (or emulator), a desktop served from a private Xvfb on this
// host, and the userspace-shaped relay (`shaped-link.mjs`) in this process, on
// this host's LAN address. The cut is the iOS recovery flow's cut leg moved to
// Android: discard both native UDP directions and the signalling carrier, hold
// the outage, then retire the app's old tuple and restore, so only a fresh ICE
// generation can carry the picture back. Nothing on the device is configured:
// the cut lives in the relay, never in the phone's settings.
//
// Paths: signalling, Metro and the app's report ride `adb reverse` (TCP, never
// cut by anything but the relay); media is UDP between the phone and the
// relay's LAN sockets. This host's firewall answers only flows it opened, so
// the relay seeds each generation's first send at the phone's own candidate on
// the relay's /24 (`seedBrowser`): ordinary ICE hole punching.
//
// Each run is judged on this host's clock alone (the relay is in-process):
//   wire  — the first media datagram of a generation newer than the cut's,
//           forwarded toward the phone after the path returned (the bar, ≤2000 ms);
//   app   — the first report the app posts after the path returned whose
//           inbound-rtp framesDecoded exceeds the pre-cut count (the phone's
//           own decode, at report arrival; recorded, not judged);
//   wire ops — same session id, no new open, no close, no revoke, a restart;
//   tap   — after the recovery a real tap lands in the fixture as down AND up.
//
// Usage (from the repo root, with DISPLAY and WAYLAND_DISPLAY unset):
//   ANDROID_SERIAL=… DESKLINK_ANDROID_OUT=<fresh dir> DESKLINK_ROAM_APP_ADDRESS=192.168.1.144 \
//     DESKLINK_ENGINE=… DESKLINK_VERIFY_TARGET=… node packages/desktop-client/test/android-roam-flow.mjs
// Env: DESKLINK_ROAM_RUNS (default 3), DESKLINK_ROAM_CUT_OFF_MS (default 12000),
// DESKLINK_ROAM_INSTALL (1 installs the built APK first, without -g),
// DESKLINK_ROAM_END_SCREEN_OFF (1 presses power at the end if the screen is on),
// DESKLINK_ICE_TRACE (1 records the engine's ICE timeline into engine.log).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { ShapedLink, startSignalling } from './shaped-link.mjs';
import { pictureBox } from './picture-box.mjs';
import {
    assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const out = resolve(process.env.DESKLINK_ANDROID_OUT ?? '');
assert(process.env.DESKLINK_ANDROID_OUT && !existsSync(out), 'set DESKLINK_ANDROID_OUT to a fresh evidence directory');
mkdirSync(out, { recursive: true });
const serial = process.env.ANDROID_SERIAL ?? '';
assert(serial !== '', 'set ANDROID_SERIAL');
const appAddress = process.env.DESKLINK_ROAM_APP_ADDRESS ?? '';
assert(/^\d+\.\d+\.\d+\.\d+$/.test(appAddress), 'set DESKLINK_ROAM_APP_ADDRESS to this host\'s LAN IPv4');
const RUNS = Number(process.env.DESKLINK_ROAM_RUNS ?? 3);
const CUT_OFF_MS = Number(process.env.DESKLINK_ROAM_CUT_OFF_MS ?? 12000);
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixtureBin = resolve(process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const example = join(repo, 'packages/desktop-client/example');
const apk = join(example, 'android/app/build/outputs/apk/debug/app-debug.apk');
const BUNDLE = 'dev.desklink.example';
for (const path of [engine, fixtureBin, apk]) assert(existsSync(path), `missing: ${path}`);
const scratch = mkdtempSync(join(homedir(), '.cache', 'desklink-android-roam-'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const log = (...args) => {
    const line = `${new Date().toISOString()} ${args.join(' ')}`;
    console.log(line);
    appendFileSync(join(out, 'flow.log'), `${line}\n`);
};
setTimeout(() => { console.error('OVERALL TIMEOUT'); process.exit(2); }, 25 * 60_000).unref();

const receipt = {
    journey: 'android-roam-cut', serial, appAddress, runsPlanned: RUNS, cutOffMs: CUT_OFF_MS, out,
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    engineSha256: sha(engine), fixtureSha256: sha(fixtureBin), apkSha256: sha(apk),
    harnessSha256: sha(fileURLToPath(import.meta.url)), shapedLinkSha256: sha(join(here, 'shaped-link.mjs')),
    shape: 'userspace-shaped link in this process; no netem, privileges, firewall or device-setting changes',
    runs: [],
};
const saveReceipt = () => writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

const adbRun = (...args) => spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120000 });
const adb = (...args) => {
    const done = adbRun(...args);
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
const capture = name => {
    const path = join(out, name);
    const shot = spawnSync('sh', ['-c', `adb -s ${serial} exec-out screencap -p > '${path}'`]);
    assert.equal(shot.status, 0, 'the device could not be captured');
    return path;
};
// Our app must hold the screen, awake. A lock screen (or any other window) in
// front stops the run: no PIN is ever typed and no other app is driven.
const deviceState = () => {
    const power = /mWakefulness=(\w+)/.exec(adb('shell', 'dumpsys', 'power'))?.[1] ?? 'unknown';
    const focus = /mCurrentFocus=(.*)/.exec(adb('shell', 'dumpsys', 'window'))?.[1]?.trim() ?? 'unknown';
    return { power, focus, ours: power === 'Awake' && focus.includes(BUNDLE) };
};
const assertOurs = what => {
    const state = deviceState();
    if (!state.ours) throw Object.assign(new Error(`device not ours ${what}: ${JSON.stringify(state)}`), { blocked: true });
    return state;
};

const children = [];
const logs = { bridge: '', fixture: '', metro: '' };
const start = (name, cmd, args, childEnv, cwd = repo) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => { logs[name] += c; });
    child.stderr.on('data', c => {
        logs[name] += c;
        if (name === 'bridge') appendFileSync(join(out, 'engine.log'), c);
    });
    children.push([name, child]);
    return child;
};
const waitFor = async (ready, what, ms = 60000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (ready()) return; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
};
const freePort = async () => {
    const probe = createServer();
    await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
    const { port } = probe.address();
    probe.close();
    return port;
};

const reverses = [];
const reverse = (spec, to = spec) => { adb('reverse', spec, to); reverses.push(spec); };
let xvfb = null; let claim = null; let receiver = null; let link = null; let relay = null;
const tapLog = join(out, 'bridge-engine.log');

try {
    const startState = deviceState();
    receipt.deviceAtStart = startState;
    receipt.screenOffTimeoutMs = Number(adb('shell', 'settings', 'get', 'system', 'screen_off_timeout').trim());
    receipt.deviceModel = adb('shell', 'getprop', 'ro.product.model').trim();
    receipt.wmSize = adb('shell', 'wm', 'size').trim();
    if (startState.power !== 'Awake') throw Object.assign(new Error(`device screen is ${startState.power}`), { blocked: true });

    // The host: a private X11 display, the repainting fixture, the bridge.
    claim = claimPrivateDisplay({ from: 170, count: 60 });
    const authority = join(scratch, 'Xauthority');
    spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]);
    const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
    xvfb = start('xvfb', 'Xvfb', [claim.display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], env);
    trackOwnedXvfb(xvfb, claim.display);
    const state = pid => { try { return readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; } };
    await waitFor(() => state(xvfb.pid)?.includes('State:\tT'), 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: claim.display, XAUTHORITY: authority };
    start('fixture', fixtureBin, ['--animate', '--move'], xenv);
    await waitFor(() => logs.fixture.includes('"ready"'), 'the fixture to be ready');
    const fixtureLines = () => logs.fixture.split('\n').filter(line => line.startsWith('{'));

    const token = randomBytes(24).toString('hex');
    start('bridge', process.execPath, [join(repo, 'packages/desktop-host/bin/desklink-host.mjs'), 'bridge',
        '--listen', '127.0.0.1:0', '--token', token, '--source', 'x11', '--display', claim.display],
    { ...xenv, DESKLINK_IOS_TAP_LOG: tapLog, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${join(here, 'engine-tap.cjs')}`.trim() });
    await waitFor(() => /open\s+http:\/\/[^:]+:\d+\//.test(logs.bridge), 'the bridge URL', 30000);
    const bridgePort = Number(/open\s+http:\/\/[^:]+:(\d+)\//.exec(logs.bridge)[1]);

    // The relay: this host's LAN address faces the phone, loopback the engine.
    const subnet = appAddress.split('.').slice(0, 3).join('.') + '.';
    const relayLog = [];
    link = new ShapedLink(line => {
        const at = Date.now();
        relayLog.push({ at, line });
        appendFileSync(join(out, 'link.log'), `${at} ${line}\n`);
    }, { appAddress, engineAddress: '127.0.0.1', remoteBrowser: true, seedBrowser: ip => ip.startsWith(subnet) });
    const wire = [];
    const wireRecord = (dir, raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        const sessionId = message.result?.sessionId ?? message.params?.sessionId ?? null;
        const record = { at: Date.now(), dir, sessionId };
        if (message.method !== undefined) {
            if (!['session.open', 'session.close', 'session.restart_ice', 'session.description'].includes(message.method)) return;
            Object.assign(record, { method: message.method, id: message.id ?? null });
        } else if (['session.description', 'session.state', 'session.revoked'].includes(message.event)) {
            record.event = message.event;
            if (message.event === 'session.description') {
                const sdp = message.params?.description?.sdp ?? '';
                record.descriptionType = message.params?.description?.type ?? null;
                record.ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1] ?? null;
                record.fingerprint = sdp.match(/a=fingerprint:([^\r\n]+)/)?.[1] ?? null;
            }
            if (message.event === 'session.state') record.transport = message.params?.transport ?? null;
        } else if (message.result?.sessionId) {
            record.result = 'open';
        } else return;
        wire.push(record);
        appendFileSync(join(out, 'wire.jsonl'), `${JSON.stringify(record)}\n`);
    };
    relay = await startSignalling(link, bridgePort, token, { relayOnly: true, onWire: wireRecord });
    log(`relay signalling 127.0.0.1:${relay.port}, media on ${appAddress}`);

    // The app's own reports, stamped on arrival with this host's clock.
    const reports = [];
    receiver = createServer((request, response) => {
        const chunks = [];
        request.on('data', c => chunks.push(c));
        request.on('end', () => {
            try { reports.push({ arrived: Date.now(), ...JSON.parse(Buffer.concat(chunks).toString()) }); } catch { /* not ours */ }
            appendFileSync(join(out, 'reports.jsonl'), `${JSON.stringify(reports.at(-1))}\n`);
            response.writeHead(204);
            response.end();
        });
    });
    await new Promise(ok => receiver.listen(0, '127.0.0.1', ok));
    const decoded = report => (report?.stats ?? []).filter(s => s.type === 'inbound-rtp').reduce((t, s) => t + (s.framesDecoded ?? 0), 0);

    // Metro serves the debug build's JavaScript to the device's own 8081.
    // An emulator resolves its bundler as the host's own 10.0.2.2:8081, which
    // adb reverse does not intercept; a phone resolves localhost:8081.
    const metroPort = serial.startsWith('emulator-') ? 8081 : await freePort();
    start('metro', 'npx', ['expo', 'start', '--port', String(metroPort)], { ...env, CI: '1' }, example);
    await waitFor(() => /Waiting on http/.test(logs.metro), 'Metro', 120000);
    if (process.env.DESKLINK_ROAM_INSTALL === '1') adb('install', '-r', apk);
    reverse('tcp:8081', `tcp:${metroPort}`);
    reverse(`tcp:${relay.port}`);
    reverse(`tcp:${receiver.address().port}`);
    Object.assign(receipt, { bridgePort, relayPort: relay.port, metroPort, display: claim.display });

    const link_ = `desklink-example://connect?url=${encodeURIComponent(`ws://127.0.0.1:${relay.port}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://127.0.0.1:${receiver.address().port}/report`)}`;
    adb('shell', 'am', 'force-stop', BUNDLE);
    await sleep(800);
    adb('shell', 'am', 'start', '-n', `${BUNDLE}/.MainActivity`, '-a', 'android.intent.action.VIEW', '-d', `"${link_}"`);
    const launchedAt = Date.now();
    await waitFor(() => reports.some(r => r.presentedAt > 0), 'the first presented frame', 240000);
    receipt.firstLiveMs = Date.now() - launchedAt;
    await sleep(3000);
    assertOurs('after launch');
    capture('00-live.png');

    // Where to tap: the picture band on the device's own screen.
    const aim = () => {
        const png = PNG.sync.read(readFileSync(capture('tap-aim.png')));
        const box = pictureBox(png, png.width, 200);
        assert(box.bottom - box.top > 50 && box.right > box.left, `no picture on the device screen to tap: ${JSON.stringify(box)}`);
        return { x: Math.round((box.left + box.right) / 2), y: Math.round(box.top + (box.bottom - box.top) * 0.35), box };
    };
    const tap = async (at) => {
        const before = fixtureLines().length;
        adb('shell', 'input', 'tap', String(at.x), String(at.y));
        const until = Date.now() + 10000;
        for (;;) {
            const fresh = fixtureLines().slice(before);
            const downs = fresh.filter(l => l.includes('"button"') && l.includes('"down"')).length;
            const ups = fresh.filter(l => l.includes('"button"') && l.includes('"up"')).length;
            if (downs > 0 && ups > 0) return { downs, ups, at: { x: at.x, y: at.y }, event: JSON.parse(fresh.find(l => l.includes('"button"'))) };
            if (Date.now() >= until) throw new Error(`the tap at ${at.x},${at.y} left ${downs} down(s) and ${ups} up(s)`);
            await sleep(200);
        }
    };
    const sessionIds = () => [...new Set(wire.filter(w => w.sessionId).map(w => w.sessionId))];
    const relayAt = (pattern, since) => {
        for (const { at, line } of relayLog) {
            const match = pattern.exec(line);
            if (match !== null && at >= since) return { at, match };
        }
        return null;
    };

    for (let n = 1; n <= RUNS; n++) {
        const run = { run: n, verdict: 'FAIL' };
        receipt.runs.push(run);
        const runStart = wire.length;
        try {
            assertOurs(`before run ${n}`);
            // Baseline: live and decoding, one session, a tap that lands.
            await waitFor(() => reports.length > 0 && Date.now() - reports.at(-1).arrived < 2500, 'a fresh live report before the cut', 30000);
            const baseDecoded = decoded(reports.at(-1));
            await waitFor(() => decoded(reports.at(-1)) > baseDecoded, 'the picture to keep decoding before the cut', 15000);
            const at = aim();
            run.aim = at;
            run.preTap = await tap(at);
            const ids = sessionIds();
            run.sessionIdBefore = ids.at(-1) ?? null;
            run.generationBefore = link.snapshot().generation;
            capture(`run${n}-01-before-cut.png`);
            await sleep(1500);

            // Cut: both native UDP directions discarded and signalling down.
            const before = link.snapshot().counters;
            assert(before.toEngine > 0 && before.toBrowser > 0, 'native traffic did not traverse both relay directions before the cut');
            run.decodedAtCut = decoded(reports.at(-1));
            run.cutAt = Date.now();
            link.set({ discard: true }, `run ${n} owned path cut`);
            relay.setCut(true);
            run.cutCounters = { ...before };
            await sleep(3000);
            capture(`run${n}-02-during-cut.png`);
            await sleep(Math.max(0, CUT_OFF_MS - (Date.now() - run.cutAt)));
            const atPath = link.snapshot().counters;
            run.atPathCounters = atPath;
            assert(atPath.discardedToEngine > before.discardedToEngine, 'the cut discarded no toEngine datagrams');
            assert(atPath.discardedToBrowser > before.discardedToBrowser, 'the cut discarded no toBrowser datagrams');

            // Restore: retire the app's old tuple, lift the discard, reopen signalling.
            await link.rebindBrowserSide();
            const pathAt = Date.now();
            link.set({ discard: false }, `run ${n} owned path back`);
            relay.setCut(false);
            run.pathBackAt = pathAt;
            run.outageMs = pathAt - run.cutAt;

            const genBefore = run.generationBefore;
            let wireMedia = null;
            let appBack = null;
            const until = Date.now() + 30000;
            while (Date.now() < until && (wireMedia === null || appBack === null)) {
                wireMedia ??= (() => {
                    const hit = relayAt(/^link generation (\d+) media through /, pathAt);
                    return hit !== null && Number(hit.match[1]) > genBefore ? hit : null;
                })();
                appBack ??= reports.find(r => r.arrived >= pathAt && decoded(r) > run.decodedAtCut) ?? null;
                await sleep(50);
            }
            run.firstNewGenFrameAt = wireMedia?.at ?? null;
            run.firstNewGeneration = wireMedia ? Number(wireMedia.match[1]) : null;
            run.wireRecoveryMs = wireMedia ? wireMedia.at - pathAt : null;
            run.appDecodeReportMs = appBack ? appBack.arrived - pathAt : null;
            const restart = wire.slice(runStart).find(w => w.dir === 'app>' && w.method === 'session.restart_ice' && w.at >= pathAt);
            run.restartIceAfterPathMs = restart ? restart.at - pathAt : null;
            capture(`run${n}-03-after-path-back.png`);
            assert(run.wireRecoveryMs !== null, 'no new-generation media reached the relay within 30 s of the path returning');
            assert(appBack !== null, 'the app reported no further decoded frames within 30 s of the path returning');

            // Same session, one open, no close, no revoke, a fresh ICE generation.
            await sleep(1500);
            const ops = wire.slice(runStart);
            run.wireOps = {
                opens: ops.filter(w => w.dir === 'app>' && w.method === 'session.open').length,
                restartIce: ops.filter(w => w.dir === 'app>' && w.method === 'session.restart_ice').length,
                closes: ops.filter(w => w.dir === 'app>' && w.method === 'session.close').length,
                revoked: ops.filter(w => w.event === 'session.revoked').length,
            };
            const offers = ops.filter(w => w.dir === 'engine>' && w.event === 'session.description' && w.descriptionType === 'offer' && w.ufrag);
            run.ufrags = [...new Set(offers.map(w => w.ufrag))];
            run.ufragBefore = wire.slice(0, runStart).filter(w => w.event === 'session.description' && w.descriptionType === 'offer' && w.ufrag).at(-1)?.ufrag ?? null;
            run.newUfrag = run.ufrags.some(u => u !== run.ufragBefore);
            run.fingerprints = [...new Set(wire.filter(w => w.fingerprint).map(w => w.fingerprint))].length;
            run.sessionIdAfter = sessionIds().at(-1) ?? null;
            run.sameSession = run.sessionIdBefore !== null && run.sessionIdAfter === run.sessionIdBefore
                && run.wireOps.opens === 0 && run.wireOps.closes === 0 && run.wireOps.revoked === 0 && run.fingerprints === 1;

            // Still live afterwards, and a real tap lands.
            assertOurs(`after run ${n} recovery`);
            const afterDecoded = decoded(reports.at(-1));
            await waitFor(() => decoded(reports.at(-1)) > afterDecoded, 'the picture to keep decoding after the recovery', 15000);
            run.postTap = await tap(aim());
            capture(`run${n}-04-after-tap.png`);
            run.tapAfterRecovery = true;
            const snap = link.snapshot();
            run.routes = snap.routes;
            run.finalCounters = snap.counters;
            run.verdict = run.wireRecoveryMs <= 2000 && run.sameSession && restart !== undefined && run.newUfrag ? 'PASS' : 'FAIL';
        } catch (error) {
            run.error = String(error?.message ?? error);
            try { capture(`run${n}-99-failure.png`); } catch { /* device gone */ }
            if (error?.blocked) throw error;
            // A failed run is kept; the next one starts once the app is live again.
            relay.setCut(false);
            link.set({ discard: false }, `run ${n} failed; path left up`);
            try { await waitFor(() => reports.length > 0 && Date.now() - reports.at(-1).arrived < 2500, 'the app live again after a failed run', 60000); } catch (again) {
                run.recoveryAbandoned = String(again.message);
                break;
            }
        } finally {
            run.tapAfterRecovery ??= false;
            run.sameSession ??= false;
            saveReceipt();
            log(`run ${n}: ${run.verdict} wire ${run.wireRecoveryMs}ms app ${run.appDecodeReportMs}ms restart ${run.restartIceAfterPathMs}ms same-session ${run.sameSession} tap ${run.tapAfterRecovery}${run.error ? ` error ${run.error}` : ''}`);
        }
    }
    receipt.outcome = receipt.runs.length === RUNS && receipt.runs.every(r => r.verdict === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
    receipt.error = String(error?.message ?? error);
    receipt.blocked = error?.blocked === true;
    try { capture('99-failure.png'); } catch { /* device gone */ }
    console.error('FLOW-FAIL', error);
} finally {
    receipt.outcome ??= 'FAIL';
    // Back out: our app stopped, the home screen, and the screen off when asked.
    try { adbRun('shell', 'am', 'force-stop', BUNDLE); adbRun('shell', 'input', 'keyevent', 'KEYCODE_HOME'); } catch { /* device gone */ }
    if (process.env.DESKLINK_ROAM_END_SCREEN_OFF === '1') {
        try {
            if (/mWakefulness=Awake/.test(adb('shell', 'dumpsys', 'power'))) adb('shell', 'input', 'keyevent', '26');
            receipt.endPower = /mWakefulness=(\w+)/.exec(adb('shell', 'dumpsys', 'power'))?.[1];
        } catch (error) { receipt.endPowerError = String(error); }
    }
    for (const spec of reverses.splice(0)) adbRun('reverse', '--remove', spec);
    try { relay?.close(); link?.close(); } catch { /* closed */ }
    receiver?.close();
    for (const [, child] of children) if (child !== xvfb) child.kill('SIGTERM');
    await sleep(700);
    for (const [, child] of children) { if (child !== xvfb && child.exitCode === null) child.kill('SIGKILL'); }
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    claim?.release();
    rmSync(scratch, { recursive: true, force: true });
    for (const name of ['bridge', 'fixture', 'metro']) writeFileSync(join(out, `${name}.log`), logs[name]);
    saveReceipt();
    log(`outcome ${receipt.outcome}${receipt.blocked ? ' (blocked)' : ''}; evidence ${out}`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : receipt.blocked ? 3 : 1);
