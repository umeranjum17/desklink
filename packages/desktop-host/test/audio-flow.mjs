// Linux/private digital audio only. Build host + engine, then:
// env -u DISPLAY -u WAYLAND_DISPLAY DESKLINK_ENGINE=<binary> node packages/desktop-host/test/audio-flow.mjs <fresh-output>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, readlinkSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineClient } from '../dist/engineProcess.js';
import { Bridge, BRIDGE_PATH } from '../dist/index.js';
import { WebSocket } from 'ws';
import { assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from './lab-safety.mjs';
assertNoAmbientDesktop();
assert.equal(process.platform, 'linux');
assert(process.argv[2], 'supply a fresh evidence directory');
const output = resolve(process.argv[2]), enginePath = resolve(process.env.DESKLINK_ENGINE ?? 'packages/desktop-host/engine/target/debug/desklink-host');
mkdirSync(output, { mode: 0o700 });
const lab = mkdtempSync('/tmp/dla-'), run = join(lab, 'run'), owned = [];
for (const dir of ['run', 'home', 'config', 'cache', 'state']) mkdirSync(join(lab, dir), { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: join(lab, 'home'), TMPDIR: lab,
    XDG_CONFIG_HOME: join(lab, 'config'), XDG_CACHE_HOME: join(lab, 'cache'), XDG_STATE_HOME: join(lab, 'state'),
    XDG_RUNTIME_DIR: run, PIPEWIRE_RUNTIME_DIR: run, PIPEWIRE_REMOTE: 'pipewire-0',
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${lab}/absent`, DISPLAY: '', WAYLAND_DISPLAY: '',
    DESKLINK_H264_ENCODER: 'off', DESKLINK_OPENH264: 'off', DESKLINK_AXI_ENGINE_PID_FILE: join(output, 'engine.pid') };
const save = (name, value) => writeFileSync(join(output, `${name}.json`), JSON.stringify(value, null, 2));
async function until(check, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await check()) return; await sleep(30); }
    throw Error(`deadline: ${label}`);
}
function identity(pid) {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
function hostIdentity() {
    return { processes: readdirSync('/proc').filter(p => /^\d+$/.test(p)).flatMap(pid => {
        try {
            const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
            return ['pipewire', 'wireplumber', 'pipewire-pulse'].includes(name) ? [{ pid, name, started: identity(pid)?.[19] }] : [];
        } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
    }), sockets: readFileSync('/proc/net/unix', 'utf8').split('\n').filter(l => /\/pipewire-\d+$/.test(l)).sort() };
}
let pw, xvfb, display, engine, bridge, socket;
function proveSocket() {
    assert.equal(Number(identity(pw.pid)?.[1]), process.pid);
    assert(lstatSync(join(run, 'pipewire-0')).isSocket());
    const fds = readdirSync(`/proc/${pw.pid}/fd`).map(fd => readlinkSync(`/proc/${pw.pid}/fd/${fd}`));
    assert(readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => {
        const f = line.trim().split(/\s+/);
        return f[7] === join(run, 'pipewire-0') && (parseInt(f[3], 16) & 0x10000) && fds.includes(`socket:[${f[6]}]`);
    }), 'private listener must belong to our PipeWire child');
}
function start(name, command, args) {
    if (['wireplumber', 'pw-play'].includes(command)) proveSocket();
    const fd = openSync(join(output, `${name}.log`), 'a');
    const child = spawn(command, args, { env, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    child.on('error', error => console.error(name, error));
    owned.push({ name, child });
    save('owned-pids', owned.map(({ name, child }) => ({ name, pid: child.pid })));
    return child;
}
function cmd(command, args) {
    if (command === 'pw-dump') proveSocket();
    const r = spawnSync(command, args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 8e6 });
    assert.equal(r.status, 0, `${command}: ${r.stderr || r.error}`);
    return r.stdout;
}
const dump = () => JSON.parse(cmd('pw-dump', []));
function wav() {
    const pcm = Buffer.alloc(48000 * 3 * 4);
    for (let i = 0; i < 144000; i++) {
        const hz = i < 48000 ? 1000 : i < 96000 ? 0 : 440;
        const value = Math.round(16383 * Math.sin(2 * Math.PI * hz * i / 48000));
        pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2);
    }
    const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24);
    h.writeUInt32LE(192000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    writeFileSync(join(output, 'fixture.wav'), Buffer.concat([h, pcm]));
}
function analyze(chunks, pcm, tone) {
    assert(chunks.length >= 10);
    for (const [i, c] of chunks.entries()) {
        assert(c.bytes > 0 && c.bytes <= 19200 && c.bytes % 4 === 0 && c.frames * 4 === c.bytes, 'whole-frame byte bound');
        assert.equal(c.format, 's16le');
        assert.equal(c.sample_rate, 48000);
        assert.equal(c.channels, 2);
        assert.equal(c.gap_ms, 0);
        if (i) {
            assert.equal(c.seq, chunks[i - 1].seq + 1);
            assert(c.timestamp_us > chunks[i - 1].timestamp_us, 'timestamp regression');
        }
    }
    assert.equal(pcm.length, chunks.reduce((sum, c) => sum + c.bytes, 0));
    const sampleSpanUs = (pcm.length / 4 - chunks.at(-1).frames) / 48000 * 1e6;
    const timestampSpanUs = chunks.at(-1).timestamp_us - chunks[0].timestamp_us;
    assert(Math.abs(timestampSpanUs - sampleSpanUs) <= 30000, 'sample-duration/engine-clock span (30ms)');
    const samples = Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readInt16LE(i * 4));
    for (let i = 0; i < samples.length; i++) assert.equal(pcm.readInt16LE(i * 4 + 2), samples[i], 'stereo fixture channels');
    const rms = values => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
    if (!tone) { assert(rms(samples) < 10, 'no-play silence RMS'); return { rms: rms(samples), timestampSpanUs, sampleSpanUs }; }
    const onset = samples.findIndex(x => Math.abs(x) > 500), end = samples.findLastIndex(x => Math.abs(x) > 500);
    assert(onset >= 0, 'tone windows must not be silence');
    assert(Math.abs(end - onset + 1 - 144000) <= 4800, '3s waveform sample count (one chunk tolerance)');
    const windows = [0, 1, 2].map(second => {
        const values = samples.slice(onset + second * 48000 + 9600, onset + second * 48000 + 38400);
        assert.equal(values.length, 28800);
        const crossings = values.filter((x, i) => i && x > 0 && values[i - 1] <= 0).length;
        return { rms: rms(values), hz: crossings / (values.length / 48000) };
    });
    assert(windows[0].rms > 10000 && windows[2].rms > 10000, 'tone windows must not be silence');
    assert(windows[1].rms < 10, 'middle silence RMS');
    assert(Math.abs(windows[0].hz - 1000) < 5 && Math.abs(windows[2].hz - 440) < 5, 'wrong tone frequency');
    return { windows, onset, end, sampleSpanUs, timestampSpanUs };
}
const before = hostIdentity(); save('host-identity-before', before);
try {
    writeFileSync(join(output, 'pipewire.conf'), readFileSync('/usr/share/pipewire/pipewire.conf', 'utf8') + `\ncontext.objects = [ { factory = adapter args = {
        factory.name = support.null-audio-sink node.name = desklink-lab-sink
        media.class = Audio/Sink audio.position = [ FL FR ] } } ]\n`);
    pw = start('pipewire', 'pipewire', ['-c', join(output, 'pipewire.conf')]);
    await until(() => existsSync(join(run, 'pipewire-0')), 'private socket'); proveSocket();
    start('wireplumber', 'wireplumber', ['--profile', 'policy']);
    await until(() => dump().filter(o => o.info?.props?.['port.monitor'] === true).length >= 2, 'private policy monitor ports');
    save('private-before', dump());
    display = claimPrivateDisplay();
    env.XAUTHORITY = join(lab, 'xauth'); writeFileSync(env.XAUTHORITY, '');
    cmd('xauth', ['-f', env.XAUTHORITY, 'add', display.display, '.', randomBytes(16).toString('hex')]);
    xvfb = start('xvfb', 'Xvfb', [display.display, '-screen', '0', '320x240x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY]);
    trackOwnedXvfb(xvfb, display.display); await verifyOwnedXvfb(xvfb); env.DISPLAY = display.display;
    proveSocket();
    engine = await EngineClient.start(enginePath, ['serve'], { onDiagnostic: console.log }, env);
    const source = { kind: 'x11', display: display.display };
    const opened = await engine.openSession({ source, audio: true, maxFps: 10 });
    assert.deepEqual(opened.audio, { source: 'pipewire-monitor', format: 's16le', sample_rate: 48000, channels: 2 });
    if (process.env.DESKLINK_AUDIO_CONTROLLED_ERROR === '1') throw Error('controlled-error after real session open');
    async function nextAudio(params) {
        let result;
        await until(async () => {
            try { result = await engine.request('session.audio', { session_id: opened.sessionId, ...params }); return true; }
            catch (error) { if (error.code !== 'audio' || !error.message.includes('no audio chunk')) throw error; return false; }
        }, 'session.audio');
        return result;
    }
    async function capture(label, count) {
        const chunks = [], buffers = [];
        while (chunks.length < count) {
            const path = join(output, `${label}-${chunks.length}.pcm`), meta = await nextAudio({ path, max_bytes: 19200 });
            const bytes = readFileSync(path); assert.equal(bytes.length, meta.bytes);
            chunks.push(meta); buffers.push(bytes);
        }
        save(`${label}-chunks`, chunks);
        return { chunks, pcm: Buffer.concat(buffers) };
    }
    const negative = await capture('no-play', 10);
    const noPlay = analyze(negative.chunks, negative.pcm, false);
    const graph = dump(), node = graph.find(o => o.info?.props?.['stream.capture.sink']);
    const format = node.info.params.Format[0];
    assert.equal(format.format, 'S16LE'); assert.equal(format.rate, 48000); assert.equal(format.channels, 2);
    const sink = graph.find(o => o.info?.props?.['node.name'] === 'desklink-lab-sink');
    assert.equal(graph.filter(o => o.info?.props?.['media.class'] === 'Audio/Sink').length, 1);
    const links = graph.filter(o => o.info?.['output-node-id'] === sink.id && o.info?.['input-node-id'] === node.id);
    assert.equal(links.length, 2);
    for (const link of links) {
        assert.equal(link.info.state, 'active');
        assert.equal(graph.find(o => o.id === link.info['output-port-id']).info.props['port.monitor'], true);
    }
    save('private-capture', graph);
    wav(); const player = start('play', 'pw-play', ['--target', 'desklink-lab-sink', join(output, 'fixture.wav')]);
    const positive = await capture('positive', 38), signal = analyze(positive.chunks, positive.pcm, true);
    assert.equal(positive.chunks[0].seq, negative.chunks.at(-1).seq + 1);
    assert(positive.chunks[0].timestamp_us > negative.chunks.at(-1).timestamp_us);
    await until(() => player.exitCode !== null || player.signalCode !== null, 'digital playback finished'); assert.equal(player.exitCode, 0);
    // Analyzer controls mutate captured data ONLY; they are not transport proof.
    assert.throws(() => analyze(positive.chunks, Buffer.alloc(positive.pcm.length), true), /tone windows/);
    const wrong = Buffer.from(positive.pcm);
    for (let i = signal.onset; i < signal.onset + 48000; i++) {
        const value = Math.round(16383 * Math.sin(2 * Math.PI * 700 * i / 48000));
        wrong.writeInt16LE(value, i * 4); wrong.writeInt16LE(value, i * 4 + 2);
    }
    assert.throws(() => analyze(positive.chunks, wrong, true), /wrong tone frequency/);
    const regressed = structuredClone(positive.chunks); regressed[1].timestamp_us = regressed[0].timestamp_us - 1;
    assert.throws(() => analyze(regressed, positive.pcm, true), /timestamp regression/);
    const events = engine.drainEvents(opened.sessionId), audio = events.filter(e => e.event === 'session.audio.changed');
    const video = events.filter(e => e.event === 'session.frame.changed');
    assert(audio.length && video.length);
    const avDeltaUs = Math.abs(audio[0].params.timestamp_us - video[0].params.timestamp_us);
    assert(avDeltaUs <= 200000, 'first A/V engine-clock bound (200ms)');
    for (const c of positive.chunks) assert(audio.some(e => e.params.seq === c.seq && e.params.timestamp_us === c.timestamp_us));
    const metrics = await engine.metrics(); assert.equal(metrics.audio_dropped_bytes, 0); assert(metrics.audio_bytes > 0);
    await assert.rejects(engine.request('session.audio', { session_id: opened.sessionId, max_bytes: 0 }), { code: 'malformed' });
    const boundedPath = join(output, 'bounded.pcm'), bounded = await nextAudio({ path: boundedPath, max_bytes: 7 });
    assert.equal(bounded.bytes, 4); assert.equal(bounded.frames, 1); assert.equal(readFileSync(boundedPath).length, 4);
    const metadata = await nextAudio({});
    assert.equal(metadata.written, false); assert.equal(metadata.bytes, 0); assert.equal(metadata.frames, 0);
    await assert.rejects(nextAudio({ path: join(output, 'absent', 'audio.pcm') }), { code: 'audio' });
    save('result', { opened, signal, noPlay, avDeltaUs, format, links, bounded, metadata, metrics, events,
        analyzerControls: ['silence-in-tone', '700Hz-in-1kHz-window', 'timestamp-regression'], enginePath,
        command: process.argv, node: process.version, sourceCommit: cmd('git', ['rev-parse', 'HEAD']).trim(),
        flowSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
        engineSha256: createHash('sha256').update(readFileSync(enginePath)).digest('hex') });
    await engine.closeSession(opened.sessionId);
    await until(() => !dump().some(o => o.info?.props?.['stream.capture.sink']), 'session close removes capture');
    save('private-after-close', dump());
    const videoOnly = await engine.openSession({ source, maxFps: 10 });
    await assert.rejects(engine.request('session.audio', { session_id: videoOnly.sessionId }), { code: 'operation' });
    await assert.rejects(engine.openSession({ source: { kind: 'encoded', codec: 'h264', width: 320, height: 240 }, audio: true }), { code: 'operation' });
    await engine.stop(); engine = undefined;
    const localEvents = [], remoteEvents = [], replies = new Map(), saved = process.env;
    proveSocket(); process.env = env;
    try {
        bridge = await Bridge.start({
            engineCommand: enginePath, engineArgs: ['serve'], listen: '127.0.0.1:0', token: 'private-lab', source,
            engineOptions: { onEvent: e => localEvents.push(e) },
        });
    } finally { process.env = saved; }
    socket = new WebSocket(`ws://127.0.0.1:${bridge.port}${BRIDGE_PATH}?token=private-lab`);
    socket.on('message', line => { const v = JSON.parse(String(line)); if (v.event) remoteEvents.push(v); else replies.set(v.id, v); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    async function remote(id, method, params = {}) {
        socket.send(JSON.stringify({ id, method, params }));
        await until(() => replies.has(id), method); return replies.get(id);
    }
    assert((await remote(1, 'session.open', { audio: true })).result?.audio);
    const remotePath = join(output, 'forbidden.pcm'), denied = await remote(2, 'session.audio', { path: remotePath });
    assert.equal(denied.error?.code, 'operation'); assert(!existsSync(remotePath));
    await until(() => localEvents.filter(e => e.event === 'session.audio.changed').length >= 5, 'host audio notifications');
    assert((await remote(3, 'session.metrics')).result); // ordered protocol round trip after the observation interval
    assert(!remoteEvents.some(e => e.event === 'session.audio.changed'));
    save('bridge-boundary', { denied, localEvents, remoteEvents });
    socket.terminate(); socket = undefined; await bridge.close(); bridge = undefined;
    pw.kill('SIGTERM'); await until(() => pw.exitCode !== null || pw.signalCode !== null, 'private server exited');
    assert(!existsSync(join(run, 'pipewire-0')));
    engine = await EngineClient.start(enginePath, ['serve'], {}, env);
    await assert.rejects(engine.openSession({ source, audio: true }), { code: 'audio-unavailable' });
    save('refusals', ['malformed-zero-bound', 'audio-failed-write', 'operation-video-only', 'operation-encoded', 'audio-unavailable-private-server']);
    console.log('PASS: real positive/no-play, format/monitor links, clock/sample bounds, analyzer controls, local/remote refusals');
} finally {
    const errors = [];
    async function clean(action) { try { await action(); } catch (error) { errors.push(String(error)); } }
    socket?.terminate();
    if (bridge) await clean(() => bridge.close());
    if (engine) await clean(() => engine.stop());
    for (const { child } of owned.toReversed()) await clean(async () => {
        if (child === xvfb) await stopOwnedXvfb(child);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await until(() => child.exitCode !== null || child.signalCode !== null, 'owned child reaped');
        assert(!identity(child.pid), 'owned process survived');
    });
    display?.release();
    const enginePids = existsSync(env.DESKLINK_AXI_ENGINE_PID_FILE) ? readFileSync(env.DESKLINK_AXI_ENGINE_PID_FILE, 'utf8').trim().split(/\s+/) : [];
    await clean(() => { for (const pid of enginePids) assert(!identity(pid), 'engine survived'); });
    await clean(() => {
        assert(!readdirSync(run).some(name => lstatSync(join(run, name)).isSocket()), 'private socket survived');
        if (display) assert(!existsSync(`/tmp/.X11-unix/X${display.number}`), 'owned X socket survived');
        const sockets = readFileSync('/proc/net/unix', 'utf8').split('\n');
        assert(!sockets.some(line => line.includes(`${run}/`)), 'owned audio socket identity survived');
        if (display) assert(!sockets.some(line => line.endsWith(`/tmp/.X11-unix/X${display.number}`)), 'owned X socket identity survived');
    });
    const after = hostIdentity(); save('host-identity-after', after);
    await clean(() => assert.deepEqual(after, before, 'host identity only; NOT a live routing assertion'));
    rmSync(lab, { recursive: true }); assert(!existsSync(lab));
    save('teardown', { errors, ownedPids: owned.map(o => o.child.pid), enginePids, labRemoved: !existsSync(lab) });
    assert.deepEqual(errors, [], 'owned teardown');
    console.log('TEARDOWN PASS: zero surviving owned processes/sockets; host identity only (no live routing claim)');
}
if (process.env.DESKLINK_AUDIO_CONTROLLED_ERROR !== '1') {
    const control = spawnSync(process.execPath, [fileURLToPath(import.meta.url), join(output, 'controlled-error')], {
        env: { ...process.env, DESKLINK_AUDIO_CONTROLLED_ERROR: '1' }, encoding: 'utf8', timeout: 30000,
    });
    writeFileSync(join(output, 'controlled-error.log'), `${control.stdout}\n${control.stderr}`);
    assert.equal(control.status, 1, `controlled-error process: ${control.error ?? control.stderr}`);
    assert.match(control.stderr, /controlled-error after real session open/);
    const teardown = JSON.parse(readFileSync(join(output, 'controlled-error/teardown.json')));
    assert.deepEqual(teardown.errors, []); assert.equal(teardown.labRemoved, true);
    console.log('PASS: controlled-error teardown after real engine audio open');
}
