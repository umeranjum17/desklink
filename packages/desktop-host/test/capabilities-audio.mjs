#!/usr/bin/env node
/**
 * `capture.audio` is a live machine fact, not a build flag.
 *
 * This flow proves the audio half of `capabilities` against two real,
 * task-owned audio servers: one whose sink exposes monitor ports, one with no
 * sink at all — same build, same command, opposite answer. It also proves the
 * answer costs nothing: no capture stream appears on the server, and the probe
 * reaches no session bus, so it cannot have prompted anyone. The private server
 * is the isolation boundary (`PIPEWIRE_RUNTIME_DIR`), so the person's PipeWire,
 * sinks and routing are never connected to, read or changed.
 *
 * Usage (from the repo root):
 *
 *   DESKLINK_ENGINE=packages/desktop-host/engine/target/debug/desklink-host \
 *     node packages/desktop-host/test/capabilities-audio.mjs
 *
 * A host with no pipewire daemon, no wireplumber or no stock config skips with
 * a printed reason, like `encoded-flow.mjs` does without Chrome.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stockConfig = '/usr/share/pipewire/pipewire.conf';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function which(name) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return found.status === 0 && found.stdout.trim() !== '' ? found.stdout.trim() : null;
}
/** The lab cannot run on this host; nothing about the engine is in question. */
class Skipped extends Error {}
function skip(reason) {
    console.log(`SKIP: ${reason}`);
    process.exit(0);
}

const engine =
    [
        process.env.DESKLINK_ENGINE,
        process.env.MUXR_DESKLINK_ENGINE,
        process.env.DESKLINK_AXI_ENGINE,
        join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'),
    ].find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) ?? null;
const tools = { pipewire: which('pipewire'), wireplumber: which('wireplumber'), pwDump: which('pw-dump') };
if (engine === null) skip('no engine binary (set DESKLINK_ENGINE)');
if (Object.values(tools).some((tool) => tool === null)) {
    skip(`no private audio lab: ${Object.entries(tools).filter(([, path]) => path === null).map(([name]) => name).join(', ')} not installed`);
}
if (!existsSync(stockConfig)) skip(`no ${stockConfig} to build a private server from`);
// The lab runs without a session bus (a prompt would need one), and only
// WirePlumber 0.5's `policy` profile gives the private sink its port config
// that way. Without it the lab cannot build its fixture, and nothing about the
// engine is in question.
const wireplumberHelp = spawnSync(tools.wireplumber, ['--help'], { encoding: 'utf8' });
if (!`${wireplumberHelp.stdout ?? ''}${wireplumberHelp.stderr ?? ''}`.includes('--profile')) {
    const version = (spawnSync(tools.wireplumber, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').pop();
    skip(`the installed wireplumber (${version}) has no --profile option; the lab needs the 0.5 "policy" profile to configure its private sink`);
}

const lab = mkdtempSync(join(tmpdir(), 'desklink-audio-'));
const runtime = join(lab, 'run');
mkdirSync(runtime);
// The stock config plus one sink of this run's own, the same null-audio-sink
// factory a host with no audio hardware uses. Its monitor ports are the
// mechanism the engine's answer is about, not a fixture invented for the test.
writeFileSync(
    join(lab, 'pipewire.conf'),
    readFileSync(stockConfig, 'utf8') +
        `
context.objects = [
    {   factory = adapter
        args = {
            factory.name     = support.null-audio-sink
            node.name        = desklink-lab-sink
            node.description = "Desklink lab sink"
            media.class      = Audio/Sink
            audio.position   = [ FL FR ]
        }
    }
]
`,
);

// A session bus that is not there: a prompt would need one (the portal), and the
// answer must not. No display either: this flow is only about audio, so nothing
// here touches the person's desktop.
const env = {
    ...process.env,
    PIPEWIRE_RUNTIME_DIR: runtime,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(lab, 'absent-bus')}`,
};
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;

const started = [];
function start(name, command, args) {
    const child = spawn(command, args, {
        env,
        stdio: ['ignore', 'ignore', openSync(join(lab, `${name}.log`), 'a')],
    });
    started.push({ name, child });
}
const stop = (child) => child.exitCode === null && child.signalCode === null && child.kill('SIGTERM');
const alive = () => started.filter(({ child }) => child.exitCode === null && child.signalCode === null);

function serverObjects() {
    const dumped = spawnSync(tools.pwDump, [], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(dumped.status, 0, `pw-dump failed: ${dumped.stderr}`);
    return JSON.parse(dumped.stdout).map((object) => (object.info ?? {}).props ?? {});
}
/** `pw-dump` prints spa's `true`/`false` strings as JSON booleans. */
const flag = (value) => value === true || value === 'true';
const monitors = () =>
    serverObjects().filter((props) => flag(props['port.monitor']) && props['port.direction'] === 'out').length;
function capabilities() {
    const ran = spawnSync(engine, ['capabilities'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(ran.status, 0, `capabilities exited ${ran.status}: ${ran.stderr}`);
    return JSON.parse(ran.stdout).capture;
}
async function until(ready, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (ready()) return true;
        await sleep(200);
    }
    return false;
}

let failures = [];
let skipped = null;
try {
    start('pipewire', tools.pipewire, ['-c', join(lab, 'pipewire.conf')]);
    // The session manager connects on startup and gives up with no socket yet,
    // so it comes up after the daemon it serves.
    if (!(await until(() => existsSync(join(runtime, 'pipewire-0'))))) throw new Skipped('the private PipeWire daemon never created a socket');
    start('wireplumber', tools.wireplumber, ['--profile', 'policy']);
    // The session manager gives the sink its port config; until the monitor
    // ports exist there is nothing this flow can ask about.
    if (!(await until(() => monitors() >= 2))) {
        throw new Skipped(`the private server produced no sink with monitor ports on this host: ${serverObjects().length} objects, daemons ${alive().map(({ name, child }) => `${name}=${child.pid}`).join(' ')}`);
    }

    // (a) A sink with monitor ports: this machine can capture the desktop's mix.
    const withSink = capabilities();
    assert.equal(withSink.audio, true, 'audio is true where a sink exposes monitor ports');
    assert.equal(withSink.audio_source, 'pipewire-monitor', 'the source names the mechanism');
    assert.deepEqual(withSink.audio_formats, ['s16le'], 'the format is the one the engine carries');
    // The answer cost nothing: no capture stream was opened to produce it.
    assert.deepEqual(
        serverObjects().filter((props) => flag(props['stream.capture.sink']) || props['media.class'] === 'Stream/Input/Audio'),
        [],
        'capabilities started no capture',
    );

    // (b) No server at all: the same binary, the same command, the honest false.
    for (const { child } of started) stop(child);
    assert.ok(await until(() => !existsSync(join(runtime, 'pipewire-0'))), 'the private server stopped listening');
    const withoutSink = capabilities();
    assert.equal(withoutSink.audio, false, 'audio is false where no audio server is reachable');
    assert.equal(withoutSink.audio_source, null, 'no source is named when there is none');
    assert.deepEqual(withoutSink.audio_formats, ['s16le'], 'the format describes the build, not the host');

    console.log('PASS: capture.audio true with a sink exposing monitor ports, false with no reachable server; no capture stream opened and no session bus needed');
    console.log(JSON.stringify({ withSink, withoutSink }));
} catch (error) {
    if (!(error instanceof Skipped)) failures.push(error);
    else {
        skipped = error.message;
        // The lab's own logs, so a skip on a machine we cannot see is diagnosable.
        for (const name of ['pipewire', 'wireplumber']) {
            const log = join(lab, `${name}.log`);
            if (existsSync(log)) console.log(`${name}: ${readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' | ')}`);
        }
    }
} finally {
    for (const { child } of started) stop(child);
    await sleep(300);
    for (const { name, child } of alive()) failures.push(new Error(`${name} (pid ${child.pid}) survived the run`));
    rmSync(lab, { recursive: true, force: true });
    if (existsSync(lab)) failures.push(new Error(`the lab directory ${lab} survived the run`));
}

if (skipped !== null && failures.length === 0) skip(skipped);
if (failures.length > 0) {
    for (const error of failures) console.error(error.stack ?? String(error));
    console.error('FAIL: the audio capability is not the machine fact it claims to be');
    process.exit(1);
}
