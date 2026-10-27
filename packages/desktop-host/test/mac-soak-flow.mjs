#!/usr/bin/env node
/**
 * macOS soak: does a session survive real use at the promised latency and frame rate?
 *
 * Run ON the private Mac lab (nothing here touches it from elsewhere). One run:
 *   1. opens a session through the bridge and a headless Chrome client, and shows an
 *      owned fixture window (`mac-soak-fixture.py`) that pulses at 60 Hz and flips an
 *      echo cell on every key;
 *   2. types a marker every minute for an hour, sampling fps (one-second windows of
 *      presented frames) and keystroke latency (key sent -> echo cell flipped in the
 *      decoded picture) the whole time;
 *   3. sleeps the Mac, wakes it, and types again;
 *   4. kills the client connection without telling the engine, reconnects, types again,
 *      and records a short clip of the fixture across the reconnect.
 * It writes `timeline.json` (rewritten after every marker, so a failure keeps what was
 * measured) and `reconnect.webm` into --out. fps and latency use the journey lane's
 * method (`mac-soak-stats.mjs`); the soak adds each one's worst value.
 *
 * The one command, detached so the ssh session may die while the Mac sleeps:
 *
 *   ssh umerfaroq@100.97.31.92 'cd ~/fm-desklink-mac/<checkout> && DESKLINK_MAC_LAB=1 \
 *     DESKLINK_ENGINE=<signed desklink-host> nohup node packages/desktop-host/test/mac-soak-flow.mjs \
 *     --out ~/fm-desklink-mac/soak/<run> >~/fm-desklink-mac/soak/<run>.log 2>&1 &'
 *
 * Flags (defaults): --out <dir> (required) --minutes 60 --interval-s 60 --gap-ms 150
 *   --sleep-s 30 (least time asleep) --offline-s 5 (client offline before reconnect)
 *   --tail-s 20 (measured seconds after wake and after reconnect) --max-fps 60
 *   --sleep display|system (display: `pmset displaysleepnow`, woken with `caffeinate -u`, needs
 *   nothing; system: `pmset sleepnow`, which this harness cannot undo unattended) and, for system,
 *   --wake pmset|manual (pmset: `sudo -n pmset schedule wake`, needs passwordless sudo;
 *   manual: someone wakes the Mac within 15 minutes)
 *   --dry-run [--fail-at soak|sleep|reconnect]: the same run against a fake Mac on a
 *   virtual clock; touches nothing.
 *
 * Needs: macOS, `npm ci` in this checkout, python3 with pyobjc (DESKLINK_PYTHON, e.g. /usr/bin/python3), Chrome (DESKLINK_CHROME
 * or the default app path), the lab-signed engine with Screen Recording and
 * Accessibility granted, and the Mac set to not ask for a password on wake.
 *
 * Cleanup: everything the run starts (keep-awake, scheduled wake, fixture, Chrome, bridge,
 * dev server) is undone in a `finally` and on SIGINT/SIGTERM, and the Mac's sleep settings
 * are read before and after and compared; the timeline says whether they match.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { fpsSummary, fpsWindows, latencySummary, round1 } from './mac-soak-stats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

// ---- arguments -------------------------------------------------------------

export function parseArgs(args) {
    const flags = new Map();
    for (let i = 0; i < args.length; i += 1) {
        assert(args[i].startsWith('--'), `unexpected argument ${args[i]}`);
        const name = args[i].slice(2);
        const bare = name === 'dry-run';
        flags.set(name, bare ? true : args[++i]);
        assert(bare || flags.get(name) !== undefined, `--${name} needs a value`);
    }
    const known = ['out', 'minutes', 'interval-s', 'gap-ms', 'sleep-s', 'offline-s', 'tail-s', 'max-fps', 'sleep', 'wake', 'dry-run', 'fail-at'];
    for (const name of flags.keys()) assert(known.includes(name), `unknown flag --${name}`);
    const number = (name, fallback, min) => {
        const value = Number(flags.get(name) ?? fallback);
        assert(Number.isFinite(value) && value >= min, `--${name} must be a number >= ${min}`);
        return value;
    };
    const plan = {
        dryRun: flags.get('dry-run') === true,
        out: flags.get('out') === undefined ? undefined : resolve(flags.get('out')),
        minutes: number('minutes', 60, 1),
        intervalS: number('interval-s', 60, 5),
        gapMs: number('gap-ms', 150, 0),
        sleepS: number('sleep-s', 30, 5),
        offlineS: number('offline-s', 5, 1),
        tailS: number('tail-s', 20, 5),
        maxFps: number('max-fps', 60, 1),
        sleep: flags.get('sleep') ?? 'display',
        wake: flags.get('wake') ?? 'pmset',
        failAt: flags.get('fail-at') ?? null,
    };
    assert(plan.out !== undefined, '--out <directory> is required');
    assert(['display', 'system'].includes(plan.sleep), '--sleep must be display or system');
    assert(['pmset', 'manual'].includes(plan.wake), '--wake must be pmset or manual');
    assert(plan.failAt === null || (plan.dryRun && ['soak', 'sleep', 'reconnect'].includes(plan.failAt)), '--fail-at is soak|sleep|reconnect and only with --dry-run');
    return plan;
}

// ---- cleanup that runs however the run ends --------------------------------

class Cleanup {
    steps = [];
    results = [];
    add(step, undo) { this.steps.push({ step, undo }); }
    async run() {
        while (this.steps.length > 0) {
            const { step, undo } = this.steps.pop();
            try {
                await undo();
                this.results.push({ step, ok: true });
            } catch (error) {
                this.results.push({ step, ok: false, error: String(error?.message ?? error) });
            }
        }
        return this.results;
    }
}

// ---- the orchestration, identical for the real Mac and the dry run ----------

const markerText = (n) => `m${String(n).padStart(3, '0')}`;

export async function runSoak(lab, plan, timeline, save) {
    const spans = timeline.phases;
    const frames = [];
    let phase = null;
    let begin = null;
    let inGap = false;
    const enter = (name, gap = false) => {
        if (phase !== null) spans.push({ phase, start: begin, end: lab.now(), gap: inGap });
        phase = name;
        inGap = gap;
        begin = lab.now();
    };
    const current = () => phase;
    const event = (name, extra = {}) => timeline.events.push({ name, at: lab.now(), ...extra });
    const drain = async () => { for (const t of await lab.frames()) frames.push({ t, phase: current() }); };
    const hold = async (ms) => {
        const end = lab.now() + ms;
        while (lab.now() < end) {
            await lab.wait(Math.min(5000, end - lab.now()));
            await drain();
        }
    };
    const type = async (n) => {
        const text = markerText(n);
        const at = lab.now();
        const typed = await lab.type(text, plan.gapMs);
        timeline.markers.push({ n, text, at, phase: current(), typed_ok: typed.typed_ok, rejection: typed.rejection ?? null });
        // The first marker proves the path; an hour of lost keystrokes proves nothing.
        if (n === 0 && !typed.typed_ok) throw new Error(`the first marker did not reach the fixture (rejection: ${typed.rejection ?? 'none'})`);
        typed.echo_ms.forEach((ms, i) => timeline.latency.push({ at: at + i * 1, ms, phase: current(), marker: n }));
        await drain();
        save();
    };
    const finish = () => { if (phase !== null) enter(null); };

    timeline.pending = { frames, current };
    try {
        await lab.prepare();
        event('session-open', await lab.connect());
        enter('soak');
        const start = lab.now();
        for (let n = 0; n < plan.minutes; n += 1) {
            if (plan.failAt === 'soak' && n === 3) throw new Error('fake failure in the soak');
            const tick = start + n * plan.intervalS * 1000;
            await type(n);
            if (n % 10 === 0) timeline.metrics.push({ at: lab.now(), ...(await lab.metrics()) });
            await hold(Math.max(0, tick + plan.intervalS * 1000 - lab.now()));
        }

        enter('sleep', true);
        event('sleep-requested');
        const slept = await lab.sleepWake(plan);
        event('woke', slept);
        enter('wake-gap', true);
        const wakeAt = lab.now();
        while (!(await lab.frames().then((got) => { got.forEach((t) => frames.push({ t, phase: current() })); return got.length > 0; }))) {
            if (lab.now() - wakeAt > 60_000) { timeline.recovery.wake_first_frame_ms = null; break; }
            await lab.wait(250);
        }
        timeline.recovery.wake_first_frame_ms ??= lab.now() - wakeAt;
        enter('after-wake');
        for (let i = 0; i < 3; i += 1) await type(1000 + i);
        await hold(plan.tailS * 1000);

        await lab.clipStart();
        await hold(2000);
        enter('reconnect', true);
        event('client-killed');
        await lab.disconnect();
        await lab.wait(plan.offlineS * 1000);
        if (plan.failAt === 'reconnect') throw new Error('fake failure in the reconnect');
        const back = await lab.connect();
        event('reconnected', back);
        timeline.recovery.reconnect_first_frame_ms = back.first_frame_ms;
        enter('after-reconnect');
        const first = await lab.type(markerText(2000), plan.gapMs);
        timeline.recovery.reconnect_first_echo_ms = first.echo_ms[0];
        timeline.markers.push({ n: 2000, text: markerText(2000), at: lab.now(), phase: current(), typed_ok: first.typed_ok, rejection: first.rejection ?? null });
        first.echo_ms.forEach((ms) => timeline.latency.push({ at: lab.now(), ms, phase: current(), marker: 2000 }));
        for (let i = 1; i < 3; i += 1) await type(2000 + i);
        await hold(plan.tailS * 1000);
        timeline.clip = await lab.clipStop(join(plan.out, 'reconnect.webm'));
    } finally {
        await drain().catch(() => undefined);
        finish();
        delete timeline.pending;
        timeline.frames = frames;
    }
}

// ---- summary: the hour's numbers, and the same for each recovery phase -------

export function summarise(timeline) {
    const windows = [];
    for (const span of timeline.phases) {
        for (const w of fpsWindows(timeline.frames.filter((f) => f.phase === span.phase).map((f) => f.t), span.start, span.end)) {
            windows.push({ ...w, phase: span.phase, gap: span.gap });
        }
    }
    const summary = {};
    for (const name of ['soak', 'after-wake', 'after-reconnect']) {
        const fps = fpsSummary(windows.filter((w) => w.phase === name));
        const latency = latencySummary(timeline.latency.filter((s) => s.phase === name));
        summary[name] = {
            fps: { windows: fps.windows, median: round1(fps.median), p05: round1(fps.p05), worst: fps.worst },
            latency_ms: { samples: latency.samples, lost: latency.lost, p50: round1(latency.p50), p95: round1(latency.p95), worst: round1(latency.worst) },
        };
    }
    return { summary, fps_windows: windows.map(({ at, fps, phase, gap }) => ({ at, fps, phase, gap })) };
}

// ---- the dry run: a fake Mac on a virtual clock ------------------------------

class FakeLab {
    constructor(plan, cleanup) {
        this.plan = plan;
        this.cleanup = cleanup;
        this.clock = 1_800_000_000_000;
        this.drained = this.clock;
        this.seed = 7;
        this.deadUntil = 0;
        this.settings = { sleep: '1', displaysleep: '10', sched: '' };
        this.before = { ...this.settings };
    }
    random() { this.seed = (this.seed * 1103515245 + 12345) % 2147483648; return this.seed / 2147483648; }
    now() { return this.clock; }
    async wait(ms) { this.clock += ms; }
    describe() { return { platform: 'fake (dry run)', sleep_settings_before: this.snapshot() }; }
    snapshot() { return JSON.stringify(this.settings); }
    async prepare() {
        this.cleanup.add('stop fake keep-awake', () => { this.keepAwake = false; });
        this.cleanup.add('close fake app', () => { this.app = false; });
        this.keepAwake = true;
        this.app = true;
    }
    async connect() {
        const first = 1200 + Math.round(this.random() * 400);
        this.drained = this.clock;
        this.clock += first;
        this.deadUntil = this.clock;
        this.drained = this.clock;
        return { first_frame_ms: first };
    }
    async disconnect() { this.deadUntil = Infinity; }
    async frames() {
        const out = [];
        for (let t = this.drained; t < this.clock; t += 1000 / 60) {
            if (t >= this.deadUntil && this.random() > 0.01) out.push(Math.round(t));
        }
        this.drained = this.clock;
        return out;
    }
    async type(text, gapMs) {
        const echo = [...text].map(() => Math.round((45 + this.random() * 30 + (this.random() > 0.97 ? 90 : 0)) * 10) / 10);
        this.clock += echo.reduce((a, b) => a + b + gapMs, 0);
        return { typed_ok: true, echo_ms: echo };
    }
    async metrics() { return { captured_frames: Math.round((this.clock - 1_800_000_000_000) / 16.7), dropped_frames: 12 }; }
    async sleepWake(plan) {
        const requested = this.clock;
        this.settings.sched = 'wake at +' + plan.sleepS;
        this.cleanup.add('cancel scheduled wake', () => { this.settings.sched = ''; });
        if (plan.failAt === 'sleep') throw new Error('fake failure after the wake was scheduled');
        this.keepAwake = false;
        this.clock += (plan.sleepS + 15) * 1000;
        this.keepAwake = true;
        this.deadUntil = this.clock + 3000;
        return { requested_at: requested, asleep_ms: this.clock - requested, kind: plan.sleep };
    }
    async clipStart() {}
    async clipStop(path) { return { path, note: 'dry run: no clip' }; }
    sleepSettingsNow() { return this.snapshot(); }
}

// ---- the real Mac ----------------------------------------------------------

function freePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
    });
}
const pad = (n) => String(n).padStart(2, '0');
const pmsetDate = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });

class MacLab {
    constructor(plan, cleanup) {
        this.plan = plan;
        this.cleanup = cleanup;
        this.calls = new Map();
        this.nextCall = 0;
    }
    now() { return Date.now(); }
    wait(ms) { return sleep(ms); }
    sleepSettingsNow() { return `${run('pmset', ['-g', 'custom'])}\n${run('pmset', ['-g', 'sched'])}`; }
    spawnOwned(step, command, args, options = {}) {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
        child.stdout.resume();
        child.stderr.setEncoding('utf8');
        child.recent = '';
        child.stderr.on('data', (chunk) => { child.recent = (child.recent + chunk).slice(-600); });
        this.cleanup.add(step, async () => {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await Promise.race([new Promise((done) => child.once('exit', done)), sleep(8000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
        });
        return child;
    }
    keepAwake() {
        this.awake = this.spawnOwned('stop keep-awake', 'caffeinate', ['-dimsu']);
    }
    describe() {
        return { platform: run('sw_vers', ['-productVersion']).trim(), arch: process.arch, engine: this.engine, chrome: this.chrome, display: this.display, sleep_settings_before: this.sleepBefore };
    }

    async prepare() {
        const { plan } = this;
        assert.equal(process.platform, 'darwin', 'run this on the lab Mac');
        assert.equal(process.env.DESKLINK_MAC_LAB, '1', 'set DESKLINK_MAC_LAB=1 after confirming this is the private Mac lab');
        this.engine = resolve(process.env.DESKLINK_ENGINE ?? '');
        assert(existsSync(this.engine), 'set DESKLINK_ENGINE to the lab-signed desklink-host');
        const signing = run('codesign', ['-dr', '-', this.engine], { stdio: ['ignore', 'pipe', 'pipe'] });
        assert(signing.includes('identifier "dev.desklink.host"'), `the engine is not the lab-signed DesklinkHost: ${signing}`);
        this.chrome = process.env.DESKLINK_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        assert(existsSync(this.chrome), `no Chrome at ${this.chrome}; set DESKLINK_CHROME`);
        const capabilities = JSON.parse(run(this.engine, ['capabilities']));
        assert.equal(capabilities.capture?.grant, 'granted', 'Screen Recording is not granted to the engine');
        assert.equal(capabilities.input?.grant, 'granted', 'Accessibility is not granted to the engine');
        this.display = capabilities.capture.displays.find((d) => d.main);
        if (plan.sleep === 'system' && plan.wake === 'pmset') run('sudo', ['-n', 'true']);
        mkdirSync(plan.out, { recursive: true });
        this.sleepBefore = this.sleepSettingsNow();
        this.keepAwake();

        const { points } = this.display;
        this.fixture = [120, 120, 480, 240];
        assert(points.width >= 600 && points.height >= 360, 'the display is smaller than the soak fixture');
        const keys = join(plan.out, 'fixture-keys.log');
        writeFileSync(keys, '');
        this.keysLog = keys;
        const fixture = this.spawnOwned('close fixture', process.env.DESKLINK_PYTHON ?? 'python3', [join(here, 'mac-soak-fixture.py'), ...this.fixture.map(String), keys]);
        await new Promise((ready, fail) => {
            fixture.stdout.setEncoding('utf8');
            fixture.stdout.on('data', (chunk) => { if (chunk.includes('READY')) ready(); });
            fixture.once('exit', () => fail(new Error(`fixture exited: ${fixture.recent}`)));
            sleep(15_000).then(() => fail(new Error('fixture never became ready')));
        });

        const { createServer: createVite } = await import('vite');
        const vite = await createVite({ root: repo, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
        await vite.listen();
        this.cleanup.add('stop dev server', () => vite.close());

        const ctl = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise((listening) => ctl.once('listening', listening));
        this.cleanup.add('close control socket', () => new Promise((closed) => { ctl.clients.forEach((c) => c.terminate()); ctl.close(closed); }));
        const ready = new Promise((resolveReady) => ctl.once('connection', (socket) => {
            this.socket = socket;
            socket.on('message', (raw) => {
                const message = JSON.parse(String(raw));
                const call = this.calls.get(message.id);
                if (message.ready === true) resolveReady();
                else if (call !== undefined) {
                    this.calls.delete(message.id);
                    if (message.error !== undefined) call.reject(new Error(message.error));
                    else call.resolve(message.result);
                }
            });
        }));

        const port = await freePort();
        const token = randomBytes(24).toString('base64url');
        const bridge = this.spawnOwned('stop bridge', process.execPath, [join(repo, 'packages/desktop-host/bin/desklink-host.mjs'),
            'bridge', '--listen', `127.0.0.1:${port}`, '--token', token, '--source', 'display', '--display-id', String(this.display.id)],
        { env: { ...process.env, DESKLINK_ENGINE: this.engine } });
        this.bridgeUrl = `ws://127.0.0.1:${port}/desktop?token=${encodeURIComponent(token)}`;
        for (let tries = 0; ; tries += 1) {
            assert(bridge.exitCode === null && tries < 100, `bridge did not start: ${bridge.recent}`);
            const up = await new Promise((resolveUp) => { const probe = new WebSocket(this.bridgeUrl); probe.once('open', () => { probe.close(); resolveUp(true); }); probe.once('error', () => resolveUp(false)); });
            if (up) break;
            await sleep(150);
        }

        const profile = mkdtempSync(join(tmpdir(), 'desklink-soak-chrome-'));
        this.cleanup.add('remove Chrome profile', () => rmSync(profile, { recursive: true, force: true }));
        const [fx, fy, fw, fh] = this.fixture;
        const page = `${vite.resolvedUrls.local[0]}packages/desktop-host/test/mac-soak-flow.html?control=${encodeURIComponent(`ws://127.0.0.1:${ctl.address().port}`)}`
            + `&echo=${fx + fw / 2},${fy},${fw / 2},${fh}&fixture=${this.fixture}&points=${points.width},${points.height}&maxFps=${plan.maxFps}`;
        this.spawnOwned('close Chrome', this.chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', page]);
        await Promise.race([ready, sleep(30_000).then(() => { throw new Error('the Chrome client never connected to the driver'); })]);
    }

    call(cmd, args, timeoutMs = 60_000) {
        const id = ++this.nextCall;
        return new Promise((resolveCall, reject) => {
            this.calls.set(id, { resolve: resolveCall, reject });
            this.socket.send(JSON.stringify({ id, cmd, args }));
            sleep(timeoutMs).then(() => { if (this.calls.delete(id)) reject(new Error(`${cmd} timed out after ${timeoutMs} ms`)); });
        });
    }
    connect() { return this.call('connect', { engine: this.bridgeUrl }, 60_000); }
    disconnect() { return this.call('disconnect'); }
    frames() { return this.call('frames'); }
    metrics() { return this.call('metrics'); }
    clipStart() { return this.call('clip_start'); }
    async clipStop(path) {
        writeFileSync(path, Buffer.from(await this.call('clip_stop', {}, 120_000), 'base64'));
        return { path, note: 'the fixture only, as the client presented it' };
    }
    async type(text, gapMs) {
        const before = readFileSync(this.keysLog, 'utf8').split('\n').filter(Boolean).length;
        const result = await this.call('type', { text, gap_ms: gapMs }, 30_000);
        await sleep(200);
        const typed = readFileSync(this.keysLog, 'utf8').split('\n').filter(Boolean).slice(before).map((line) => line.slice(line.indexOf(' ') + 1)).join('');
        return { typed_ok: typed === text, echo_ms: result.echo_ms, rejection: result.rejection };
    }

    /** Sleep the Mac now and return when it is awake again; time asleep is the wall-clock jump. */
    async sleepWake({ sleepS, wake, sleep: kind }) {
        const requested = Date.now();
        if (kind === 'display') {
            // The power log says when the display went off and on; the live power state is not readable here.
            const state = () => run('sh', ['-c', "pmset -g log | grep -E 'Display is turned (on|off)' | tail -n 2"]).trim();
            const before = state();
            run('pmset', ['displaysleepnow']);
            await sleep(2000);
            const during = state();
            await sleep(sleepS * 1000);
            run('caffeinate', ['-u', '-t', '5']);
            await sleep(2000);
            return { requested_at: requested, woke_at: Date.now(), asleep_ms: Date.now() - requested, kind, display_state: { before, during, after: state() }, system_sleep: 'not exercised: needs a human to wake the Mac' };
        }
        let scheduled = null;
        if (wake === 'pmset') {
            scheduled = pmsetDate(new Date(requested + (sleepS + 15) * 1000));
            run('sudo', ['-n', 'pmset', 'schedule', 'wake', scheduled]);
            this.cleanup.add('cancel scheduled wake', () => run('sudo', ['-n', 'pmset', 'schedule', 'cancel', 'wake', scheduled]));
        }
        this.awake.kill('SIGTERM');
        await sleep(500);
        run('pmset', ['sleepnow']);
        const limit = requested + (wake === 'manual' ? 15 * 60_000 : (sleepS + 15) * 1000 + 120_000);
        let last = Date.now();
        for (;;) {
            await sleep(500);
            const now = Date.now();
            if (now - last > 5000) { this.keepAwake(); run('caffeinate', ['-u', '-t', '5']); return { requested_at: requested, woke_at: now, asleep_ms: now - last, wake, scheduled_wake: scheduled }; }
            last = now;
            if (now > limit) { this.keepAwake(); throw new Error('the Mac did not sleep and wake within the limit'); }
        }
    }
}

// ---- main ------------------------------------------------------------------

export async function main(argv) {
    const plan = parseArgs(argv);
    mkdirSync(plan.out, { recursive: true });
    const cleanup = new Cleanup();
    const lab = plan.dryRun ? new FakeLab(plan, cleanup) : new MacLab(plan, cleanup);
    const timeline = {
        schema: 'desklink.mac-soak/1',
        mode: plan.dryRun ? 'dry-run' : 'mac',
        command: `node packages/desktop-host/test/mac-soak-flow.mjs ${argv.join(' ')}`,
        plan: { ...plan, out: undefined },
        started_at: lab.now(), finished_at: null, ok: false, failure: null,
        host: null, phases: [], events: [], markers: [], latency: [], metrics: [], frames: [], recovery: {}, clip: null,
        summary: null, fps_windows: [], cleanup: [], sleep_settings: null,
    };
    const save = () => {
        const { pending } = timeline;
        const snapshot = { ...timeline, frames: undefined, pending: undefined };
        if (pending !== undefined) snapshot.partial = true;
        writeFileSync(join(plan.out, 'timeline.tmp'), `${JSON.stringify(snapshot, null, 1)}\n`);
        renameSync(join(plan.out, 'timeline.tmp'), join(plan.out, 'timeline.json'));
    };
    const stop = async (signal) => { await cleanup.run(); process.exit(signal === 'SIGINT' ? 130 : 143); };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));

    try {
        await runSoak(lab, plan, timeline, save);
        timeline.ok = true;
    } catch (error) {
        timeline.failure = { phase: timeline.pending?.current?.() ?? timeline.phases.at(-1)?.phase ?? 'prepare', message: String(error?.message ?? error) };
    } finally {
        timeline.cleanup = await cleanup.run();
        timeline.host = lab.describe();
        const after = lab.sleepSettingsNow();
        timeline.sleep_settings = { before: timeline.host.sleep_settings_before, after, restored: timeline.host.sleep_settings_before === after };
        timeline.ok &&= timeline.sleep_settings.restored && timeline.cleanup.every((c) => c.ok);
        Object.assign(timeline, summarise(timeline));
        timeline.finished_at = lab.now();
        delete timeline.frames;
        delete timeline.pending;
        save();
    }
    console.log(JSON.stringify({ ok: timeline.ok, failure: timeline.failure, summary: timeline.summary, recovery: timeline.recovery, events: timeline.events.map((e) => e.name), cleanup: timeline.cleanup, sleep_settings_restored: timeline.sleep_settings.restored, timeline: join(plan.out, 'timeline.json') }, null, 1));
    return timeline.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(`mac-soak-flow: ${error.message}`); process.exit(2); });
}
