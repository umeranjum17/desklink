#!/usr/bin/env node
/**
 * One finger, one drag, in portrait, from the moment the view exists.
 *
 * Why this exists: a one-finger drag on a portrait phone spent its whole
 * movement on a pan of the picture, which in portrait has nowhere to go, so the
 * desktop never saw the pointer move. The same drag works once the picture has
 * been zoomed and brought back, so the bug reads as "it only works once the
 * session has settled". This flow drags in portrait in both states and judges
 * every one of them by what the DESKTOP recorded, never by what the device
 * screen showed: the GTK fixture's own event log and captures of both screens.
 *
 * The desktop half is the same private lab the other flows use (its own Xvfb
 * display, cookie and bridge port, `WAYLAND_DISPLAY` empty). The device is an
 * emulator this run reaches over 10.0.2.2; this flow never starts one.
 *
 * Usage:
 *
 *   node packages/desktop-client/test/android-portrait-drag-flow.mjs
 *
 * Environment:
 *
 *   ANDROID_SERIAL            device serial (default the only attached device)
 *   DESKLINK_ANDROID_HOST     this machine's address for the device (10.0.2.2)
 *   DESKLINK_ANDROID_OUT      where the evidence goes
 *   DESKLINK_ANDROID_SKIP_BUILD  1 reuses the APK the last run built
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.env.DESKLINK_ANDROID_OUT
    ?? join(homedir(), 'lab-tmp', 'desklink-portrait-drag', `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`));
assert(!existsSync(out), 'refusing to overwrite evidence');
mkdirSync(out, { recursive: true });
const scratch = join(out, 'scratch');
mkdirSync(scratch, { recursive: true });
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = join(repo, 'packages/desktop-host/test/fixtures/notes-document.py');
const example = join(repo, 'packages/desktop-client/example');
const apk = join(example, 'android/app/build/outputs/apk/debug/app-debug.apk');
const jar = join(out, 'touch.jar');
const display = `:${[170, 180, 190, 200].flatMap(n => [n, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7, n + 8, n + 9])
    .find(n => !existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`))}`;
assert(display, 'no free private X display left; clean up an old lab');
const host = process.env.DESKLINK_ANDROID_HOST ?? '10.0.2.2';
const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const events = join(out, 'notes-events.jsonl');
const document = join(out, 'document.txt');
const selection = join(out, 'selection.txt');
const attached = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(([, state]) => state === 'device').map(([serial]) => serial);
const serial = process.env.ANDROID_SERIAL ?? attached[0];
assert(serial && attached.includes(serial),
    `name the device with ANDROID_SERIAL; adb reports ${attached.join(', ') || 'none'}`);
const adb = (...args) => {
    const done = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 180000 });
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
const receipt = {
    outcome: 'FAIL', serial, display,
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    drags: {},
};
const children = [];
let xvfb, bridge, metro, receiver, xenv;

const logs = {};
const start = (name, cmd, args, childEnv, cwd = repo) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => { logs[name] = (logs[name] ?? '') + c; });
    child.stderr.on('data', c => { logs[name] = (logs[name] ?? '') + c; });
    children.push([name, child]);
    return child;
};
const waitFor = async (ready, what, ms = 60000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (ready()) return; await sleep(200); }
    throw new Error(`timed out waiting for ${what}`);
};
/** Everything the desktop itself recorded, oldest first. */
const log = () => existsSync(events)
    ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
const after = kind => log().filter(row => row.kind === kind);

try {
    // ---- the desktop half: a private display, a real document, the bridge ----
    assert(existsSync(engine), `missing binary: ${engine}: cargo build the engine first`);
    assert(existsSync(fixture), `missing fixture: ${fixture}`);
    const authority = join(scratch, 'Xauthority');
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
    xvfb = start('xvfb', 'Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp']);
    trackOwnedXvfb(xvfb, display);
    const procState = pid => { try { return readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; } };
    await waitFor(() => procState(xvfb.pid)?.includes('State:\tT'), 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };
    start('fixture', 'python3', [fixture, '--events', events, '--text', document, '--selection', selection], xenv);
    await waitFor(() => after('ready').length > 0, 'the document fixture');

    const probe = createServer();
    await new Promise(ok => probe.listen(0, '0.0.0.0', ok));
    const bridgePort = probe.address().port;
    probe.close();
    receipt.bridgePort = bridgePort;
    bridge = start('bridge', process.execPath,
        ['packages/desktop-host/bin/desklink-host.mjs', 'bridge', '--source', 'x11', '--display', display, '--listen', `0.0.0.0:${bridgePort}`], xenv);
    await waitFor(() => /^open\s+http/m.test(logs.bridge), 'the bridge URL');
    const token = /token[= ](\S+)/.exec(logs.bridge)[1];

    // ---- the device half: the same example app, built from this checkout ----
    const reports = [];
    receiver = createServer((request, response) => {
        const chunks = [];
        request.on('data', c => chunks.push(c));
        request.on('end', () => {
            reports.push(Buffer.concat(chunks).toString());
            response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            response.end();
        });
    });
    await new Promise(ok => receiver.listen(0, '0.0.0.0', ok));
    const link = `desklink-example://connect?url=${encodeURIComponent(`ws://${host}:${bridgePort}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://${host}:${receiver.address().port}/report`)}`;
    receipt.link = link.replace(token, '<bridge-token>');

    if (process.env.DESKLINK_ANDROID_SKIP_BUILD !== '1') {
        const build = spawnSync('flock', ['/tmp/fm-desklink-heavy.lock', 'bash', '-c', [
            'npm install --no-audit --no-fund',
            'npx expo prebuild --platform android --no-install',
            'cd android && ./gradlew --no-daemon assembleDebug',
        ].join(' && ')], { cwd: example, env, encoding: 'utf8', timeout: 3600000 });
        writeFileSync(join(out, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
        assert.equal(build.status, 0, 'the example app did not build; see build.log');
    }
    assert(existsSync(apk), `no APK at ${apk}: build the example app first`);
    receipt.apkSha256 = hash(apk);
    const inject = spawnSync('bash', [join(repo, 'packages/desktop-client/test/inject/build.sh'), jar], { encoding: 'utf8' });
    assert.equal(inject.status, 0, `the touch injector did not build: ${inject.stderr}`);
    receipt.injectorSha256 = hash(jar);

    metro = start('metro', 'npx', ['expo', 'start', '--port', '8081'], { ...env, CI: '1' }, example);
    await waitFor(() => /Waiting on http/.test(logs.metro), 'Metro');
    adb('install', '-r', '-g', apk);
    adb('reverse', 'tcp:8081', 'tcp:8081');
    adb('push', jar, '/data/local/tmp/touch.jar');
    // Portrait, held there: the journey is a portrait journey, and a device that
    // rotates mid-drag would prove something else.
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    // A fresh install is a stopped package, and a stopped package resolves no
    // implicit intent, so the app is started by name; the connection link rides
    // along as the intent's data, which is where the app reads it from.
    adb('shell', 'am', 'start', '-n', 'dev.desklink.example/.MainActivity',
        '-a', 'android.intent.action.VIEW', '-d', `"${link}"`);
    await waitFor(() => reports.length > 0, "the app's own report", 180000);
    await waitFor(() => {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        return typeof last.presentedAt === 'number' && last.presentedAt > 0;
    }, 'the first presented frame', 180000);
    await sleep(4000);
    const [width, height] = /(\d+)x(\d+)/.exec(adb('shell', 'wm', 'size'))?.slice(1).map(Number) ?? [1080, 2400];
    receipt.device = { width, height };
    assert(height > width, `this journey is a portrait one; the device is ${width}x${height}`);

    // ---- the injector: real MotionEvents, one or two pointers, from a file ----
    const run = async (line) => {
        adb('shell', `printf '%s\\n' '${line}' > /data/local/tmp/desklink-gesture.txt`);
        let text = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const done = spawnSync('adb', ['-s', serial, 'shell', 'uiautomator', 'runtest',
                '/system/framework/uiautomator.jar', '/data/local/tmp/touch.jar',
                '-c', 'com.android.uiautomator.core.Touch'], { encoding: 'utf8', timeout: 120000 });
            text = `${done.stdout ?? ''}${done.stderr ?? ''}`;
            if (/OK \(\d+ tests?\)/.test(text)) return;
            await sleep(1500);
        }
        assert.fail(`the injector refused ${line}: ${text}`);
    };
    const gesture = async (verb, x1, y1, x2, y2, param = 0, hold = 0) => {
        const line = [verb, x1, y1, x2, y2, param, hold].join(' ');
        await run(line);
        return line;
    };

    /** A capture of the phone's own screen, as the person saw it. */
    const phoneShot = async name => {
        const path = join(out, name);
        const pulled = join(scratch, name);
        spawnSync('bash', ['-c', `adb -s ${serial} exec-out screencap -p > ${JSON.stringify(pulled)}`], { encoding: 'utf8' });
        copyFileSync(pulled, path);
        return path;
    };

    /**
     * Where the desktop is on this device, measured rather than assumed: a tap
     * lands and the desktop records the pixel it hit, so a few taps solve the
     * fit and give the picture's own rectangle on the screen.
     */
    const solveFit = async () => {
        const samples = [];
        const covered = () => new Set(samples.map(s => s.py)).size >= 2
            && new Set(samples.map(s => s.px)).size >= 2 && samples.length >= 3;
        // The picture can sit anywhere in the view — a fill starts at the top, a
        // fitted picture is centred — so taps are tried down the screen until
        // enough of them land on the desktop to solve both axes.
        for (const fy of [0.08, 0.16, 0.24, 0.36, 0.44, 0.52]) {
            for (const fx of [0.5, 0.2, 0.8]) {
                if (covered()) break;
                const [px, py] = [Math.round(width * fx), Math.round(height * fy)];
                const before = after('button').length;
                await gesture('tap', px, py);
                try { await waitFor(() => after('button').length >= before + 2, 'the tap to land', 4000); } catch { continue; }
                const down = after('button').filter(row => row.phase === 'down').pop();
                samples.push({ px, py, dx: down.x, dy: down.y });
                await sleep(600);
            }
        }
        assert(samples.length >= 3, `too few taps on the picture reached the desktop: ${JSON.stringify(samples)}`);
        const column = samples[0];
        const across = samples.find(s => s.py === column.py && s.px !== column.px);
        const down = samples.find(s => s.px === column.px && s.py !== column.py);
        assert(across && down, `the marks do not span both axes: ${JSON.stringify(samples)}`);
        const scaleX = (across.dx - column.dx) / (across.px - column.px);
        const scaleY = (down.dy - column.dy) / (down.py - column.py);
        assert(Number.isFinite(scaleX) && Number.isFinite(scaleY) && Math.abs(scaleX) > 0.05 && Math.abs(scaleY) > 0.05,
            `the picture does not fit the device as a scale: ${JSON.stringify(samples)}`);
        const toPhone = (dx, dy) => [
            Math.round(column.px + (dx - column.dx) / scaleX),
            Math.round(column.py + (dy - column.dy) / scaleY),
        ];
        const rect = { x0: toPhone(0, 0)[0], y0: toPhone(0, 0)[1], x1: toPhone(1280, 720)[0], y1: toPhone(1280, 720)[1] };
        const inside = (dx, dy) => {
            const [px, py] = toPhone(dx, dy);
            // Inside the picture's middle band, and on the screen: a zoomed
            // picture reaches past the edges, and a finger cannot land there.
            const lo = (from, edge) => Math.min(Math.max(edge * 0.08, from), edge * 0.92);
            return [
                Math.round(lo(Math.min(Math.max(px, rect.x0 + (rect.x1 - rect.x0) * 0.15), rect.x0 + (rect.x1 - rect.x0) * 0.85), width)),
                Math.round(lo(Math.min(Math.max(py, rect.y0 + (rect.y1 - rect.y0) * 0.15), rect.y0 + (rect.y1 - rect.y0) * 0.85), height)),
            ];
        };
        receipt.fit = { samples, scaleX: Math.round(scaleX * 1e4) / 1e4, scaleY: Math.round(scaleY * 1e4) / 1e4, rect };
        return inside;
    };
    const at = await solveFit();

    /**
     * One one-finger drag, and what the desktop made of it. The drag carries no
     * hold: a long press would arm the client's own press and prove something
     * else, so this is the plain finger movement a person makes.
     */
    const drag = async (name, place) => {
        const before = await phoneShot(`${name}-phone-before.png`);
        const pointers = after('pointer').length;
        const buttons = after('button').length;
        const line = await gesture('drag', ...place(200, 150), ...place(1100, 600), 600, 0);
        await sleep(1500);
        const rows = after('pointer').slice(pointers);
        const xs = [...new Set(rows.map(r => r.x))].length;
        const ys = [...new Set(rows.map(r => r.y))].length;
        const shot = await phoneShot(`${name}-phone-after.png`);
        return {
            command: line,
            commandScreen: `${line} (on a ${width}x${height} portrait screen)`,
            pointerSamples: rows.length, distinctX: xs, distinctY: ys,
            buttonsPressed: after('button').length > buttons,
            moves: rows.map(r => ({ x: r.x, y: r.y })),
            captures: [before, shot],
            // The desktop is the judge: the pointer moved, and it moved across
            // the desktop rather than jittering on one pixel.
            passed: rows.length >= 4 && xs >= 3 && ys >= 3,
        };
    };

    /** How many pixels of the phone's own screen changed: the effect, measured there. */
    const screenChanged = (a, b) => {
        const metric = spawnSync('compare', ['-metric', 'AE', a, b, 'null:'], { encoding: 'utf8' });
        return Number((metric.stderr || metric.stdout).trim().split(/\s+/)[0]);
    };

    /**
     * The same drag on a picture that is larger than the view, which is what a
     * landscape phone shows: the picture moves and the desktop sees nothing.
     */
    const panOfPicture = async (place) => {
        const before = await phoneShot('03-zoomed-pan-phone-before.png');
        const pointers = after('pointer').length;
        const line = await gesture('drag', ...place(200, 150), ...place(1100, 600), 600, 0);
        await sleep(1500);
        const shot = await phoneShot('03-zoomed-pan-phone-after.png');
        const moved = screenChanged(before, shot);
        return {
            command: line, commandScreen: `${line} (on a ${width}x${height} portrait screen)`,
            pointerSamples: after('pointer').length - pointers,
            phonePixelsChanged: moved, captures: [before, shot],
            passed: after('pointer').length === pointers && moved > 2000,
        };
    };

    // ---- 1. the state the session starts in: the picture at its fill ----
    receipt.drags['01-filling'] = await drag('01-filling', at);

    // ---- 2. the state the drag works in today: zoomed, then back to fit ----
    // A pinch takes the picture out of the fill state and its scale back to the
    // fit it started at, which is the only way a person reaches the other state
    // without leaving the app. Same drag, same place.
    const [cx, cy] = at(640, 360);
    await gesture('pinch', cx, cy, 0, 0, 20, 12);
    await sleep(1200);
    // The picture moved when the state changed, so where the desktop is on this
    // screen is solved again rather than carried over from the fill.
    receipt.drags['02-after-zoom'] = await drag('02-after-zoom', await solveFit());

    // ---- 3. the picture bigger than the view: the finger still pans it ----
    // A landscape phone shows a desktop that fills the view edge to edge, which
    // is this state: the picture is larger than the view, so a one-finger drag
    // belongs to the picture. A pinch out reaches it without leaving the app.
    const [zx, zy] = (await solveFit())(640, 360);
    await gesture('pinch', zx, zy, 0, 0, 300, 12);
    await sleep(1500);
    receipt.drags['03-zoomed-pan'] = await panOfPicture(await solveFit());

    const drags = Object.entries(receipt.drags).filter(([, d]) => d);
    const failed = drags.filter(([, d]) => !d.passed).map(([name]) => name);
    receipt.failed = failed;
    receipt.outcome = failed.length ? 'FAIL' : 'PASS';
    console.log(`\n${drags.map(([name, d]) => `${d.passed ? 'PASS' : 'FAIL'}  ${name}  (${d.pointerSamples} pointer samples on the desktop)`).join('\n')}`);
    console.log(`\nevidence ${out}`);
} catch (error) {
    receipt.error = String(error);
    console.error(String(error));
} finally {
    for (const [, child] of children) child.kill('SIGTERM');
    await sleep(700);
    for (const [, child] of children) { try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { child.exitCode ??= 0; } }
    receiver?.close();
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    for (const [name, text] of Object.entries(logs)) writeFileSync(join(out, `${name}.log`), text);
    if (existsSync(events)) copyFileSync(events, join(out, 'notes-events.jsonl.copy'));
    if (existsSync(selection)) copyFileSync(selection, join(out, 'selection.copy.txt'));
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : 1);