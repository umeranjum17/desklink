// Pre-cut release qualification: real control channel, decoded video, owned Xvfb.
// CARGO_TARGET_DIR=<task build> env -u DISPLAY -u WAYLAND_DISPLAY node
// packages/desktop-client/test/fixture-release-flow.mjs <fresh-evidence-dir>
// Browser operations use chrome-devtools-axi against this run's private Chromium.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShapedLink, startSignalling } from './shaped-link.mjs';
import { assertNoAmbientDesktop, claimPrivateDisplay, stopOwnedXvfb, trackOwnedXvfb, verifyOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert(process.argv[2], 'supply a fresh evidence directory');
const evidence = resolve(process.argv[2]);
assert(!existsSync(evidence), 'refusing to overwrite evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const build = process.env.CARGO_TARGET_DIR;
assert(build, 'set task-owned CARGO_TARGET_DIR');
const engine = join(build, 'debug/desklink-host'), fixture = join(build, 'debug/examples/x11_target');
assert(existsSync(engine) && existsSync(fixture), 'build engine and fixture first');
const scratchRoot = join(build, 'release-labs');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'run-'));
const result = { head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), teardown: [] };
const wait = async (check, ms, why) => {
    const end = Date.now() + ms;
    while (!await check()) { assert(Date.now() < end, `timeout: ${why}`); await sleep(25); }
};
const exec = promisify(execFile);
let claim, xvfb, target, bridge, signalling, vite, browser, axiEnv, fixtureLog = '', linkLog = '';
const rows = () => fixtureLog.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const axi = async (...args) => {
    const source = args[0] === 'run' ? args.pop() : '';
    const call = exec('chrome-devtools-axi', args, { env: axiEnv, timeout: 30000 });
    call.child.stdin.end(source);
    try { return (await call).stdout; }
    catch (error) { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`); }
};
// The run API prints our JSON directly, without parsing AXI's human CLI wrapper.
const evaluate = async expression => JSON.parse((await axi('run', `console.log(JSON.stringify(await page.eval(${JSON.stringify(expression)})));`)).trim());
const link = new ShapedLink((...items) => { linkLog += `${Date.now()} ${items.join(' ')}\n`; });
try {
    claim = claimPrivateDisplay({ from: 240, count: 30 });
    const authority = join(scratch, 'Xauthority');
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', claim.display, '.', randomBytes(16).toString('hex')]).status, 0);
    xvfb = spawn('Xvfb', [claim.display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    trackOwnedXvfb(xvfb, claim.display); await verifyOwnedXvfb(xvfb);
    const env = { ...process.env, DISPLAY: claim.display, WAYLAND_DISPLAY: '', XAUTHORITY: authority, XDG_SESSION_TYPE: 'x11', DESKLINK_OPENH264: 'off' };
    target = spawn(fixture, ['--animate'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [target.stdout, target.stderr]) stream.on('data', chunk => { fixtureLog += chunk; });
    await wait(() => rows().some(e => e.kind === 'ready'), 5000, 'fixture ready');
    Object.assign(process.env, env);
    const token = randomBytes(16).toString('hex');
    const { Bridge } = await import('../../desktop-host/dist/index.js');
    bridge = await Bridge.start({ listen: '127.0.0.1:0', token, engineCommand: engine, engineArgs: ['serve'], serveExample: false, source: { kind: 'x11', display: claim.display } });
    signalling = await startSignalling(link, bridge.port, token);
    writeFileSync(join(scratch, 'index.html'), '<video autoplay muted style="width:100%;height:90vh"></video><script type="module" src="/driver.js"></script>');
    writeFileSync(join(scratch, 'driver.js'), `
const peer = new RTCPeerConnection({ iceServers: [] });
const socket = new WebSocket('ws://127.0.0.1:${signalling.port}/desktop?token=${token}');
const probe = window.__probe = { replies: [], errors: [] };
window.addEventListener('unhandledrejection', e => probe.errors.push(String(e.reason)));
const pending = new Map(), candidates = []; let seq = 0, inputSeq = 0, sessionId, channel;
const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
async function flush() {
    if (!sessionId) return;
    for (const c of candidates.splice(0)) await request('session.candidate', { session_id: sessionId, candidate: c.candidate, sdp_mid: c.sdpMid, sdp_m_line_index: c.sdpMLineIndex });
}
peer.onicecandidate = e => { if (e.candidate) candidates.push(e.candidate.toJSON()); void flush(); };
peer.ontrack = e => { const video = document.querySelector('video'); video.srcObject = new MediaStream([e.track]); void video.play(); };
peer.ondatachannel = e => { channel = e.channel; channel.onmessage = e => probe.replies.push({ at: Date.now(), ...JSON.parse(e.data) }); };
socket.onmessage = async e => {
    const m = JSON.parse(e.data), p = m.params ?? {};
    if (m.id !== undefined) { const w = pending.get(m.id); pending.delete(m.id); if (m.error) w?.reject(new Error(m.error.message)); else w?.resolve(m.result); return; }
    if (m.event === 'session.description') {
        await peer.setRemoteDescription(p.description); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        await request('session.description', { session_id: p.sessionId, generation: p.generation, description: answer });
    }
    if (m.event === 'session.candidate') await peer.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex });
};
socket.onopen = async () => { sessionId = (await request('session.open', { max_width: 1280, max_height: 720, max_fps: 30 })).sessionId; await flush(); };
const send = message => { const seq = ++inputSeq; channel.send(JSON.stringify({ ...message, seq })); return seq; };
window.__hold = () => { send({ kind: 'pointer', phase: 'down', x: 320, y: 180, button: 1 }); return send({ kind: 'key', character: 'a', down: true }); };
window.__release = () => ({ at: Date.now(), seq: send({ kind: 'release_all' }) });
window.__measure = async () => {
    const frames = {}; (await peer.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') frames[r.id] = r.framesDecoded ?? 0; });
    return { at: Date.now(), frames, channel: channel?.readyState, ...probe };
};
`);
    const { createServer } = await import('vite');
    vite = await createServer({ root: scratch, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
    const profile = join(scratch, 'profile');
    browser = spawn(process.env.DESKLINK_CHROME ?? '/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }, stdio: 'ignore' });
    await wait(() => existsSync(join(profile, 'DevToolsActivePort')), 10000, 'private browser CDP');
    axiEnv = { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0', CHROME_DEVTOOLS_AXI_SESSION: `dl-fixture-${process.pid}`, CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]}` };
    await axi('open', vite.resolvedUrls.local[0]);
    const measure = () => evaluate('window.__measure()');
    await wait(async () => { const m = await measure(); return m.channel === 'open' && Object.values(m.frames).some(n => n > 5); }, 20000, 'live decoded video and control');
    await verifyOwnedXvfb(xvfb);
    await evaluate('window.__hold()');
    await wait(() => rows().some(e => e.kind === 'button' && e.phase === 'down') && rows().some(e => e.kind === 'key' && e.phase === 'down'), 2000, 'held input');
    await sleep(4000); // Sustained X autorepeat must not queue behind animation ticks.
    result.before = await measure();
    await axi('screenshot', join(evidence, 'before.png'));
    result.release = await evaluate('window.__release()');
    await wait(() => rows().some(e => e.kind === 'button' && e.phase === 'up'), Math.max(1, 2000 - (Date.now() - result.release.at)), 'button-up within 2s of release_all');
    result.buttonUpMs = Date.now() - result.release.at;
    assert(result.buttonUpMs <= 2000, `button-up took ${result.buttonUpMs}ms`);
    await wait(() => rows().filter(e => e.kind === 'key' && e.phase === 'up').length >= rows().filter(e => e.kind === 'key' && e.phase === 'down').length, 2000, 'final key release, not autorepeat');
    result.after = await measure();
    assert(result.after.replies.some(r => r.kind === 'ack' && r.seq === result.release.seq), 'release_all not acknowledged');
    assert.deepEqual(result.after.errors, []);
    assert(Object.keys(result.before.frames).some(id => result.after.frames[id] > result.before.frames[id]), 'decoded frames stopped');
    await axi('screenshot', join(evidence, 'after.png'));
    result.pass = true;
} catch (error) { result.pass = false; result.error = String(error); process.exitCode = 1; }
finally {
    for (const [name, cleanup] of [
        ['axi', () => axiEnv && axi('stop')],
        ['browser', async () => { if (browser?.exitCode === null && browser.signalCode === null) { browser.kill('SIGTERM'); await wait(() => browser.exitCode !== null || browser.signalCode !== null, 5000, 'browser exit'); } }],
        ['signalling', () => signalling?.close()], ['link', () => link.close()], ['vite', () => vite?.close()], ['bridge', () => bridge?.close()],
        ['fixture', async () => { if (target?.exitCode === null && target.signalCode === null) { target.kill('SIGTERM'); await wait(() => target.exitCode !== null || target.signalCode !== null, 3000, 'fixture exit'); } }],
        ['xvfb', () => xvfb && stopOwnedXvfb(xvfb)], ['claim', () => claim?.release()], ['scratch', () => rmSync(scratch, { recursive: true, force: true })],
    ]) { try { await cleanup(); } catch (error) { result.teardown.push(`${name}: ${error.message}`); } }
    if (result.teardown.length) { result.pass = false; process.exitCode = 1; }
    writeFileSync(join(evidence, 'fixture-events.jsonl'), fixtureLog);
    writeFileSync(join(evidence, 'link.log'), linkLog);
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log('FIXTURE-RELEASE ' + JSON.stringify(result));
}
