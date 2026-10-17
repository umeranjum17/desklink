// P0a RED baseline: userspace-shaped media + signaling outage on an owned Xvfb.
// Build the engine/fixture, then run with DISPLAY and WAYLAND_DISPLAY unset:
// node packages/desktop-client/test/roam-flow.mjs <fresh-evidence-dir> --outage 12000
// P0b: --path new-address --driver-restart uses a TEST-ONLY retention shim.
// P1: --product-retention disables that shim and checks real bridge retention.
// P1e: --burst-restarts 3 --product-retention sends queued restarts on reattach.
// P3b: --stall-carrier blackholes the carrier instead of closing it (the
//      tailnet case); --media-cut drops only the media/ICE path and keeps the
//      signalling carrier up, so the client's own ICE reaches failed while the
//      dial loop is idle and the held session must return to live on the same
//      session when the path comes back; --corrupt-offer makes the restart
//      offer fail SDP-apply, which must stay terminal rather than recover.
// Record the standalone 20s roam's actual outcome against the unchanged 2s bar.
// P3a: --adapter hook mounts the real hook over the demo carrier; --authorize-revoked
// makes the app's authorize() refuse from the cut on.
// --scenario never-connected --adapter hook: the link discards every datagram
// before the first open, so ICE never connects; the hook must end once with
// `never-connected` within the 20 s first-frame bound, closing that one session
// and opening no other for 60 s.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { ShapedLink, startSignalling } from './shaped-link.mjs';
import { assertNoAmbientDesktop, claimPrivateDisplay, stopOwnedXvfb, trackOwnedXvfb, verifyOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const outage = Number(option('--outage', '12000'));
const scenario = option('--scenario', 'roam');
const pathMode = option('--path', 'same-address');
const burstRestarts = Number(option('--burst-restarts', '1'));
assert(Number.isInteger(burstRestarts) && burstRestarts >= 1 && burstRestarts <= 100, '--burst-restarts must be 1..100');
const killDuringRestart = args.includes('--kill-during-restart');
// P3b: the carrier stalls instead of closing (a blackholed tailnet socket),
// and/or the recovery offer is corrupted so SDP-apply fails.
const stallCarrier = args.includes('--stall-carrier');
const mediaCut = args.includes('--media-cut');
const corruptOffer = args.includes('--corrupt-offer');
const adapter = option('--adapter', 'driver');
assert(['driver', 'demo', 'hook'].includes(adapter), 'unknown --adapter');
const hook = adapter === 'hook';
assert(!corruptOffer || hook, '--corrupt-offer requires --adapter hook');
assert(!mediaCut || hook, '--media-cut requires --adapter hook');
const authorizeRevoked = args.includes('--authorize-revoked');
assert(!authorizeRevoked || hook, '--authorize-revoked requires --adapter hook');
assert(!killDuringRestart || adapter === 'demo', '--kill-during-restart requires --adapter demo');
const driverRestart = args.includes('--driver-restart') || burstRestarts > 1 || killDuringRestart;
const productRetention = args.includes('--product-retention') || hook;
assert(!hook || !driverRestart, 'the hook restarts on its own');
assert(['same-address', 'new-address'].includes(pathMode), 'unknown --path');
assert(!mediaCut || (!stallCarrier && pathMode === 'same-address'), '--media-cut cannot be combined with --stall-carrier or --path new-address');
assert(!driverRestart || scenario === 'roam', '--driver-restart requires roam');
assert(Number.isInteger(outage) && outage >= 1000 && outage <= 60000, '--outage must be 1000..60000 ms');
assert(['roam', 'abandon', 'close-in-window', 'never-connected'].includes(scenario), 'unknown --scenario');
const neverConnected = scenario === 'never-connected';
assert(!neverConnected || hook, '--scenario never-connected requires --adapter hook');
assert(args[0] && !args[0].startsWith('--'), 'supply a fresh evidence directory first');
const evidence = resolve(args[0]);
assert(!existsSync(evidence), 'refusing to overwrite evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const tap = (direction, message) => {
    const row = { at: Date.now(), direction, ...message };
    appendFileSync(join(evidence, 'stdio.jsonl'), JSON.stringify(row) + '\n');
    return row;
};
const result = { scenario, outage, pathMode, driverRestart, burstRestarts, productRetention, adapter, authorizeRevoked, killDuringRestart, stallCarrier, mediaCut, corruptOffer, head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim(),
    shape: 'userspace-shaped link; no netem, privileges or firewall changes', tap: [], teardown: { strays: [], failures: [] } };
const tag = `DESKLINK_ROAM=${process.pid}`;
const tagged = () => readdirSync('/proc').flatMap(name => {
    try { return Number(name) !== process.pid && readFileSync(`/proc/${name}/environ`).toString().split('\0').includes(tag) ? [Number(name)] : []; }
    catch { return []; }
});
const driver = (port, token) => `
${adapter === 'demo' ? `import { bridgeSignaling } from '/@fs/${worktree}/packages/desktop-client/example/bridgeSignaling.ts';` : ''}
const probe = window.__probe = { sessionId: null, peerId: 1, iceGeneration: 0, answerAt: null, errors: [], controls: [], pings: [] };
window.addEventListener('unhandledrejection', e => probe.errors.push(String(e.reason)));
const peer = new RTCPeerConnection({ iceServers: [] });
let socket, demo;
probe.pending = 0; probe.carrierClosed = 0;
const pending = new Map(); let seq = 0, inputSeq = 0, channel;
const request = (method, params = {}) => {
    probe.pending++;
    const started = performance.now();
    const reply = ${adapter === 'demo' ? 'demo.request(method, params)' : `new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    })`};
    return reply.catch(error => {
        if (method === 'session.restart_ice') probe.restartRejected = { code: error.code, ms: performance.now() - started };
        throw error;
    }).finally(() => probe.pending--);
};
const candidates = [];
const offers = new Set();
peer.onicecandidate = e => { if (e.candidate) candidates.push(e.candidate.toJSON()); void flush(); };
async function flush() {
    if (!probe.sessionId) return;
    for (const c of candidates.splice(0)) await request('session.candidate', { session_id: probe.sessionId, candidate: c.candidate, sdp_mid: c.sdpMid, sdp_m_line_index: c.sdpMLineIndex });
}
peer.ontrack = e => { const video = document.querySelector('video'); video.srcObject = new MediaStream([e.track]); void video.play(); };
peer.ondatachannel = e => {
    channel = e.channel;
    channel.onmessage = e => {
        const message = JSON.parse(e.data), at = Date.now();
        probe.controls.push({ at, ...message });
        if (message.kind === 'ping') probe.pings.push(at);
    };
};
function connect(restart = false) {
${adapter === 'demo' ? '' : `socket = new WebSocket('ws://127.0.0.1:${port}/desktop?token=${token}');`}
if (socket) socket.onclose = () => { for (const p of pending.values()) p.reject(new Error('bridge closed')); pending.clear(); };
const receive = async m => {
    const p = m.params ?? {};
    if (m.id !== undefined) { const w = pending.get(m.id); pending.delete(m.id); if (m.error) w?.reject(new Error(m.error.message)); else w?.resolve(m.result); return; }
    if (m.event === 'session.description') {
        const ufrag = p.description.sdp.match(/a=ice-ufrag:([^\\r\\n]+)/)[1];
        if (offers.has(ufrag)) return;
        offers.add(ufrag); probe.iceGeneration++;
        await peer.setRemoteDescription(p.description);
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        await request('session.description', { session_id: p.sessionId, generation: p.generation, description: answer });
        probe.answerAt = Date.now();
    }
    if (m.event === 'session.candidate') await peer.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex });
};
const opened = async () => {
    if (restart) { await Promise.all(Array.from({ length: ${burstRestarts} }, () => request('session.restart_ice', { session_id: probe.sessionId, generation: 1 }))); return; }
    const opened = await request('session.open', { max_width: 1280, max_height: 720, max_fps: 30 }); probe.sessionId = opened.sessionId; await flush();
};
${adapter === 'demo' ? `demo = bridgeSignaling('ws://127.0.0.1:${port}/desktop?token=${token}');
demo.subscribe(event => {
    if (event.kind === 'carrier-closed') { probe.carrierClosed++; return; }
    const params = event.kind === 'candidate' ? { ...event, ...event.candidate } : event;
    void receive({ event: 'session.' + event.kind, params });
});
void demo.open.then(opened).catch(error => probe.errors.push(String(error)));` : `socket.onmessage = e => void receive(JSON.parse(e.data)); socket.onopen = opened;`}
}
connect();
window.__restart = () => connect(true);
window.__carrierRequest = () => { void request('session.metrics', { session_id: probe.sessionId }).catch(error => { probe.carrierRejection = error.code; }); };
const send = message => channel.send(JSON.stringify({ ...message, seq: ++inputSeq }));
window.__hold = () => { send({ kind: 'pointer', phase: 'down', x: 320, y: 180, button: 1 }); send({ kind: 'key', character: 'a', down: true }); };
window.__release = () => send({ kind: 'release_all' });
window.__clipboard = (kind, request, text) => send({ kind, request, ...(text === undefined ? {} : { text }) });
window.__measure = async () => {
    const stats = await peer.getStats(); const frames = {};
    stats.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') frames[row.id] = row.framesDecoded ?? 0; });
    const transport = [...stats.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId);
    const pair = stats.get(transport?.selectedCandidatePairId);
    const remote = stats.get(pair?.remoteCandidateId);
    return { at: Date.now(), sessionId: probe.sessionId, peerId: probe.peerId, iceGeneration: probe.iceGeneration, answerAt: probe.answerAt,
        pending: probe.pending, carrierClosed: probe.carrierClosed, carrierRejection: probe.carrierRejection, restartRejected: probe.restartRejected,
        offerError: probe.offerError, pair: pair && { id: pair.id, state: pair.state, remotePort: remote?.port }, frames, channel: channel?.readyState,
        pings: probe.pings, controls: probe.controls, errors: probe.errors };
};
`;

// The real hook and web binding over the demo carrier; nothing here recovers.
const hookDriver = (port, token) => `
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { bridgeSignaling } from '/@fs/${worktree}/packages/desktop-client/example/bridgeSignaling.ts';
import { useDesktopSession } from '/@fs/${worktree}/packages/desktop-client/src/useDesktopSession.ts';
import { attachSurface, nativeDesklink } from '/@fs/${worktree}/packages/desktop-client/src/native.web.ts';
const probe = window.__probe = { status: 'boot', failure: null, holdAt: null, sessionId: null, generation: null, offerError: null, answerAt: null, iceGeneration: 0, opens: [], authorizes: [], carriers: [], restarts: [], closes: [], log: [], errors: [], pings: [], controls: [] };
// Engine heartbeats over the data channel: the control path, apart from video.
nativeDesklink.addListener('onSessionEvent', e => {
    if (e.name === 'control') {
        const message = JSON.parse(String(e.payload.message));
        probe.controls.push({ at: Date.now(), ...message });
        if (message.kind === 'ping') probe.pings.push(Date.now());
    }
    if (e.name === 'failure' && String(e.payload.reason ?? '') === 'sdp') probe.offerError = String(e.payload.message ?? 'sdp');
    if (e.name === 'answer') probe.answerAt = Date.now();
});
// P3b: corrupt the next offer the hook hands to the native binding, so the
// terminal SDP-apply failure runs through useDesktopSession, not a test peer.
let corruptNextOffer = false;
const realSetRemoteDescription = nativeDesklink.setRemoteDescription.bind(nativeDesklink);
nativeDesklink.setRemoteDescription = (id, type, sdp) => {
    if (type === 'offer') probe.iceGeneration++;
    if (!corruptNextOffer || type !== 'offer') return realSetRemoteDescription(id, type, sdp);
    corruptNextOffer = false;
    const bad = sdp
        .replace(/^m=video[^\\r\\n]*/m, 'm=video 9 INVALID 0')
        .replace(/^a=ice-ufrag:.*$/m, 'a=ice-ufrag:');
    return realSetRemoteDescription(id, type, bad);
};
window.addEventListener('unhandledrejection', e => probe.errors.push(String(e.reason)));
let carrier = null, session = null;
const authorize = async () => {
    probe.authorizes.push(Date.now());
    if (window.__revoked) throw new Error('this phone is no longer paired');
    carrier?.close();
    const own = carrier = bridgeSignaling('ws://127.0.0.1:${port}/desktop?token=${token}');
    await own.open;
    probe.carriers.push(Date.now());
    return { session: { maxWidth: 1280, maxHeight: 720, maxFps: 30 }, signaling: {
        subscribe: handler => own.subscribe(handler),
        close: () => own.close(),
        request: async (method, params) => {
            const at = Date.now();
            if (method === 'session.open') probe.opens.push(at);
            if (method === 'session.restart_ice') probe.restarts.push(at);
            if (method === 'session.close') probe.closes.push(at);
            const reply = await own.request(method, params);
            if (method === 'session.open') { probe.sessionId = reply.sessionId; probe.generation = reply.generation; }
            return reply;
        },
    } };
};
function Harness() {
    session = useDesktopSession({ authorize, onStateChange: s => {
        if (s.status !== probe.status) probe.log.push([Date.now(), s.status]);
        probe.status = s.status; probe.failure = s.failure?.code ?? null;
        if (s.status === 'failed' && s.failure?.code === 'transport' && probe.holdAt === null) probe.holdAt = Date.now();
    } });
    React.useEffect(() => { void session.connect(); }, []);
    React.useEffect(() => { if (session.nativeId != null) attachSurface(session.nativeId, document.body, 'desktop'); }, [session.nativeId]);
    return null;
}
TestRenderer.create(React.createElement(Harness));
window.__hold = () => { session.setInputEnabled(true); session.send({ kind: 'pointer', phase: 'down', x: 320, y: 180, button: 1 }); session.send({ kind: 'key', character: 'a', down: true }); };
window.__release = () => session.releaseHeld();
window.__clipboardWrite = async text => { session.setInputEnabled(true); await session.pasteLocalToRemote(text); };
window.__clipboardRead = async () => { session.setInputEnabled(true); return session.copyRemoteToLocal(async () => {}); };
window.__restart = () => { corruptNextOffer = true; void carrier.request('session.restart_ice', { session_id: probe.sessionId, generation: probe.generation }); };
window.__measure = async () => {
    const frames = {};
    for (const row of await session.getStats()) if (row.type === 'inbound-rtp' && row.kind === 'video') frames[row.id] = row.framesDecoded ?? 0;
    return { at: Date.now(), sessionId: probe.sessionId, peerId: session.nativeId, frames, channel: session.snapshot.presented ? 'open' : 'closed',
        status: probe.status, failure: probe.failure, holdAt: probe.holdAt, offerError: probe.offerError, answerAt: probe.answerAt, iceGeneration: probe.iceGeneration,
        opens: probe.opens, authorizes: probe.authorizes, carriers: probe.carriers,
        restarts: probe.restarts, closes: probe.closes, log: probe.log, errors: probe.errors, pings: probe.pings,
        controls: probe.controls, clipboard: session.clipboard };
};
`;

async function run() {
    const targetDir = process.env.CARGO_TARGET_DIR ?? join(process.env.HOME, '.cache/dl-roam-persistence-target');
    const engine = process.env.DESKLINK_AXI_ENGINE ?? join(targetDir, 'debug/desklink-host');
    const fixture = process.env.DESKLINK_VERIFY_TARGET ?? join(targetDir, 'debug/examples/x11_target');
    assert(existsSync(engine) && existsSync(fixture), 'build task-owned desklink-host and x11_target first');
    const scratch = mkdtempSync(join(tmpdir(), 'dl-roam-'));
    let claim, xvfb, target, bridge, signalling, relay, vite, context, pageVideo;
    let fixtureLog = '', fixtureBuffer = '', refused = 0, blocked = false, holdMetrics = false, stalled = false;
    const observedFixture = [];
    const upstreams = new Set();
    const link = new ShapedLink((...items) => appendFileSync(join(evidence, 'link.log'), `${Date.now()} ${items.join(' ')}\n`));
    const fixtureRows = () => fixtureLog.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const wait = async (check, ms, why) => {
        const deadline = Date.now() + ms;
        while (!await check()) { assert(Date.now() < deadline, `timeout: ${why}`); await sleep(25); }
    };
    try {
        claim = claimPrivateDisplay({ from: 240, count: 30 });
        const authority = join(scratch, 'Xauthority');
        assert.equal(spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]).status, 0);
        xvfb = spawn('Xvfb', [claim.display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
        trackOwnedXvfb(xvfb, claim.display); await verifyOwnedXvfb(xvfb);
        const env = { ...process.env, DISPLAY: claim.display, XAUTHORITY: authority, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', DESKLINK_ROAM: String(process.pid), DESKLINK_OPENH264: 'off' };
        target = spawn(fixture, ['--animate'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [target.stdout, target.stderr]) stream.on('data', chunk => {
            fixtureLog += chunk;
            fixtureBuffer += chunk;
            const lines = fixtureBuffer.split('\n'); fixtureBuffer = lines.pop();
            for (const line of lines) {
                try { observedFixture.push({ ...JSON.parse(line), observedAt: Date.now() }); } catch { /* diagnostic */ }
            }
        });
        await wait(() => fixtureLog.includes('"ready"'), 5000, 'fixture ready');
        // Only the owned display may become ambient for the child engine.
        Object.assign(process.env, env);
        const token = randomBytes(16).toString('hex');
        const { Bridge } = await import(join(worktree, 'packages/desktop-host/dist/index.js'));
        bridge = await Bridge.start({ listen: '127.0.0.1:0', token, engineCommand: engine, engineArgs: ['serve'], serveExample: false,
            source: { kind: 'x11', display: claim.display } });
        // Tap bytes at the real stdio boundary, not client requests: close on
        // detach originates inside Bridge. This test deliberately inspects it.
        if (driverRestart && !productRetention) {
            // TEST ONLY: retain the bridge's session across detach; the driver
            // reattaches without session.open. Product persistence is NOT proven.
            bridge.releaseSessionIfDetached = () => tap('reattach-shim', { retained: true });
        }
        const child = bridge.engine.child;
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (...values) => {
            for (const line of String(values[0]).trim().split('\n')) {
                const message = JSON.parse(line);
                if (['session.open', 'session.close', 'session.restart_ice', 'session.description'].includes(message.method)) result.tap.push(tap('bridge->engine', message));
                else if (hook) tap('bridge->engine', message);
            }
            return write(...values);
        };
        child.stderr.on('data', chunk => appendFileSync(join(evidence, 'engine.log'), chunk));
        let buffered = '';
        child.stdout.on('data', chunk => {
            buffered += chunk;
            const lines = buffered.split('\n'); buffered = lines.pop();
            for (const line of lines) {
                const message = JSON.parse(line);
                if (['session.revoked', 'session.state', 'session.description'].includes(message.event)) result.tap.push(tap('engine->bridge', message));
                else if (hook) tap('engine->bridge', message);
            }
        });
        signalling = await startSignalling(link, bridge.port, token, { relayOnly: driverRestart || hook });
        relay = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: () => { if (blocked) refused++; return !blocked; } });
        relay.on('connection', client => {
            const host = new WebSocket(`ws://127.0.0.1:${signalling.port}/desktop?token=${token}`);
            upstreams.add(host);
            const queue = [];
            const forward = raw => {
                // A stalled carrier is blackholed, not closed: the socket stays
                // open but carries nothing, which is the tailnet case the
                // client cannot see as a close.
                if (stalled) return;
                if (host.readyState !== WebSocket.OPEN) { queue.push(raw); return; }
                host.send(raw);
                if (killDuringRestart && JSON.parse(String(raw)).method === 'session.restart_ice') {
                    // Dispatch to the real bridge, then cut before forwarding its reply.
                    tap('restart-carrier-cut', {}); client.terminate();
                }
            };
            host.on('open', () => { for (const raw of queue.splice(0)) forward(raw); });
            client.on('message', forward);
            const heldIds = new Set();
            client.on('message', raw => {
                const message = JSON.parse(String(raw));
                if (holdMetrics && message.method === 'session.metrics') heldIds.add(message.id);
            });
            host.on('message', raw => {
                if (stalled) return;
                if (heldIds.has(JSON.parse(String(raw)).id)) return; // Withhold a real reply until the carrier cut.
                if (client.readyState === WebSocket.OPEN) client.send(String(raw));
            });
            host.on('close', () => { upstreams.delete(host); client.terminate(); });
            host.on('error', error => { tap('relay-error', { message: error.message }); client.terminate(); });
            client.on('close', () => host.close());
        });
        await new Promise(resolve => relay.once('listening', resolve));
        writeFileSync(join(scratch, 'index.html'), '<video autoplay muted style="width:100%;height:100vh"></video><script type="module" src="/driver.js"></script>');
        writeFileSync(join(scratch, 'driver.js'), (hook ? hookDriver : driver)(relay.address().port, token));
        const { createServer } = await import('vite');
        const stub = join(scratch, 'app-stub.js');
        writeFileSync(stub, `export const Linking = {}, Platform = {}, Pressable = null, ScrollView = null, Settings = {}, StatusBar = null, StyleSheet = { create: x => x }, Text = null, View = null, AppState = { addEventListener: () => ({ remove() {} }) }, SafeAreaProvider = null, useSafeAreaInsets = () => ({}), ClipboardConfirmation = null, DesktopView = null, ModifierKeys = null, useDesktopSession = () => ({});`);
        const src = join(worktree, 'packages/desktop-client/src');
        vite = await createServer({ root: scratch, configFile: false, logLevel: 'error', define: { global: 'globalThis' },
            plugins: [{ name: 'native-web', enforce: 'pre', resolveId: (source, importer) => source === './native' && importer?.startsWith(src) ? join(src, 'native.web.ts') : null }],
            resolve: { alias: [
                { find: 'react-test-renderer', replacement: join(worktree, 'node_modules/react-test-renderer') },
                ...['react-native', 'expo-clipboard', 'react-native-safe-area-context', '@desklink/react-native'].map(find => ({ find, replacement: stub })),
                { find: /^react$/, replacement: join(worktree, 'node_modules/react/index.js') },
            ] },
            server: { host: '127.0.0.1', port: 0, fs: { allow: [scratch, worktree] } } });
        await vite.listen();
        const { chromium } = await import('playwright-core');
        // Chromium keeps the real runtime dir; only its profile is isolated.
        context = await chromium.launchPersistentContext(join(scratch, 'profile'), { executablePath: process.env.DESKLINK_CHROME ?? '/usr/bin/chromium', headless: true,
            env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }, viewport: { width: 1280, height: 720 },
            recordVideo: { dir: evidence, size: { width: 1280, height: 720 } },
            args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
        const page = context.pages()[0];
        // Motion clip of the roam journey, saved beside the stills/receipts.
        result.video = null;
        pageVideo = page.video();
        page.on('pageerror', error => appendFileSync(join(evidence, 'browser.log'), `${Date.now()} ${error}\n`));
        page.on('requestfailed', request => appendFileSync(join(evidence, 'browser.log'), `${Date.now()} ${request.url()} ${request.failure()?.errorText}\n`));
        // No candidate pair can answer: the hook opens on a path that never forms.
        if (neverConnected) link.set({ discard: true }, 'never-connected cut');
        await page.goto(vite.resolvedUrls.local[0]);
        await page.waitForFunction(() => typeof window.__measure === 'function');
        const measure = () => page.evaluate(() => window.__measure());
        if (neverConnected) {
            // The status log, not the status: a reopen leaves `failed` at once.
            await wait(async () => (await measure()).log.some(([, status]) => status === 'failed'), 30000, 'first open fails');
            const first = await measure();
            result.endedAfterOpenMs = first.log.find(([, status]) => status === 'failed')[0] - first.opens[0];
            await sleep(Math.max(0, first.opens[0] + 60000 - Date.now()));
            const m = await measure();
            const engine = method => result.tap.filter(e => e.direction === 'bridge->engine' && e.method === method).length;
            Object.assign(result, { status: m.status, failure: m.failure, statusLog: m.log, opens: m.opens.length, closes: m.closes.length,
                authorizes: m.authorizes.length, engineOpens: engine('session.open'), engineCloses: engine('session.close'),
                framesDecoded: Object.values(m.frames).reduce((a, b) => a + b, 0), counters: link.counters, pageErrors: m.errors });
            assert.equal(m.failure, 'never-connected', 'failure code');
            assert.equal(m.status, 'failed', 'status 60 s after the open');
            assert(result.endedAfterOpenMs <= 21000, `ended ${result.endedAfterOpenMs} ms after the open, past the 20 s first-frame bound`);
            assert.deepEqual({ opens: result.opens, closes: result.closes, engineOpens: result.engineOpens, engineCloses: result.engineCloses },
                { opens: 1, closes: 1, engineOpens: 1, engineCloses: 1 }, 'one open and one close in 60 s');
            assert(result.counters.discarded > 0, 'the link never saw the path it cut');
            return;
        }
        await wait(async () => { const m = await measure(); return m.channel === 'open' && Object.values(m.frames).some(n => n > 5); }, 20000, 'decoded live video and input');
        await verifyOwnedXvfb(xvfb);
        await page.evaluate(() => window.__hold());
        await wait(() => fixtureRows().some(e => e.kind === 'key' && e.phase === 'down') && fixtureRows().some(e => e.kind === 'button' && e.phase === 'down'), 2000, 'held key and button');
        await sleep(1000); // Allow X autorepeat to establish its pre-cut rate.
        // P0b isolates connectivity; held-input outage safety remains P0a's test.
        if (driverRestart || (productRetention && scenario !== 'roam')) {
            await page.evaluate(() => window.__release());
            await wait(() => fixtureRows().some(e => e.kind === 'button' && e.phase === 'up'), 2000, 'pre-cut P0b release');
        }
        await page.screenshot({ path: join(evidence, 'before.png') });
        result.before = await measure();
        if (adapter === 'demo') {
            holdMetrics = true;
            await page.evaluate(() => window.__carrierRequest());
            await wait(async () => (await measure()).pending === 1, 1000, 'real carrier request awaiting reply');
        }
        result.cutAt = Date.now(); blocked = true;
        if (authorizeRevoked) await page.evaluate(() => { window.__revoked = true; });
        if (!productRetention || scenario === 'roam') link.set({ discard: true }, 'roam cut');
        // A stalled carrier keeps its socket open and swallows everything; the
        // default cuts it so the relay closes upstream.
        if (stallCarrier) stalled = true;
        else if (!mediaCut) for (const client of relay.clients) client.terminate();
        if (adapter === 'demo') {
            await sleep(1000);
            result.carrierAfterCut = await measure();
            assert.equal(result.carrierAfterCut.pending, 0, 'request pending 1s after carrier cut');
            assert.equal(result.carrierAfterCut.carrierClosed, 1, 'carrier close not delivered exactly once');
            assert.equal(result.carrierAfterCut.carrierRejection, 'transport');
            await page.evaluate(() => { window.__probe.carrierRejection = null; window.__carrierRequest(); });
            await wait(async () => (await measure()).carrierRejection === 'transport', 50, 'future request rejected on dead carrier');
        }
        if (scenario === 'close-in-window') {
            await sleep(500);
            if (productRetention) {
                const closeStarted = Date.now();
                await bridge.close();
                result.explicitCloseMs = Date.now() - closeStarted;
                assert(result.explicitCloseMs <= 1000, 'bridge.close exceeded 1s inside retention window');
            }
            await page.close();
        }
        // A real attempted handshake demonstrates admission refusal during outage.
        const denied = new WebSocket(`ws://127.0.0.1:${relay.address().port}/desktop`);
        denied.on('error', () => {});
        await new Promise(resolve => denied.once('close', resolve));
        await sleep(Math.max(0, result.cutAt + outage - Date.now()));
        result.refused = refused;
        result.atPathBack = scenario === 'close-in-window' ? null : await measure();
        result.backAt = Date.now();
        if (scenario !== 'abandon') {
            if (pathMode === 'new-address') await link.rebindBrowserSide();
            blocked = false; link.set({}, 'path back');
            if (stallCarrier) stalled = false;
        }
        const held = result.before;
        let last = result.atPathBack, recovered = null;
        let reset = last !== null && (last.sessionId !== held.sessionId || last.peerId !== held.peerId
            || Object.keys(held.frames).some(id => !(id in last.frames) || last.frames[id] < held.frames[id]));
        if (burstRestarts > 1) { result.restartAt = Date.now(); await page.evaluate(() => window.__restart()); }
        if (scenario === 'roam') {
            while (Date.now() - result.backAt < 2000) {
                const m = await measure();
                if (m.sessionId !== held.sessionId || m.peerId !== held.peerId || Object.keys(held.frames).some(id => !(id in m.frames) || m.frames[id] < last.frames[id])) reset = true;
                if (!reset && Object.keys(held.frames).some(id => m.frames[id] > result.atPathBack.frames[id])) { recovered = m.at - result.backAt; break; }
                last = m; await sleep(25);
            }
            await page.screenshot({ path: join(evidence, 'after.png') });
        }
        result.counterReset = reset; result.firstFrameAfterPathBackMs = recovered; result.last = last;
        if (corruptOffer) {
            // P3b: ask for a restart on path-back; the hook corrupts the SDP
            // it hands to the native binding, so that offer's SDP-apply fails.
            // A failure that is not the peer's own ICE is terminal, so the
            // held session must be discarded, not kept for the ICE hold.
            result.restartAt = Date.now();
            const beforeRestart = await measure();
            await page.evaluate(() => window.__restart());
            await wait(async () => (await measure()).offerError, 5000, 'corrupt offer SDP-apply failure');
            const offerAfter = await measure();
            result.offerError = offerAfter.offerError;
            result.offerAfter = offerAfter;
            assert(offerAfter.iceGeneration >= 2, 'the corrupt restart offer never arrived');
            assert.equal(offerAfter.answerAt, beforeRestart.answerAt, 'an SDP-apply failure was answered instead of staying terminal');
            await wait(async () => (await measure()).peerId !== beforeRestart.peerId, 2000, 'terminal SDP failure did not discard the held session');
            result.corruptOfferTerminal = true;
            await page.screenshot({ path: join(evidence, 'corrupt-offer.png') });
            return;
        }
        if (driverRestart) {
            result.beforeRestart = await measure();
            if (pathMode === 'new-address' && burstRestarts === 1) {
                assert.equal(recovered, null, 'old tuple healed before restart');
                assert.deepEqual(result.beforeRestart.frames, result.atPathBack.frames, 'frames before restart on retired tuple');
            }
            if (burstRestarts === 1) { result.restartAt = Date.now(); await page.evaluate(() => window.__restart()); }
            if (killDuringRestart) {
                await wait(async () => (await measure()).restartRejected, 1000, 'restart rejected after carrier cut');
                result.restartRejection = (await measure()).restartRejected;
                assert.equal(result.restartRejection.code, 'transport');
                assert(result.restartRejection.ms <= 50, 'restart rejection exceeded 50ms');
                assert.equal((await measure()).pending, 0);
                return;
            }
            await wait(async () => {
                const m = await measure();
                return m.iceGeneration === 2 && m.answerAt > result.restartAt
                    && result.tap.some(e => e.event === 'session.state' && e.at >= m.answerAt && e.params.transport === 'connected');
            }, 20000, 'engine connected after restart answer');
            result.connected = await measure();
            await wait(async () => {
                const m = await measure();
                result.afterRestart = m;
                return m.pair?.state === 'succeeded' && m.pair.remotePort !== held.pair.remotePort
                    && Object.keys(held.frames).some(id => m.frames[id] > result.connected.frames[id]);
            }, 5000, 'frames advance on new selected tuple');
            const linkLog = readFileSync(join(evidence, 'link.log'), 'utf8');
            result.generation2Port = Number(linkLog.match(/\(generation 2\) → browser through 127\.0\.0\.1:(\d+)/)?.[1]);
            assert.equal(result.afterRestart.pair.remotePort, result.generation2Port, 'selected tuple bypassed relay');
            assert(linkLog.includes(`link generation 2 media through 127.0.0.1:${result.generation2Port}`), 'no generation-2 relay media');
            const restartOffers = result.tap.filter(e => e.event === 'session.description' && e.at >= result.restartAt);
            result.restartUfrags = [...new Set(restartOffers.map(e => e.params.description.sdp.match(/a=ice-ufrag:([^\r\n]+)/)[1]))];
            assert.equal(restartOffers.length, burstRestarts, 'each restart must re-emit an offer');
            assert.equal(result.restartUfrags.length, 1, 'queued restarts stacked ICE credentials');
            if (burstRestarts > 1) assert(recovered !== null && recovered <= 2000, 'burst recovery exceeded 2s');
            assert.equal(result.afterRestart.sessionId, held.sessionId);
            assert.equal(result.afterRestart.peerId, held.peerId);
            assert.deepEqual(result.afterRestart.errors, []);
            await wait(async () => {
                result.controlAfterRestart = await measure();
                return result.controlAfterRestart.pings.some(at => at >= result.connected.at);
            }, 10000, 'heartbeat returns on the new nominated pair');
            const controlAt = Date.now();
            await verifyOwnedXvfb(xvfb);
            await page.evaluate(() => { window.__hold(); window.__release(); });
            await wait(() => ['button', 'key'].every(kind => ['down', 'up'].every(phase =>
                observedFixture.some(e => e.observedAt >= controlAt && e.kind === kind && e.phase === phase))),
            3000, 'fixture-confirmed key and pointer after restart');
            const clipboardText = 'Umer: control after ICE restart';
            await page.evaluate(text => window.__clipboard('clipboard_write', 'roam-write', text), clipboardText);
            await wait(async () => (await measure()).controls.some(m => m.request === 'roam-write'), 3000, 'clipboard write reply');
            await page.evaluate(() => window.__clipboard('clipboard_read', 'roam-read'));
            await wait(async () => (await measure()).controls.some(m => m.request === 'roam-read'), 3000, 'clipboard read reply');
            result.controlProof = await measure();
            const clipboard = result.controlProof.controls.find(m => m.request === 'roam-read');
            assert.equal(clipboard.error, undefined, 'clipboard read refused');
            assert.equal(clipboard.text, clipboardText, 'clipboard round trip after restart');
            assert(Object.keys(held.frames).some(id => result.controlProof.frames[id] > result.afterRestart.frames[id]), 'frames stopped during control proof');
            assert.equal(result.controlProof.sessionId, held.sessionId);
            assert.equal(result.controlProof.peerId, held.peerId);
            assert.equal(result.controlProof.pair.remotePort, result.generation2Port);
            result.firstPingAfterRestartMs = result.controlAfterRestart.pings.find(at => at >= result.connected.at) - result.backAt;
            result.controlMarkers = observedFixture.filter(e => e.observedAt >= controlAt);
            result.sessionCounts = { opens: result.tap.filter(e => e.method === 'session.open').length,
                closes: result.tap.filter(e => e.method === 'session.close').length };
            assert.deepEqual(result.sessionCounts, { opens: 1, closes: 0 }, 'recovery replaced the desktop session');
            assert(!result.tap.some(e => e.event === 'session.revoked'), 'recovery revoked the session');
            await page.screenshot({ path: join(evidence, 'restart.png') });
        }
        // The host holds a detached session for its 30 s reattach window, and the
        // hook keeps the held session inside it however the carrier failed: the
        // P3a dial loop when the carrier closed, and the P3b ICE-failed hold when
        // it stalled. Past the window the first carrier opens a new session.
        const reopens = hook && outage > 30000;
        if (productRetention && scenario === 'roam' && !reopens) {
            assert.equal(result.atPathBack.sessionId, held.sessionId, 'session id changed during outage');
            assert(!result.tap.some(e => e.direction === 'bridge->engine' && e.method === 'session.close'), 'bridge closed session inside retention window');
            assert(!result.tap.some(e => e.event === 'session.revoked'), 'engine ended retained session');
        }
        if (hook && scenario === 'roam') {
            const closed = () => result.tap.some(e => e.direction === 'bridge->engine' && e.method === 'session.close' && e.params.session_id === held.sessionId);
            if (authorizeRevoked) {
                await wait(async () => (await measure()).status === 'ended', 2000, 'revoked pairing ended the session');
                // No carrier is left to carry a close: the bridge's window sends it,
                // unless the engine's own ICE failure (~25 s) revokes the session first.
                const ended = () => closed() || result.tap.some(e => e.direction === 'engine->bridge' && e.event === 'session.revoked' && e.params?.sessionId === held.sessionId);
                await wait(ended, Math.max(0, result.cutAt + 32000 - Date.now()), 'held session ended');
                await sleep(2000);
            } else if (reopens) {
                const backCarrier = await (async () => { await wait(async () => (await measure()).carriers.some(at => at >= result.backAt), 10000, 'carrier after path-back'); return (await measure()).carriers.find(at => at >= result.backAt); })();
                await wait(async () => { const m = await measure(); return m.sessionId !== held.sessionId && Object.values(m.frames).some(n => n > 0); }, 10000, 'picture on a new session');
                const m = await measure();
                result.reopenAfterCarrierMs = m.opens.find(at => at >= backCarrier) - backCarrier;
                result.newPictureMs = m.at - result.backAt;
                assert(result.reopenAfterCarrierMs <= 500, `reopen ${result.reopenAfterCarrierMs}ms after the first carrier`);
                assert(result.newPictureMs <= 3000, `new-session picture ${result.newPictureMs}ms after path-back`);
            } else {
                assert(recovered !== null && recovered <= 2000, `recovery ${recovered}ms after path-back`);
                if (pathMode === 'new-address') assert(result.tap.some(e => e.direction === 'bridge->engine' && e.method === 'session.restart_ice' && e.at >= result.backAt), 'no restart_ice after path-back');
            }
            // The real hook resumes input and clipboard on the new nominated pair
            // without replacing the desktop session: fixture-confirmed key and
            // pointer, an exact clipboard round trip, and decoded frames still
            // advancing while they finish.
            if (!authorizeRevoked && !reopens) {
                const controlAt = Date.now();
                await verifyOwnedXvfb(xvfb);
                const framesBeforeControl = (await measure()).frames;
                await page.evaluate(() => window.__hold());
                await wait(() => ['button', 'key'].every(kind =>
                    observedFixture.some(e => e.observedAt >= controlAt && e.kind === kind && e.phase === 'down')), 3000, 'fixture-confirmed key and pointer down after recovery');
                await page.evaluate(() => window.__release());
                await wait(() => ['button', 'key'].every(kind =>
                    observedFixture.some(e => e.observedAt >= controlAt && e.kind === kind && e.phase === 'up')), 3000, 'fixture-confirmed key and pointer up after recovery');
                const clipboardText = 'Umer: control after ICE restart';
                await page.evaluate(text => window.__clipboardWrite(text), clipboardText);
                await wait(async () => (await measure()).controls.some(m => m.kind === 'clipboard' && m.request != null), 3000, 'clipboard write reply after recovery');
                const read = await page.evaluate(() => window.__clipboardRead());
                assert.equal(read.error, undefined, 'clipboard read refused after recovery');
                assert.equal(read.text, clipboardText, 'clipboard round trip after recovery');
                result.controlProof = await measure();
                assert(Object.keys(framesBeforeControl).some(id => result.controlProof.frames[id] > framesBeforeControl[id]), 'frames stopped during hook control proof');
                assert.equal(result.controlProof.sessionId, held.sessionId, 'hook control proof changed the session');
                assert.equal(result.controlProof.peerId, held.peerId, 'hook control proof changed the peer');
                // A new-address recovery restarts ICE and moves to the nominated
                // generation-2 pair; a same-address recovery keeps generation 1.
                if (pathMode === 'new-address') {
                    assert(result.controlProof.iceGeneration >= 2, 'hook control proof ran before the generation-2 restart');
                    const linkLog = readFileSync(join(evidence, 'link.log'), 'utf8');
                    result.hookGeneration2Port = Number(linkLog.match(/\(generation 2\) → browser through 127\.0\.0\.1:(\d+)/)?.[1]);
                    assert(Number.isInteger(result.hookGeneration2Port) && linkLog.includes(`link generation 2 media through 127.0.0.1:${result.hookGeneration2Port}`), 'no generation-2 relay media in hook run');
                }
                result.hookControlMarkers = observedFixture.filter(e => e.observedAt >= controlAt);
                result.hookControlAfterRecoveryMs = result.controlProof.at - result.backAt;
            }
            if (!authorizeRevoked) {
                await sleep(Math.max(0, result.cutAt + 45000 - Date.now()));
                const a = await measure(); await sleep(1000); const b = await measure();
                result.at45 = { sessionId: b.sessionId, peerId: b.peerId, advanced: Object.keys(b.frames).some(id => b.frames[id] > (a.frames[id] ?? Infinity)) };
                assert(result.at45.advanced && a.peerId === b.peerId, 'frames not advancing at cut + 45 s');
            }
            const m = await measure();
            Object.assign(result, { recoveryMs: recovered, sameSession: !reopens && !authorizeRevoked && m.sessionId === held.sessionId && !closed(),
                holdAt: m.holdAt, heldIceFailure: m.holdAt != null && m.holdAt >= result.cutAt && m.holdAt <= result.backAt,
                opens: m.opens.length, authorizesAfterCut: m.authorizes.filter(at => at >= result.cutAt).length, restartsAfterBack: m.restarts.filter(at => at >= result.backAt).length,
                status: m.status, failure: m.failure, statusLog: m.log, timeline: { authorizes: m.authorizes, carriers: m.carriers, opens: m.opens, restarts: m.restarts }, pageErrors: m.errors,
                pingsAfterBack: m.pings.filter(at => at >= result.backAt).length, firstPingAfterCut: m.pings.find(at => at > result.cutAt + 1000) - result.backAt });
            if (authorizeRevoked) {
                assert.equal(m.status, 'ended'); assert.equal(result.authorizesAfterCut, 1, 'redial after a refused pairing');
            } else {
                assert.equal(result.opens, reopens ? 2 : 1, 'session.open count'); assert.equal(m.status, 'live');
                if (!reopens) assert(result.sameSession, 'session changed');
            }
        }
        result.closeMs = result.tap.find(e => e.direction === 'bridge->engine' && e.method === 'session.close' && e.params.session_id === held.sessionId)?.at - result.cutAt;
        // The engine releases held input only once ICE disconnects (~4 s); a shorter outage never gets there.
        const releases = outage >= 4000;
        if (releases) await wait(() => {
            const rows = fixtureRows();
            return rows.some(e => e.kind === 'button' && e.phase === 'up')
                && rows.filter(e => e.kind === 'key' && e.phase === 'up').length >= rows.filter(e => e.kind === 'key' && e.phase === 'down').length;
        }, 3000, 'fixture observed release of held button and final key (not autorepeat up)');
        const rows = fixtureRows();
        result.keyDowns = rows.filter(e => e.kind === 'key' && e.phase === 'down').length;
        result.keyRepeats = Math.max(0, result.keyDowns - 1);
        result.buttonUps = rows.filter(e => e.kind === 'button' && e.phase === 'up').length;
        result.keyUps = rows.filter(e => e.kind === 'key' && e.phase === 'up').length;
        result.counters = link.counters;
        if (productRetention && scenario === 'abandon') {
            assert(Math.abs(result.closeMs - 30000) <= 500, `abandon close outside 30s ±0.5s: ${result.closeMs}`);
        }
        const buttonUp = observedFixture.find(e => e.kind === 'button' && e.phase === 'up');
        result.inputReleaseAfterCutMs = buttonUp?.observedAt - result.cutAt;
        assert(result.refused > 0, 'outage admission was not exercised');
        if (releases) assert(result.buttonUps > 0 && result.keyUps >= result.keyDowns, 'held input was not released');
        assert(driverRestart || hook || scenario !== 'roam' || recovered !== null, 'RED: pre-cut peer/session did not resume decoded video within 2s of path-back');
    } finally {
        writeFileSync(join(evidence, 'fixture-events.jsonl'), fixtureLog);
        writeFileSync(join(evidence, 'fixture-observed.json'), JSON.stringify(observedFixture, null, 2));
        for (const [name, cleanup] of [
            ['browser', () => context?.close()],
            ['video', async () => {
                // Playwright finalizes the .webm on page/context close; keep a
                // deterministic name beside before.png/after.png/result.json.
                try { await pageVideo?.path(); } catch { /* path resolves after close */ }
                const found = readdirSync(evidence).filter(f => f.endsWith('.webm'));
                if (found.length > 0) {
                    const dest = join(evidence, 'roam.webm');
                    if (found.length === 1 && found[0] === 'roam.webm') result.video = 'roam.webm';
                    else {
                        for (const [i, file] of found.entries()) {
                            const name = found.length === 1 ? dest : join(evidence, `roam-${i}.webm`);
                            if (resolve(evidence, file) !== resolve(name)) renameSync(join(evidence, file), name);
                        }
                        result.video = found.length === 1 ? 'roam.webm' : found.map((_, i) => `roam-${i}.webm`);
                    }
                }
            }],
            ['relay', async () => { for (const client of relay?.clients ?? []) client.terminate(); for (const host of upstreams) host.terminate(); if (relay) await new Promise(resolve => relay.close(resolve)); }],
            ['signalling', () => signalling?.close()], ['link', () => link.close()], ['vite', () => vite?.close()], ['bridge', () => bridge?.close()],
            ['fixture', async () => { if (target?.exitCode === null) { target.kill('SIGTERM'); await wait(() => target.exitCode !== null || target.signalCode !== null, 3000, 'fixture exit'); } }],
            ['xvfb', () => xvfb && stopOwnedXvfb(xvfb)], ['claim', () => claim?.release()], ['scratch', () => rmSync(scratch, { recursive: true, force: true })],
        ]) { try { await cleanup(); } catch (error) { result.teardown.failures.push(`${name}: ${error.message}`); } }
        for (let i = 0; i < 100 && tagged().length; i++) await sleep(100);
        result.teardown.strays = tagged();
        assert.deepEqual(result.teardown, { strays: [], failures: [] }, 'owned lab cleanup failed');
    }
}
await run().then(() => { result.pass = true; }, error => { result.pass = false; result.error = String(error); process.exitCode = 1; });
writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log('ROAM-RESULT ' + JSON.stringify(result));
