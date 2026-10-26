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
 *   node packages/desktop-host/test/portal-g2g-flow.mjs --input-proof
 *   node packages/desktop-host/test/portal-g2g-flow.mjs --cursor-proof
 *     [--background light|dark] [--scale 2]
 *   node packages/desktop-host/test/portal-g2g-flow.mjs --hyprland-input-proof
 *     [--hyprland-config lua|legacy] [--scale 2]
 *   node packages/desktop-host/test/portal-g2g-flow.mjs --wayland-qual
 *     (DESKLINK_QUAL_EVIDENCE_DIR names an absolute directory)
 *
 * `--input-proof` shares one window, then the output, through
 * xdg-desktop-portal-wlr and taps each over the control channel: the window's
 * tap is refused with a typed reason (its desktop origin is unknown), the
 * monitor's takes its usual path. `/dev/uinput` is masked in every cage, so no
 * input reaches any desktop. xdph cannot share a window on sway, and stock
 * xdpw 0.8.4 sends no `size` for a window stream (which the engine needs), so
 * `DESKLINK_PORTAL_XDPW` names an xdpw 0.8.4 built with a window size added the
 * way xdph reports it: in `xdpw_impl_screencast_start`'s stream properties, an
 * `else if (cast->current_constraints.width > 0)` branch after the output one
 * appending `"size", "(ii)", current_constraints.width, .height`; then
 * `meson setup build -Dman-pages=disabled -Dsd-bus-provider=libsystemd`.
 * `wlr.portal` is read from `../share/xdg-desktop-portal/portals/` beside it.
 *
 * `--hyprland-input-proof` runs the real Hyprland, headless on the render node
 * with no Wayland parent, in place of sway, and shares windows through xdph:
 * a tap on a shared window lands on that window's point (Hyprland's
 * `cursorpos`, and the window's own pointer log), still after the window has
 * moved; a window two windows look like, or one on a hidden workspace, is
 * refused; a monitor share keeps its path. A capture of the lab output (grim)
 * shows each tap's agent cue, and the agent's point, drawn on the desktop
 * point the tap landed on. A tap landing on another output moves the cue
 * helper onto it (respawned with the landed origin through the point
 * helper's output selection, edge glow with it); a tap on the helper's own
 * output reuses it, and closing the session reaps every helper.
 * `DESKLINK_CUE_EVIDENCE_DIR` keeps those captures.
 *
 * `--wayland-qual` proves a live monitor share, pointer input on a full-output
 * window share, the agent cue on the lab output but not in the shared stream,
 * and a side-by-side mp4, then records the layer-shell probe with and without
 * layer-shell. `DESKLINK_QUAL_EVIDENCE_DIR` keeps the stills and recording.
 *
 * Hyprland 0.56's headless backend has
 * no allocator of its own, so `DESKLINK_PORTAL_AQUAMARINE` names a directory
 * holding an aquamarine of the same version built with one lab patch: in
 * `src/backend/Headless.cpp`, `drmFD()` and `drmRenderNodeFD()` return a node
 * opened from `AQ_HEADLESS_RENDER_NODE` (once, kept) instead of -1. Its
 * `/run/user/$UID` is a directory in the lab, so Hyprland's sockets are lab
 * files the cage checks, and the ambient Hyprland's sockets are unreachable.
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
 *   DESKLINK_PORTAL_SWAYMSG swaymsg for the input proof's chooser (default: on PATH)
 *   DESKLINK_PORTAL_XDPW    xdg-desktop-portal-wlr for --input-proof (see above)
 *   DESKLINK_PORTAL_HYPRLAND  Hyprland for --hyprland-input-proof (default: on PATH)
 *   DESKLINK_PORTAL_AQUAMARINE  the lab aquamarine's library directory (see above)
 *   DESKLINK_PORTAL_RENDER_NODE  render node name, e.g. renderD129 (default:
 *                           the first one not bound to the nvidia driver, whose
 *                           24-bit readback the portal's shm path refuses)
 *   DESKLINK_CHROME         browser binary
 *
 * A machine missing any piece skips with a printed reason and a passing exit.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import {
    chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
    openSync, realpathSync, rmSync, statSync, writeFileSync,
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
        XDG_CURRENT_DESKTOP: config.hyprland ? 'Hyprland' : 'sway',
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
    let hyprland = null;
    if (config.hyprland) {
        start('hyprland', config.hyprland, ['-c', join(dir, config.hyprlandConfig)], {
            ...env, AQ_HEADLESS_RENDER_NODE: `/dev/dri/${config.renderNode}`, LD_LIBRARY_PATH: config.aquamarine,
        });
        await until('the Hyprland control socket', () => {
            const sig = existsSync(`${runtime}/hypr`) ? readdirSync(`${runtime}/hypr`)[0] : undefined;
            if (sig && [".socket.sock", ".socket2.sock"].every((leaf) => existsSync(`${runtime}/hypr/${sig}/${leaf}`))) hyprland = sig;
            return hyprland !== null;
        });
        // The engine's Hyprland is a file in the lab directory, and only it.
        const inLab = (leaf) => {
            const seen = statSync(`${runtime}/hypr/${hyprland}/${leaf}`), lab = statSync(join(dir, 'run/hypr', hyprland, leaf));
            return seen.dev === lab.dev && seen.ino === lab.ino;
        };
        if (!inLab('.socket.sock') || !inLab('.socket2.sock')) fail('the Hyprland sockets are not the lab directory\'s');
    } else {
        start('sway', config.sway, ['-c', join(dir, 'sway.conf')]);
    }
    const hyprEnv = { ...env, HYPRLAND_INSTANCE_SIGNATURE: hyprland ?? '' };
    const hyprctl = (args) => spawnSync('hyprctl', args, { env: hyprEnv, encoding: 'utf8' });
    if (hyprland && !/^ok/.test(hyprctl(['output', 'create', 'headless', 'HEADLESS-1']).stdout)) fail('Hyprland made no headless output');
    let wayland = null;
    await until('the compositor socket', () => {
        wayland = readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name)) ?? null;
        return wayland !== null;
    });
    const client = { ...(hyprland ? hyprEnv : env), WAYLAND_DISPLAY: wayland };
    if (config.cursorProof || config.xdpw) {
        client.SWAYSOCK = join(runtime, readdirSync(runtime).find(n => n.startsWith('sway-ipc.') && n.endsWith('.sock')));
    }
    if (config.cursorProof) {
        setInterval(() => {
            const command = join(dir, 'pointer-command');
            if (!existsSync(command)) return;
            const [x,y] = JSON.parse(readFileSync(command,'utf8'));
            const moved = spawnSync(config.swaymsg, ['-s', client.SWAYSOCK, 'seat', 'seat0', 'cursor', 'set', String(x), String(y)], { env:client,encoding:'utf8' });
            writeFileSync(join(dir,'pointer-result'), JSON.stringify({status:moved.status,out:moved.stdout,err:moved.stderr}));
            rmSync(command);
        }, 20);
    }
    if (hyprland) {
        // The harness asks for Hyprland's state and moves windows through the
        // cage, whose `hyprctl` reaches only the lab's instance.
        setInterval(() => {
            const command = join(dir, 'hypr-command');
            if (!existsSync(command)) return;
            const results = JSON.parse(readFileSync(command, 'utf8')).map((args) => {
                // `grim` captures a lab output, to see what the overlays drew.
                if (args[0] === 'grim') {
                    const ran = spawnSync('grim', args.slice(1), { env: client, encoding: 'utf8' });
                    return { status: ran.status, out: ran.stdout, err: ran.stderr };
                }
                // `helpers` lists the engine's overlay processes, to prove a
                // cross-output move respawns one helper (new pid, old reaped)
                // and a same-output tap reuses it (same pid, no leak).
                if (args[0] === 'helpers') {
                    const pids = { agent: [], point: [] };
                    for (const pid of readdirSync('/proc')) {
                        if (!/^\d+$/.test(pid)) continue;
                        let cmd = '';
                        try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
                        if (cmd.includes('agent-overlay-wayland')) pids.agent.push(Number(pid));
                        if (cmd.includes('point-overlay-wayland')) pids.point.push(Number(pid));
                    }
                    return { status: 0, out: JSON.stringify(pids), err: '' };
                }
                // The real helper's layer-shell discovery against this cage.
                if (args[0] === 'probe') {
                    const ran = spawnSync(config.engine, ['point-layer-shell-probe'], { env: client, encoding: 'utf8' });
                    return { status: ran.status, out: ran.stdout.trim(), err: ran.stderr.trim() };
                }
                const ran = hyprctl(args);
                return { status: ran.status, out: ran.stdout, err: ran.stderr };
            });
            rmSync(command);
            writeFileSync(join(dir, 'hypr-result'), JSON.stringify(results));
        }, 20);
    }
    // One window to share, two that look alike; the qualification proof shares
    // one full-output window to compare the cue with the client at once.
    const stamps = hyprland
        ? (config.qual
            ? [['Umer notes', `${config.width}x${config.height}`, ['--cursor-fixture', '--pointer-log', join(dir, 'pointer.log'), '--background', 'dark']]]
            : [['Umer notes', '480x300', ['--cursor-fixture', '--pointer-log', join(dir, 'pointer.log')]], ['Umer twin', '320x200', []], ['Umer twin', '320x200', []]])
            .map(([title, size, extra]) => ['--title', title, '--window', size, ...extra])
        : [config.cursorProof ? ['--cursor-fixture', '--pointer-log', join(dir, 'pointer.log'), '--background', config.background] : []];
    for (const extra of stamps) {
        const stamp = spawn(config.stamp, ['--mode', config.scenario, '--freeze-file', join(dir, 'freeze'), ...extra], {
            stdio: ['ignore', 'pipe', 'ignore'], env: client,
        });
        children.push(stamp);
        const stampReady = await Promise.race([
            new Promise((done) => createInterface({ input: stamp.stdout }).once('line', (line) => done(JSON.parse(line)))),
            sleep(20_000).then(() => null),
        ]);
        if (stampReady?.ready !== true) fail('the stamp client never mapped');
    }
    if (config.xdpw) {
        // The input proof shares a single window, which xdg-desktop-portal-wlr
        // offers on sway; xdph's window sharing needs Hyprland itself.
        start('xdpw', config.xdpw, [], client);
        await until('the portal backend', () => busNames().some((n) => n.name === 'org.freedesktop.impl.portal.desktop.wlr'));
    } else {
        start('xdph', config.xdph, [], client);
        await until('the portal backend', () => busNames().some((n) => n.name === 'org.freedesktop.impl.portal.desktop.hyprland'));
    }
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
    // uinput devices are host-wide: one made in here would reach the live desktop.
    let uinput = 'absent';
    try {
        closeSync(openSync('/dev/uinput', 'w'));
        uinput = 'writable';
    } catch {
        if (existsSync('/dev/uinput')) uinput = 'masked';
    }
    if (uinput === 'writable') fail('/dev/uinput is writable in the cage');
    const dri = readdirSync('/dev/dri');
    if (dri.some((name) => name.startsWith('card'))) fail(`a KMS node is visible: ${dri.join(', ')}`);
    const isolation = {
        bus_names: busNames().map((n) => n.name).filter((name) => !name.startsWith(':')).sort(),
        bus_peers: peers.length,
        foreign_bus_peers: 0,
        runtime_dir: runtimeEntries,
        ambient_sockets_visible: 0,
        dri,
        uinput,
        pid_namespace_init: process.pid === 1,
        wayland_display: wayland,
        ...(hyprland ? { hyprland_sockets: 'lab directory' } : {}),
    };
    process.stdout.write(`${JSON.stringify({ cage: 'ready', isolation })}\n`);

    // The cursor proof's engine asks this cage's compositor for cursor positions.
    const engine = spawn(config.engine, ['serve'], { stdio: 'inherit', env: { ...(config.cursorProof || config.hyprland ? client : env), RUST_LOG: 'warn' } });
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
    const inputProof = process.argv.includes('--input-proof');
    const hyprlandProof = process.argv.includes('--hyprland-input-proof');
    const qualProof = process.argv.includes('--wayland-qual');
    const qualEvidence = process.env.DESKLINK_QUAL_EVIDENCE_DIR;
    if (qualProof && !qualEvidence) {
        console.error('--wayland-qual writes its evidence: set DESKLINK_QUAL_EVIDENCE_DIR');
        process.exit(2);
    }
    const hyprlandConfig = option('hyprland-config', 'lua');
    assert(['lua', 'legacy'].includes(hyprlandConfig), '--hyprland-config is lua or legacy');
    const scenarios = (process.argv.includes('--cursor-proof') || inputProof || hyprlandProof || qualProof ? 'still' : option('scenario', 'typing,scroll')).split(',');
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
        ['pipewire', which('pipewire')], ['wireplumber', which('wireplumber')], ['sway', hyprlandProof || qualProof || sway],
        ['xdg-desktop-portal', portal], ['xdg-desktop-portal-hyprland', xdph], ['chrome', chrome],
        ...(qualProof ? [['ffmpeg', which('ffmpeg')]] : []),
    ].filter(([, found]) => !found).map(([name]) => name);
    const xdpw = inputProof ? firstFile([process.env.DESKLINK_PORTAL_XDPW, ...PORTAL_DIRS.map((d) => `${d}/xdg-desktop-portal-wlr`)]) : null;
    const wlrPortal = xdpw && firstFile([join(dirname(xdpw), '../share/xdg-desktop-portal/portals/wlr.portal'), '/usr/share/xdg-desktop-portal/portals/wlr.portal']);
    if (inputProof && !wlrPortal) missing.push('xdg-desktop-portal-wlr (set DESKLINK_PORTAL_XDPW)');
    if (inputProof && !(process.env.DESKLINK_PORTAL_SWAYMSG || which('swaymsg'))) missing.push('swaymsg');
    const hyprland = hyprlandProof || qualProof ? process.env.DESKLINK_PORTAL_HYPRLAND || which('Hyprland') : null;
    const aquamarine = process.env.DESKLINK_PORTAL_AQUAMARINE;
    if (hyprlandProof || qualProof) {
        if (!hyprland || !which('hyprctl')) missing.push('Hyprland and hyprctl');
        if (!aquamarine || !readdirSafe(aquamarine).some((n) => n.startsWith('libaquamarine.so'))) missing.push('the lab aquamarine (set DESKLINK_PORTAL_AQUAMARINE)');
    }
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
            engine, stamp, sway, portal, xdph, portalFile, xdpw, wlrPortal, inputProof, chrome, hyprland, hyprlandConfig, aquamarine, renderNode, width, height, maxFps, seconds, scenario, freezeAfter,
            embeddedControl: process.argv.includes('--embedded-control'),
            cursorProof: process.argv.includes('--cursor-proof'), background: option('background', 'light'), scale: Number(option('scale', '1')), swaymsg: process.env.DESKLINK_PORTAL_SWAYMSG || which('swaymsg'),
            qualProof, evidence: qualEvidence,
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
        if (process.argv.includes('--cursor-proof') || inputProof || hyprlandProof || qualProof) continue;
        const measured = result.g2g_ms.n > 0 && Number.isFinite(result.g2g_ms.p50);
        if (gate && scenario === 'typing' && !(measured && result.presented_fps >= 50 && result.g2g_ms.p50 <= 50)) {
            console.error(`FAIL typing: ${result.presented_fps} fps presented, p50 ${result.g2g_ms.p50} ms over ${result.g2g_ms.n} decoded stamps`);
            failed = true;
        }
    }
    process.exit(failed ? 1 : 0);
}

const readdirSafe = (path) => {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
};
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
            `touch "${dir}/render" "${dir}/no-uinput"`,
            `chmod 000 "${dir}/no-uinput"`,
            `[ ! -e /dev/uinput ] || mount --bind "${dir}/no-uinput" /dev/uinput`,
            `mount --bind "/dev/dri/${run.renderNode}" "${dir}/render"`,
            'mount -t tmpfs -o mode=755 tmpfs /dev/dri',
            `touch "/dev/dri/${run.renderNode}"`,
            `mount --bind "${dir}/render" "/dev/dri/${run.renderNode}"`,
            '[ ! -d /dev/snd ] || mount -t tmpfs tmpfs /dev/snd',
            run.hyprland
                ? `mount --bind "${dir}/run" /run/user/${uid}`
                : `mount -t tmpfs -o mode=700,uid=0,gid=0 tmpfs /run/user/${uid}`,
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
        if (run.qualProof) return { ...await qualProofFlow(engine, dir, run), isolation: first.isolation };
        if (run.cursorProof) return {...await cursorProof(engine, dir, run), isolation:first.isolation};
        if (run.inputProof) return { ...await inputProof(engine, dir, run), isolation: first.isolation };
        if (run.hyprland) return { ...await hyprlandInputProof(engine, dir, run), isolation: first.isolation };

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
    mkdirSync(join(dir, 'run'), { mode: 0o700 });
    for (const leaf of ['home/.config/hypr', 'home/.config/xdg-desktop-portal-wlr', 'home/.config/xdg-desktop-portal', 'portals', 'services']) {
        mkdirSync(join(dir, leaf), { recursive: true });
    }
    const ambient = [process.env.DBUS_SESSION_BUS_ADDRESS?.match(/unix:path=([^,;]+)/)?.[1]];
    for (const name of ['bus', 'pipewire-0', 'pipewire-0-manager', 'wayland-0', 'wayland-1', process.env.WAYLAND_DISPLAY]) {
        if (name) ambient.push(name.startsWith('/') ? name : `/run/user/${process.getuid()}/${name}`);
    }
    // Every Hyprland of the person's own session.
    const hyprDir = `/run/user/${process.getuid()}/hypr`;
    for (const sig of readdirSafe(hyprDir)) ambient.push(`${hyprDir}/${sig}/.socket.sock`, `${hyprDir}/${sig}/.socket2.sock`);
    writeFileSync(join(dir, 'cage.json'), JSON.stringify({
        scenario: run.scenario, engine: realpathSync(run.engine), stamp: realpathSync(run.stamp), sway: run.sway,
        portal: run.portal, xdph: run.xdph, xdpw: run.inputProof ? run.xdpw : null,
        hyprland: run.hyprland, aquamarine: run.aquamarine, renderNode: run.renderNode,
        qual: run.qualProof, width: run.width, height: run.height,
        hyprlandConfig: run.hyprlandConfig === 'lua' ? 'hyprland.lua' : 'hyprland.conf', cursorProof: run.cursorProof, background: run.background, swaymsg: run.swaymsg,
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
    const [modeW, modeH] = [run.width, run.height];
    writeFileSync(join(dir, 'hyprland.conf'), [
        `monitor = HEADLESS-1, ${modeW}x${modeH}@60, 0x0, ${run.scale}`,
        'animations {\n  enabled = false\n}',
        'misc {\n  disable_hyprland_logo = true\n  disable_splash_rendering = true\n  disable_watchdog_warning = true\n}',
        '',
    ].join('\n'));
    writeFileSync(join(dir, 'hyprland.lua'), [
        `hl.monitor({ output = "HEADLESS-1", mode = "${modeW}x${modeH}@60", position = "0x0", scale = ${run.scale} })`,
        'hl.config({ animations = { enabled = false }, misc = { disable_hyprland_logo = true, disable_splash_rendering = true, disable_watchdog_warning = true } })',
        '',
    ].join('\n'));
    // The consent step, answered by the lab: share the one headless output,
    // or in the Hyprland proof the window `share` names, from xdph's list.
    const picker = join(dir, 'picker.sh');
    writeFileSync(picker, run.hyprland ? `#!${process.execPath}
const share = require('fs').readFileSync(${JSON.stringify(join(dir, 'share'))}, 'utf8');
if (share === 'Monitor') { console.log('[SELECTION]/screen:HEADLESS-1'); process.exit(0); }
const window = (process.env.XDPH_WINDOW_SHARING_LIST || '').split('[HA>]')
    .map((entry) => entry.match(/^(\\d+)\\[HC>\\].*\\[HT>\\](.*)\\[HE>\\]/)).find((m) => m && m[2] === share);
if (window) console.log('[SELECTION]/window:' + window[1]);
` : '#!/bin/sh\necho "[SELECTION]/screen:HEADLESS-1"\n');
    chmodSync(picker, 0o755);
    writeFileSync(join(dir, 'home/.config/hypr/xdph.conf'), `screencopy {\n  custom_picker_binary = ${picker}\n  max_fps = 60\n}\n`);
    // xdpw's consent step: the harness names the share kind. A simple chooser's
    // answer is matched against every window whatever types were asked for, as
    // xdph's picker offers windows to an engine that asked for monitors.
    const chooser = join(dir, 'chooser.sh');
    writeFileSync(chooser, [
        '#!/bin/sh',
        `if [ "$(cat '${join(dir, 'share')}')" = Monitor ]; then echo "Monitor: HEADLESS-1"; exit; fi`,
        `id=$('${run.swaymsg}' -s "$SWAYSOCK" -t get_tree | grep -o '"foreign_toplevel_identifier": "[^"]*"' | head -1 | cut -d'"' -f4)`,
        'echo "Window: $id"',
        '',
    ].join('\n'));
    chmodSync(chooser, 0o755);
    writeFileSync(join(dir, 'home/.config/xdg-desktop-portal-wlr/config'), `[screencast]\nchooser_type=simple\nchooser_cmd=${chooser}\nmax_fps=30\n`);
    writeFileSync(join(dir, 'home/.config/xdg-desktop-portal/portals.conf'), `[preferred]\ndefault=${run.inputProof ? 'wlr' : 'hyprland'}\n`);
    if (run.inputProof) copyFileSync(run.wlrPortal, join(dir, 'portals/wlr.portal'));
    else copyFileSync(run.portalFile, join(dir, 'portals/hyprland.portal'));
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
    const shot = document.createElement('canvas');
    const shotContext = shot.getContext('2d');
    const state = { frames: 0, measuring: false, sourceWidth: 0, times: [], g2g: [], undecoded: 0 };
    let pending = [];
    let channel = null;
    const replies = [];
    pc.ondatachannel = (event) => {
        channel = event.channel;
        channel.onmessage = (message) => replies.push(JSON.parse(message.data));
    };
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
        get channelOpen() { return channel?.readyState === 'open'; },
        // The picture the client actually decoded, for a same-moment still.
        snapshot() {
            if (video.videoWidth === 0) return null;
            shot.width = video.videoWidth; shot.height = video.videoHeight;
            shotContext.drawImage(video, 0, 0);
            return shot.toDataURL('image/png');
        },
        async control(message) {
            channel.send(JSON.stringify(message));
            for (let i = 0; i < 100; i++) {
                const reply = replies.find((r) => r.seq === message.seq && (r.kind === 'ack' || r.kind === 'rejected'));
                if (reply) return reply;
                await new Promise((done) => setTimeout(done, 50));
            }
            return null;
        },
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

// A tap on a shared window must never land somewhere the person did not point:
// the portal reports no origin for a window and the pointer device spans the
// whole desktop, so the engine refuses it. The monitor share keeps its path.
async function inputProof(engine, dir, run) {
    const browser = await startChrome(run.chrome);
    try {
        const openShare = answerOffers(engine, browser);
        const shares = {};
        for (const share of ['Window', 'Monitor']) {
            writeFileSync(join(dir, 'share'), share);
            const opened = await openShare(share, run);
            const { width, height } = opened.geometry.encoded;
            const tap = await browser.evaluate(`window.__g2g.control(${JSON.stringify({ kind: 'pointer', phase: 'down', x: width >> 1, y: height >> 1, button: 1, seq: 1 })})`);
            const typed = await browser.evaluate(`window.__g2g.control(${JSON.stringify({ kind: 'text', text: 'a', seq: 2 })})`);
            await engine.request('session.close', { session_id: opened.sessionId });
            shares[share] = { kind: opened.source.kind, origin: opened.source.origin, tap, typed };
        }
        const { Window: window, Monitor: monitor } = shares;
        assert.equal(window.kind, 'Window', 'the lab did not share a single window');
        assert.equal(window.tap?.kind, 'rejected', `a window-share tap was applied: ${JSON.stringify(window.tap)}`);
        assert.equal(window.tap.code, 'input-unavailable');
        assert.match(window.tap.message, /shared window cannot take taps/);
        // Only pointing is refused; the cage has no input device, so typing
        // meets the ordinary refusal, as it does on the monitor share.
        assert.equal(window.typed?.message, 'no input backend', JSON.stringify(window.typed));
        assert.equal(monitor.kind, 'Monitor');
        assert.equal(monitor.tap?.message, 'no input backend', `the monitor share's tap changed path: ${JSON.stringify(monitor.tap)}`);
        return { source: 'portal', shares };
    } finally {
        await browser.close();
    }
}

/** Answers the engine's offers from the page; returns how to open one share. */
function answerOffers(engine, browser) {
    let current = { sessionId: null, generation: 1 };
    engine.on((event) => {
        if (event.event === 'session.description' && event.params.description.type === 'offer') {
            browser.evaluate(`window.__g2g.answer(${JSON.stringify(event.params.description.sdp)})`)
                .then((sdp) => engine.request('session.description', { session_id: current.sessionId, generation: current.generation, description: { type: 'answer', sdp } }))
                .catch((error) => console.error(`answer failed: ${error.message}`));
        } else if (event.event === 'session.candidate') {
            browser.evaluate(`window.__g2g.candidate(${JSON.stringify({
                candidate: event.params.candidate, sdpMid: event.params.sdpMid, sdpMLineIndex: event.params.sdpMLineIndex,
            })})`).catch(() => {});
        }
    });
    return async (share, run) => {
        await browser.evaluate(PAGE);
        const opened = await engine.request('session.open', {
            source: { kind: 'portal' },
            max_width: run.width,
            max_height: run.height,
            ...(run.hyprland ? { agent_indicator: true } : {}),
        }, 60_000);
        current = opened;
        await browser.until('window.__g2g.channelOpen', 30_000, `the ${share} share's control channel`);
        return opened;
    };
}

/** Count pixels near one colour in a square around `center`. */
function nearColor(png, center, [r, g, b], tolerance, radius = 0) {
    let count = 0;
    const left = Math.max(0, center.x - radius), right = Math.min(png.width, center.x + radius);
    const top = Math.max(0, center.y - radius), bottom = Math.min(png.height, center.y + radius);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const i = (y * png.width + x) * 4;
        if (Math.abs(png.data[i] - r) <= tolerance && Math.abs(png.data[i + 1] - g) <= tolerance && Math.abs(png.data[i + 2] - b) <= tolerance) count++;
    }
    return count;
}

/** The box of one colour's pixels, or null; the search skips an edge band. */
function colorBox(png, [r, g, b], tolerance = 20, margin = 0) {
    let box = null;
    for (let y = margin; y < png.height - margin; y++) for (let x = margin; x < png.width - margin; x++) {
        const i = (y * png.width + x) * 4;
        if (Math.abs(png.data[i] - r) > tolerance || Math.abs(png.data[i + 1] - g) > tolerance || Math.abs(png.data[i + 2] - b) > tolerance) continue;
        box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) }
            : { left: x, top: y, right: x, bottom: y };
    }
    return box;
}

/** Live portal picture, input landing, cue on screen but not in the stream, one recording, and the layer-shell probe. */
async function qualProofFlow(engine, dir, run) {
    const evidence = resolve(run.evidence);
    assert(evidence.startsWith('/'), 'DESKLINK_QUAL_EVIDENCE_DIR must be absolute');
    mkdirSync(evidence, { recursive: true });
    const frames = join(evidence, '.frames');
    rmSync(frames, { recursive: true, force: true });
    for (const kind of ['screen', 'client']) mkdirSync(join(frames, kind), { recursive: true });
    const { PNG } = await import('pngjs');
    const cageRun = async (...commands) => {
        const result = join(dir, 'hypr-result');
        rmSync(result, { force: true });
        writeFileSync(join(dir, 'hypr-command'), JSON.stringify(commands));
        for (let i = 0; i < 300 && !existsSync(result); i++) await sleep(20);
        assert(existsSync(result), 'the cage did not run the Hyprland commands');
        return JSON.parse(readFileSync(result, 'utf8'));
    };
    const hypr = async (...commands) => (await cageRun(...commands)).map((entry, i) => {
        assert.equal(entry.status, 0, `hyprctl ${commands[i].join(' ')}: ${entry.err}`);
        return entry.out;
    });
    const clients = async () => JSON.parse((await hypr(['-j', 'clients']))[0]);
    const titled = async (title) => (await clients()).filter((client) => client.title === title);
    const cursor = async () => JSON.parse((await hypr(['-j', 'cursorpos']))[0]);
    const lua = run.hyprlandConfig === 'lua';
    const dispatch = async (legacy, luaForm) => {
        const [said] = await hypr(lua ? ['dispatch', luaForm] : ['dispatch', ...legacy]);
        assert.match(said.trim(), /^ok/, `dispatch ${lua ? luaForm : legacy.join(' ')}: ${said}`);
    };
    const moveWindow = (address, x, y) => dispatch(['movewindowpixel', `exact ${x} ${y},address:${address}`],
        `hl.dsp.window.move({ x = ${x}, y = ${y}, window = "address:${address}" })`);
    const pointerLog = () => {
        const lines = existsSync(join(dir, 'pointer.log')) ? readFileSync(join(dir, 'pointer.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
        return lines.length ? JSON.parse(lines.at(-1)) : null;
    };
    const capture = async (name) => {
        const path = join(evidence, name);
        await hypr(['grim', '-o', 'HEADLESS-1', path]);
        return PNG.sync.read(readFileSync(path));
    };
    const browser = await startChrome(run.chrome);
    let seq = 0;
    const control = (message) => browser.evaluate(`window.__g2g.control(${JSON.stringify({ ...message, seq: ++seq })})`);
    const openShare = answerOffers(engine, browser);
    const share = async (name) => {
        writeFileSync(join(dir, 'share'), name);
        const opened = await openShare(name, run);
        await browser.until('window.__g2g.frames > 0', 30_000, `a first frame of ${name}`);
        await sleep(500);
        return opened;
    };
    const still = async (name) => {
        const data = await browser.evaluate('window.__g2g.snapshot()');
        assert(typeof data === 'string' && data.startsWith('data:image/png'), 'the client has no decoded picture');
        const bytes = Buffer.from(data.split(',')[1], 'base64');
        writeFileSync(join(evidence, name), bytes);
        return PNG.sync.read(bytes);
    };
    try {
        await browser.evaluate(PAGE);
        // 1. The portal screen share gives the client a live picture; keep it.
        const monitor = await share('Monitor');
        const monitorStill = await still('monitor-client-still.png');
        await capture('monitor-lab-output.png');
        await engine.request('session.close', { session_id: monitor.sessionId });
        await sleep(300);

        // 2. A full-output window share: input lands on the fixture through
        // the engine's Hyprland path, and its own pointer log confirms it.
        const notes = await share('Umer notes');
        assert.equal(notes.source.kind, 'Window', 'the lab did not share a window');
        const [window] = await titled('Umer notes');
        assert(window, 'the fixture window is missing');
        await moveWindow(window.address, 0, 0);
        const encoded = notes.geometry.encoded, source = notes.geometry.source;
        const tap = async (fx, fy) => {
            const x = Math.floor(fx * encoded.width), y = Math.floor(fy * encoded.height);
            const reply = await control({ kind: 'pointer', phase: 'move', x, y, button: 1 });
            await sleep(250);
            const [now] = await titled('Umer notes');
            const local = {
                x: Math.floor(x * source.width / encoded.width) * now.size[0] / source.width,
                y: Math.floor(y * source.height / encoded.height) * now.size[1] / source.height,
            };
            const expected = { x: Math.floor(now.at[0] + local.x), y: Math.floor(now.at[1] + local.y) };
            const cursorpos = await cursor(), window_saw = pointerLog();
            assert.equal(reply?.kind, 'ack', `input was refused: ${JSON.stringify(reply)}`);
            assert(Math.abs(cursorpos.x - expected.x) <= 1 && Math.abs(cursorpos.y - expected.y) <= 1,
                `the pointer did not land on the window point: ${JSON.stringify({ expected, cursorpos })}`);
            assert(window_saw && Math.abs(window_saw.x - local.x) <= 1 && Math.abs(window_saw.y - local.y) <= 1,
                `the fixture did not receive the pointer: ${JSON.stringify({ local, window_saw })}`);
            return { tap: { x, y }, expected, local, cursorpos, window_saw, reply };
        };
        const landing = await tap(0.3, 0.62);
        await sleep(700);
        // Same moment: the desktop capture (cue drawn) and the shared stream.
        const screen = await capture('agent-cue-on-screen.png');
        const frame = await engine.request('session.frame', { session_id: notes.sessionId, path: join(dir, 'agent-cue-capture.raw') });
        const client = await still('agent-cue-client-still.png');
        const raw = readFileSync(join(dir, 'agent-cue-capture.raw'));
        const captured = new PNG({ width: frame.width, height: frame.height });
        for (let i = 0; i < frame.width * frame.height; i++) {
            captured.data[i * 4] = raw[i * 4 + 2];
            captured.data[i * 4 + 1] = raw[i * 4 + 1];
            captured.data[i * 4 + 2] = raw[i * 4];
            captured.data[i * 4 + 3] = 255;
        }
        writeFileSync(join(evidence, 'agent-cue-not-in-capture.png'), PNG.sync.write(captured));
        rmSync(join(dir, 'agent-cue-capture.raw'), { force: true });
        const rim = colorBox(screen, [0x12, 0x30, 0x47], 6, 10);
        assert(rim, 'the agent cue is not drawn on the lab output');
        const drawn = { x: (rim.left + rim.right) / 2, y: rim.top + 30 };
        assert(Math.abs(drawn.x - landing.expected.x) <= 2 && Math.abs(drawn.y - landing.expected.y) <= 2,
            `the agent cue is not where the input landed: ${JSON.stringify({ expected: landing.expected, drawn })}`);
        const onScreen = nearColor(screen, drawn, [0x29, 0x99, 0xff], 20, 60);
        assert(onScreen > 0, 'the agent cue ring is not on the lab output');
        const localRing = {
            x: Math.floor(landing.local.x * frame.width / source.width),
            y: Math.floor(landing.local.y * frame.height / source.height),
        };
        const inFrame = nearColor(captured, localRing, [0x29, 0x99, 0xff], 20, 90);
        const clientScale = client.width / source.width;
        const inClient = nearColor(client, { x: Math.floor(landing.local.x * clientScale), y: Math.floor(landing.local.y * clientScale) }, [0x29, 0x99, 0xff], 60, 90);
        assert.equal(inFrame, 0, 'the agent cue was captured into the shared window stream');
        assert.equal(inClient, 0, 'the agent cue reached the client picture');

        // 3. One recording: the lab output and the client picture side by side
        // while three more taps land and the cue on screen moves.
        const ticks = 48;
        const taps = new Map([[6, [0.3, 0.35]], [20, [0.7, 0.6]], [34, [0.45, 0.5]]]);
        for (let i = 0; i < ticks; i++) {
            if (taps.has(i)) await tap(...taps.get(i));
            await hypr(['grim', '-o', 'HEADLESS-1', join(frames, 'screen', `${String(i).padStart(3, '0')}.png`)]);
            const data = await browser.evaluate('window.__g2g.snapshot()');
            assert(typeof data === 'string' && data.startsWith('data:image/png'), 'the client picture stopped during the recording');
            writeFileSync(join(frames, 'client', `${String(i).padStart(3, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
            await sleep(120);
        }
        const font = firstFile(['/usr/share/fonts/noto/NotoSans-Regular.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf']);
        assert(font, 'no font to label the recording');
        const recording = join(evidence, 'wayland-portal-cue.mp4');
        const filter = `[0:v]scale=-2:540,pad=iw:ih+44:0:44:color=0x101418,drawtext=fontfile=${font}:text='Lab desktop with the agent cue':x=16:y=12:fontsize=20:fontcolor=white[a];`
            + `[1:v]scale=-2:540,pad=iw:ih+44:0:44:color=0x101418,drawtext=fontfile=${font}:text='Client shared picture stays clean':x=16:y=12:fontsize=20:fontcolor=white[b];[a][b]hstack=inputs=2[v]`;
        const composed = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-framerate', '8', '-i', join(frames, 'screen', '%03d.png'),
            '-framerate', '8', '-i', join(frames, 'client', '%03d.png'),
            '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', recording], { encoding: 'utf8' });
        assert.equal(composed.status, 0, `ffmpeg: ${composed.stderr}`);
        await engine.request('session.close', { session_id: notes.sessionId });

        // 4. Layer-shell discovery: this compositor offers it; a private
        // Wayland server without it makes the helper say so, not stay silent.
        const onCompositor = (await cageRun(['probe']))[0];
        const withoutLayerShell = await noLayerShellProbe(run.engine, dir);
        assert.equal(onCompositor.status, 0, JSON.stringify(onCompositor));
        assert.equal(onCompositor.out, 'READY');
        assert.equal(withoutLayerShell.status, 2, JSON.stringify(withoutLayerShell));
        assert.match(withoutLayerShell.out, /layer_shell_unavailable/);
        writeFileSync(join(evidence, 'layer-shell-probe.json'), JSON.stringify({ compositor: onCompositor, no_layer_shell: withoutLayerShell }, null, 1));

        rmSync(frames, { recursive: true, force: true });
        return {
            source: 'portal', compositor: 'hyprland', config: run.hyprlandConfig,
            monitor: { still: monitorStill.width + 'x' + monitorStill.height },
            input: landing,
            cue: { drawn, on_screen: onScreen, captured_pixels: inFrame, client_pixels: inClient },
            recording: basename(recording), probe: { compositor: onCompositor.out, no_layer_shell: withoutLayerShell.out },
        };
    } finally {
        await browser.close();
        rmSync(frames, { recursive: true, force: true });
    }
}

/** Run the real helper's probe against a private Wayland registry with no layer-shell. */
function noLayerShellProbe(binary, dir) {
    const socket = join(dir, 'no-layer-shell.sock');
    rmSync(socket, { force: true });
    const server = net.createServer((connection) => {
        let buffered = Buffer.alloc(0);
        connection.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 8) {
                const object = buffered.readUInt32LE(0);
                const sizeOpcode = buffered.readUInt32LE(4);
                const size = sizeOpcode >>> 16, opcode = sizeOpcode & 0xffff;
                if (size < 8 || buffered.length < size) break;
                const body = buffered.subarray(8, size);
                buffered = buffered.subarray(size);
                if (object === 1 && opcode === 0 && body.length >= 4) {
                    const reply = Buffer.alloc(12);
                    reply.writeUInt32LE(body.readUInt32LE(0), 0);
                    reply.writeUInt32LE(12 << 16, 4);
                    reply.writeUInt32LE(1, 8);
                    connection.write(reply);
                }
            }
        });
    });
    return new Promise((done) => {
        server.listen(socket, async () => {
            const env = { ...process.env, WAYLAND_DISPLAY: socket, XDG_RUNTIME_DIR: dir };
            delete env.DISPLAY;
            const child = spawn(binary, ['point-layer-shell-probe'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.stderr.on('data', (chunk) => { err += chunk; });
            const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
            const status = await new Promise((exit) => child.once('exit', exit));
            clearTimeout(timeout);
            server.close();
            rmSync(socket, { force: true });
            done({ status, out: out.trim(), err: err.trim() });
        });
    });
}

// On Hyprland a shared window's taps land on the window: the engine finds it
// by the title Hyprland announces and warps the pointer through Hyprland's own
// IPC. The cage has no input device (uinput is masked), so only pointer motion
// can take effect; a press is refused before anything moves.
async function hyprlandInputProof(engine, dir, run) {
    const hypr = async (...commands) => {
        const result = join(dir, 'hypr-result');
        rmSync(result, { force: true });
        writeFileSync(join(dir, 'hypr-command'), JSON.stringify(commands));
        for (let i = 0; i < 250 && !existsSync(result); i++) await sleep(20);
        assert(existsSync(result), 'the cage did not run the hyprctl commands');
        const results = JSON.parse(readFileSync(result, 'utf8'));
        for (const [i, r] of results.entries()) assert.equal(r.status, 0, `hyprctl ${commands[i].join(' ')}: ${r.err}`);
        return results.map((r) => r.out);
    };
    const clients = async () => JSON.parse((await hypr(['-j', 'clients']))[0]);
    const cursor = async () => JSON.parse((await hypr(['-j', 'cursorpos']))[0]);
    const titled = async (title) => (await clients()).filter((c) => c.title === title);
    const lua = run.hyprlandConfig === 'lua';
    const dispatch = async (legacy, luaForm) => {
        const [said] = await hypr(lua ? ['dispatch', luaForm] : ['dispatch', ...legacy]);
        assert.match(said.trim(), /^ok/, `dispatch ${lua ? luaForm : legacy.join(' ')}: ${said}`);
    };
    const moveWindow = (address, x, y) => dispatch(['movewindowpixel', `exact ${x} ${y},address:${address}`],
        `hl.dsp.window.move({ x = ${x}, y = ${y}, window = "address:${address}" })`);
    const raiseWindow = (address) => dispatch(['alterzorder', `top,address:${address}`],
        `hl.dsp.window.alter_zorder({ mode = "top", window = "address:${address}" })`);
    const hideWindow = (address) => dispatch(['movetoworkspacesilent', `2,address:${address}`],
        `hl.dsp.window.move({ workspace = "2", follow = false, window = "address:${address}" })`);
    // What the overlays drew, read off a capture of one lab output.
    const { PNG } = await import('pngjs');
    const captures = [];
    const capture = async (output, name) => {
        const path = join(dir, `${name}.png`);
        await hypr(['grim', '-o', output, path]);
        captures.push(path);
        return PNG.sync.read(readFileSync(path));
    };
    // The box of one colour's pixels in an output's logical points, inside
    // the agent indicator's edge glow; null when none show. `margin` is the
    // untouched edge band in logical points (the glow scan passes 0).
    const markBox = (png, [r, g, b], logicalWidth, margin = 10) => {
        const scale = png.width / logicalWidth, edge = Math.ceil(margin * scale);
        let box = null;
        for (let y = edge; y < png.height - edge; y++) for (let x = edge; x < png.width - edge; x++) {
            const i = (y * png.width + x) * 4;
            if (Math.abs(png.data[i] - r) > 6 || Math.abs(png.data[i + 1] - g) > 6 || Math.abs(png.data[i + 2] - b) > 6) continue;
            box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) }
                : { left: x, top: y, right: x, bottom: y };
        }
        return box && Object.fromEntries(Object.entries(box).map(([side, at]) => [side, at / scale]));
    };
    const pointerLog = () => {
        const lines = existsSync(join(dir, 'pointer.log')) ? readFileSync(join(dir, 'pointer.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
        return lines.length ? JSON.parse(lines.at(-1)) : null;
    };

    const browser = await startChrome(run.chrome);
    try {
        const openShare = answerOffers(engine, browser);
        let seq = 0;
        const control = (message) => browser.evaluate(`window.__g2g.control(${JSON.stringify({ ...message, seq: ++seq })})`);
        const share = async (name) => {
            writeFileSync(join(dir, 'share'), name);
            const opened = await openShare(name, run);
            assert.equal(opened.agentIndicator, true, `the ${name} share's agent indicator did not start`);
            await browser.until('window.__g2g.frames > 0', 30_000, `a first frame of ${name}`);
            // Hyprland announces a share when it copies a frame.
            await sleep(300);
            return { opened, still: await cursor() };
        };

        // Layout coordinates are logical: the output is its mode over its scale.
        const [logicalW, logicalH] = [run.width / run.scale, run.height / run.scale];
        const twins = await titled('Umer twin');
        const corner = [logicalW - twins[0].size[0] - 10, logicalH - twins[0].size[1] - 10];
        for (const twin of twins) await moveWindow(twin.address, ...corner);

        // 1. The shared window: each tap lands where the window shows it.
        const { opened: notes } = await share('Umer notes');
        assert.equal(notes.source.kind, 'Window', 'the lab did not share a single window');
        const [window] = await titled('Umer notes');
        const encoded = notes.geometry.encoded, source = notes.geometry.source;
        const samples = [];
        const tapAt = async (fx, fy, cueOn = 'HEADLESS-1') => {
            const x = Math.floor(fx * encoded.width), y = Math.floor(fy * encoded.height);
            const reply = await control({ kind: 'pointer', phase: 'move', x, y, button: 1 });
            const [now] = await titled('Umer notes');
            // Encoded pixels -> the stream's pixels -> the window's logical points.
            const local = {
                x: Math.floor(x * source.width / encoded.width) * now.size[0] / source.width,
                y: Math.floor(y * source.height / encoded.height) * now.size[1] / source.height,
            };
            await sleep(150);
            const sample = { tap: { x, y }, window_at: now.at, expected: { x: Math.floor(now.at[0] + local.x), y: Math.floor(now.at[1] + local.y) },
                cursorpos: await cursor(), window_saw: pointerLog(), reply };
            samples.push(sample);
            assert.equal(reply?.kind, 'ack', `a window-share tap was not applied: ${JSON.stringify(reply)}`);
            assert(Math.abs(sample.cursorpos.x - sample.expected.x) <= 1 && Math.abs(sample.cursorpos.y - sample.expected.y) <= 1,
                `the pointer is not on the window's point: ${JSON.stringify(sample)}`);
            assert(sample.window_saw && Math.abs(sample.window_saw.x - local.x) <= 1 && Math.abs(sample.window_saw.y - local.y) <= 1,
                `the window did not get the pointer at its own point: ${JSON.stringify(sample)}`);
            if (!cueOn) return sample;
            // The cue eases onto its point; its dark rim reaches 30 points out.
            await sleep(600);
            const rim = markBox(await capture(cueOn, `cue-${samples.length}`), [0x12, 0x30, 0x47], logicalW);
            sample.cue = rim && { x: (rim.left + rim.right) / 2, y: rim.top + 30 };
            assert(sample.cue && Math.abs(sample.cue.x - sample.expected.x) <= 2 && Math.abs(sample.cue.y - sample.expected.y) <= 2,
                `the click cue is not where the tap landed: ${JSON.stringify(sample)}`);
            return sample;
        };
        await moveWindow(window.address, Math.floor(logicalW / 10), Math.floor(logicalH / 8));
        await tapAt(0.25, 0.75);
        await tapAt(0.9, 0.1);
        // 2. The same window, moved after the share started, still maps.
        const moved = [logicalW - window.size[0] - 20, 10];
        await moveWindow(window.address, ...moved);
        assert.deepEqual((await titled('Umer notes'))[0].at, moved, 'the lab could not move the window');
        await tapAt(0.5, 0.5);
        // The agent's point marks where a press there would land.
        const marked = { x: Math.floor(source.width * 0.3), y: Math.floor(source.height * 0.6) };
        await engine.request('session.point', { session_id: notes.sessionId, ...marked, timeout_ms: 10_000 });
        await sleep(300);
        const ring = markBox(await capture('HEADLESS-1', 'point'), [0x4c, 0x9e, 0xd0], logicalW);
        const point = {
            expected: { x: Math.floor(moved[0] + marked.x * window.size[0] / source.width), y: Math.floor(moved[1] + marked.y * window.size[1] / source.height) },
            drawn: ring && { x: (ring.left + ring.right) / 2, y: (ring.top + ring.bottom) / 2 },
        };
        assert(point.drawn && Math.abs(point.drawn.x - point.expected.x) <= 2 && Math.abs(point.drawn.y - point.expected.y) <= 2,
            `the point is not where a press would land: ${JSON.stringify(point)}`);
        await engine.request('session.point', { session_id: notes.sessionId, clear: true });
        // A press on another output moves the cue helper onto it: the cue
        // draws where the tap landed there with its halo, a repeat tap on the
        // helper's own output reuses it, and moving back and forth leaks no
        // helper processes. Same for the point ring.
        const helpers = async () => JSON.parse((await hypr(['helpers']))[0]);
        const held = await helpers();
        assert.equal(held.agent.length, 1, `the window share has no single cue helper: ${JSON.stringify(held)}`);
        await hypr(['output', 'create', 'headless', 'HEADLESS-2']);
        const second = JSON.parse((await hypr(['-j', 'monitors']))[0]).find((m) => m.name === 'HEADLESS-2');
        assert(second, 'the lab could not add a second output');
        const outputs = {
            'HEADLESS-1': { name: 'HEADLESS-1', x: 0, y: 0, logicalW },
            'HEADLESS-2': { name: 'HEADLESS-2', x: second.x, y: second.y, logicalW: second.width / second.scale },
        };
        // One output's capture: the cue's dark rim (its centre, 30 points
        // below the rim's top) and the halo's vivid blue box; either is null
        // when that output shows no cue at all.
        const analyse = async (output, name) => {
            const png = await capture(output.name, name);
            const rim = markBox(png, [0x12, 0x30, 0x47], output.logicalW);
            return {
                cue: rim && { x: (rim.left + rim.right) / 2, y: rim.top + 30 },
                halo: markBox(png, [0x29, 0x99, 0xff], output.logicalW),
            };
        };
        const gapTo = (box, local) => {
            const dx = local.x < box.left ? box.left - local.x : local.x > box.right ? local.x - box.right : 0;
            const dy = local.y < box.top ? box.top - local.y : local.y > box.bottom ? local.y - box.bottom : 0;
            return Math.hypot(dx, dy);
        };
        // A tap aimed at one output: it lands (cursorpos and the window's own
        // log, as above), then the cue must sit where it landed on that
        // output — halo with it — while the other output stays clean.
        const tapAcross = async (outputName, fx, fy, tag) => {
            const output = outputs[outputName];
            const other = outputs[outputName === 'HEADLESS-1' ? 'HEADLESS-2' : 'HEADLESS-1'];
            const x = Math.floor(fx * encoded.width), y = Math.floor(fy * encoded.height);
            const sentAt = Date.now();
            const reply = await control({ kind: 'pointer', phase: 'move', x, y, button: 1 });
            const ackMs = Date.now() - sentAt;
            const [now] = await titled('Umer notes');
            const local = {
                x: Math.floor(x * source.width / encoded.width) * now.size[0] / source.width,
                y: Math.floor(y * source.height / encoded.height) * now.size[1] / source.height,
            };
            const expected = { x: Math.floor(now.at[0] + local.x), y: Math.floor(now.at[1] + local.y) };
            const want = { x: expected.x - output.x, y: expected.y - output.y };
            await sleep(150);
            assert.equal(reply?.kind, 'ack', `a window-share tap was not applied: ${JSON.stringify(reply)}`);
            const cursorpos = await cursor(), window_saw = pointerLog();
            assert(Math.abs(cursorpos.x - expected.x) <= 1 && Math.abs(cursorpos.y - expected.y) <= 1,
                `the pointer is not on the window's point: ${JSON.stringify({ expected, cursorpos })}`);
            assert(window_saw && Math.abs(window_saw.x - local.x) <= 1 && Math.abs(window_saw.y - local.y) <= 1,
                `the window did not get the pointer at its own point: ${JSON.stringify({ expected, window_saw })}`);
            // First sight of the cue after the ack: how long the move took to show.
            const ackAt = Date.now();
            let first = (await analyse(output, `${tag}-first`)).cue;
            let seenMs = first ? Date.now() - ackAt : null;
            for (let i = 0; !first && i < 14; i++) {
                await sleep(200);
                first = (await analyse(output, `${tag}-poll${i}`)).cue;
                if (first) seenMs = Date.now() - ackAt;
            }
            assert(first, `no cue appeared on ${outputName} within ~3s of the tap: ${JSON.stringify({ expected, want })}`);
            // Settled: the cue sits where the tap landed, halo with it, and
            // the other output shows nothing at all.
            await sleep(600);
            const settled = await analyse(output, tag);
            assert(settled.cue && Math.abs(settled.cue.x - want.x) <= 2 && Math.abs(settled.cue.y - want.y) <= 2,
                `the moved cue is not where the tap landed: ${JSON.stringify({ expected, want, cue: settled.cue })}`);
            assert(settled.halo && gapTo(settled.halo, want) <= 45,
                `the cue halo did not move with the tap: ${JSON.stringify({ want, halo: settled.halo })}`);
            const quiet = await analyse(other, `${tag}-other`);
            assert.equal(quiet.cue, null, `a press on ${outputName} left a cue on ${other.name}: ${JSON.stringify(quiet.cue)}`);
            return { expected, want, ackMs, seenMs, pids: await helpers() };
        };
        await moveWindow(window.address, second.x + 100, second.y + 100);
        const away = await tapAcross('HEADLESS-2', 0.5, 0.5, 'away');
        assert.equal(away.pids.agent.length, 1, `the move left ${away.pids.agent.length} cue helpers: ${JSON.stringify(away.pids)}`);
        assert.notDeepEqual(away.pids.agent, held.agent, `the cross-output tap kept the old helper: ${JSON.stringify({ held, away: away.pids })}`);
        if (away.seenMs !== null && away.seenMs > 300) console.error(`SLOW move to HEADLESS-2: cue first seen ${away.seenMs} ms after the ack (ack ${away.ackMs} ms)`);
        // A repeat tap where the helper already sits restarts nothing.
        const stayed = await tapAcross('HEADLESS-2', 0.3, 0.6, 'stayed');
        assert.deepEqual(stayed.pids.agent, away.pids.agent, `a tap on the cue's own output restarted it: ${JSON.stringify({ away: away.pids, stayed: stayed.pids })}`);
        // The point ring follows the window onto the other output too, and
        // repeats there without a new helper.
        const marked2 = { x: Math.floor(source.width * 0.3), y: Math.floor(source.height * 0.6) };
        await engine.request('session.point', { session_id: notes.sessionId, ...marked2, timeout_ms: 10_000 });
        await sleep(300);
        const ringPng = await capture('HEADLESS-2', 'point-away');
        const ring2 = markBox(ringPng, [0x4c, 0x9e, 0xd0], outputs['HEADLESS-2'].logicalW);
        const [at2] = await titled('Umer notes');
        const wantRing2 = {
            x: Math.floor(at2.at[0] + marked2.x * at2.size[0] / source.width) - second.x,
            y: Math.floor(at2.at[1] + marked2.y * at2.size[1] / source.height) - second.y,
        };
        const drawn2 = ring2 && { x: (ring2.left + ring2.right) / 2, y: (ring2.top + ring2.bottom) / 2 };
        assert(drawn2 && Math.abs(drawn2.x - wantRing2.x) <= 2 && Math.abs(drawn2.y - wantRing2.y) <= 2,
            `the point is not where a press would land on the other output: ${JSON.stringify({ wantRing2, drawn2 })}`);
        const pointHeld = (await helpers()).point;
        await engine.request('session.point', { session_id: notes.sessionId, ...marked2, timeout_ms: 10_000 });
        await sleep(300);
        assert.deepEqual((await helpers()).point, pointHeld, `a point on its own output restarted its helper: ${JSON.stringify(pointHeld)}`);
        await engine.request('session.point', { session_id: notes.sessionId, clear: true });
        // Back on the first output, then there again: one move, one reuse.
        await moveWindow(window.address, ...moved);
        const back = await tapAcross('HEADLESS-1', 0.5, 0.5, 'back');
        assert.equal(back.pids.agent.length, 1, `the move back left ${back.pids.agent.length} cue helpers: ${JSON.stringify(back.pids)}`);
        assert.notDeepEqual(back.pids.agent, stayed.pids.agent, `the move back kept the other output's helper: ${JSON.stringify({ stayed: stayed.pids, back: back.pids })}`);
        if (back.seenMs !== null && back.seenMs > 300) console.error(`SLOW move to HEADLESS-1: cue first seen ${back.seenMs} ms after the ack (ack ${back.ackMs} ms)`);
        const home = await tapAcross('HEADLESS-1', 0.7, 0.3, 'home');
        assert.deepEqual(home.pids.agent, back.pids.agent, `a tap on the cue's own output restarted it: ${JSON.stringify({ back: back.pids, home: home.pids })}`);
        await hypr(['output', 'remove', 'HEADLESS-2']);
        // 3. Another window raised over the tapped point would take the
        // press: refused, and the pointer stays where it was.
        const still = await cursor();
        await moveWindow(twins[0].address, moved[0] + 40, moved[1] + 40);
        await raiseWindow(twins[0].address);
        const covered = await control({ kind: 'pointer', phase: 'move', x: Math.floor(encoded.width / 2), y: Math.floor(encoded.height / 2), button: 1 });
        assert.equal(covered?.code, 'input-unavailable', JSON.stringify(covered));
        assert.match(covered.message, /another window covers it/);
        assert.deepEqual(await cursor(), still, 'a covered tap moved the pointer');
        await moveWindow(twins[0].address, ...corner);
        // 4. A press needs the input device the cage does not have: refused,
        // and the pointer stays where it was.
        const before = await cursor();
        const press = await control({ kind: 'pointer', phase: 'down', x: 10, y: 10, button: 1 });
        assert.equal(press?.message, 'no input backend', JSON.stringify(press));
        assert.deepEqual(await cursor(), before, 'a refused press moved the pointer');
        // 5. A window on a hidden workspace has no point on the screen.
        await hideWindow(window.address);
        const hidden = await control({ kind: 'pointer', phase: 'move', x: 10, y: 10, button: 1 });
        assert.equal(hidden?.code, 'input-unavailable', JSON.stringify(hidden));
        assert.match(hidden.message, /hidden workspace/);
        assert.deepEqual(await cursor(), before, 'a refused tap moved the pointer');
        await engine.request('session.close', { session_id: notes.sessionId });
        // Closing the session reaps every helper: no leaked processes.
        let reaped = null;
        for (let i = 0; i < 50; i++) {
            reaped = await helpers();
            if (reaped.agent.length === 0 && reaped.point.length === 0) break;
            await sleep(100);
        }
        assert.deepEqual(reaped, { agent: [], point: [] }, `the closed session leaked helpers: ${JSON.stringify(reaped)}`);

        // 6. Two windows look like the shared one: refused, never a guess.
        const { opened: twin, still: resting } = await share('Umer twin');
        assert.equal(twin.source.kind, 'Window', 'the lab did not share a single window');
        assert.equal((await titled('Umer twin')).length, 2);
        const ambiguous = await control({ kind: 'pointer', phase: 'move', x: 10, y: 10, button: 1 });
        assert.equal(ambiguous?.code, 'input-unavailable', JSON.stringify(ambiguous));
        assert.match(ambiguous.message, /2 windows look like it/);
        assert.deepEqual(await cursor(), resting, 'an ambiguous tap moved the pointer');
        await engine.request('session.close', { session_id: twin.sessionId });

        // 7. A monitor share keeps its own path: the input device, absent here.
        const { opened: monitor } = await share('Monitor');
        assert.equal(monitor.source.kind, 'Monitor');
        const monitorTap = await control({ kind: 'pointer', phase: 'move', x: 10, y: 10, button: 1 });
        assert.equal(monitorTap?.message, 'no input backend', `the monitor share's tap changed path: ${JSON.stringify(monitorTap)}`);
        await engine.request('session.close', { session_id: monitor.sessionId });

        const evidence = process.env.DESKLINK_CUE_EVIDENCE_DIR;
        if (evidence) for (const path of captures) copyFileSync(path, join(evidence, `${run.hyprlandConfig}-scale${run.scale}-${basename(path)}`));
        return {
            source: 'portal', compositor: 'hyprland', config: run.hyprlandConfig, scale: run.scale,
            window: { encoded, source, samples, point, covered, press, hidden },
            multiOutput: {
                held, away, stayed,
                point: { want: wantRing2, drawn: drawn2 },
                back, home, reaped,
            },
            twin: ambiguous, monitor: monitorTap,
        };
    } finally {
        await browser.close();
    }
}
