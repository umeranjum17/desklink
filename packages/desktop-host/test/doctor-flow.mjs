// `desklink-host doctor` on a private Xvfb: a healthy machine reports every
// requirement PASS or N/A, and a hidden engine fails with text and a fix a
// person can act on. No session is started and no portal is contacted.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function doctor(extra = {}, unset = []) {
    const env = isolatedEnv(extra);
    for (const name of unset) delete env[name];
    const result = spawnSync(process.execPath, [cli, 'doctor'], {
        encoding: 'utf8',
        timeout: 90_000,
        env,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkLines(text) {
    return text.split('\n').filter((line) => /^(PASS|FAIL|N\/A)\s/.test(line));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    assert.equal(lines.length, 8, `expected eight requirement lines:\n${healthy.stdout}`);
    assert.match(healthy.stdout, /^PASS  engine\b/m);
    assert.match(healthy.stdout, /^PASS  node\b/m);
    assert.match(healthy.stdout, /^PASS  libraries\s+the engine starts with this machine's system libraries$/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  x11\\s+${escapeRegExp(display)} 1280x720, XShm \\+ XDamage$`, 'm'));
    assert.match(healthy.stdout, /^N\/A   wayland\b/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  input\\s+XTest on ${escapeRegExp(display)}$`, 'm'));
    assert.match(healthy.stdout, /^PASS  encoder\b/m);
    assert.match(healthy.stdout, new RegExp(`^PASS  versions\\s+@desklink/host ${escapeRegExp(packageVersion)} · engine \\d+\\.\\d+\\.\\d+$`, 'm'));

    // The engine is the requirement a hidden binary breaks first; its line must
    // carry the resolver's own explanation and an install command for both
    // distributions named in the brief.
    const broken = doctor({ DESKLINK_ENGINE: join(dir, 'hidden', 'desklink-host') });
    assert.equal(broken.code, 1, `hidden engine should fail:\n${broken.stdout}`);
    assert.match(broken.stdout, /^FAIL {2}engine\s+The desktop engine is not at the configured path \(.+hidden\/desklink-host\)\.$/m);
    assert.match(broken.stdout, /fix\s+Debian\/Ubuntu: `npm install @desklink\/host-linux-x64-gnu`.*Fedora:/m);
    assert.match(broken.stdout, /^N\/A {3}libraries\s+needs an engine binary/m);
    assert.match(broken.stdout, /^FAIL {2}versions\s+@desklink\/host .+ engine version unavailable/m);

    // The Wayland branch is a separate set of checks: with a session name but
    // no portal or PipeWire, both the capture and input lines must fail and
    // name the portal package for both distributions.
    const noPortal = doctor({ DESKLINK_ENGINE: engine, DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' });
    assert.equal(noPortal.code, 1, `missing portal should fail:\n${noPortal.stdout}`);
    assert.match(noPortal.stdout, /^N\/A {3}x11\b/m);
    assert.match(noPortal.stdout, /^PASS  libraries\b/m);
    assert.match(noPortal.stdout, /^FAIL {2}wayland\s+missing xdg-desktop-portal ScreenCast/m);
    assert.match(noPortal.stdout, /^FAIL {2}input\s+missing portal RemoteDesktop/m);
    assert.match(noPortal.stdout, /fix\s+Debian\/Ubuntu: `sudo apt install .*xdg-desktop-portal.*`.*Fedora: `sudo dnf install .*xdg-desktop-portal/m);

    // A machine with the engine and its libraries but no desktop session is a
    // supported answer: two FAIL lines with the desktop fix, no crash.
    const noDisplay = doctor({ DESKLINK_ENGINE: engine }, ['DISPLAY', 'WAYLAND_DISPLAY']);
    assert.equal(noDisplay.code, 1, `no display should fail cleanly:\n${noDisplay.stdout}\n${noDisplay.stderr}`);
    assert.equal(noDisplay.stderr.trim(), '', `doctor crashed without a display:\n${noDisplay.stderr}`);
    assert.match(noDisplay.stdout, /^FAIL {2}x11\s+no X11 or Wayland session \(DISPLAY and WAYLAND_DISPLAY are unset\)$/m);
    assert.match(noDisplay.stdout, /^FAIL {2}input\s+no X11 or Wayland session to inject into$/m);
    assert.match(noDisplay.stdout, /^PASS {2}libraries\b/m);
    assert.match(noDisplay.stdout, /^PASS {2}encoder\b/m);
    assert.match(noDisplay.stdout, /^PASS {2}versions\b/m);

    // The linker's own missing-library message is what a bare Linux machine
    // sees first; doctor must name the library and the packages that carry it,
    // not send the person to reinstall the npm package.
    const fakeEngine = join(dir, 'fake-engine', 'desklink-host');
    mkdirSync(dirname(fakeEngine), { recursive: true });
    writeFileSync(fakeEngine, '#!/bin/sh\necho "desklink-host: error while loading shared libraries: libX11.so.6: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
    chmodSync(fakeEngine, 0o755);
    const missingLibrary = doctor({ DESKLINK_ENGINE: fakeEngine }, ['DISPLAY', 'WAYLAND_DISPLAY']);
    assert.equal(missingLibrary.code, 1, `missing library should fail:\n${missingLibrary.stdout}`);
    assert.match(missingLibrary.stdout, /^FAIL {2}libraries\s+cannot load libX11\.so\.6$/m);
    assert.match(missingLibrary.stdout, /fix\s+Debian\/Ubuntu: `sudo apt install .*libx11-6.*`.*Fedora: `sudo dnf install .*libX11/m);
    assert.match(missingLibrary.stdout, /^FAIL {2}versions\s+@desklink\/host .*engine version unavailable/m);
    assert.doesNotMatch(missingLibrary.stdout, /npm install @desklink\/host@latest/);
    assert.match(missingLibrary.stdout.split('\n').filter((line) => /^ {6}fix/.test(line)).join('\n'), /sudo apt install .*libx11-6/);

    console.log(JSON.stringify({
        doctor: 'passed',
        display,
        healthy: lines,
        hidden_engine: checkLines(broken.stdout),
        no_portal: checkLines(noPortal.stdout),
        no_display: checkLines(noDisplay.stdout),
        missing_library: checkLines(missingLibrary.stdout),
    }, null, 2));
} finally {
    if (xvfb !== null) await stopOwnedXvfb(xvfb);
    claim.release();
    rmSync(dir, { recursive: true, force: true });
}
