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
console.log('PASS: opt-in, real .exe resolution, CLI version spawn, native capabilities, EngineClient spawn failure, and CLI missing-path reporting.');
console.log('PENDING lane 2: full serve hello handshake; this proof does not claim session transport or desktop qualification.');
