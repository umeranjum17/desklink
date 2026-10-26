// `desklink-host doctor` on a private Xvfb: a healthy machine reports every
// requirement PASS or N/A, and a hidden engine fails with text and a fix a
// person can act on. No session is started and no portal is contacted.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from './lab-safety.mjs';

assertNoAmbientDesktop();
assert.equal(process.platform, 'linux', 'owned-Xvfb doctor proof requires Linux');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(repo, 'packages/desktop-host/bin/desklink-host.mjs');
const built = join(repo, 'packages/desktop-host/dist/doctor.js');

function which(name) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return found.status === 0 && found.stdout.trim() !== '' ? found.stdout.trim() : null;
}

const engine = [
    process.env.DESKLINK_ENGINE,
    process.env.MUXR_DESKLINK_ENGINE,
    join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'),
].find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) ?? null;

if (engine === null) {
    console.log('SKIP: no engine binary (set DESKLINK_ENGINE)');
    process.exit(0);
}
if (!existsSync(built)) {
    console.log('SKIP: dist/doctor.js is not built; run npm run build');
    process.exit(0);
}
if (which('Xvfb') === null || which('xauth') === null) {
    console.log('SKIP: no private X lab (Xvfb and xauth are required)');
    process.exit(0);
}

const packageVersion = JSON.parse(readFileSync(join(repo, 'packages/desktop-host/package.json'), 'utf8')).version;
const dir = mkdtempSync(join(tmpdir(), 'desklink-doctor-'));
const home = join(dir, 'home'), cache = join(dir, 'cache'), runtime = join(dir, 'runtime');
mkdirSync(home, { recursive: true });
mkdirSync(cache, { recursive: true });
mkdirSync(runtime, { recursive: true });
const authority = join(dir, 'Xauthority');
const claim = claimPrivateDisplay({ from: 170, count: 30 });
const display = claim.display;
let xvfb = null;

function isolatedEnv(extra = {}) {
    const env = { ...process.env };
    // Nothing from the person's session may answer a check.
    for (const name of ['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DESKLINK_H264_ENCODER', 'DESKLINK_OPENH264', 'MUXR_DESKLINK_ENGINE']) delete env[name];
    return {
        ...env,
        HOME: home,
        XDG_CACHE_HOME: cache,
        XDG_RUNTIME_DIR: runtime,
        TMPDIR: dir,
        DISPLAY: display,
        XAUTHORITY: authority,
        ...extra,
    };
}

function doctor(extra = {}) {
    const result = spawnSync(process.execPath, [cli, 'doctor'], {
        encoding: 'utf8',
        timeout: 90_000,
        env: isolatedEnv(extra),
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkLines(text) {
    return text.split('\n').filter((line) => /^(PASS|FAIL|N\/A)\s/.test(line));
}

try {
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
    xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    trackOwnedXvfb(xvfb, display);
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(50);
    await verifyOwnedXvfb(xvfb);

    const healthy = doctor({ DESKLINK_ENGINE: engine });
    assert.equal(healthy.code, 0, `healthy doctor failed:\n${healthy.stdout}\n${healthy.stderr}`);
    const lines = checkLines(healthy.stdout);
    assert.equal(lines.length, 7, `expected seven requirement lines:\n${healthy.stdout}`);
    assert.match(healthy.stdout, /^PASS  engine\b/m);
    assert.match(healthy.stdout, /^PASS  node\b/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  x11\\s+${display} 1280x720, XShm \\+ XDamage$`, 'm'));
    assert.match(healthy.stdout, /^N\/A   wayland\b/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  input\\s+XTest on ${display}$`, 'm'));
    assert.match(healthy.stdout, /^PASS  encoder\b/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  versions\\s+@desklink/host ${packageVersion.replace(/\./g, '\\.')} · engine \\d+\\.\\d+\\.\\d+$`, 'm'));

    // The engine is the requirement a hidden binary breaks first; its line must
    // carry the resolver's own explanation and an install command for both
    // distributions named in the brief.
    const broken = doctor({ DESKLINK_ENGINE: join(dir, 'hidden', 'desklink-host') });
    assert.equal(broken.code, 1, `hidden engine should fail:\n${broken.stdout}`);
    assert.match(broken.stdout, /^FAIL {2}engine\s+The desktop engine is not at the configured path \(.+hidden\/desklink-host\)\.$/m);
    assert.match(broken.stdout, /fix\s+Debian\/Ubuntu: `npm install @desklink\/host-linux-x64-gnu`.*Fedora:/m);
    assert.match(broken.stdout, /^FAIL {2}versions\s+@desklink\/host .+ engine version unavailable/m);

    // The Wayland branch is a separate set of checks: with a session name but
    // no portal or PipeWire, both the capture and input lines must fail and
    // name the portal package for both distributions.
    const noPortal = doctor({ DESKLINK_ENGINE: engine, DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' });
    assert.equal(noPortal.code, 1, `missing portal should fail:\n${noPortal.stdout}`);
    assert.match(noPortal.stdout, /^N\/A {3}x11\b/m);
    assert.match(noPortal.stdout, /^FAIL {2}wayland\s+missing xdg-desktop-portal ScreenCast/m);
    assert.match(noPortal.stdout, /^FAIL {2}input\s+missing portal RemoteDesktop/m);
    assert.match(noPortal.stdout, /fix\s+Debian\/Ubuntu: `sudo apt install .*xdg-desktop-portal.*`.*Fedora: `sudo dnf install .*xdg-desktop-portal/m);

    console.log(JSON.stringify({
        doctor: 'passed',
        display,
        healthy: lines,
        hidden_engine: checkLines(broken.stdout),
        no_portal: checkLines(noPortal.stdout),
    }, null, 2));
} finally {
    if (xvfb !== null) await stopOwnedXvfb(xvfb);
    claim.release();
    rmSync(dir, { recursive: true, force: true });
}
