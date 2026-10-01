#!/usr/bin/env node
/**
 * The iOS receiver, end to end: `example/` built for the iOS simulator on a
 * Mac, showing a desktop this machine serves through `desklink-host bridge`.
 *
 * What it proves:
 *
 *  - the app's `react-native-webrtc` peer answers the engine's real offer with
 *    H.264 and NACK when the host offers H.264 beside VP9 (the host has an
 *    H.264 encoder), and with VP9 and NACK otherwise — both descriptions are
 *    written out as they crossed the
 *    bridge, not reconstructed;
 *  - the first frame reaches `presented` (the session goes `live`) and the
 *    simulator shows the desktop, which a screenshot records;
 *  - a tap on the simulator's screen arrives at the host as a click at the
 *    desktop pixel under the finger: the page on the desktop records it;
 *  - the picture keeps following the desktop: it shows the dots the page drew
 *    under those clicks, and it changes as the page repaints every frame;
 *  - a hardware keyboard reaches the desktop through the package's native input
 *    view: arrows, Esc, Tab, a Command chord (the desktop's Meta) and typed text
 *    arrive at the page as the keys they are;
 *  - on an iPad simulator (DESKLINK_IOS_IPAD=1), a trackpad pointer does too: a
 *    hover moves the desktop's pointer without a button, a click-drag selects
 *    text, a secondary click is a right click and a scroll turns the wheel. The
 *    pointer is driven by XCUITest (test/ios-pointer/), which `axe` cannot do.
 *
 * The host side runs here, on a private Xvfb (display >= 170, its own cookie):
 * a page on that display, the bridge with an `x11` source, and a relay in
 * front of the bridge that records the descriptions. The simulator side runs
 * on the Mac over ssh, inside one directory: the package and the example are
 * copied there, built, installed on a simulator named `desklink-ios-flow`
 * (created on first use and shut down after the run), launched with the
 * relay's URL, read through its accessibility tree and tapped with `axe`.
 *
 * Usage:
 *
 *   npm run build && cargo build --manifest-path packages/desktop-host/engine/Cargo.toml
 *   DESKLINK_IOS_MAC=user@mac node packages/desktop-client/test/ios-flow.mjs
 *
 * Environment:
 *
 *   DESKLINK_IOS_MAC        ssh destination of a Mac with Xcode, CocoaPods, node
 *                           and axe on its login PATH; unset skips the flow
 *   DESKLINK_IOS_DIR        directory under the Mac's home that holds everything
 *                           the flow builds and caches (default desklink-ios)
 *   DESKLINK_IOS_XCODE      DEVELOPER_DIR on the Mac, when the selected Xcode has
 *                           no iOS simulator platform installed
 *   DESKLINK_IOS_RUNTIME    iOS runtime version to run on, e.g. 18.6 (default: the
 *                           newest the Mac has)
 *   DESKLINK_IOS_IPAD       1 runs on an iPad simulator and adds the trackpad checks
 *   DESKLINK_IOS_HOST_ADDR  address the simulator reaches this machine on
 *                           (default: this machine's address as the Mac's ssh
 *                           session sees it)
 *   DESKLINK_IOS_OUT        where the descriptions and the screenshot go
 *                           (default: a fresh temporary directory)
 *   DESKLINK_IOS_SKIP_BUILD 1 reuses the app the last run built
 *   DESKLINK_IOS_APP        saved app path relative to DESKLINK_IOS_DIR
 *   DESKLINK_IOS_POINTER_PROOF before/after saves a 4x pointer crop and a
 *                           host click log proving a tap at the arrow tip
 *   DESKLINK_ENGINE         engine binary (default: this checkout's debug build)
 *   DESKLINK_CHROME         browser for the desktop's page (default: the first of
 *                           chromium, google-chrome-stable, google-chrome)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { WebSocket, WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const MAC = process.env.DESKLINK_IOS_MAC ?? '';
const DIR = process.env.DESKLINK_IOS_DIR ?? 'desklink-ios';
const BUILD = process.env.DESKLINK_IOS_SKIP_BUILD !== '1';
const APP = process.env.DESKLINK_IOS_APP ?? 'DerivedData/Build/Products/Release-iphonesimulator/desklinkexample.app';
assert.match(APP, /^[\w.-]+(\/[\w.-]+)*$/, 'DESKLINK_IOS_APP is a plain path under the task directory');
const BUNDLE = 'dev.desklink.example';
const RUNTIME = process.env.DESKLINK_IOS_RUNTIME ?? '';
const IPAD = process.env.DESKLINK_IOS_IPAD === '1';
const POINTER_PROOF = process.env.DESKLINK_IOS_POINTER_PROOF;
if (POINTER_PROOF) assert(['before', 'after'].includes(POINTER_PROOF));
const DEVICE = ['desklink-ios-flow', IPAD ? 'ipad' : '', RUNTIME].filter(Boolean).join('-');
const DEVICE_TYPE = IPAD ? 'iPad-Pro-11-inch-M4-8GB' : 'iPhone-16';
const DESKTOP = { width: 1280, height: 800 };
const MARK = `DESKLINK_IOS_FLOW=${process.pid}`;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (MAC === '') {
    console.log('SKIPPED: set DESKLINK_IOS_MAC to a Mac with Xcode to run the iOS simulator flow.');
    process.exit(0);
}
assert.match(DIR, /^[\w.-]+(\/[\w.-]+)*$/, 'DESKLINK_IOS_DIR is a plain path under the Mac home');
// A first build compiles React Native and WebRTC's pods; a rebuild is minutes.
setTimeout(() => {
    console.error('OVERALL TIMEOUT: the flow did not finish');
    void cleanup().catch((error) => console.error('CLEANUP-FAIL', error.message)).finally(() => process.exit(2));
}, (BUILD ? 45 : 8) * 60_000).unref();

// ---- the Mac ---------------------------------------------------------------
const PRELUDE = `set -euo pipefail
D="$HOME/${DIR}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export TMPDIR="$D/tmp/" npm_config_cache="$D/.npm" CP_HOME_DIR="$D/.cocoapods" EXPO_NO_TELEMETRY=1 CI=1
${process.env.DESKLINK_IOS_XCODE ? `export DEVELOPER_DIR=${JSON.stringify(process.env.DESKLINK_IOS_XCODE)}` : ''}
`;
function mac(script, timeout = 120_000) {
    const run = spawnSync('ssh', ['-o', 'BatchMode=yes', MAC, 'bash -s'], {
        input: PRELUDE + script, encoding: 'utf8', timeout, maxBuffer: 64 << 20,
    });
    if (run.status !== 0) {
        throw new Error(`on the Mac: ${script.trim().split('\n')[0]} → ${run.status ?? run.signal}\n${(run.stdout + run.stderr).slice(-3000)}`);
    }
    return run.stdout;
}

function buildApp(udid) {
    mac('mkdir -p "$D/tmp" "$D/.cocoapods" && printf "cache_root: %s\\n" "$D/.cocoapods-cache" > "$D/.cocoapods/config.yaml"');
    // Everything the app needs from this checkout: the package, not its tests.
    const copy = spawnSync('rsync', [
        '-a', '--delete', '--exclude', 'node_modules', '--exclude', 'example/ios', '--exclude', 'example/.expo',
        '--exclude', 'android', '--exclude', 'test', '--exclude', '*.spec.ts',
        `${join(repo, 'packages/desktop-client')}/`, `${MAC}:${DIR}/desktop-client/`,
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(copy.status, 0, `rsync to the Mac failed: ${copy.stderr}`);
    log('building the example app on the Mac (the first build takes a while)');
    mac(`cd "$D/desktop-client/example"
[ node_modules/.package-lock.json -nt package.json ] || npm install --no-audit --no-fund
# The native project is generated: regenerate it when what it is generated from changes,
# the package's own native module and config plugin included.
if [ ! -f ios/Podfile.lock ] || [ -n "$(find package.json app.json ../expo-module.config.json ../app.plugin.js ../ios -newer ios/Podfile.lock)" ]; then
    rm -rf ios
    npx expo prebuild --platform ios --no-install
    (cd ios && pod install)
fi
cd ios
xcodebuild -workspace desklinkexample.xcworkspace -scheme desklinkexample -configuration Release \\
    -destination "platform=iOS Simulator,id=${udid}" -derivedDataPath "$D/DerivedData" \\
    CODE_SIGNING_ALLOWED=NO build > "$D/build.log" 2>&1 || { tail -60 "$D/build.log"; exit 1; }`, 40 * 60_000);
}

/** Run the XCUITest pointer steps (test/ios-pointer/) against the running app. */
function pointerSteps(udid, steps) {
    const copy = spawnSync('rsync', ['-a', '--delete', `${join(here, 'ios-pointer')}/`, `${MAC}:${DIR}/ios-pointer/`], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(copy.status, 0, `rsync to the Mac failed: ${copy.stderr}`);
    mac(`cd "$D/ios-pointer"
# The project is generated with the xcodeproj gem CocoaPods carries, run on CocoaPods' own Ruby.
POD="$(command -v pod)"
if head -1 "$POD" | grep -q ruby; then RUBY="$(head -1 "$POD" | sed 's/^#! *//')"
else eval "$(grep -o '^GEM_HOME="[^"]*"' "$POD")"; export GEM_HOME; RUBY="$(head -1 "$GEM_HOME/bin/pod" | sed 's/^#! *//')"; fi
$RUBY project.rb
TEST_RUNNER_DESKLINK_POINTER='${JSON.stringify(steps)}' xcodebuild test -project DesklinkPointer.xcodeproj -scheme PointerTests \
    -destination "platform=iOS Simulator,id=${udid}" -derivedDataPath "$D/PointerData" > "$D/pointer.log" 2>&1 || { tail -60 "$D/pointer.log"; exit 1; }`, 10 * 60_000);
}

function simulator() {
    const listed = JSON.parse(mac('xcrun simctl list -j devices available'));
    for (const devices of Object.values(listed.devices)) {
        const found = devices.find((device) => device.name === DEVICE);
        if (found !== undefined) return found.udid;
    }
    const runtimes = JSON.parse(mac('xcrun simctl list -j runtimes available')).runtimes
        .filter((runtime) => runtime.platform === 'iOS' && (RUNTIME === '' || runtime.version.startsWith(RUNTIME)));
    assert(runtimes.length > 0, `the Mac has no iOS simulator runtime ${RUNTIME}`);
    const runtime = runtimes.at(-1).identifier;
    log(`creating simulator ${DEVICE} on ${runtime}`);
    return mac(`xcrun simctl create ${DEVICE} com.apple.CoreSimulator.SimDeviceType.${DEVICE_TYPE} ${runtime}`).trim();
}

/** The status line the app exposes as `testID="desklink-status"`, and the screen's size in points. */
function screen(udid) {
    const tree = JSON.parse(mac(`axe describe-ui --udid ${udid}`));
    let status = null;
    const walk = (node) => {
        if (node.AXUniqueId === 'desklink-status') status = node.AXLabel ?? node.AXValue ?? '';
        for (const child of node.children ?? []) walk(child);
    };
    for (const root of tree) walk(root);
    return { status, frame: tree[0].frame };
}

// ---- processes on this machine ---------------------------------------------
const owned = new Map();
function statOf(pid) {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return { state: fields[0], ppid: Number(fields[1]), started: fields[19] };
    } catch {
        return undefined;
    }
}
function alive(pid) {
    const stat = statOf(pid);
    return stat !== undefined && stat.state !== 'Z' && stat.started === owned.get(pid);
}
function remember(pid) {
    owned.set(pid, statOf(pid)?.started);
}
async function stopProcess(pid, name) {
    if (!alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(25);
    assert(!alive(pid), `${name} ${pid} survived cleanup`);
}
function strays() {
    const found = [];
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid === process.pid) continue;
        try {
            if (readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(MARK)) {
                found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 120)}`);
            }
        } catch { /* vanished */ }
    }
    return found;
}
function which(name) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : null;
}

// ---- the desktop's page: it records every click it is given ------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>desklink</title>
<body style="margin:0;overflow:hidden;font:bold 120px/1.1 system-ui,sans-serif;color:#0b1020">
<div id="box" style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
<div>desklink</div><div id="n" style="font-size:56px"></div></div>
<div id="line" style="position:fixed;left:100px;top:40px;font:40px/48px monospace">select this line of desktop text</div>
<script>
let n = 0;
window.clicks = [];
window.keys = [];
window.pointer = [];
const box = document.getElementById('box');
function frame() {
    n += 1;
    document.getElementById('n').textContent = 'frame ' + n + ' · taps ' + clicks.filter((c) => c.type === 'mousedown').length;
    box.style.background = 'hsl(' + (n * 2 % 360) + ' 85% 62%)';
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
for (const type of ['mousedown', 'mouseup']) addEventListener(type, (event) => {
    clicks.push({ type, x: event.clientX, y: event.clientY, button: event.button });
    if (type !== 'mousedown') return;
    const dot = document.createElement('div');
    dot.style.cssText = 'pointer-events:none;position:fixed;width:36px;height:36px;margin:-18px;border-radius:50%;background:#0b1020;left:' + event.clientX + 'px;top:' + event.clientY + 'px';
    document.body.append(dot);
});
for (const type of ['keydown', 'keyup']) addEventListener(type, (event) => {
    keys.push({ type, key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
    // Tab would move the page's focus; the flow only needs to see it arrive.
    if (event.key === 'Tab') event.preventDefault();
});
for (const type of ['mousemove', 'mousedown', 'mouseup', 'contextmenu', 'wheel']) addEventListener(type, (event) => {
    pointer.push({ type, x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons,
        dy: event.deltaY ?? 0, selection: getSelection().toString() });
    if (type === 'contextmenu') event.preventDefault();
}, { passive: false });
</script>`;

/** Evaluate in the page over the browser's debugging port. */
async function pageEvaluator(profile) {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const port = Number.parseInt(readFileSync(portFile, 'utf8'), 10);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((candidate) => candidate.type === 'page');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((open, fail) => { socket.once('open', open); socket.once('error', fail); });
    let next = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    });
    const evaluate = (expression) => new Promise((done, fail) => {
        const id = ++next;
        pending.set(id, (message) => (message.error || message.result.exceptionDetails
            ? fail(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
            : done(message.result.result.value)));
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    return { evaluate, close: () => socket.close() };
}

// ---- descriptions ------------------------------------------------------------
/** The video section's codecs, with the feedback each negotiated. */
function videoCodecs(sdp) {
    const video = sdp.split(/\r?\n(?=m=)/).find((section) => section.startsWith('m=video'));
    assert(video !== undefined, 'the description has a video section');
    const types = video.split(/\r?\n/)[0].split(' ').slice(3);
    return types.map((type) => ({
        type,
        codec: new RegExp(`^a=rtpmap:${type} ([^/\\s]+)`, 'm').exec(video)?.[1] ?? '?',
        feedback: [...video.matchAll(new RegExp(`^a=rtcp-fb:${type} (.+)$`, 'gm'))].map((match) => match[1].trim()),
    }));
}

// ---- the run -------------------------------------------------------------------
const out = process.env.DESKLINK_IOS_OUT ?? mkdtempSync(join(tmpdir(), 'desklink-ios-flow-'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'desklink-ios-host-'));
let xvfbPid = 0; let pagePid = 0; let bridgePid = 0; let enginePid = 0;
let relay = null; let page = null; let udid = null; let codec = null;

async function cleanup() {
    if (udid !== null) {
        try {
            mac(`xcrun simctl terminate ${udid} ${BUNDLE} || true; xcrun simctl shutdown ${udid} || true`);
        } catch (error) { log('simulator cleanup:', error.message); }
    }
    page?.close();
    relay?.close();
    if (pagePid) await stopProcess(pagePid, 'page browser');
    // SIGTERM lets the bridge close its engine; the engine is reaped after it either way.
    if (bridgePid) await stopProcess(bridgePid, 'bridge');
    if (enginePid) await stopProcess(enginePid, 'engine');
    if (xvfbPid) await stopProcess(xvfbPid, 'Xvfb');
    // Chromium's crash handlers can outlive the browser. Only reap processes
    // carrying this run's private environment marker, never another browser.
    for (const stray of strays()) {
        const pid = Number(stray.split(' ')[0]);
        remember(pid);
        await stopProcess(pid, 'task helper');
    }
    // The page's browser profile is about 100 MB; nothing here outlives the run.
    rmSync(work, { recursive: true, force: true });
    await sleep(200);
    assert.deepEqual(strays(), [], 'task processes survived cleanup');
}

async function main() {
    const engineBin = process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host');
    assert(existsSync(engineBin), `no engine at ${engineBin}: build it or set DESKLINK_ENGINE`);
    assert(existsSync(join(repo, 'packages/desktop-host/dist/bridge.js')), 'run `npm run build` first');
    const chrome = [process.env.DESKLINK_CHROME, 'chromium', 'google-chrome-stable', 'google-chrome']
        .filter(Boolean).map((name) => (name.includes('/') ? name : which(name))).find((path) => path && existsSync(path));
    assert(chrome, 'no Chromium for the desktop page: set DESKLINK_CHROME');
    const hostAddr = process.env.DESKLINK_IOS_HOST_ADDR ?? mac('echo "${SSH_CONNECTION%% *}"').trim();
    assert(hostAddr !== '', 'cannot tell which address the Mac reaches this machine on');

    // ---- simulator app (built first: the host needs nothing from it) ------------
    udid = simulator();
    if (BUILD) buildApp(udid);
    const app = mac(`echo "$D/${APP}"`).trim();
    mac(`test -d "${app}"`);
    // The example opts in to the package's config plugin, so the trackpad's presses carry their buttons.
    assert.equal(mac(`plutil -extract UIApplicationSupportsIndirectInputEvents raw "${app}/Info.plist"`).trim(), 'true',
        'the config plugin set UIApplicationSupportsIndirectInputEvents');

    // ---- private Xvfb -------------------------------------------------------------
    const number = Array.from({ length: 60 }, (_, i) => 170 + i)
        .find((n) => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
    assert(number !== undefined, 'no unclaimed X display at or above :170');
    const display = `:${number}`;
    const authority = join(work, 'Xauthority');
    assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]).status, 0);
    const env = {
        ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '',
        XDG_SESSION_TYPE: 'x11', DESKLINK_IOS_FLOW: String(process.pid),
    };
    const xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', `${DESKTOP.width}x${DESKTOP.height}x24`, '-nolisten', 'tcp'],
        { env, stdio: 'ignore' });
    xvfbPid = xvfb.pid; remember(xvfbPid);
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`) && alive(xvfbPid); i++) await sleep(50);
    assert(alive(xvfbPid), 'the private Xvfb did not start');
    assert.equal(Number(readFileSync(`/tmp/.X${number}-lock`, 'utf8').trim()), xvfbPid, 'the X lock belongs to another server');
    log('xvfb', display, 'pid', xvfbPid);

    // ---- the desktop's page -------------------------------------------------------
    writeFileSync(join(work, 'page.html'), PAGE);
    const profile = join(work, 'profile');
    mkdirSync(profile, { mode: 0o700 });
    const browser = spawn(chrome, [
        // One CSS pixel per desktop pixel, whatever scale the ambient session asks for.
        '--ozone-platform=x11', '--force-device-scale-factor=1', '--kiosk', `--window-size=${DESKTOP.width},${DESKTOP.height}`, '--window-position=0,0',
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage', '--disable-extensions', `file://${join(work, 'page.html')}`,
    ], { env: { ...env, GDK_SCALE: '' }, stdio: 'ignore' });
    pagePid = browser.pid; remember(pagePid);
    page = await pageEvaluator(profile);
    for (let i = 0; i < 50 && (await page.evaluate('innerWidth')) < DESKTOP.width - 1; i++) await sleep(100);
    // A kiosk window may stop a pixel short of the screen's edge; its origin and scale are what matter.
    const [left, top, width, ratio] = await page.evaluate('[screenX, screenY, innerWidth, devicePixelRatio]');
    assert(left === 0 && top === 0 && width >= DESKTOP.width - 1 && ratio === 1,
        `the page covers the desktop one pixel per pixel: at (${left}, ${top}), ${width} wide, scale ${ratio}`);

    // ---- the bridge, exactly as a consumer starts it ------------------------------
    const token = randomBytes(24).toString('hex');
    const bridge = spawn(process.execPath, [join(repo, 'packages/desktop-host/bin/desklink-host.mjs'), 'bridge',
        '--listen', '127.0.0.1:0', '--token', token, '--source', 'x11', '--display', display],
    { env: { ...env, DESKLINK_ENGINE: engineBin }, stdio: ['ignore', 'pipe', 'pipe'] });
    bridgePid = bridge.pid; remember(bridgePid);
    let engineLog = '';
    bridge.stderr.on('data', (chunk) => { engineLog = (engineLog + chunk).slice(-8000); });
    const bridgePort = await new Promise((ready, fail) => {
        let printed = '';
        const timer = setTimeout(() => fail(new Error(`the bridge never printed its URL: ${printed}${engineLog}`)), 30_000);
        bridge.stdout.on('data', (chunk) => {
            printed += chunk;
            const url = /open\s+http:\/\/[^:]+:(\d+)\//.exec(printed);
            if (url) { clearTimeout(timer); ready(Number(url[1])); }
        });
        bridge.on('exit', (code) => fail(new Error(`the bridge exited (${code}): ${engineLog}`)));
    });
    for (const entry of readdirSync('/proc')) {
        if (statOf(Number(entry))?.ppid === bridgePid) { enginePid = Number(entry); remember(enginePid); }
    }
    assert(enginePid !== 0, 'the bridge started no engine');
    log(`bridge on 127.0.0.1:${bridgePort} pid ${bridgePid}, engine pid ${enginePid}`);

    // ---- the relay the simulator connects to: it records what crosses it ----------
    const crossed = { opened: null, offer: null, answer: null };
    relay = new WebSocketServer({ host: hostAddr, port: 0, path: '/desktop' });
    relay.on('connection', (client, request) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${bridgePort}${request.url}`);
        const queued = [];
        const methods = new Map();
        upstream.on('open', () => { for (const line of queued.splice(0)) upstream.send(line); });
        upstream.on('message', (raw) => {
            const line = String(raw);
            const message = JSON.parse(line);
            if (message.event === 'session.description' && crossed.offer === null) {
                crossed.offer = message.params.description.sdp;
                writeFileSync(join(out, 'offer.sdp'), crossed.offer);
            }
            if (methods.get(message.id) === 'session.open' && message.result) crossed.opened = message.result;
            if (client.readyState === WebSocket.OPEN) client.send(line);
        });
        client.on('message', (raw) => {
            const line = String(raw);
            const message = JSON.parse(line);
            methods.set(message.id, message.method);
            if (message.method === 'session.description' && message.params?.description?.type === 'answer' && crossed.answer === null) {
                crossed.answer = message.params.description.sdp;
                writeFileSync(join(out, 'answer.sdp'), crossed.answer);
            }
            if (upstream.readyState === WebSocket.OPEN) upstream.send(line); else queued.push(line);
        });
        client.on('close', () => upstream.close());
        upstream.on('close', () => client.close());
        upstream.on('error', () => client.close());
    });
    await new Promise((listening) => relay.once('listening', listening));
    const relayUrl = `ws://${hostAddr}:${relay.address().port}/desktop?token=${token}`;
    log(`relay on ${hostAddr}:${relay.address().port}`);

    // ---- launch on the simulator ---------------------------------------------------
    mac(`xcrun simctl boot ${udid} 2>/dev/null || true; xcrun simctl bootstatus ${udid} -b > /dev/null
xcrun simctl install ${udid} "${app}"
xcrun simctl terminate ${udid} ${BUNDLE} 2>/dev/null || true
xcrun simctl launch ${udid} ${BUNDLE} -desklinkUrl '${relayUrl}'`, 300_000);
    log(`launched ${BUNDLE} on ${udid}`);

    let seen = { status: null };
    const deadline = Date.now() + 90_000;
    while (!/^live presented\b/.test(seen.status ?? '')) {
        assert(Date.now() < deadline, `the simulator never showed the desktop: status ${seen.status}\n${engineLog}`);
        await sleep(1000);
        try { seen = screen(udid); } catch (error) { seen = { status: `unreadable (${error.message.split('\n')[0]})` }; }
    }
    log(`simulator status: ${seen.status}`);

    // ---- descriptions ---------------------------------------------------------------
    assert(crossed.offer !== null && crossed.answer !== null, 'both descriptions crossed the bridge');
    console.log(`---- iOS answer SDP ----\n${crossed.answer.trim()}\n------------------------`);
    const offered = videoCodecs(crossed.offer);
    const answered = videoCodecs(crossed.answer);
    log(`offer video codecs: ${offered.map((c) => `${c.codec}/${c.type}`).join('; ')}`);
    log(`answer video codecs: ${answered.map((c) => `${c.codec}/${c.type} [${c.feedback.join(', ')}]`).join('; ')}`);
    // The engine codes the answer's first codec; the receiver puts H.264 first
    // whenever the host offers it, because iOS decodes it in hardware.
    const expected = offered.some((c) => c.codec === 'H264') ? 'H264' : 'VP9';
    assert.equal(answered[0].codec, expected, `the receiver answers with ${expected} first`);
    assert(answered[0].feedback.includes('nack'), `NACK is negotiated for ${expected}`);
    assert(answered[0].feedback.includes('nack pli'), `PLI is negotiated for ${expected}`);
    codec = expected;

    // ---- taps -------------------------------------------------------------------------
    const geometry = crossed.opened?.geometry?.encoded;
    assert.deepEqual(geometry, DESKTOP, 'the desktop is encoded at its own size');
    // The app's view fills the screen and letterboxes the picture inside it.
    const { width: screenWidth, height: screenHeight } = seen.frame;
    const scale = Math.min(screenWidth / geometry.width, screenHeight / geometry.height);
    const origin = { x: (screenWidth - geometry.width * scale) / 2, y: (screenHeight - geometry.height * scale) / 2 };
    const slack = Math.ceil(1 / scale) + 1;
    const targets = [{ x: 320, y: 200 }, { x: 960, y: 600 }];
    for (const target of targets) {
        const at = { x: origin.x + (target.x + 0.5) * scale, y: origin.y + (target.y + 0.5) * scale };
        const before = await page.evaluate('clicks.length');
        mac(`axe tap -x ${at.x.toFixed(1)} -y ${at.y.toFixed(1)} --udid ${udid}`);
        let clicks = [];
        for (let i = 0; i < 50 && clicks.length < 2; i++) {
            await sleep(100);
            clicks = (await page.evaluate('clicks')).slice(before);
        }
        assert.deepEqual(clicks.map((click) => click.type), ['mousedown', 'mouseup'], `a tap is one click: ${JSON.stringify(clicks)}`);
        for (const click of clicks) {
            assert(Math.abs(click.x - target.x) <= slack && Math.abs(click.y - target.y) <= slack && click.button === 0,
                `the tap at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) pt clicks desktop (${target.x}, ${target.y}): ${JSON.stringify(click)}`);
        }
        log(`tap at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) pt → host click at (${clicks[0].x}, ${clicks[0].y})`);
    }

    // ---- the picture, as the simulator shows it ------------------------------------------
    // The page drew a dark dot under each click, so a screen that follows the
    // desktop shows both. Each dot is sampled just up and left of its centre,
    // inside the dot and clear of the app's pointer mark.
    const shot = join(out, 'simulator.png');
    const rgb = (png, point) => {
        const i = (Math.round(point.y * png.width / screenWidth) * png.width + Math.round(point.x * png.width / screenWidth)) * 4;
        return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const pixel = (png, point) => rgb(png, point).reduce((sum, value) => sum + value);
    const litShare = (png) => {
        let lit = 0; let total = 0;
        for (let y = origin.y + 2; y < screenHeight - origin.y - 2; y += 2) {
            for (let x = 2; x < screenWidth - 2; x += 2) {
                total += 1;
                if (pixel(png, { x, y }) > 150) lit += 1;
            }
        }
        return lit / total;
    };
    const capture = (path) => {
        mac(`xcrun simctl io ${udid} screenshot "$D/tmp/ios-flow.png" > /dev/null`);
        assert.equal(spawnSync('scp', ['-q', '-o', 'BatchMode=yes', `${MAC}:${DIR}/tmp/ios-flow.png`, path]).status, 0, 'copy the screenshot back');
        return PNG.sync.read(readFileSync(path));
    };
    let png = null;
    let follows = false;
    for (let attempt = 0; attempt < 10 && !follows; attempt++) {
        await sleep(500);
        png = capture(shot);
        follows = litShare(png) > 0.5 && targets.every((target) => pixel(png, {
            x: origin.x + (target.x - 10) * scale, y: origin.y + (target.y - 10) * scale,
        }) < 200);
    }
    const lit = litShare(png);
    assert(lit > 0.5, `the simulator shows the desktop, not a black picture: ${(100 * lit).toFixed(1)}% lit`);
    log(`screenshot ${shot}: ${(100 * lit).toFixed(1)}% of the picture lit`);
    assert(follows, 'the simulator shows both clicks: its picture follows the desktop, not a frame from before the taps');

    if (POINTER_PROOF) {
        // Aim at the displayed tip, then record the actual desktop page events.
        // This checks the user surface and host together, including UIKit's
        // coordinate rounding, rather than accepting the broader flow slack.
        const previous = (await page.evaluate('clicks')).filter((click) => click.type === 'mousedown').at(-1);
        const tip = { x: origin.x + (previous.x + 0.5) * scale, y: origin.y + (previous.y + 0.5) * scale };
        const count = await page.evaluate('clicks.length');
        mac(`axe tap -x ${tip.x.toFixed(1)} -y ${tip.y.toFixed(1)} --udid ${udid}`);
        let received = [];
        for (let i = 0; i < 50 && received.length < 2; i++) {
            await sleep(100);
            received = (await page.evaluate('clicks')).slice(count);
        }
        assert.deepEqual(received.map((click) => click.type), ['mousedown', 'mouseup']);
        const error = Math.hypot(received[0].x - previous.x, received[0].y - previous.y);
        assert(error <= 2, `tap at pointer tip differs by ${error} desktop pixels`);
        const lines = received.map((click) => `host ${click.type} x=${click.x} y=${click.y} button=${click.button}; tip desktop=(${previous.x},${previous.y}); error=${error}px`);
        writeFileSync(join(out, 'host-click.log'), lines.join('\n') + '\n');
        for (const line of lines) log(line);
        await sleep(500);
        const frame = capture(join(out, 'desklink-ios-pointer-frame.png'));
        const density = frame.width / screenWidth;
        const mark = received[0];
        const x = Math.round((origin.x + (mark.x + 0.5) * scale - 10) * density);
        const y = Math.round((origin.y + (mark.y + 0.5) * scale - 10) * density);
        const side = Math.round(48 * density);
        const crop = new PNG({ width: side * 4, height: side * 4 });
        for (let cy = 0; cy < crop.height; cy++) {
            for (let cx = 0; cx < crop.width; cx++) {
                const source = ((y + Math.floor(cy / 4)) * frame.width + x + Math.floor(cx / 4)) * 4;
                frame.data.copy(crop.data, (cy * crop.width + cx) * 4, source, source + 4);
            }
        }
        writeFileSync(join(out, `desklink-ios-pointer-${POINTER_PROOF}.png`), PNG.sync.write(crop));
        writeFileSync(join(out, 'pointer-proof.json'), JSON.stringify({ device: IPAD ? 'iPad' : 'iPhone', udid, density, screen: seen.frame, desktop: geometry, scale, origin, tip, received, error, crop: { x, y, side, magnification: 4 } }, null, 2));
        log(`pointer ${POINTER_PROOF}: ${density}x display, 4x crop, host tip error ${error}px`);
    }
    // The page's background changes hue every frame, so a live picture is
    // another colour moments later, away from the text and the dots. A few
    // tries, so a whole turn of the hue between two screenshots cannot fool it.
    const corner = { x: origin.x + 40 * scale, y: origin.y + 40 * scale };
    const before = rgb(png, corner);
    let after = before;
    for (let attempt = 0; attempt < 3 && before.every((value, i) => Math.abs(value - after[i]) <= 8); attempt++) {
        await sleep(400);
        after = rgb(capture(join(out, 'simulator-later.png')), corner);
    }
    assert(before.some((value, i) => Math.abs(value - after[i]) > 8),
        `the picture keeps changing with the desktop: background rgb(${before}), then rgb(${after})`);
    log(`the picture follows the desktop: both clicks shown, background rgb(${before}) → rgb(${after})`);

    // ---- the hardware keyboard ------------------------------------------------------------
    // HID usages pressed on the simulator's keyboard reach the app as a hardware
    // keyboard's would: Up, Esc, Tab, Command+C, then typed text.
    const keysBefore = await page.evaluate('keys.length');
    for (const press of ['key 82', 'key 41', 'key 43', 'key-combo --modifiers 227 --key 6', 'type desk']) mac(`axe ${press} --udid ${udid}`);
    let keys = [];
    for (let i = 0; i < 50 && !keys.some((key) => key.type === 'keyup' && key.key === 'k'); i++) {
        await sleep(100);
        keys = (await page.evaluate('keys')).slice(keysBefore);
    }
    const downs = keys.filter((key) => key.type === 'keydown');
    log(`host keys: ${downs.map((key) => `${key.meta ? 'Meta+' : ''}${key.key}`).join(' ')}`);
    // The desktop reports Command's Meta as its own key too; the chord is what matters.
    assert.deepEqual(downs.map((key) => key.key).filter((key) => key !== 'Meta' && key !== 'OS'),
        ['ArrowUp', 'Escape', 'Tab', 'c', 'd', 'e', 's', 'k'], 'the hardware keys arrive as themselves, in order');
    assert(downs.find((key) => key.key === 'c').meta, 'Command+C arrives as Meta+C');
    for (const down of downs) {
        assert(keys.some((key) => key.type === 'keyup' && key.key === down.key), `${down.key} is released, not left held`);
    }

    // ---- the trackpad (iPad) ----------------------------------------------------------------
    if (!IPAD) {
        log('trackpad checks skipped: set DESKLINK_IOS_IPAD=1 to run on an iPad simulator');
    } else {
        const screenAt = (desktop) => ({ x: origin.x + (desktop.x + 0.5) * scale, y: origin.y + (desktop.y + 0.5) * scale });
        const [left, top, right, bottom] = await page.evaluate(
            '(() => { const box = document.getElementById("line").getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom]; })()');
        const line = Math.round((top + bottom) / 2);
        const spots = {
            from: { x: Math.round(left) + 8, y: line }, to: { x: Math.round(right) - 8, y: line },
            menu: { x: 640, y: 560 }, wheel: { x: 640, y: 400 },
        };
        const steps = [
            { action: 'drag', ...screenAt(spots.from), toX: screenAt(spots.to).x, toY: screenAt(spots.to).y },
            { action: 'rightClick', ...screenAt(spots.menu) },
            { action: 'scroll', ...screenAt(spots.wheel), dy: -200 },
        ];
        const pointerBefore = await page.evaluate('pointer.length');
        log('driving the trackpad with XCUITest');
        pointerSteps(udid, steps);
        await sleep(500);
        const seen = (await page.evaluate('pointer')).slice(pointerBefore);
        writeFileSync(join(out, 'pointer-events.json'), JSON.stringify(seen, null, 1));
        log(`page pointer events: ${seen.filter((event) => event.type !== 'mousemove').map((event) => `${event.type}/${event.button}@${event.x},${event.y}`).join(' ')}; ${seen.filter((event) => event.type === 'mousemove' && event.buttons === 0).length} buttonless moves`);
        const near = (event, spot) => Math.abs(event.x - spot.x) <= slack && Math.abs(event.y - spot.y) <= slack;
        const down = seen.findIndex((event) => event.type === 'mousedown' && event.button === 0 && near(event, spots.from));
        assert(down >= 0, `a trackpad press is a left button down where it pressed: ${JSON.stringify(seen.filter((event) => event.type !== 'mousemove'))}`);
        const up = seen.findIndex((event, i) => i > down && event.type === 'mouseup' && event.button === 0);
        assert(up > down && near(seen[up], spots.to), `the drag lets go where it ended: ${JSON.stringify(seen[up])}`);
        assert(seen.slice(down, up).some((event) => event.type === 'mousemove' && (event.buttons & 1) === 1), 'the button stays held through the drag');
        assert.match(seen[up].selection, /line of desktop/, 'the click-drag selected the page\'s text');
        log(`drag-select: pressed at (${seen[down].x}, ${seen[down].y}), released at (${seen[up].x}, ${seen[up].y}), selected "${seen[up].selection}"`);
        const menu = seen.find((event) => event.type === 'mousedown' && event.button === 2);
        assert(menu !== undefined && near(menu, spots.menu), `a secondary click is a right click where it clicked: ${JSON.stringify(menu)}`);
        assert(seen.some((event) => event.type === 'contextmenu'), 'the page got its context menu event');
        const wheels = seen.filter((event) => event.type === 'wheel');
        assert(wheels.length > 0, 'a trackpad scroll turns the desktop wheel');
        log(`right click at (${menu.x}, ${menu.y}); scroll: ${wheels.length} wheel events, deltaY total ${wheels.reduce((sum, event) => sum + event.dy, 0)}`);
        // XCUITest's own hover() reaches no app on the simulator, but the pointer's
        // hover reports go on while it rests over the scroll: each is a buttonless
        // move, besides the one move the scroll makes to put the pointer under it.
        const hovers = seen.filter((event) => event.type === 'mousemove' && event.buttons === 0 && near(event, spots.wheel)).length;
        assert(hovers > 1, `the pointer's hover moves the desktop's pointer with no button held: ${hovers} buttonless moves at the scroll`);
        log(`hover: ${hovers - 1} buttonless moves from the pointer's hover reports`);
    }
    console.log(`ok: the iOS receiver shows the live desktop, answers ${codec} with NACK, its taps click the host and its hardware input drives it${IPAD ? ', trackpad included' : ''} (${out})`);
}

let failed = false;
try {
    await main();
} catch (error) {
    failed = true;
    console.error('FLOW-FAIL', error instanceof Error ? error.message : error);
}
try {
    await cleanup();
} catch (error) {
    failed = true;
    console.error('CLEANUP-FAIL', error instanceof Error ? error.message : error);
}
process.exit(failed ? 1 : 0);
