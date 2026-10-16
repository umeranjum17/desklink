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
//   node packages/desktop-client/test/reattach-grace-race-flow.mjs [evidence-dir]
//
// DESKLINK_CHROME overrides the browser (default /usr/bin/chromium).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(worktree, 'packages/desktop-client/src');
const args = process.argv.slice(2);
const scratch = args[0] ? resolve(args[0]) : mkdtempSync(join(tmpdir(), 'dl-reattach-race-'));
mkdirSync(scratch, { recursive: true });
const ownedScratch = args[0] ? null : scratch;

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
const probe = window.__probe = { status: 'boot', frames: 0, restarts: [] };
window.addEventListener('unhandledrejection', (e) => { probe.error = String(e.reason); });

// The grace's stats read is parked while this is true, so a disconnect can be
// delivered deterministically inside that await window.
window.__holdStats = false;
const parkedStats = [];
const realGetStats = nativeDesklink.getStats.bind(nativeDesklink);
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
canvas.width = 320; canvas.height = 180;
const ctx = canvas.getContext('2d');
let drawing = true; let tick = 0;
const draw = () => {
    if (!drawing) return;
    tick += 1;
    ctx.fillStyle = 'hsl(' + ((tick * 7) % 360) + ' 80% 50%)';
    ctx.fillRect(0, 0, 320, 180);
    requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
const stream = canvas.captureStream(20);
const engine = new RTCPeerConnection({ iceServers: [] });
engine.addTrack(stream.getVideoTracks()[0], stream);
engine.createDataChannel('control');

const carriers = [];
const current = () => carriers[carriers.length - 1];
async function sendOffer() {
    const offer = await engine.createOffer();
    await engine.setLocalDescription(offer);
    current().emit({ kind: 'description', description: { type: 'offer', sdp: offer.sdp } });
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
                carrier.generation += 1;
                setTimeout(() => { void sendOffer(); }, 0);
                return { sessionId: 'sess-race', generation: carrier.generation,
                    source: { kind: 'screen', width: 320, height: 180, origin: { x: 0, y: 0 } },
                    geometry: { source: { width: 320, height: 180 }, encoded: { width: 320, height: 180 }, origin: { x: 0, y: 0 } } };
            }
            if (method === 'session.description') {
                if (params.description.type === 'answer') await engine.setRemoteDescription({ type: 'answer', sdp: params.description.sdp });
                return {};
            }
            if (method === 'session.candidate') {
                await engine.addIceCandidate({ candidate: params.candidate, sdpMid: params.sdpMid ?? undefined, sdpMLineIndex: params.sdpMLineIndex ?? undefined }).catch(() => {});
                return {};
            }
            if (method === 'session.restart_ice') { carrier.restartAt = Date.now(); probe.restarts.push(carrier.restartAt); return {}; }
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
            const carrier = newCarrier();
            if (window.__onAuthorize) { const resolveReattach = window.__onAuthorize; window.__onAuthorize = null; setTimeout(resolveReattach, 0); }
            return { signaling: carrier, session: { maxWidth: 320, maxHeight: 180, maxFps: 30 } };
        },
        onStateChange: (s) => { probe.status = s.status; },
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

        const protection = await page.evaluate(() => window.__phaseProtection());
        assert.equal(protection.restarts, 0, `the wait spent a restart while the picture was moving: ${JSON.stringify(protection)}`);

        const race = await page.evaluate(() => window.__phaseRace());
        await page.screenshot({ path: join(scratch, 'race.png') });
        assert(race.restartAt !== null, `no ICE restart was requested after the still-picture reattach: ${JSON.stringify(race)}`);
        const afterRelease = race.restartAt - race.releaseAt;
        const afterEvent = race.restartAt - race.disconnectedAt;
        assert(afterRelease <= 300, `restart came ${afterRelease} ms after the wait released (want <=300): ${JSON.stringify(race)}`);
        assert(afterEvent < 1000, `restart came ${afterEvent} ms after the disconnect (want <<2000): ${JSON.stringify(race)}`);

        const result = { status: 'pass', chrome, protection, race, afterRelease, afterEvent };
        writeFileSync(join(scratch, 'race-result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log('RACE-RESULT ' + JSON.stringify(result));
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
