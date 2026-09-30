// Hosted Windows proof against the real compile-seam executable. No desktop access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { EngineClient } from '../dist/engineProcess.js';
import { resolveEngine, explainMissingEngine, platformTag } from '../dist/resolveEngine.js';

assert.equal(process.platform, 'win32', 'run this proof on Windows');
const binary = process.env.DESKLINK_ENGINE;
assert.ok(binary, 'DESKLINK_ENGINE must name the compiled Windows engine');
const cli = resolve('packages/desktop-host/bin/desklink-host.mjs');
delete process.env.DESKLINK_WINDOWS;
assert.equal(resolveEngine(), null);
assert.match(explainMissingEngine(), /DESKLINK_WINDOWS=1/);
const disabled = spawnSync(process.execPath, [cli, 'path'], { encoding: 'utf8', windowsHide: true });
assert.equal(disabled.status, 1);
assert.match(disabled.stderr, /DESKLINK_WINDOWS=1/);
process.env.DESKLINK_WINDOWS = '1';
assert.equal(platformTag(), 'win32-x64-msvc');
assert.deepEqual(resolveEngine(), { command: binary, args: ['serve'], origin: 'configured' });
const version = spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /^\d+\.\d+\.\d+/);
const capabilities = spawnSync(binary, ['capabilities'], { encoding: 'utf8', windowsHide: true });
assert.equal(capabilities.status, 0, capabilities.stderr);
const caps = JSON.parse(capabilities.stdout);
assert.equal(caps.platform, 'windows');
assert.equal(caps.protocol, 3);
await assert.rejects(EngineClient.start(`${binary}.absent.exe`, ['serve']), { code: 'engine-spawn-failed' });
const missingCliEngine = spawnSync(process.execPath, [cli, 'version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DESKLINK_ENGINE: `${binary}.absent.exe` },
});
assert.equal(missingCliEngine.status, 1);
assert.match(missingCliEngine.stderr, /The desktop engine is not at the configured path .*absent\.exe/i);
// Serve handshake through the published Node API: the resolver above names the
// command, EngineClient spawns it and completes hello, and capabilities runs
// over the real serve transport. No session is opened: hosted runners have no
// desktop to capture and no input to apply.
const resolved = resolveEngine();
assert.ok(resolved !== null, 'the opt-in engine resolves for the serve handshake');
let exitDetail = null;
const client = await EngineClient.start(resolved.command, resolved.args, {
    onExit: (detail) => { exitDetail = detail; },
});
const served = await client.capabilities();
assert.equal(served.platform, 'windows');
assert.equal(served.protocol, 3);
assert.ok(served.encode.codecs.includes('vp9'), 'the static-libvpx build serves VP9');
assert.deepEqual(served.encoded.codecs, ['h264']);
// The graceful stop: the engine exits 0 without answering, so the request
// itself is not the verdict; the observed exit detail is.
await client.request('shutdown', {}, 15_000).then(() => undefined, () => undefined);
const exitDeadline = Date.now() + 5_000;
while (exitDetail === null && Date.now() < exitDeadline) {
    await new Promise((done) => setTimeout(done, 50));
}
assert.deepEqual(exitDetail, { code: 0, signal: null });
await client.stop();
console.log('PASS: opt-in, real .exe resolution, CLI version spawn, native capabilities, EngineClient spawn failure, CLI missing-path reporting, and serve hello/capabilities with clean exit.');
