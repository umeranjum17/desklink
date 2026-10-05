#!/usr/bin/env node
/**
 * Glass-to-glass latency and frame rate through the portal capture path, in a
 * private cage.
 *
 * The Linux desktop path is ScreenCast portal + PipeWire. This flow runs that
 * whole stack task-owned and measures it the way the X11 lab does: a stamp
 * client paints the wall clock into the top-left corner of a fullscreen
 * surface, the engine captures it through the portal, and headless Chrome
 * decodes the stamp from every presented frame.
 *
 * The cage is three namespaces plus private daemons:
 *
 *  - user + mount: `/run/user/$UID` is a fresh tmpfs, so the live session bus,
 *    PipeWire and Wayland sockets do not exist inside; `/dev/dri` holds one
 *    render node and no KMS (card) node, and `/dev/snd` is empty;
 *  - pid: every cage process dies with the cage, whatever path it exits by;
 *  - its own dbus-daemon (no service activation), PipeWire, WirePlumber
 *    (`policy` profile, no hardware monitors), a headless wlroots compositor,
 *    xdg-desktop-portal and xdg-desktop-portal-hyprland, whose picker is a
 *    script that selects the one headless output.
 *
 * Chrome stays outside, on its own profile, with no display variables; it
 * reaches the engine over loopback only. The engine's control protocol is the
 * cage's stdin/stdout.
 *
 * Why sway and not Hyprland: a Hyprland with no parent Wayland session needs a
 * KMS device and a seat, which belong to the live desktop. The portal backend
 * serves any wlroots compositor, and a sway 1.11 (wlroots 0.19) built with no
 * DRM, libinput or session backend runs headless on a render node alone:
 *
 *   meson setup build -Dwlroots:backends= -Dwlroots:session=disabled \
 *     -Dwlroots:renderers=gles2 -Dwlroots:allocators=gbm -Dwlroots:xwayland=disabled
 *
 * The `still` scenario checks refinement: the flow freezes its stamp
 * `--freeze-after` seconds after the measurement window opens (2 by default),
 * so read `engine.refined` — the in-window refinements — there, not the
 * latency.
 *
 * Usage:
 *
 *   node packages/desktop-host/test/portal-g2g-flow.mjs [--size 1920x1080]
 *     [--fps 60] [--scenario typing,scroll,still] [--seconds 15] [--gate]
 *     [--freeze-after 2]
 *   node packages/desktop-host/test/portal-g2g-flow.mjs --cursor-proof
 *     [--background light|dark] [--scale 2]
 *
 * `--cursor-proof` opens a hidden-cursor session, moves the cage's pointer
 * through sway, and checks every session.cursor sample against where the
 * compositor delivered the pointer to the stamp surface, with the hidden
 * frames unchanged and a still cursor producing no new samples.
 * `DESKLINK_CURSOR_EVIDENCE_DIR` keeps the samples and a hidden frame with
 * the cursor redrawn from them.
 *
 * One JSON line per scenario, in the X11 lab's shape plus `source`, `load` and
 * `isolation`. A run counts only when the 1-minute load average is at most
 * nproc/4 before and after it (`load.counts`); `--gate` turns an uncounted run,
 * or a typing run under 50 presented fps, over 50 ms p50, or with no decoded
 * stamps, into a failure.
 *
 * Environment:
 *
 *   DESKLINK_PORTAL_ENGINE  engine binary (else DESKLINK_AXI_ENGINE, else the
 *                           debug build in this checkout)
 *   DESKLINK_PORTAL_STAMP   stamp client (default: examples/wl_stamp_target
 *                           next to the engine binary)
 *   DESKLINK_PORTAL_SWAY    headless compositor binary (default: sway on PATH)
 *   DESKLINK_PORTAL_RENDER_NODE  render node name, e.g. renderD129 (default:
 *                           the first one not bound to the nvidia driver, whose
 *                           24-bit readback the portal's shm path refuses)
 *   DESKLINK_CHROME         browser binary
 *
 * A machine missing any piece skips with a printed reason and a passing exit.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
    realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { assertNoAmbientDesktop } from './lab-safety.mjs';

assertNoAmbientDesktop();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const self = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PORTAL_DIRS = ['/usr/lib', '/usr/libexec'];

function which(name) {
    const found = spawnSync('sh', ['-c', `command -v "$1"`, 'sh', name], { encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : null;
}
const firstFile = (paths) => paths.find((path) => typeof path === 'string' && path !== '' && existsSync(path)) ?? null;

// ---------------------------------------------------------------- inside ----

/**
 * PID 1 of the cage. Starts the private stack, proves isolation, reports one
 * JSON line on stdout, then hands stdin/stdout to the engine. Everything here
 * dies with this process: it is the pid namespace's init.
 */
async function cage(dir) {
    assert.equal(process.pid, 1, 'portal cage must be the init of its private PID namespace');
    const config = JSON.parse(readFileSync(join(dir, 'cage.json'), 'utf8'));
    const runtime = `/run/user/${process.getuid()}`;
    const env = {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        HOME: join(dir, 'home'),
        XDG_RUNTIME_DIR: runtime,
        XDG_CONFIG_HOME: join(dir, 'home/.config'),
        XDG_STATE_HOME: join(dir, 'home/.local/state'),
        XDG_DATA_HOME: join(dir, 'home/.local/share'),
        XDG_CACHE_HOME: join(dir, 'home/.cache'),
        XDG_CURRENT_DESKTOP: 'sway',
        XDG_DESKTOP_PORTAL_DIR: join(dir, 'portals'),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
        // No system bus: nothing in the cage may reach logind or rtkit.
        DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/nonexistent',
        WAYLAND_DISPLAY: '',
        WLR_BACKENDS: 'headless',
        WLR_RENDERER: 'gles2',
        WLR_LIBINPUT_NO_DEVICES: '1',
    };
    const children = [];
    /** A daemon logging to `<dir>/<name>.log`. */
    const start = (name, command, args, childEnv = env) => {
        const out = join(dir, `${name}.log`);
        children.push(spawn('sh', ['-c', 'exec "$@" >"$0" 2>&1', out, command, ...args], { stdio: 'ignore', env: childEnv }));
    };
    const fail = (message) => {
        process.stdout.write(`${JSON.stringify({ cage: 'failed', message })}\n`);
        process.exit(1);
    };
    const until = async (what, test, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (test()) return;
            await sleep(50);
        }
        fail(`${what} did not appear within ${timeoutMs} ms`);
    };
    const busNames = () => {
        const listed = spawnSync('busctl', ['--user', 'list', '--json=short', '--no-pager'], { env, encoding: 'utf8' });
        return listed.status === 0 ? JSON.parse(listed.stdout) : [];
    };

    start('dbus', 'dbus-daemon', [`--config-file=${join(dir, 'bus.conf')}`, '--nofork']);
    await until('the private bus', () => existsSync(`${runtime}/bus`));
    start('pipewire', 'pipewire', []);
    await until('PipeWire', () => existsSync(`${runtime}/pipewire-0`));
    start('wireplumber', 'wireplumber', ['--profile', 'policy']);
    start('sway', config.sway, ['-c', join(dir, 'sway.conf')]);
    let wayland = null;
    await until('the compositor socket', () => {
        wayland = readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name)) ?? null;
        return wayland !== null;
    });
    const client = { ...env, WAYLAND_DISPLAY: wayland };
    if (config.cursorProof) {
        client.SWAYSOCK = join(runtime, readdirSync(runtime).find(n => n.startsWith('sway-ipc.') && n.endsWith('.sock')));
        setInterval(() => {
            const command = join(dir, 'pointer-command');
            if (!existsSync(command)) return;
            const [x,y] = JSON.parse(readFileSync(command,'utf8'));
            const moved = spawnSync(config.swaymsg, ['-s', client.SWAYSOCK, 'seat', 'seat0', 'cursor', 'set', String(x), String(y)], { env:client,encoding:'utf8' });
            writeFileSync(join(dir,'pointer-result'), JSON.stringify({status:moved.status,out:moved.stdout,err:moved.stderr}));
            rmSync(command);
        }, 20);
    }
    const stamp = spawn(config.stamp, ['--mode', config.scenario, '--freeze-file', join(dir, 'freeze'),
        ...(config.cursorProof ? ['--cursor-fixture', '--pointer-log', join(dir, 'pointer.log'), '--background', config.background] : [])], {
        stdio: ['ignore', 'pipe', 'ignore'], env: client,
    });
    children.push(stamp);
    const stampReady = await Promise.race([
        new Promise((done) => createInterface({ input: stamp.stdout }).once('line', (line) => done(JSON.parse(line)))),
        sleep(20_000).then(() => null),
    ]);
    if (stampReady?.ready !== true) fail('the stamp client never mapped');
    start('xdph', config.xdph, [], client);
    await until('the portal backend', () => busNames().some((n) => n.name === 'org.freedesktop.impl.portal.desktop.hyprland'));
    start('portal', config.portal, []);
    await until('the portal', () => busNames().some((n) => n.name === 'org.freedesktop.portal.Desktop'));

    // Isolation evidence, checked here and reported to the harness.
    // The bus reports each peer's PID as seen from this pid namespace; a peer
    // from outside the cage has none here and shows as 0 or no PID at all.
    const peers = busNames().filter((n) => n.name.startsWith(':'));
    const strangers = peers.filter((n) => !(n.pid > 0));
    if (strangers.length > 0) fail(`private bus has foreign peers: ${JSON.stringify(strangers)}`);
    const runtimeEntries = readdirSync(runtime).sort();
    // The same path may name a private socket in here; the ambient one is the
    // same inode, which must not be reachable.
    const ambientVisible = config.ambient.filter(({ path, dev, ino }) => {
        try {
            const seen = statSync(path);
            return seen.dev === dev && seen.ino === ino;
        } catch {
            return false;
        }
    });
    if (ambientVisible.length > 0) fail(`ambient sockets are reachable in the cage: ${ambientVisible.map((a) => a.path).join(', ')}`);
    const dri = readdirSync('/dev/dri');
    if (dri.some((name) => name.startsWith('card'))) fail(`a KMS node is visible: ${dri.join(', ')}`);
    const isolation = {
        bus_names: busNames().map((n) => n.name).filter((name) => !name.startsWith(':')).sort(),
        bus_peers: peers.length,
        foreign_bus_peers: 0,
        runtime_dir: runtimeEntries,
        ambient_sockets_visible: 0,
        dri,
        pid_namespace_init: process.pid === 1,
        wayland_display: wayland,
    };
    process.stdout.write(`${JSON.stringify({ cage: 'ready', isolation })}\n`);

    // The cursor proof's engine asks this cage's compositor for cursor positions.
    const engine = spawn(config.engine, ['serve'], { stdio: 'inherit', env: { ...(config.cursorProof ? client : env), RUST_LOG: 'warn' } });
    const finish = () => {
        for (const child of children) child.kill('SIGKILL');
        process.exit(0);
    };
    engine.on('exit', finish);
    process.on('SIGTERM', () => engine.kill('SIGTERM'));
}

// --------------------------------------------------------------- outside ----

async function main() {
    const option = (name, fallback) => {
        const index = process.argv.indexOf(`--${name}`);
        return index >= 0 ? process.argv[index + 1] : fallback;
    };
    const [width, height] = option('size', '1920x1080').split('x').map(Number);
    const maxFps = Number(option('fps', '60'));
    const seconds = Number(option('seconds', '15'));
    const freezeAfter = Number(option('freeze-after', '2'));
    const scenarios = (process.argv.includes('--cursor-proof') ? 'still' : option('scenario', 'typing,scroll')).split(',');
    const gate = process.argv.includes('--gate');
    assert(width > 0 && height > 0 && maxFps > 0 && seconds > 0, 'bad --size, --fps or --seconds');
    assert(Number.isInteger(freezeAfter) && freezeAfter > 0, 'bad --freeze-after');
    assert(!scenarios.includes('still') || freezeAfter < seconds, 'bad --freeze-after (must fall inside --seconds for still)');
    assert(scenarios.every((s) => ['typing', 'scroll', 'still'].includes(s)), '--scenario is typing, scroll or still');

    const skip = (reason) => {
        console.log(`skipped: ${reason}`);
        process.exit(0);
    };
    if (process.platform !== 'linux') skip('the portal lab is Linux only');
    const engine = firstFile([
        process.env.DESKLINK_PORTAL_ENGINE,
        process.env.DESKLINK_AXI_ENGINE,
        join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'),
    ]);
    if (engine === null) skip('no engine binary (set DESKLINK_PORTAL_ENGINE)');
    const stamp = firstFile([process.env.DESKLINK_PORTAL_STAMP, join(dirname(engine), 'examples/wl_stamp_target')]);
    if (stamp === null) skip('no stamp client (cargo build --example wl_stamp_target, or set DESKLINK_PORTAL_STAMP)');
    const sway = process.env.DESKLINK_PORTAL_SWAY || which('sway');
    const portal = firstFile(PORTAL_DIRS.map((d) => `${d}/xdg-desktop-portal`));
    const xdph = firstFile(PORTAL_DIRS.map((d) => `${d}/xdg-desktop-portal-hyprland`));
    const portalFile = firstFile(['/usr/share/xdg-desktop-portal/portals/hyprland.portal']);
    if (portalFile === null) skip('hyprland.portal is not installed');
    const chrome = firstFile([process.env.DESKLINK_CHROME]) ?? ['google-chrome-stable', 'google-chrome', 'chromium'].map(which).find(Boolean) ?? null;
    const missing = [
        ['unshare', which('unshare')], ['dbus-daemon', which('dbus-daemon')], ['busctl', which('busctl')],
        ['pipewire', which('pipewire')], ['wireplumber', which('wireplumber')], ['sway', sway],
        ['xdg-desktop-portal', portal], ['xdg-desktop-portal-hyprland', xdph], ['chrome', chrome],
    ].filter(([, found]) => !found).map(([name]) => name);
    if (missing.length > 0) skip(`missing ${missing.join(', ')}`);
    if (spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true']).status !== 0) {
        skip('unprivileged user namespaces are not available');
    }
    let driEntries = [];
    try {
        driEntries = readdirSync('/dev/dri');
    } catch {
        driEntries = [];
    }
    const renderNode = process.env.DESKLINK_PORTAL_RENDER_NODE || driEntries.filter((n) => n.startsWith('renderD')).sort()
        .find((n) => {
            try {
                return basename(readlinkSync(`/sys/class/drm/${n}/device/driver`)) !== 'nvidia';
            } catch {
                return false;
            }
        });
    if (!renderNode) skip('no usable render node (set DESKLINK_PORTAL_RENDER_NODE)');

    const limit = availableParallelism() / 4;
    let failed = false;
    for (const scenario of scenarios) {
        const before = loadavg()[0];
        const result = await measure({
            engine, stamp, sway, portal, xdph, portalFile, chrome, renderNode, width, height, maxFps, seconds, scenario, freezeAfter,
            embeddedControl: process.argv.includes('--embedded-control'),
            cursorProof: process.argv.includes('--cursor-proof'), background: option('background', 'light'), scale: Number(option('scale', '1')), swaymsg: process.env.DESKLINK_PORTAL_SWAYMSG || which('swaymsg'),
        });
        const after = loadavg()[0];
        result.load = {
            before: round(before), after: round(after), limit, counts: before <= limit && after <= limit,
        };
        console.log(JSON.stringify(result));
        if (gate && !result.load.counts) {
            console.error(`FAIL ${scenario}: load ${result.load.before}/${result.load.after} is over ${limit}`);
            failed = true;
        }
        if (process.argv.includes('--cursor-proof')) continue;
        const measured = result.g2g_ms.n > 0 && Number.isFinite(result.g2g_ms.p50);
        if (gate && scenario === 'typing' && !(measured && result.presented_fps >= 50 && result.g2g_ms.p50 <= 50)) {
            console.error(`FAIL typing: ${result.presented_fps} fps presented, p50 ${result.g2g_ms.p50} ms over ${result.g2g_ms.n} decoded stamps`);
            failed = true;
        }
    }
    process.exit(failed ? 1 : 0);
}

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

async function measure(run) {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-portal-lab-'));
    const cleanup = [() => rmSync(dir, { recursive: true, force: true })];
    try {
        writeCage(dir, run);
        const uid = process.getuid();
        const gid = process.getgid();
        // As root of a fresh user namespace: mask what the cage must not see,
        // then drop to the caller's own ids in a nested one.
        const setup = [
            'set -e',
            'ulimit -c 0',
            `touch "${dir}/render"`,
            `mount --bind "/dev/dri/${run.renderNode}" "${dir}/render"`,
            'mount -t tmpfs -o mode=755 tmpfs /dev/dri',
            `touch "/dev/dri/${run.renderNode}"`,
            `mount --bind "${dir}/render" "/dev/dri/${run.renderNode}"`,
            '[ ! -d /dev/snd ] || mount -t tmpfs tmpfs /dev/snd',
            `mount -t tmpfs -o mode=700,uid=0,gid=0 tmpfs /run/user/${uid}`,
            `exec unshare --user --map-user=${uid} --map-group=${gid} -- "${process.execPath}" "${self}" --cage "${dir}"`,
        ].join('\n');
        const child = spawn('unshare', [
            '--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc', '--', 'sh', '-c', setup,
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-4000);
        });
        const exited = new Promise((done) => child.once('exit', done));
        cleanup.unshift(async () => {
            child.kill('SIGKILL');
            await exited;
        });

        const lines = createInterface({ input: child.stdout });
        const first = await Promise.race([
            new Promise((done) => lines.once('line', (line) => done(JSON.parse(line)))),
            exited.then((code) => ({ cage: 'failed', message: `the cage exited ${code}: ${stderr.slice(-800)}` })),
            sleep(90_000).then(() => ({ cage: 'failed', message: 'the cage did not come up within 90 s' })),
        ]);
        if (first.cage !== 'ready') throw new Error(`${first.message}\n${tailLogs(dir)}`);
        // The cage's pid namespace: once its init is gone, nothing may be left in it.
        const init = Number(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/)[0]);
        const namespace = readlinkSync(`/proc/${init}/ns/pid`);
        cleanup.push(async () => {
            const survivors = () => readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
                try {
                    return readlinkSync(`/proc/${pid}/ns/pid`) === namespace;
                } catch {
                    return false;
                }
            });
            // The kernel reaps a dead namespace's processes asynchronously.
            for (let i = 0; i < 60 && survivors().length > 0; i++) await sleep(50);
            assert.deepEqual(survivors(), [], 'cage processes survived their namespace');
        });
        const engine = new Engine(child, lines);
        await engine.request('hello', { protocol: 3 });
        if (run.cursorProof) return {...await cursorProof(engine, dir, run), isolation:first.isolation};

        const browser = await startChrome(run.chrome);
        cleanup.unshift(() => browser.close());
        await browser.evaluate(PAGE);

        let sessionId = null;
        let generation = 1;
        engine.on((event) => {
            if (event.event === 'session.description' && event.params.description.type === 'offer') {
                browser.evaluate(`window.__g2g.answer(${JSON.stringify(event.params.description.sdp)})`)
                    .then((sdp) => engine.request('session.description', {
                        session_id: sessionId, generation, description: { type: 'answer', sdp },
                    }))
                    .catch((error) => console.error(`answer failed: ${error.message}`));
            } else if (event.event === 'session.candidate') {
                browser.evaluate(`window.__g2g.candidate(${JSON.stringify({
                    candidate: event.params.candidate, sdpMid: event.params.sdpMid, sdpMLineIndex: event.params.sdpMLineIndex,
                })})`).catch(() => {});
            }
        });
        const opened = await engine.request('session.open', {
            source: { kind: 'portal' },

            max_width: run.width,
            max_height: run.height,
            max_fps: run.maxFps,
        }, 60_000);
        sessionId = opened.sessionId;
        generation = opened.generation;
        const encoded = opened.geometry.encoded;
        await browser.until('window.__g2g.frames > 0', 30_000, 'a first presented frame');
        await browser.evaluate(`window.__g2g.begin(${opened.geometry.source.width})`);
        const metricsStart = await engine.request('session.metrics', { session_id: sessionId });
        const windowAt = Date.now();
        if (run.scenario === 'still') {
            await sleep(run.freezeAfter * 1000);
            writeFileSync(join(dir, 'freeze'), '');
        }
        await sleep(run.seconds * 1000 - (Date.now() - windowAt));
        const page = await browser.evaluate('window.__g2g.report()');
        const metrics = await engine.request('session.metrics', { session_id: sessionId });
        const elapsed = (Date.now() - windowAt) / 1000;
        await engine.request('session.close', { session_id: sessionId }).catch(() => {});

        return {
            source: 'portal',
            size: `${run.width}x${run.height}`,
            max_fps: run.maxFps,
            mode: run.scenario,
            encoded: { height: encoded.height, width: encoded.width },
            presented_fps: page.presented_fps,
            frame_interval_p95_ms: page.frame_interval_p95_ms,
            g2g_ms: page.g2g_ms,
            engine: {
                encoded_frames: metrics.encoded_frames - metricsStart.encoded_frames,
                captured_frames: metrics.captured_frames - metricsStart.captured_frames,
                dropped_frames: metrics.dropped_frames - metricsStart.dropped_frames,
                refined: metrics.refined_frames - metricsStart.refined_frames,
                encode_ms_mean: round((metrics.encode_micros - metricsStart.encode_micros)
                    / Math.max(1, metrics.encoded_frames - metricsStart.encoded_frames) / 1000, 2),
                kbps_target: metrics.target_kbps,
                mbps_actual: round((metrics.encoded_bytes - metricsStart.encoded_bytes) * 8 / elapsed / 1e6, 2),
                captured_fps: round((metrics.captured_frames - metricsStart.captured_frames) / elapsed),
                encoded_fps: round((metrics.encoded_frames - metricsStart.encoded_frames) / elapsed),
            },
            receiver: page.receiver,
            isolation: first.isolation,
        };
    } finally {
        for (const step of cleanup) await step();
    }
}

function writeCage(dir, run) {
    for (const leaf of ['home/.config/hypr', 'home/.config/xdg-desktop-portal', 'portals', 'services']) {
        mkdirSync(join(dir, leaf), { recursive: true });
    }
    const ambient = [process.env.DBUS_SESSION_BUS_ADDRESS?.match(/unix:path=([^,;]+)/)?.[1]];
    for (const name of ['bus', 'pipewire-0', 'pipewire-0-manager', 'wayland-0', 'wayland-1', process.env.WAYLAND_DISPLAY]) {
        if (name) ambient.push(name.startsWith('/') ? name : `/run/user/${process.getuid()}/${name}`);
    }
    writeFileSync(join(dir, 'cage.json'), JSON.stringify({
        scenario: run.scenario, engine: realpathSync(run.engine), stamp: realpathSync(run.stamp), sway: run.sway,
        portal: run.portal, xdph: run.xdph, cursorProof: run.cursorProof, background: run.background, swaymsg: run.swaymsg,
        ambient: ambient.filter((path) => path && existsSync(path)).map((path) => {
            const { dev, ino } = statSync(path);
            return { path, dev, ino };
        }),
    }));
    // No service directory content: nothing on this bus is activated on demand.
    writeFileSync(join(dir, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=/run/user/${process.getuid()}/bus</listen>
  <servicedir>${join(dir, 'services')}</servicedir>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
`);
    writeFileSync(join(dir, 'sway.conf'), [
        `output HEADLESS-1 mode ${run.width}x${run.height}@60Hz position 0 0 scale ${run.scale}`,
        'default_border none',
        ...(run.cursorProof ? ['seat seat0 fallback true'] : []),
        'swaybg_command -',
        '',
    ].join('\n'));
    // The consent step, answered by the lab: share the one headless output.
    const picker = join(dir, 'picker.sh');
    writeFileSync(picker, '#!/bin/sh\necho "[SELECTION]/screen:HEADLESS-1"\n');
    chmodSync(picker, 0o755);
    writeFileSync(join(dir, 'home/.config/hypr/xdph.conf'), `screencopy {\n  custom_picker_binary = ${picker}\n  max_fps = 60\n}\n`);
    writeFileSync(join(dir, 'home/.config/xdg-desktop-portal/portals.conf'), '[preferred]\ndefault=hyprland\n');
    copyFileSync(run.portalFile, join(dir, 'portals/hyprland.portal'));
}

function tailLogs(dir) {
    return readdirSync(dir).filter((name) => name.endsWith('.log')).map((name) => {
        const text = readFileSync(join(dir, name), 'utf8').trim().split('\n').slice(-6).join('\n  ');
        return `${name}:\n  ${text}`;
    }).join('\n');
}

/** The engine's control protocol over the cage's stdin/stdout. */
class Engine {
    constructor(child, lines) {
        this.child = child;
        this.next = 0;
        this.pending = new Map();
        this.listeners = [];
        lines.on('line', (line) => {
            if (line.trim() === '') return;
            const message = JSON.parse(line);
            if (message.id === undefined) {
                for (const listener of this.listeners) listener(message);
                return;
            }
            const waiting = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) waiting?.reject(new Error(`${message.error.code}: ${message.error.message}`));
            else waiting?.resolve(message.result);
        });
    }

    on(listener) {
        this.listeners.push(listener);
    }

    request(method, params, timeoutMs = 15_000) {
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
    }
}

/**
 * The receiver. It answers offers, decodes the stamp on every presented frame
 * (`requestVideoFrameCallback`), and reports the X11 lab's numbers.
 */
const PAGE = `(() => {
    const pc = new RTCPeerConnection();
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    document.body.appendChild(video);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const state = { frames: 0, measuring: false, sourceWidth: 0, times: [], g2g: [], undecoded: 0 };
    let pending = [];
    pc.ontrack = (event) => { video.srcObject = new MediaStream([event.track]); video.play().catch(() => {}); };
    const onFrame = (now, meta) => {
        state.frames++;
        if (state.measuring && video.videoWidth > 0) {
            state.times.push(now);
            const scale = video.videoWidth / state.sourceWidth;
            const strip = Math.ceil(48 * scale);
            canvas.width = video.videoWidth; canvas.height = strip;
            context.drawImage(video, 0, 0, video.videoWidth, strip, 0, 0, video.videoWidth, strip);
            const pixels = context.getImageData(0, 0, canvas.width, strip).data;
            let stamp = 0;
            for (let bit = 0; bit < 24; bit++) {
                const x = Math.floor((bit * 48 + 24) * scale), y = Math.floor(24 * scale);
                stamp = stamp * 2 + (pixels[(y * canvas.width + x) * 4 + 1] > 127 ? 1 : 0);
            }
            const shown = Math.round(performance.timeOrigin + meta.expectedDisplayTime) & 0xffffff;
            const age = (shown - stamp + 0x1000000) % 0x1000000;
            if (age < 5000) state.g2g.push(age); else state.undecoded++;
        }
        video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    const pct = (values, p) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
    };
    window.__g2g = {
        get frames() { return state.frames; },
        async answer(sdp) {
            await pc.setRemoteDescription({ type: 'offer', sdp });
            for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
            await pc.setLocalDescription(await pc.createAnswer());
            await new Promise((done) => {
                if (pc.iceGatheringState === 'complete') return done();
                pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && done());
                setTimeout(done, 2000);
            });
            return pc.localDescription.sdp;
        },
        async candidate(candidate) {
            if (pc.remoteDescription === null) pending.push(candidate);
            else await pc.addIceCandidate(candidate).catch(() => {});
        },
        async begin(sourceWidth) {
            state.sourceWidth = sourceWidth;
            state.start = await this.stats();
            state.measuring = true;
        },
        async stats() {
            const stats = await pc.getStats();
            for (const report of stats.values()) if (report.type === 'inbound-rtp' && report.kind === 'video') return report;
            return {};
        },
        async report() {
            state.measuring = false;
            const end = await this.stats(), start = state.start;
            const delta = (key) => (end[key] ?? 0) - (start[key] ?? 0);
            const intervals = state.times.slice(1).map((t, i) => t - state.times[i]);
            const span = (state.times.at(-1) - state.times[0]) / 1000;
            const round = (v, n = 1) => v === null ? null : Math.round(v * 10 ** n) / 10 ** n;
            return {
                presented_fps: round(state.times.length > 1 ? (state.times.length - 1) / span : 0),
                frame_interval_p95_ms: round(pct(intervals, 95)),
                g2g_ms: { p50: pct(state.g2g, 50), p95: pct(state.g2g, 95), max: state.g2g.length ? Math.max(...state.g2g) : null,
                    n: state.g2g.length, undecoded: state.undecoded },
                receiver: {
                    decoded: delta('framesDecoded'), dropped: delta('framesDropped'),
                    decode_ms_mean: round(delta('totalDecodeTime') / Math.max(1, delta('framesDecoded')) * 1000, 2),
                    jitter_buffer_ms_mean: round(delta('jitterBufferDelay') / Math.max(1, delta('jitterBufferEmittedCount')) * 1000, 1),
                },
            };
        },
    };
})()`;

/** Headless Chrome over CDP, on its own profile, with no display variables. */
async function startChrome(binary) {
    const profile = mkdtempSync(join(tmpdir(), 'desklink-portal-chrome-'));
    const env = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const chrome = spawn(binary, [
        '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], env });
    let stderr = '';
    chrome.stderr.setEncoding('utf8');
    chrome.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const exited = new Promise((done) => chrome.once('exit', done));
    const portFile = join(profile, 'DevToolsActivePort');
    let port = null;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && port === null; await sleep(100)) {
        if (existsSync(portFile)) port = Number.parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10) || null;
    }
    const close = async () => {
        chrome.kill('SIGKILL');
        await exited;
        rmSync(profile, { recursive: true, force: true });
    };
    if (port === null) {
        await close();
        throw new Error(`Chrome never opened a debugging port: ${stderr.slice(-400)}`);
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((open, fail) => { socket.once('open', open); socket.once('error', fail); });
    let next = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const waiting = pending.get(message.id);
        if (waiting === undefined) return;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolveSend, rejectSend) => {
        const id = ++next;
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails !== undefined) {
            throw new Error(`the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        }
        return result.result.value;
    };
    return {
        evaluate,
        async until(expression, timeoutMs, what) {
            for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(120)) {
                if (await evaluate(expression)) return;
            }
            throw new Error(`timed out waiting for ${what}`);
        },
        async close() {
            // A graceful close lets Chrome remove its own temporary files.
            await Promise.race([send('Browser.close').catch(() => {}), sleep(3000)]);
            socket.close();
            await Promise.race([exited, sleep(3000)]);
            await close();
        },
    };
}

// Last, so every class and constant above is initialised.
if (process.argv[2] === '--cage') await cage(process.argv[3]);
else await main();

// Run only inside the namespace cage above; no ambient Wayland socket or input.
async function cursorProof(engine, dir, run) {
    const events = [];
    engine.on(event => events.push(event));
    const move = async (x,y) => {
        const result = join(dir,'pointer-result');
        rmSync(result,{force:true});
        writeFileSync(join(dir,'pointer-command'), JSON.stringify([x,y]));
        for(let i=0;i<200 && !existsSync(result);i++) await sleep(20);
        assert(existsSync(result),'private compositor did not move pointer');
        const moved = JSON.parse(readFileSync(result,'utf8'));
        assert.equal(moved.status,0,JSON.stringify(moved));
        await sleep(300);
    };
    if (run.embeddedControl) {
        const embedded = await engine.request('session.open', {source:{kind:'portal'},max_width:run.width,max_height:run.height},60000);
        writeFileSync(join(dir,'freeze'),'');
        await sleep(500);
        await move(100,100);
        const before = await engine.request('session.frame',{session_id:embedded.sessionId,path:join(dir,'embedded-before.raw')});
        await move(400,300);
        const after = await engine.request('session.frame',{session_id:embedded.sessionId,path:join(dir,'embedded-after.raw')});
        const equal = readFileSync(join(dir,'embedded-before.raw')).equals(readFileSync(join(dir,'embedded-after.raw')));
        console.error(JSON.stringify({embedded_control:true,engine:run.engine,before_seq:before.seq,after_seq:after.seq,pixels_equal:equal}));
        await engine.request('session.close',{session_id:embedded.sessionId});
        assert(after.seq>before.seq && !equal,'positive control: embedded cursor did not damage frames');
        return {source:'portal',embedded_pixels:'changed on pointer motion'};
    }
    // Where the compositor actually delivers the pointer: the fullscreen stamp
    // surface at the output origin logs each wl_pointer position it receives,
    // in logical pixels; session.cursor speaks the source's own geometry.
    const truth = () => {
        const lines = readFileSync(join(dir, 'pointer.log'), 'utf8').trim().split('\n');
        const {x, y} = JSON.parse(lines.at(-1));
        const {width, height} = hidden.geometry.source;
        return {x: Math.floor(x * width / logicalW), y: Math.floor(y * height / logicalH)};
    };
    const cursorEvents = () => events.filter(e => e.event === 'session.cursor' && e.params.sessionId === hidden.sessionId).map(e => e.params);
    // Layout coordinates are logical: the output is its mode over its scale.
    const [logicalW, logicalH] = [run.width / run.scale, run.height / run.scale];
    const hidden = await engine.request('session.open', {source:{kind:'portal'},cursor:'hidden',max_width:run.width,max_height:run.height}, 60000);
    assert.equal(hidden.cursor.source, 'ext-image-copy-capture-v1');
    assert.equal(hidden.cursor.positions, true, JSON.stringify(hidden.cursor));
    writeFileSync(join(dir,'freeze'),'');
    await sleep(500);
    await move(100,100);
    const frame = await engine.request('session.frame',{session_id:hidden.sessionId,path:join(dir,'hidden-before.raw')});
    const samples = [];
    for(const [x,y] of [[400,300],[700,500]].map(([x,y]) => [x / run.scale, y / run.scale]).concat([[logicalW-60,logicalH-40]])) {
        await move(x,y);
        const after = await engine.request('session.frame',{session_id:hidden.sessionId,path:join(dir,'hidden-after.raw')});
        assert.equal(after.seq,frame.seq,'pointer motion damaged hidden frames');
        assert.deepEqual(readFileSync(join(dir,'hidden-before.raw')),readFileSync(join(dir,'hidden-after.raw')));
        const actual = truth(), delivered = cursorEvents().at(-1);
        assert(actual.x !== 0 && actual.y !== 0, 'the lab pointer never left the origin');
        assert.deepEqual({x: delivered.x, y: delivered.y, visible: delivered.visible}, {...actual, visible: true}, 'delivered cursor is not where the compositor put the pointer');
        // The stamp's cursor surface sets hotspot (4,6) in logical pixels.
        const {width, height} = hidden.geometry.source;
        assert.deepEqual(delivered.hotspot, {x: Math.floor(4 * width / logicalW), y: Math.floor(6 * height / logicalH)}, 'hotspot is not the one the cursor surface set');
        samples.push({commanded:[x,y], actual, delivered});
    }
    // Still cursor: the compositor goes quiet and the last position stands.
    const before = cursorEvents().length;
    await sleep(2000);
    assert.equal(cursorEvents().length, before, 'a still cursor produced new positions');
    const stamps = cursorEvents().map(e => e.timestamp_us);
    assert(stamps.every((t, i) => i === 0 || stamps[i - 1] <= t), 'cursor timestamps went backwards');
    if(process.env.DESKLINK_CURSOR_EVIDENCE_DIR) {
        const out = process.env.DESKLINK_CURSOR_EVIDENCE_DIR;
        writeFileSync(join(out, `cursor-events-${run.background}-scale${run.scale}.json`), JSON.stringify({open: hidden.cursor, samples, events: cursorEvents()}, null, 1));
        // The hidden frame, with the cursor redrawn as a crosshair from the
        // last delivered sample: the pixels themselves never contain it.
        const {PNG}=await import('pngjs');
        const raw=readFileSync(join(dir,'hidden-before.raw'));
        const png=new PNG({width:frame.width,height:frame.height});
        for(let i=0;i<frame.width*frame.height;i++) {png.data[i*4]=raw[i*4+2];png.data[i*4+1]=raw[i*4+1];png.data[i*4+2]=raw[i*4];png.data[i*4+3]=255;}
        const last = samples.at(-1).delivered, {width, height} = hidden.geometry.source;
        const sx = frame.width / width, sy = frame.height / height;
        for (let d = -12; d <= 12; d++) for (const [px, py] of [[last.x + d, last.y], [last.x, last.y + d]]) {
            const x = Math.floor(px * sx), y = Math.floor(py * sy);
            if (x >= 0 && y >= 0 && x < frame.width && y < frame.height) png.data.set([255, 0, 160, 255], (y * frame.width + x) * 4);
        }
        writeFileSync(join(out,`portal-hidden-${run.background}-scale${run.scale}.png`),PNG.sync.write(png));
    }
    await engine.request('session.close',{session_id:hidden.sessionId});
    return {source:'portal',cursor:hidden.cursor,cursor_events:cursorEvents().length,samples,hidden_pixels:'unchanged on pointer motion'};
}
