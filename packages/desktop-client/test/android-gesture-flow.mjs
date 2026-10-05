#!/usr/bin/env node
/**
 * The three gestures, end to end: drag-select, a fling and a two-finger scroll,
 * from an Android device to a real desktop this machine serves.
 *
 * Why this exists: the phone proof (lab-tmp/dl-j2-android-proof) proved click
 * and long press, and could not express drag or two fingers at all — that
 * device delivers no MOVE event to any application, from any injector. This
 * flow runs the same journey on hardware that can, and judges every gesture by
 * what the DESKTOP recorded, never by what the device screen showed: the GTK
 * fixture's own event log (`notes-events.jsonl`), the selection it read back
 * out of its own buffer, and a capture of the desktop display itself, taken
 * through `import` on the private Xvfb.
 *
 * The host side is the same private lab the other flows use: display >= 170, its
 * own cookie, the shipped GTK document fixture, the bridge on a loopback port,
 * `WAYLAND_DISPLAY` empty. The device is an emulator reaching this machine
 * through 10.0.2.2, or a phone over the network; this flow never starts one.
 *
 * Usage:
 *
 *   node packages/desktop-client/test/android-gesture-flow.mjs
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
    ?? join(homedir(), 'lab-tmp', 'desklink-gesture-flow', `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`));
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
const host = process.env.DESKLINK_ANDROID_HOST;
assert(host, 'set DESKLINK_ANDROID_HOST to this machine\'s address on the device\'s network');
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
    const done = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120000 });
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
const receipt = {
    outcome: 'FAIL', serial, display,
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    gestures: {},
};
const children = [];
let xvfb, bridge, metro, receiver;

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
/** A capture of the desktop display itself — the record, not the device screen. */
const capture = name => {
    const path = join(out, name);
    const shot = spawnSync('import', ['-window', 'root', path], { env: xenv, encoding: 'utf8' });
    assert.equal(shot.status, 0, `the desktop could not be captured: ${shot.stderr}`);
    return path;
};
/** How many pixels differ between two captures: the effect, measured on the desktop. */
const changed = (before, after) => {
    const metric = spawnSync('compare', ['-metric', 'AE', before, after, 'null:'], { encoding: 'utf8' });
    return Number((metric.stderr || metric.stdout).trim().split(/\s+/)[0]);
};
/**
 * How much of the picture is selected-highlight blue. A drag that selects
 * paints it, so this counts the effect itself rather than how many pixels a
 * move happened to disturb.
 */
const highlighted = path => {
    const px = spawnSync('convert', [path, '-colorspace', 'RGB', '-fx',
        '(b > r + 0.1 && b > g + 0.06) ? 1 : 0', '-format', '%[fx:mean*w*h]', 'info:'],
    { encoding: 'utf8' });
    return Math.round(Number(px.stdout.trim()));
};

let xenv;
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
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `"${link}"`);
    await waitFor(() => reports.length > 0, "the app's own report", 180000);
    await waitFor(() => {
        const last = JSON.parse(reports[reports.length - 1] ?? '{}');
        return typeof last.presentedAt === 'number' && last.presentedAt > 0;
    }, 'the first presented frame', 180000);
    await sleep(4000);
    const [width, height] = /(\d+)x(\d+)/.exec(adb('shell', 'wm', 'size'))?.slice(1).map(Number) ?? [1080, 2400];
    receipt.device = { width, height };

    // ---- the injector: real MotionEvents, one or two pointers, from a file ----
    // The device's own uiautomator jar goes first so its real framework classes
    // win, and `runtest` wants the jars before `-c`. Its teardown always ends
    // with a resolution warning on a current image, so the run counts when the
    // test itself ran; what the gesture did is judged below, on the desktop.
    const run = async (line) => {
        adb('shell', `printf '%s\\n' '${line}' > /data/local/tmp/desklink-gesture.txt`);
        let text = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const done = spawnSync('adb', ['-s', serial, 'shell', 'uiautomator', 'runtest',
                '/system/framework/uiautomator.jar', '/data/local/tmp/touch.jar',
                '-c', 'com.android.uiautomator.core.Touch'], { encoding: 'utf8', timeout: 120000 });
            text = `${done.stdout ?? ''}${done.stderr ?? ''}`;
            if (/OK \(\d+ tests?\)/.test(text)) return;
            await sleep(1500); // a killed run leaves its UiAutomation registered
        }
        assert.fail(`the injector refused ${line}: ${text}`);
    };
    const gesture = (verb, x1, y1, x2, y2, param = 0, hold = 0) => {
        const line = [verb, x1, y1, x2, y2, param, hold].join(' ');
        return run(line).then(() => line);
    };

    /**
     * Where the desktop is on this device, measured rather than assumed: a tap
     * lands and the desktop records the pixel it hit, so a few taps solve the
     * fit and give the picture's own rectangle on the screen. A guess here would
     * put every gesture in the letterbox and prove nothing.
     */
    const solveFit = async () => {
        const samples = [];
        const covered = () => new Set(samples.map(s => s.py)).size >= 2
            && new Set(samples.map(s => s.px)).size >= 2 && samples.length >= 3;
        for (const fy of [0.08, 0.16, 0.24, 0.32, 0.44]) {
            for (const fx of [0.5, 0.2, 0.8]) {
                if (covered()) break;
                const [px, py] = [Math.round(width * fx), Math.round(height * fy)];
                const before = after('button').length;
                await gesture('tap', px, py);
                // A tap in the letterbox is not a tap on the desktop, so a mark
                // that never arrives is a point to skip, not a failure.
                try { await waitFor(() => after('button').length >= before + 2, 'the tap to land', 4000); } catch { continue; }
                const down = after('button').filter(row => row.phase === 'down').pop();
                samples.push({ px, py, dx: down.x, dy: down.y });
                await sleep(600); // past the double-tap window, so the next mark is its own click
            }
        }
        assert(samples.length >= 3, `too few taps on the picture reached the desktop: ${JSON.stringify(samples)}`);
        // One pair across the screen for each axis: a scale solved from a single
        // row is a scale of zero in the other.
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
        // The picture's own rectangle on this screen, so a gesture stays where
        // there is a desktop to hit: the desktop is 1280x720.
        const rect = { x0: toPhone(0, 0)[0], y0: toPhone(0, 0)[1], x1: toPhone(1280, 720)[0], y1: toPhone(1280, 720)[1] };
        const inside = (dx, dy) => {
            const [px, py] = toPhone(dx, dy);
            return [
                Math.round(Math.min(Math.max(px, rect.x0 + (rect.x1 - rect.x0) * 0.2), rect.x0 + (rect.x1 - rect.x0) * 0.8)),
                Math.round(Math.min(Math.max(py, rect.y0 + (rect.y1 - rect.y0) * 0.2), rect.y0 + (rect.y1 - rect.y0) * 0.8)),
            ];
        };
        receipt.fit = { samples, scaleX: Math.round(scaleX * 1e4) / 1e4, scaleY: Math.round(scaleY * 1e4) / 1e4, rect };
        return inside;
    };
    const at = await solveFit();

    /**
     * A gesture, retried while the desktop's own record does not show it. The
     * device's injection loses the odd event, so a dropped one is a fact about
     * the harness, not about the product; the attempt that lands is the one the
     * evidence keeps, and every attempt is counted.
     */
    const untilRecorded = async (name, fire, recorded, attempts = 4) => {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const line = await fire();
            let landed = true;
            try { await waitFor(() => recorded(), `${name} to reach the desktop`, 15000); } catch { landed = false; }
            if (landed) return { line, attempt };
            await sleep(800);
        }
        throw new Error(`${name} never reached the desktop in ${attempts} attempts`);
    };

    // A gesture the device cannot express is a result, not a crash: each one is
    // recorded with what arrived on the desktop, so the evidence can name it.
    const record = async (name, prove) => {
        try {
            receipt.gestures[name] = await prove();
        } catch (error) {
            receipt.gestures[name] = { passed: false, error: String(error) };
        }
    };

    // ---- 1. drag-select: hold (the client arms a press on a long press), then move ----
    await record('drag-select', async () => {
        const empty = capture('01-drag-select-before.png');
        const buttons = after('button').length;
        const pointers = after('pointer').length;
        const { line, attempt } = await untilRecorded('the drag',
            () => gesture('drag', ...at(360, 355), ...at(760, 355), 600, 900),
            () => after('button').length > buttons && after('pointer').length > pointers + 4);
        await sleep(1200);
        const rows = log().slice(-80);
        const moved = rows.filter(row => row.kind === 'pointer').length;
        const held = rows.some(row => row.kind === 'button' && row.phase === 'down') && moved >= 5;
        const selected = existsSync(selection) ? readFileSync(selection, 'utf8') : '';
        const shot = capture('01-drag-select-desktop.png');
        return {
            command: line, attempt, pointerSamples: moved, selection: selected,
            releaseRecorded: rows.some(row => row.kind === 'button' && row.phase === 'up'),
            desktopPixelsChanged: changed(empty, shot),
            highlightedBefore: highlighted(empty), highlightedAfter: highlighted(shot),
            capture: shot,
            // The selection is the desktop's own: the highlight it painted plus
            // the words its buffer reads back when the release lands.
            passed: held && highlighted(shot) > highlighted(empty) + 200,
        };
    });

    // ---- 2. two-finger scroll ----
    await record('two-finger-scroll', async () => {
        const before = capture('02-two-finger-scroll-before.png');
        const wheels = after('wheel').length;
        const { line, attempt } = await untilRecorded('the two-finger scroll',
            () => gesture('twofinger', ...at(540, 340), ...at(540, 160), 24),
            () => after('wheel').length > wheels);
        await sleep(1500);
        const rows = after('wheel').slice(wheels);
        const detents = rows.reduce((sum, row) => sum + Math.abs(row.dy), 0);
        const shot = capture('02-two-finger-scroll-desktop.png');
        return {
            command: line, attempt, events: rows, detents: Math.round(detents * 100) / 100,
            capture: shot, desktopPixelsChanged: changed(before, shot),
            passed: detents >= 2 && changed(before, shot) > 5000,
        };
    });

    // ---- 3. a fling: the same two-finger travel, far fewer frames ----
    await record('fling', async () => {
        await sleep(1000);
        const before = capture('03-fling-before.png');
        const wheels = after('wheel').length;
        const started = Date.now();
        const { line, attempt } = await untilRecorded('the fling',
            () => gesture('twofinger', ...at(540, 340), ...at(540, 150), 4),
            () => after('wheel').length > wheels);
        const landed = Date.now();
        const rows = after('wheel').slice(wheels);
        // What a fling claims is that the movement lands fast and in few
        // samples. Whether anything keeps scrolling afterwards is the momentum
        // question, and it is measured, not assumed.
        await sleep(2500);
        const withMomentum = after('wheel').slice(wheels);
        const detents = rows.reduce((sum, row) => sum + Math.abs(row.dy), 0);
        const shot = capture('03-fling-desktop.png');
        return {
            command: line, attempt, events: rows, detents: Math.round(detents * 100) / 100,
            wallMs: landed - started, momentumEvents: withMomentum.length - rows.length,
            capture: shot, desktopPixelsChanged: changed(before, shot),
            passed: detents >= 2 && rows.length <= 8,
        };
    });

    const gestures = Object.entries(receipt.gestures);
    const failed = gestures.filter(([, g]) => !g.passed).map(([name]) => name);
    receipt.failed = failed;
    receipt.outcome = failed.length ? 'FAIL' : 'PASS';
    console.log(`\n${gestures.map(([name, g]) => `${g.passed ? 'PASS' : 'FAIL'}  ${name}`).join('\n')}`);
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
