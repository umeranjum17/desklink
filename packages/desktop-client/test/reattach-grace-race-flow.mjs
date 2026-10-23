// Reattach-grace restart race: a carrier cut that re-dials onto a held session
// whose picture is still, and an engine transport `disconnected` that lands
// while the grace's `getStats()` await is in flight. The client must ask the
// engine for an ICE restart right after the reattach wait, not up to 2000 ms
// later: if the disconnect lands during the grace's stats await,
// `onTransportState` arms `scheduleRestart(RESTART_AFTER_MS)`, and the grace's
// later `scheduleRestart(0)` must clear that armed timer instead of returning
// early on it.
//
// It runs the real `useDesktopSession` hook and the real `native.web` binding
// in real Chromium over a real WebRTC peer connection. The peer's other end is
// co-located so the run needs no engine process or display: the client logic
// under test does not depend on where the frames come from, only that real
// frames arrive and real stats are read. The carrier is a `Signaling` object
// exactly as the README defines it, and the disconnect is delivered through its
// `state` event, which is how the engine reports it.
//
// Then, on a fresh page with the engine's 500 ms heartbeat on, a path outage
// long enough that the heartbeat lags the restored picture, as the engine's
// SCTP retransmission backoff makes it after ~15 s: nothing crosses the link,
// restarts are spent on the carrier until it dies, and the path comes back
// through a reattach and an ICE restart, with the heartbeat 15 s behind the
// picture of a still desktop (the engine's one keepalive frame a second).
// That recovery must hold: no restart, close or reopen for the next 18 s. A
// second outage after it must still be seen and recovered on the same
// session.
//
//   node packages/desktop-client/test/reattach-grace-race-flow.mjs [evidence-dir]
//
// DESKLINK_CHROME overrides the browser (default /usr/bin/chromium).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordSteps } from '../../desktop-host/test/step-record.mjs';

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(worktree, 'packages/desktop-client/src');
const args = process.argv.slice(2);
const geometryOnly = args.includes('--geometry-only');
const evidenceArg = args.find((arg) => arg !== '--geometry-only');
const scratch = evidenceArg ? resolve(evidenceArg) : mkdtempSync(join(tmpdir(), 'dl-reattach-race-'));
mkdirSync(scratch, { recursive: true });
const ownedScratch = evidenceArg ? null : scratch;

const chrome = process.env.DESKLINK_CHROME
    ?? ['/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find(existsSync);
assert(chrome, 'no Chromium found: set DESKLINK_CHROME');

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>driver</title>
<div id="stage" style="position:absolute;inset:0"></div>
<script type="module" src="./driver.ts"></script>
`;
const RN_STUB = `export const AppState = { addEventListener: () => ({ remove() {} }) };\nexport const Platform = { OS: 'web' };\n`;

// The real hook over a real peer connection; the runner drives the two phases
// through `window.__phase*`.
const DRIVER_TS = `
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDesktopSession } from '__SRC__/useDesktopSession';
import { attachSurface, nativeDesklink } from '__SRC__/native.web';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = window.__probe = { status: 'boot', frames: 0, restarts: [], log: [], opens: [], closes: [], pings: 0, surfaceSizes: [] };
window.addEventListener('unhandledrejection', (e) => { probe.error = String(e.reason); });

// The grace's stats read is parked while this is true, so a disconnect can be
// delivered deterministically inside that await window.
window.__holdStats = false;
const parkedStats = [];
const realGetStats = nativeDesklink.getStats.bind(nativeDesklink);
const realSetSurfaceSize = nativeDesklink.setSurfaceSize.bind(nativeDesklink);
nativeDesklink.setSurfaceSize = (id, width, height) => {
    probe.surfaceSizes.push([width, height]);
    return realSetSurfaceSize(id, width, height);
};
nativeDesklink.getStats = (id) => window.__holdStats
    ? new Promise((resolveStats) => parkedStats.push(() => realGetStats(id).then(resolveStats, () => resolveStats('[]'))))
    : realGetStats(id);
window.__releaseStats = () => {
    const waiting = parkedStats.splice(0);
    window.__holdStats = false;
    for (const run of waiting) run();
};

// The other end: a real RTCPeerConnection producing real video.
const canvas = document.createElement('canvas');
canvas.width = 600; canvas.height = 1200;
const ctx = canvas.getContext('2d');
let drawing = true; let tick = 0; let still = null;
const frame = () => {
    tick += 1;
    ctx.fillStyle = 'hsl(' + ((tick * 7) % 360) + ' 80% 50%)';
    ctx.fillRect(0, 0, 600, 1200);
};
const draw = () => {
    if (!drawing) return;
    frame();
    requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
// 'still' is a still desktop: the engine re-sends one unchanged frame a
// second, which the client's 500 ms stats read sees 1-1.5 s apart; one frame
// every 1.25 s gives it those gaps.
const paint = (on) => {
    clearInterval(still);
    if (on === 'still') { on = false; frame(); still = setInterval(frame, 1250); }
    if (on && !drawing) requestAnimationFrame(draw);
    drawing = on;
};
const stream = canvas.captureStream(20);
const engine = new RTCPeerConnection({ iceServers: [] });
engine.addTrack(stream.getVideoTracks()[0], stream);

// The engine's side of the link. While up is false nothing crosses it: no
// dial, no heartbeat, and (with the picture stopped) no frames. pinging is the
// engine's 500 ms heartbeat; reoffer answers a restart with an ICE-restart
// offer. Both stay off for the race phases, which only count restarts.
const link = window.__link = { up: true, pinging: false, reoffer: false };
const control = engine.createDataChannel('control');
setInterval(() => {
    if (!link.pinging || control.readyState !== 'open') return;
    control.send('{"kind":"ping"}');
    probe.pings += 1;
}, 500);
// Run once the engine has applied the client's next answer.
let onAnswer = null;

const carriers = [];
const current = () => carriers[carriers.length - 1];
async function sendOffer(options, geometry) {
    const offer = await engine.createOffer(options);
    await engine.setLocalDescription(offer);
    current().emit({ kind: 'description', description: { type: 'offer', sdp: offer.sdp }, ...(geometry === undefined ? {} : { geometry }) });
}
engine.onicecandidate = (e) => {
    if (e.candidate === null) return;
    current()?.emit({ kind: 'candidate', candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
};

function newCarrier() {
    const handlers = new Set();
    let dead = false;
    const carrier = {
        generation: 0,
        async request(method, params) {
            if (method === 'session.open') {
                probe.opens.push(Date.now());
                carrier.generation += 1;
                setTimeout(() => { void sendOffer(); }, 0);
                return { sessionId: 'sess-race', generation: carrier.generation,
                    source: { kind: 'screen', width: 600, height: 1200, origin: { x: 0, y: 0 } },
                    geometry: { source: { width: 600, height: 1200 }, encoded: { width: 600, height: 1200 }, origin: { x: 0, y: 0 } } };
            }
            if (method === 'session.description') {
                if (params.description.type === 'answer') await engine.setRemoteDescription({ type: 'answer', sdp: params.description.sdp });
                const answered = onAnswer; onAnswer = null; answered?.();
                return {};
            }
            if (method === 'session.candidate') {
                await engine.addIceCandidate({ candidate: params.candidate, sdpMid: params.sdpMid ?? undefined, sdpMLineIndex: params.sdpMLineIndex ?? undefined }).catch(() => {});
                return {};
            }
            if (method === 'session.restart_ice') {
                carrier.restartAt = Date.now(); probe.restarts.push(carrier.restartAt);
                if (link.reoffer && link.up) setTimeout(() => { void sendOffer({ iceRestart: true }); }, 0);
                return {};
            }
            if (method === 'session.close') probe.closes.push(Date.now());
            return {};
        },
        subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
        close() { dead = true; },
        emit(event) { if (dead) return; for (const handler of handlers) handler(event); },
    };
    carriers.push(carrier);
    return carrier;
}

let session = null;
function Harness() {
    session = useDesktopSession({
        authorize: async () => {
            if (!link.up) throw Object.assign(new Error('the desktop is unreachable'), { code: 'transport' });
            const carrier = newCarrier();
            if (window.__onAuthorize) { const resolveReattach = window.__onAuthorize; window.__onAuthorize = null; setTimeout(resolveReattach, 0); }
            return { signaling: carrier, session: { maxWidth: 1200, maxHeight: 1200, maxFps: 30 } };
        },
        onStateChange: (s) => { if (s.status !== probe.status) probe.log.push([Date.now(), s.status]); probe.status = s.status; },
        onError: (f) => { probe.error = f.code; },
    });
    window.__session = session;
    React.useEffect(() => { void session.connect(); }, []);
    React.useEffect(() => {
        if (session.nativeId == null) return;
        const stage = document.getElementById('stage');
        attachSurface(session.nativeId, stage, 'desktop');
        const video = stage.querySelector('video');
        let last = 0;
        const spin = () => {
            if (typeof video.requestVideoFrameCallback !== 'function') return;
            video.requestVideoFrameCallback((_now, meta) => {
                if (meta.presentedFrames > last) { last = meta.presentedFrames; probe.frames += 1; }
                spin();
            });
        };
        spin();
    }, [session.nativeId]);
    return null;
}
TestRenderer.create(React.createElement(Harness));

// Cut the carrier and wait for the hook's dial to reattach on a fresh one.
async function cutAndReattach(record) {
    const reattached = new Promise((r) => { window.__onAuthorize = r; });
    record.carrierCutAt = Date.now();
    current().emit({ kind: 'carrier-closed' });
    await reattached;
    await sleep(0);
    record.reattachAt = Date.now();
}

// The picture keeps moving: the wait must see frames advance and spend nothing.
window.__phaseProtection = async () => {
    const before = probe.restarts.length;
    window.__holdStats = false;
    await cutAndReattach({});
    await sleep(600);
    return { restarts: probe.restarts.length - before };
};

window.__phaseGeometry = async () => {
    const initial = window.__session.snapshot.geometry;
    if (initial?.source?.width !== 600 || initial?.source?.height !== 1200) {
        throw new Error('expected the live session to start at 600x1200; got ' + JSON.stringify(initial));
    }
    await sendOffer({ iceRestart: true });
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const check = () => engine.signalingState === 'stable' ? resolve() : Date.now() >= deadline
            ? reject(new Error('first renegotiation offer was not answered'))
            : setTimeout(check, 20);
        check();
    });
    const unchanged = await new Promise((resolve) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
            if (window.__session.snapshot.geometry?.source?.width === 600) return resolve(window.__session.snapshot.geometry);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(poll, 20);
        };
        poll();
    });
    if (unchanged == null) throw new Error('offer without geometry changed or lost the existing geometry');
    const swapped = { source: { width: 1200, height: 600 }, encoded: { width: 1200, height: 600 }, origin: { x: 0, y: 0 } };
    await sendOffer({ iceRestart: true }, swapped);
    const updated = await new Promise((resolve) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
            const geometry = window.__session.snapshot.geometry;
            if (geometry?.source?.width === 1200 && geometry?.source?.height === 600) return resolve(geometry);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(poll, 20);
        };
        poll();
    });
    return { initial, unchanged, updated, surfaceSizes: probe.surfaceSizes.slice() };
};

window.__phaseRace = async () => {
    const record = {};
    const before = probe.restarts.length;
    drawing = false;
    await sleep(300); // let the encoder drain so the stats read sees a still picture
    window.__holdStats = true;
    await cutAndReattach(record);
    // The grace timer fires ~200 ms after the reattach and only then clears the
    // restart slot and awaits stats: the race needs the disconnect to land in
    // that await, i.e. after the timer, while the stats read is parked.
    await sleep(250);
    record.disconnectedAt = Date.now();
    current().emit({ kind: 'state', transport: 'disconnected', capture: 'ok', firstFrame: true });
    await sleep(200);
    record.releaseAt = Date.now();
    window.__releaseStats();
    await sleep(2300); // long enough to observe a late (~2000 ms) restart if the arm is not cancelled
    record.restartAt = probe.restarts.length > before ? probe.restarts[probe.restarts.length - 1] : null;
    record.restarts = probe.restarts.length - before;
    return record;
};

// A path outage: nothing crosses the link, and the carrier dies carrierMs in
// (restarts reach it only while it lives). Back on the path, the engine
// answers a restart with an ICE-restart offer; the picture returns with that
// generation (a still desktop if still) and the heartbeat lagMs after it.
window.__phaseOutage = async ({ downMs, carrierMs, lagMs, watchMs, still }) => {
    const r = { nativeId: session.nativeId, cutAt: Date.now() };
    const since = (t0, times) => times.filter((t) => t > t0).length;
    const firstAfter = (t0, live) => probe.log.find(([t, s]) => t > t0 && (s === 'live') === live)?.[0] ?? null;
    link.up = false; link.pinging = false; paint(false);
    await sleep(carrierMs);
    current().emit({ kind: 'carrier-closed' });
    await sleep(downMs - carrierMs);
    r.detectedAt = firstAfter(r.cutAt, false);
    r.restartsDown = since(r.cutAt, probe.restarts);
    onAnswer = () => { r.restoredAt = Date.now(); paint(still ? 'still' : true); setTimeout(() => { link.pinging = true; }, lagMs); };
    r.pathAt = Date.now();
    link.up = true;
    for (let waited = 0; probe.status !== 'live' && waited < 10000; waited += 20) await sleep(20);
    r.recoveredAt = firstAfter(r.pathAt, true);
    if (r.recoveredAt === null) return r;
    const frames = probe.frames, pings = probe.pings;
    await sleep(watchMs);
    r.watchedMs = Date.now() - r.recoveredAt;
    r.restartsAfter = since(r.recoveredAt, probe.restarts);
    r.closes = since(r.cutAt, probe.closes);
    r.opens = since(r.cutAt, probe.opens);
    r.statusesAfter = probe.log.filter(([t]) => t > r.recoveredAt);
    r.framesAfter = probe.frames - frames;
    r.pingsAfter = probe.pings - pings;
    r.nativeIdAfter = session.nativeId;
    return r;
};
`;

const viteConfig = `const SRC = ${JSON.stringify(SRC)};
const WT = ${JSON.stringify(join(worktree, 'node_modules'))};
const PAGE = ${JSON.stringify(scratch)};
export default { root: PAGE, logLevel: 'error', define: { global: 'globalThis' },
  plugins: [{ name: 'native-shim', enforce: 'pre', resolveId(source, importer) {
    if (source === './native' && importer && importer.startsWith(SRC)) return SRC + '/native.web.ts';
    return null;
  } }],
  resolve: { alias: [
    { find: 'react-native', replacement: PAGE + '/rn-stub.js' },
    { find: 'react-test-renderer', replacement: WT + '/react-test-renderer' },
    { find: /^react$/, replacement: WT + '/react/index.js' },
  ] } };
`;

async function main() {
    writeFileSync(join(scratch, 'index.html'), INDEX_HTML);
    writeFileSync(join(scratch, 'rn-stub.js'), RN_STUB);
    writeFileSync(join(scratch, 'driver.ts'), DRIVER_TS.split('__SRC__').join(SRC));
    writeFileSync(join(scratch, 'vite.config.mjs'), viteConfig);

    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: join(scratch, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, fs: { allow: [scratch, worktree] } } });
    await vite.listen();
    const url = vite.resolvedUrls.local[0];

    const { chromium } = await import('playwright-core');
    const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
        executablePath: chrome, headless: true, viewport: { width: 640, height: 480 },
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    try {
        const page = context.pages()[0] ?? await context.newPage();
        page.on('pageerror', (error) => console.error('PAGE-ERROR', String(error)));
        await page.goto(url);
        await page.waitForFunction(() => window.__probe != null && typeof window.__phaseRace === 'function');
        const wait = async (check, ms, why) => {
            const deadline = Date.now() + ms;
            while (!await check()) { assert(Date.now() < deadline, `timeout: ${why}`); await new Promise((r) => setTimeout(r, 50)); }
        };
        await wait(async () => { const p = await page.evaluate(() => window.__probe); return p.status === 'live' && p.frames > 3; }, 30000, 'live picture with advancing frames');
        await new Promise((r) => setTimeout(r, 1500)); // let the media watcher poll once so a baseline exists

        const geometry = await page.evaluate(() => window.__phaseGeometry());
        assert.deepEqual(geometry.initial.source, { width: 600, height: 1200 });
        assert.deepEqual(geometry.unchanged.source, { width: 600, height: 1200 }, 'an offer without geometry keeps the current size');
        assert.deepEqual(geometry.updated?.source, { width: 1200, height: 600 }, 'an offer with geometry updates the live session');
        assert.deepEqual(geometry.updated.encoded, { width: 1200, height: 600 }, 'the live session records encoded dimensions');
        assert(geometry.surfaceSizes.some(([width, height]) => width === 1200 && height === 600), 'the presented native surface receives the encoded dimensions');
        if (geometryOnly) {
            const result = { status: 'pass', chrome, geometry };
            writeFileSync(join(scratch, 'geometry-result.json'), JSON.stringify(result, null, 2) + '\n');
            console.log('GEOMETRY-RESULT ' + JSON.stringify(result));
            return;
        }

        const protection = await page.evaluate(() => window.__phaseProtection());
        assert.equal(protection.restarts, 0, `the wait spent a restart while the picture was moving: ${JSON.stringify(protection)}`);

        const race = await page.evaluate(() => window.__phaseRace());
        await page.screenshot({ path: join(scratch, 'race.png') });
        assert(race.restartAt !== null, `no ICE restart was requested after the still-picture reattach: ${JSON.stringify(race)}`);
        const afterRelease = race.restartAt - race.releaseAt;
        const afterEvent = race.restartAt - race.disconnectedAt;
        assert(afterRelease <= 300, `restart came ${afterRelease} ms after the wait released (want <=300): ${JSON.stringify(race)}`);
        assert(afterEvent < 1000, `restart came ${afterEvent} ms after the disconnect (want <<2000): ${JSON.stringify(race)}`);

        // The outage legs run on a fresh page, with the engine's heartbeat and re-offers on.
        await page.reload();
        await page.waitForFunction(() => window.__probe != null && typeof window.__phaseOutage === 'function');
        await wait(async () => { const p = await page.evaluate(() => window.__probe); return p.status === 'live' && p.frames > 3; }, 30000, 'live picture after the reload');
        await page.evaluate(() => Object.assign(window.__link, { pinging: true, reoffer: true }));
        await new Promise((r) => setTimeout(r, 3000)); // heartbeats land and arm the stall watchdog
        const held = (name, leg) => {
            const why = `${name}: ${JSON.stringify(leg)}`;
            assert(leg.detectedAt !== null, `the outage never took the session off live: ${why}`);
            assert(leg.recoveredAt !== null, `no recovery to live after the path came back: ${why}`);
            assert(leg.recoveredAt - leg.pathAt <= 2000, `live came ${leg.recoveredAt - leg.pathAt} ms after the path (want <=2000): ${why}`);
            assert.equal(leg.restartsAfter, 0, `a restart fired after the recovery: ${why}`);
            assert.equal(leg.closes, 0, `the session was closed: ${why}`);
            assert.equal(leg.opens, 0, `a new session was opened: ${why}`);
            assert.deepEqual(leg.statusesAfter, [], `the status left live after the recovery: ${why}`);
            assert.equal(leg.nativeIdAfter, leg.nativeId, `the native session changed: ${why}`);
            assert(leg.framesAfter > 0, `the picture did not advance after the recovery: ${why}`);
            assert(leg.pingsAfter > 0, `the heartbeat never came back: ${why}`);
        };
        const outage = await page.evaluate((leg) => window.__phaseOutage(leg), { downMs: 15000, carrierMs: 7000, lagMs: 15000, watchMs: 18000, still: true });
        held('outage', outage);
        assert(outage.restartsDown >= 1, `no restart was spent during the outage: ${JSON.stringify(outage)}`);
        assert(outage.watchedMs >= 10000, `watched ${outage.watchedMs} ms after the recovery (want >=10000)`);
        const second = await page.evaluate((leg) => window.__phaseOutage(leg), { downMs: 6000, carrierMs: 0, lagMs: 1000, watchMs: 4000 });
        held('second outage', second);

        const result = { status: 'pass', chrome, geometry, protection, race, afterRelease, afterEvent, outage, second };
        writeFileSync(join(scratch, 'race-result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log('RACE-RESULT ' + JSON.stringify(result));
        recordSteps(scratch, {
            start: 'a live desktop picture in the desklink client over a real WebRTC connection, with the desktop held still',
            steps: [
                `While the picture moves, a short reconnect wait spends no ICE restart (${protection.restarts} restarts).`,
                `Cut the connection while the picture is still: the client asks for an ICE restart ${afterRelease} ms after its reconnect wait ends and ${afterEvent} ms after the disconnect.`,
                `Cut the network path for ${outage.pathAt - outage.cutAt} ms: the client stops calling the picture live, and the picture is live again ${outage.recoveredAt - outage.pathAt} ms after the path returns, on the same session, and stays live with no restart, close or reopen.`,
                `Cut the path a second time: the picture is live again ${second.recoveredAt - second.pathAt} ms after the path returns, on the same session.`,
            ],
            result: 'After a network outage the client brings the live desktop picture back on the same session within 2 s of the path returning, and keeps it live.',
        });
    } finally {
        await context.close();
        await vite.close();
    }
    if (ownedScratch) rmSync(ownedScratch, { recursive: true, force: true });
}

main().catch(async (error) => {
    console.error('RACE-FAIL', error);
    if (ownedScratch) rmSync(ownedScratch, { recursive: true, force: true });
    process.exit(1);
});
