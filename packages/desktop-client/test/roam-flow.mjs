// P0a RED baseline: userspace-shaped media + signaling outage on an owned Xvfb.
// Build the engine/fixture, then run with DISPLAY and WAYLAND_DISPLAY unset:
// node packages/desktop-client/test/roam-flow.mjs <fresh-evidence-dir> --outage 12000
// P0b: --path new-address --driver-restart uses a TEST-ONLY retention shim.
// P1: --product-retention disables that shim and checks real bridge retention.
// Record the standalone 20s roam's actual outcome against the unchanged 2s bar.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const driverRestart = args.includes('--driver-restart');
const productRetention = args.includes('--product-retention');
assert(['same-address', 'new-address'].includes(pathMode), 'unknown --path');
assert(!driverRestart || scenario === 'roam', '--driver-restart requires roam');
assert(Number.isInteger(outage) && outage >= 1000 && outage <= 60000, '--outage must be 1000..60000 ms');
assert(['roam', 'abandon', 'close-in-window'].includes(scenario), 'unknown --scenario');
assert(args[0] && !args[0].startsWith('--'), 'supply a fresh evidence directory first');
const evidence = resolve(args[0]);
assert(!existsSync(evidence), 'refusing to overwrite evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const tap = (direction, message) => {
    const row = { at: Date.now(), direction, ...message };
    appendFileSync(join(evidence, 'stdio.jsonl'), JSON.stringify(row) + '\n');
    return row;
};
const result = { scenario, outage, pathMode, driverRestart, productRetention, head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim(),
    shape: 'userspace-shaped link; no netem, privileges or firewall changes', tap: [], teardown: { strays: [], failures: [] } };
const tag = `DESKLINK_ROAM=${process.pid}`;
const tagged = () => readdirSync('/proc').flatMap(name => {
    try { return Number(name) !== process.pid && readFileSync(`/proc/${name}/environ`).toString().split('\0').includes(tag) ? [Number(name)] : []; }
    catch { return []; }
});
const driver = (port, token) => `
const probe = window.__probe = { sessionId: null, peerId: 1, iceGeneration: 0, answerAt: null, errors: [] };
window.addEventListener('unhandledrejection', e => probe.errors.push(String(e.reason)));
const peer = new RTCPeerConnection({ iceServers: [] });
let socket;
const pending = new Map(); let seq = 0, inputSeq = 0, channel;
const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const candidates = [];
peer.onicecandidate = e => { if (e.candidate) candidates.push(e.candidate.toJSON()); void flush(); };
async function flush() {
    if (!probe.sessionId) return;
    for (const c of candidates.splice(0)) await request('session.candidate', { session_id: probe.sessionId, candidate: c.candidate, sdp_mid: c.sdpMid, sdp_m_line_index: c.sdpMLineIndex });
}
peer.ontrack = e => { const video = document.querySelector('video'); video.srcObject = new MediaStream([e.track]); void video.play(); };
peer.ondatachannel = e => { channel = e.channel; channel.onmessage = () => {}; };
function connect(restart = false) {
socket = new WebSocket('ws://127.0.0.1:${port}/desktop?token=${token}');
socket.onclose = () => { for (const p of pending.values()) p.reject(new Error('bridge closed')); pending.clear(); };
socket.onmessage = async e => {
    const m = JSON.parse(e.data), p = m.params ?? {};
    if (m.id !== undefined) { const w = pending.get(m.id); pending.delete(m.id); if (m.error) w?.reject(new Error(m.error.message)); else w?.resolve(m.result); return; }
    if (m.event === 'session.description') {
        probe.iceGeneration++;
        await peer.setRemoteDescription(p.description);
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        await request('session.description', { session_id: p.sessionId, generation: p.generation, description: answer });
        probe.answerAt = Date.now();
    }
    if (m.event === 'session.candidate') await peer.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex });
};
socket.onopen = async () => {
    if (restart) { await request('session.restart_ice', { session_id: probe.sessionId, generation: 1 }); return; }
    const opened = await request('session.open', { max_width: 1280, max_height: 720, max_fps: 30 }); probe.sessionId = opened.sessionId; await flush();
};
}
connect();
window.__restart = () => connect(true);
const send = message => channel.send(JSON.stringify({ ...message, seq: ++inputSeq }));
window.__hold = () => { send({ kind: 'pointer', phase: 'down', x: 320, y: 180, button: 1 }); send({ kind: 'key', character: 'a', down: true }); };
window.__release = () => send({ kind: 'release_all' });
window.__measure = async () => {
    const stats = await peer.getStats(); const frames = {};
    stats.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') frames[row.id] = row.framesDecoded ?? 0; });
    const transport = [...stats.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId);
    const pair = stats.get(transport?.selectedCandidatePairId);
    const remote = stats.get(pair?.remoteCandidateId);
    return { at: Date.now(), sessionId: probe.sessionId, peerId: probe.peerId, iceGeneration: probe.iceGeneration, answerAt: probe.answerAt,
        pair: pair && { id: pair.id, state: pair.state, remotePort: remote?.port }, frames, channel: channel?.readyState, errors: probe.errors };
};
`;

async function run() {
    const targetDir = process.env.CARGO_TARGET_DIR ?? join(process.env.HOME, '.cache/dl-roam-persistence-target');
    const engine = process.env.DESKLINK_AXI_ENGINE ?? join(targetDir, 'debug/desklink-host');
    const fixture = process.env.DESKLINK_VERIFY_TARGET ?? join(targetDir, 'debug/examples/x11_target');
    assert(existsSync(engine) && existsSync(fixture), 'build task-owned desklink-host and x11_target first');
    const scratch = mkdtempSync(join(tmpdir(), 'dl-roam-'));
    let claim, xvfb, target, bridge, signalling, relay, vite, context;
    let fixtureLog = '', fixtureBuffer = '', refused = 0, blocked = false;
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
                if (['session.close', 'session.restart_ice', 'session.description'].includes(message.method)) result.tap.push(tap('bridge->engine', message));
            }
            return write(...values);
        };
        let buffered = '';
        child.stdout.on('data', chunk => {
            buffered += chunk;
            const lines = buffered.split('\n'); buffered = lines.pop();
            for (const line of lines) {
                const message = JSON.parse(line);
                if (['session.revoked', 'session.state'].includes(message.event)) result.tap.push(tap('engine->bridge', message));
            }
        });
        signalling = await startSignalling(link, bridge.port, token, { relayOnly: driverRestart });
        relay = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: () => { if (blocked) refused++; return !blocked; } });
        relay.on('connection', client => {
            const host = new WebSocket(`ws://127.0.0.1:${signalling.port}/desktop?token=${token}`);
            upstreams.add(host);
            const queue = [];
            host.on('open', () => { for (const raw of queue) host.send(raw); });
            client.on('message', raw => host.readyState === WebSocket.OPEN ? host.send(raw) : queue.push(raw));
            host.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(String(raw)); });
            host.on('close', () => { upstreams.delete(host); client.terminate(); });
            host.on('error', error => { tap('relay-error', { message: error.message }); client.terminate(); });
            client.on('close', () => host.close());
        });
        await new Promise(resolve => relay.once('listening', resolve));
        writeFileSync(join(scratch, 'index.html'), '<video autoplay muted style="width:100%;height:100vh"></video><script type="module" src="/driver.js"></script>');
        writeFileSync(join(scratch, 'driver.js'), driver(relay.address().port, token));
        const { createServer } = await import('vite');
        vite = await createServer({ root: scratch, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
        await vite.listen();
        const { chromium } = await import('playwright-core');
        // Chromium keeps the real runtime dir; only its profile is isolated.
        context = await chromium.launchPersistentContext(join(scratch, 'profile'), { executablePath: process.env.DESKLINK_CHROME ?? '/usr/bin/chromium', headless: true,
            env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }, viewport: { width: 1280, height: 720 },
            args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
        const page = context.pages()[0];
        await page.goto(vite.resolvedUrls.local[0]);
        const measure = () => page.evaluate(() => window.__measure());
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
        result.cutAt = Date.now(); blocked = true;
        if (!productRetention || scenario === 'roam') link.set({ discard: true }, 'roam cut');
        for (const client of relay.clients) client.terminate();
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
        }
        const held = result.before;
        let last = result.atPathBack, recovered = null;
        let reset = last !== null && (last.sessionId !== held.sessionId || last.peerId !== held.peerId
            || Object.keys(held.frames).some(id => !(id in last.frames) || last.frames[id] < held.frames[id]));
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
        if (driverRestart) {
            result.beforeRestart = await measure();
            if (pathMode === 'new-address') {
                assert.equal(recovered, null, 'old tuple healed before restart');
                assert.deepEqual(result.beforeRestart.frames, result.atPathBack.frames, 'frames before restart on retired tuple');
            }
            result.restartAt = Date.now();
            await page.evaluate(() => window.__restart());
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
            assert.equal(result.afterRestart.sessionId, held.sessionId);
            assert.equal(result.afterRestart.peerId, held.peerId);
            assert.deepEqual(result.afterRestart.errors, []);
            await page.screenshot({ path: join(evidence, 'restart.png') });
        }
        if (productRetention && scenario === 'roam') {
            assert.equal(result.atPathBack.sessionId, held.sessionId, 'session id changed during outage');
            assert(!result.tap.some(e => e.direction === 'bridge->engine' && e.method === 'session.close'), 'bridge closed session inside retention window');
            assert(!result.tap.some(e => e.event === 'session.revoked'), 'engine ended retained session');
        }
        result.closeMs = result.tap.find(e => e.direction === 'bridge->engine' && e.method === 'session.close' && e.params.session_id === held.sessionId)?.at - result.cutAt;
        await wait(() => {
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
        assert(result.buttonUps > 0 && result.keyUps >= result.keyDowns, 'held input was not released');
        assert(driverRestart || scenario !== 'roam' || recovered !== null, 'RED: pre-cut peer/session did not resume decoded video within 2s of path-back');
    } finally {
        writeFileSync(join(evidence, 'fixture-events.jsonl'), fixtureLog);
        writeFileSync(join(evidence, 'fixture-observed.json'), JSON.stringify(observedFixture, null, 2));
        for (const [name, cleanup] of [
            ['browser', () => context?.close()],
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
