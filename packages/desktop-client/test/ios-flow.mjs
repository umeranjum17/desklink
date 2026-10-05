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
 *  - the picture fills the phone from the desktop's top-left corner, below the
 *    status bar, and keeps following the desktop, a notes page: it shows the
 *    dots the page drew under those clicks, and the note's caret blinking;
 *  - one finger pans the picture without clicking; turned to landscape, black
 *    bars stay under 15% of the screen, and turned back the picture starts at
 *    the top-left corner again (screenshots of each are saved);
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
 * copied there, built, installed on a uniquely named `desklink-ios-flow-*`
 * simulator (created and deleted by this run), or on one of the Mac's own
 * simulators with DESKLINK_IOS_DEVICE (left in place), launched with the
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
 *   DESKLINK_IOS_DEVICE     name or udid of one of the Mac's own simulators to
 *                           run on instead, left in place (default: a throwaway
 *                           simulator this run creates and deletes)
 *   DESKLINK_IOS_TREE       path receiving the raw accessibility tree JSON
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { pictureBox } from './picture-box.mjs';
import { WebSocket, WebSocketServer } from 'ws';

import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const MAC = process.env.DESKLINK_IOS_MAC ?? '';
const DIR = process.env.DESKLINK_IOS_DIR ?? 'desklink-ios';
const BUILD = process.env.DESKLINK_IOS_SKIP_BUILD !== '1';
// Expo names the built app after the app, not after the package; an explicit
// DESKLINK_IOS_APP overrides what the build products hold.
const APP = process.env.DESKLINK_IOS_APP ?? '';
if (APP !== '') assert.match(APP, /^[\w.-]+(\/[\w.-]+)*$/, 'DESKLINK_IOS_APP is a plain path under the task directory');
const BUNDLE = 'dev.desklink.example';
const RUNTIME = process.env.DESKLINK_IOS_RUNTIME ?? '';
/** Run on one of the Mac's own named simulators instead of a throwaway one. */
const REUSE = process.env.DESKLINK_IOS_DEVICE ?? '';
const IPAD = process.env.DESKLINK_IOS_IPAD === '1';
const POINTER_PROOF = process.env.DESKLINK_IOS_POINTER_PROOF;
if (POINTER_PROOF) assert(['before', 'after'].includes(POINTER_PROOF));
const DEVICE = ['desklink-ios-flow', IPAD ? 'ipad' : '', RUNTIME, process.pid, randomBytes(8).toString('hex')].filter(Boolean).join('-');
const DEVICE_TYPE = IPAD ? 'iPad-Pro-11-inch-M4-8GB' : 'iPhone-16';
const DESKTOP = { width: 1280, height: 720 };
/** The notes column, near the desktop's left edge: the filled picture shows it on every simulator the flow runs on. */
const COLUMN = { left: 40, right: 340 };
const MARK = `DESKLINK_IOS_FLOW=${process.pid}`;
const browserSession = randomBytes(16).toString('hex');

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
# Expo names the generated project after the app, which is not the package's name.
WS="$(ls -d *.xcworkspace | head -1)"
xcodebuild -workspace "$WS" -scheme "$(basename "$WS" .xcworkspace)" -configuration Release \\
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
    if (REUSE !== '') {
        const named = Object.values(JSON.parse(mac('xcrun simctl list devices -j')).devices).flat()
            .filter((device) => device.isAvailable !== false);
        const found = named.find((device) => device.name === REUSE || device.udid === REUSE);
        assert(found, `the Mac has no available simulator named ${REUSE}`);
        log(`using the Mac's own simulator ${found.name} (${found.udid}); this run leaves it in place`);
        return { udid: found.udid, temporary: false };
    }
    const runtimes = JSON.parse(mac('xcrun simctl list -j runtimes available')).runtimes
        .filter((runtime) => runtime.platform === 'iOS' && (RUNTIME === '' || runtime.version.startsWith(RUNTIME)));
    assert(runtimes.length > 0, `the Mac has no iOS simulator runtime ${RUNTIME}`);
    const runtime = runtimes.at(-1).identifier;
    log(`creating simulator ${DEVICE} on ${runtime}`);
    return { udid: mac(`xcrun simctl create ${DEVICE} com.apple.CoreSimulator.SimDeviceType.${DEVICE_TYPE} ${runtime}`).trim(), temporary: true };
}

/**
 * Every string the simulator's own screen shows, with the node it came from:
 * no metrics, no URLs, no tokens, and no word counted twice for one node.
 */
function visibleNodes(udid) {
    const entries = [];
    let seen = 0;
    const walk = (node) => {
        const own = [...new Set(['AXLabel', 'AXValue']
            .map((field) => node[field])
            .filter((value) => typeof value === 'string' && value.trim() !== '')
            .map((value) => value.trim()))]
            .map((value) => ({
                text: value,
                id: node.AXUniqueId ?? null,
                frame: node.AXFrame ?? null,
                pid: node.pid ?? null,
                key: node.AXUniqueId ?? `node-${seen++}`,
            }));
        // A node whose label and value are the same string says it once, and a
        // container whose whole string is its only child's is speaking for it:
        // neither is a second word on the phone's screen.
        // axe's tree spells its child list differently at different levels, so
        // take whichever array of nodes the node carries.
        const kids = Object.values(node).find((value) => Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object')) ?? [];
        const below = kids.map((child) => walk(child));
        const children = below.flatMap((result) => result.entries);
        const echoes = own.length === 1 && kids.length === 1 ? children.filter((entry) => entry.text === own[0]) : [];
        // An unnamed container reports its subtree's text as its own, at any
        // depth. That is the accessibility tree echoing one word that is on the
        // screen once, not a second label: a named control keeps its own.
        const said = new Set(below.flatMap((result) => result.texts));
        const mine = own.filter((entry) => entry.id !== null || !said.has(entry.text));
        return {
            entries: [...children.filter((entry) => !echoes.includes(entry)), ...mine],
            texts: [...said, ...mine.map((entry) => entry.text)],
        };
    };
    const tree = JSON.parse(mac(`axe describe-ui --udid ${udid}`));
    if (process.env.DESKLINK_IOS_TREE) writeFileSync(process.env.DESKLINK_IOS_TREE, JSON.stringify(tree, null, 1));
    for (const root of tree) entries.push(...walk(root).entries);
    // React Native hands the accessibility tree a wrapper and its inner text
    // node at the same frame in the same process: one word on the phone's
    // screen, two nodes saying it. Collapse by frame, keeping the named node.
    const byFrame = new Map();
    for (const entry of entries) {
        const same = `${entry.pid}|${entry.frame}|${entry.text}`;
        const previous = byFrame.get(same);
        if (previous === undefined || (previous.id === null && entry.id !== null)) byFrame.set(same, entry);
    }
    return [...byFrame.values()];
}

const visibleText = (udid) => visibleNodes(udid).map((entry) => entry.text);

/** Whichever array of nodes an axe tree node carries its children under. */
function kidsOf(node) {
    return Object.values(node).find((value) => Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object')) ?? [];
}

/** The hidden accessibility status the app exposes as `testID="desklink-status"`, and the screen's size in points. */
function screen(udid) {
    const tree = JSON.parse(mac(`axe describe-ui --udid ${udid}`));
    if (process.env.DESKLINK_IOS_TREE) writeFileSync(process.env.DESKLINK_IOS_TREE, JSON.stringify(tree, null, 1));
    let status = null;
    const walk = (node) => {
        if (node.AXUniqueId === 'desklink-status') status = node.AXLabel ?? node.AXValue ?? '';
        for (const child of kidsOf(node)) walk(child);
    };
    for (const root of tree) walk(root);
    return { status, frame: tree[0].frame };
}

/** The accessibility value the simulator's own screen carries for one identifier. */
function byId(udid, id) {
    const tree = JSON.parse(mac(`axe describe-ui --udid ${udid}`));
    if (process.env.DESKLINK_IOS_TREE) writeFileSync(process.env.DESKLINK_IOS_TREE, JSON.stringify(tree, null, 1));
    let found = null;
    const walk = (node) => {
        if (node.AXUniqueId === id) found = { label: node.AXLabel ?? null, value: node.AXValue ?? null };
        for (const child of kidsOf(node)) walk(child);
    };
    for (const root of tree) walk(root);
    assert(found, `the screen has no ${id}`);
    return found;
}

async function waitForId(udid, id, want) {
    const deadline = Date.now() + 15_000;
    let seen = null;
    while (Date.now() < deadline) {
        try {
            seen = byId(udid, id);
            if (seen.value === want) return seen;
        } catch (error) {
            if (!String(error?.message ?? error).includes(`the screen has no ${id}`)) throw error;
        }
        await sleep(500);
    }
    assert.equal(seen?.value, want, `the screen never showed ${id} as ${want}`);
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
function rememberBrowserHelpers() {
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || owned.has(pid)) continue;
        try {
            const stat = statOf(pid);
            if (!stat || stat.state === 'Z' || statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
            if (!readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DESKLINK_IOS_BROWSER_SESSION=${browserSession}`)) continue;
            if (statOf(pid)?.started === stat.started) owned.set(pid, stat.started);
        } catch {}
    }
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
// A notes page, written in a column near the desktop's left edge: a filled
// phone starts at the top-left corner in either orientation. Its caret blinks, so a live
// picture changes on its own; typed keys land in the note.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Notes</title>
<body style="margin:0;overflow:hidden;background:#fbfaf7;color:#1d1d1f;font:24px/1.5 system-ui,sans-serif">
<main style="position:fixed;top:0;bottom:0;left:${COLUMN.left}px;width:${COLUMN.right - COLUMN.left}px;padding-top:56px">
<h1 style="font:600 34px/1.2 system-ui,sans-serif;margin:0 0 20px">Umer's notes</h1>
<p style="margin:0 0 12px">Desk lamp: warmer bulb</p>
<p style="margin:0 0 12px"><span id="line">select this line</span></p>
<p style="margin:0 0 12px">Call about the shelf on Friday</p>
<p style="margin:0"><span id="typed"></span><span id="caret" style="display:inline-block;width:3px;height:30px;vertical-align:-6px;background:#1d1d1f"></span></p>
<textarea id="pad" aria-label="notes pad" style="position:fixed;left:${COLUMN.left}px;top:600px;width:280px;height:96px;font:20px/1.4 system-ui,sans-serif;border:1px solid #b9b6ae;border-radius:8px;background:#fff;padding:6px"></textarea>
<button id="copy-out" style="position:fixed;left:400px;top:600px;width:170px;height:44px;font:17px system-ui,sans-serif;border-radius:8px;background:#1d1d1f;color:#fbfaf7">Copy this line</button>
</main>
<script>
window.clicks = [];
window.keys = [];
window.pointer = [];
window.pastes = [];
// Each step of the flow clears the desktop's marks first, so a capture shows
// only what that step did.
window.reset = () => {
    for (const dot of document.querySelectorAll('.click-dot')) dot.remove();
    window.clicks.length = 0;
    window.keys.length = 0;
    window.pointer.length = 0;
    window.pastes.length = 0;
};
const caret = document.getElementById('caret');
setInterval(() => { caret.style.visibility = caret.style.visibility === 'hidden' ? 'visible' : 'hidden'; }, 300);
const pad = document.getElementById('pad');
pad.addEventListener('paste', (event) => {
    window.pastes.push({ text: event.clipboardData ? event.clipboardData.getData('text') : '', value: pad.value });
});
document.getElementById('copy-out').addEventListener('click', async () => {
    window.copyAttempts = (window.copyAttempts ?? 0) + 1;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('line'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let ok = document.execCommand('copy');
    if (!ok && navigator.clipboard) {
        try { await navigator.clipboard.writeText(selection.toString()); ok = true; } catch (error) { window.copyError = String(error); }
    }
    window.copied = ok ? selection.toString() : null;
});
addEventListener('keydown', (event) => {
    // The mirror is for keys typed at the page itself: a focused field takes
    // its own characters, so mirroring those too would double them on screen.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && document.activeElement === document.body) {
        document.getElementById('typed').textContent += event.key;
    }
});
for (const type of ['mousedown', 'mouseup']) addEventListener(type, (event) => {
    clicks.push({ type, x: event.clientX, y: event.clientY, button: event.button });
    if (type !== 'mousedown') return;
    const dot = document.createElement('div');
    dot.className = 'click-dot';
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
    for (let i = 0; i < 300 && !existsSync(portFile); i++) await sleep(100);
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
let xvfbPid = 0; let xvfb; let pagePid = 0; let bridgePid = 0; let enginePid = 0;
let relay = null; let page = null; let udid = null; let codec = null; let temporarySimulator = false;

async function cleanup() {
    if (udid !== null && temporarySimulator) {
        try {
            mac(`xcrun simctl terminate ${udid} ${BUNDLE} || true; xcrun simctl shutdown ${udid} || true; xcrun simctl delete ${udid}`);
            udid = null;
        } catch (error) { log('simulator cleanup:', error.message); }
    }
    page?.close();
    relay?.close();
    rememberBrowserHelpers();
    if (pagePid) await stopProcess(pagePid, 'page browser');
    rememberBrowserHelpers();
    for (const pid of owned.keys()) {
        if (pid !== pagePid && pid !== bridgePid && pid !== enginePid && pid !== xvfbPid) await stopProcess(pid, 'page browser helper');
    }
    // SIGTERM lets the bridge close its engine; the engine is reaped after it either way.
    if (bridgePid) await stopProcess(bridgePid, 'bridge');
    if (enginePid) await stopProcess(enginePid, 'engine');
    if (xvfb) await stopOwnedXvfb(xvfb);
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
    ({ udid, temporary: temporarySimulator } = simulator());
    if (BUILD) buildApp(udid);
    const app = (APP === '' ? mac('ls -d "$D/DerivedData/Build/Products/Release-iphonesimulator/"*.app | head -1').trim() : mac(`echo "$D/${APP}"`).trim());
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
    xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', `${DESKTOP.width}x${DESKTOP.height}x24`, '-nolisten', 'tcp'],
        { env, stdio: 'ignore' });
    trackOwnedXvfb(xvfb, display);
    xvfbPid = xvfb.pid; remember(xvfbPid);
    for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`) && alive(xvfbPid); i++) await sleep(50);
    assert(alive(xvfbPid), 'the private Xvfb did not start');
    await verifyOwnedXvfb(xvfb);
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
    ], { env: { ...env, GDK_SCALE: '', DESKLINK_IOS_BROWSER_SESSION: browserSession }, stdio: 'ignore' });
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
    mac(`mkdir -p "$D/tmp"
xcrun simctl boot ${udid} 2>/dev/null || true; xcrun simctl bootstatus ${udid} -b > /dev/null
xcrun simctl install ${udid} "${app}"
xcrun simctl terminate ${udid} ${BUNDLE} 2>/dev/null || true
xcrun simctl launch ${udid} ${BUNDLE} -desklinkUrl '${relayUrl}'`, 300_000);
    log(`launched ${BUNDLE} on ${udid}`);

    let seen = { status: null };
    const deadline = Date.now() + 90_000;
    while (seen.status !== 'Connected') {
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
    // Where it landed is read off a screenshot: the light paper on the app's black.
    const { width: screenWidth, height: screenHeight } = seen.frame;
    const rgb = (png, point) => {
        const i = (Math.round(point.y * png.width / screenWidth) * png.width + Math.round(point.x * png.width / screenWidth)) * 4;
        return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const pixel = (png, point) => rgb(png, point).reduce((sum, value) => sum + value);
    const capture = (path) => {
        mac(`xcrun simctl io ${udid} screenshot "$D/tmp/ios-flow.png" > /dev/null`);
        assert.equal(spawnSync('scp', ['-q', '-o', 'BatchMode=yes', `${MAC}:${DIR}/tmp/ios-flow.png`, path]).status, 0, 'copy the screenshot back');
        return PNG.sync.read(readFileSync(path));
    };
    /** Share of the screen inside fully black rows or columns: the letterbox. */
    const barShare = (png) => {
        const dark = (x, y) => { const i = (y * png.width + x) * 4; return png.data[i] + png.data[i + 1] + png.data[i + 2] < 30; };
        let rows = 0; for (let y = 0; y < png.height; y++) { let n = 0; for (let x = 0; x < png.width; x += 2) n += dark(x, y); if (n >= 0.98 * Math.ceil(png.width / 2)) rows++; }
        let cols = 0; for (let x = 0; x < png.width; x++) { let n = 0; for (let y = 0; y < png.height; y += 2) n += dark(x, y); if (n >= 0.98 * Math.ceil(png.height / 2)) cols++; }
        return (rows * png.width + cols * png.height - rows * cols) / (png.width * png.height);
    };
    // The first frame can trail the live status by a moment.
    let box = { top: 0, left: 0, bottom: 0 };
    for (let attempt = 0; attempt < 20 && box.bottom - box.top < screenWidth * geometry.height / geometry.width - 2; attempt++) {
        if (attempt > 0) await sleep(500);
        box = pictureBox(capture(join(out, 'desklink-receiver-fill-portrait.png')), screenWidth);
    }
    const scale = (box.bottom - box.top) / geometry.height;
    const origin = { x: box.left, y: box.top };
    assert(box.left <= 1, `the picture starts at the screen's left edge, the desktop's left edge with it: ${box.left.toFixed(1)} pt`);
    assert(box.top >= 20, `the status bar does not cover the picture: it starts ${box.top.toFixed(1)} pt down`);
    assert(Math.abs(scale * geometry.width - screenWidth) <= 3, `portrait fits the screen's width: ${(scale * geometry.width).toFixed(0)} pt`);
    const slack = Math.ceil(1 / scale) + 1;
    const shown = { left: -origin.x / scale, right: (screenWidth - origin.x) / scale };
    assert(shown.left <= COLUMN.left && shown.right >= COLUMN.right, `the screen shows the notes column: desktop x ${shown.left.toFixed(0)}-${shown.right.toFixed(0)}`);
    log(`picture ${(geometry.width * scale).toFixed(0)}x${(geometry.height * scale).toFixed(0)} pt at (${origin.x.toFixed(1)}, ${origin.y.toFixed(1)}) on a ${screenWidth}x${screenHeight} pt screen`);
    const targets = [{ x: 120, y: 300 }, { x: 300, y: 560 }];
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
    const litShare = (png) => {
        let lit = 0; let total = 0;
        for (let y = box.top + 2; y < box.bottom - 2; y += 2) {
            for (let x = box.left + 2; x < screenWidth - 2; x += 2) {
                total += 1;
                if (pixel(png, { x, y }) > 150) lit += 1;
            }
        }
        return lit / total;
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
    // The note's caret blinks, so a live picture shows it lit, then not, moments
    // later. A few tries, so two screenshots a whole blink apart cannot fool it.
    const [caretX, caretY] = await page.evaluate('(() => { const box = document.getElementById("caret").getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()');
    const caret = { x: origin.x + caretX * scale, y: origin.y + caretY * scale };
    const before = rgb(png, caret);
    let after = before;
    for (let attempt = 0; attempt < 6 && before.every((value, i) => Math.abs(value - after[i]) <= 8); attempt++) {
        await sleep(250);
        after = rgb(capture(join(out, 'simulator-later.png')), caret);
    }
    assert(before.some((value, i) => Math.abs(value - after[i]) > 8),
        `the picture keeps changing with the desktop: caret rgb(${before}), then rgb(${after})`);
    log(`the picture follows the desktop: both clicks shown, caret rgb(${before}) → rgb(${after})`);

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
            menu: { x: 200, y: 560 }, wheel: { x: 200, y: 400 },
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
        assert.match(seen[up].selection, /this/, 'the click-drag selected the page\'s text');
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
    // ---- phone-only control --------------------------------------------------------
    // Every step below reaches the desktop from the phone's own screen. Nothing in
    // this run sends input to the lab display from here: the page's event log is
    // the only record of the desktop's side of it.
    const screenPoint = (point) => ({ x: origin.x + (point.x + 0.5) * scale, y: origin.y + (point.y + 0.5) * scale });
    const within = (event, spot) => event !== undefined && Math.abs(event.x - spot.x) <= slack && Math.abs(event.y - spot.y) <= slack;
    const tapDesktop = (spot) => mac(`axe tap -x ${screenPoint(spot).x.toFixed(1)} -y ${screenPoint(spot).y.toFixed(1)} --udid ${udid}`);
    const steps = [];
    // Every step starts from a cleared desktop, so its capture carries only
    // what that step did.
    const clean = async () => { await page.evaluate('window.reset()'); return 0; };
    const step = async (name, note) => {
        const shot = join(out, `step-${name}.png`);
        capture(shot);
        steps.push({ step: name, capture: shot.split('/').pop(), result: note });
        log(`step ${name}: ${note} (${shot})`);
    };
    // What the phone's screen says, with nothing diagnostic on it and no word
    // said twice by one node.
    const onScreen = visibleNodes(udid);
    const diagnostics = onScreen.filter((entry) => /wss?:\/\/|[Tt]oken|key=|bearer|0x[0-9a-f]{6}|\bfps\b|\bms\b.*\bpixels?\b/i.test(entry.text));
    assert.deepEqual(diagnostics, [], `the phone screen shows no addresses, tokens or metrics: ${JSON.stringify(diagnostics)}`);
    const repeated = onScreen.map((entry) => entry.text).filter((text, index, all) => all.indexOf(text) !== index);
    writeFileSync(join(out, 'visible-text.json'), JSON.stringify(onScreen, null, 1));
    log(`the phone screen carries ${onScreen.length} strings, none diagnostic, no string twice: ${onScreen.map((entry) => `${entry.text}${entry.id ? ` [${entry.id}]` : ''}`).join(' | ')}`);
    log(`every string is one thing on the screen: ${onScreen.map((entry) => `${entry.text}@${entry.frame}`).join(' | ')}`);
    if (repeated.length > 0) log(`strings that appear on more than one node, each a real control: ${[...new Set(repeated)].join(', ')}`);
    // The fit is the documented one, and it is not "fills": portrait fits the
    // desktop to the screen's width, so a 16:9 desktop on a tall phone is a
    // band at the top with the app's own chrome below it. Measure and say it.
    const fitWidthHeight = screenWidth * geometry.height / geometry.width;
    const pictureHeightPt = box.bottom - box.top;
    assert(Math.abs(pictureHeightPt - fitWidthHeight) <= 2,
        `portrait shows the whole desktop at the width fit: ${pictureHeightPt.toFixed(0)} pt tall against ${fitWidthHeight.toFixed(0)} pt predicted`);
    assert(fitWidthHeight <= screenHeight, `the whole desktop fits a portrait phone without cropping: ${fitWidthHeight.toFixed(0)} pt of ${screenHeight} pt`);
    assert.equal(onScreen.filter((entry) => entry.text === 'Connected').length, 1,
        `the phone says its live status once, not twice: ${JSON.stringify(onScreen.filter((entry) => entry.text === 'Connected'))}`);
    await step('00-live-desktop', `live desktop at the documented portrait fit: ${(geometry.width * scale).toFixed(0)}x${pictureHeightPt.toFixed(0)} pt band at the top of a ${screenWidth}x${screenHeight} pt screen (${(100 * pictureHeightPt / screenHeight).toFixed(0)}% of its height; the rest is letterbox and the app's own chrome), no diagnostic text on the phone`);

    // The whole phone-only journey as one screen recording on the Mac.
    mac(`nohup xcrun simctl io ${udid} recordVideo --codec=h264 "$D/tmp/phone-control.mp4" > "$D/tmp/record.log" 2>&1 < /dev/null & echo $! > "$D/tmp/record.pid"; sleep 3`);

    // 1. pointer and click
    const press = { x: 700, y: 460 };
    let since = await clean();
    tapDesktop(press);
    let clicked = [];
    for (let i = 0; i < 50 && clicked.length < 2; i++) { await sleep(100); clicked = (await page.evaluate('clicks')).slice(since); }
    assert.deepEqual(clicked.map((click) => click.type), ['mousedown', 'mouseup'], `a tap on the phone is one click on the desktop: ${JSON.stringify(clicked)}`);
    assert(within(clicked[0], press) && clicked[0].button === 0, `the click lands under the finger: ${JSON.stringify(clicked[0])}`);
    await step('01-click', `tap → mousedown+mouseup at desktop (${clicked[0].x}, ${clicked[0].y})`);

    // 2. drag: hold the button and move, and let go where the finger lifted
    const [lineLeft, lineTop, lineRight, lineBottom] = await page.evaluate(
        '(() => { const box = document.getElementById("line").getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom]; })()');
    const from = { x: Math.round(lineLeft) + 6, y: Math.round((lineTop + lineBottom) / 2) };
    const to = { x: Math.round(lineRight) - 6, y: from.y };
    since = await clean();
    pointerSteps(udid, [{ action: IPAD ? 'drag' : 'dragTouch', ...screenPoint(from), toX: screenPoint(to).x, toY: screenPoint(to).y }]);
    await sleep(500);
    const dragged = (await page.evaluate('pointer')).slice(since);
    writeFileSync(join(out, 'step-02-drag-events.json'), JSON.stringify(dragged, null, 1));
    const held = dragged.filter((event) => event.type === 'mousemove' && (event.buttons & 1) === 1);
    const dragDown = dragged.find((event) => event.type === 'mousedown' && event.button === 0);
    const dragUp = dragged.find((event) => event.type === 'mouseup' && event.button === 0);
    assert(within(dragDown, from), `the drag presses where the finger went down: ${JSON.stringify(dragDown)}`);
    assert(within(dragUp, to), `the drag lets go where the finger lifted: ${JSON.stringify(dragUp)}`);
    assert(held.length > 0, `the button is held while the finger travels: ${held.length} moves with it down`);
    assert.match(dragUp.selection ?? '', /this/, `the drag selected the page's text: ${JSON.stringify(dragUp.selection)}`);
    await step('02-drag', `press (${dragDown.x}, ${dragDown.y}) → ${held.length} held moves → release (${dragUp.x}, ${dragUp.y}), selected ${JSON.stringify(dragUp.selection)}`);

    // 3. two fingers scroll the desktop; a one finger would pan the picture
    since = await clean();
    pointerSteps(udid, [{ action: 'scrollTwo', ...screenPoint({ x: 700, y: 300 }), dy: 220 }]);
    const wheels = (await page.evaluate('pointer')).slice(since).filter((event) => event.type === 'wheel');
    const total = wheels.reduce((sum, event) => sum + event.dy, 0);
    assert(wheels.length > 0 && Math.abs(total) >= 100, `two fingers turn the desktop's wheel: ${wheels.length} wheel events, deltaY ${total}`);
    await step('03-scroll', `two-finger scroll → ${wheels.length} wheel events, deltaY ${total}`);

    // 4. typing on the phone reaches the desktop's own field, once per character
    const padSpot = { x: 150, y: 640 };
    tapDesktop(padSpot);
    await sleep(300);
    const padBefore = await page.evaluate('document.getElementById("pad").value');
    const mirrorBefore = await page.evaluate('document.getElementById("typed").textContent');
    since = await clean();
    mac(`axe type 'desklink' --udid ${udid}`);
    let typed = padBefore;
    for (let i = 0; i < 50 && typed === padBefore; i++) { await sleep(200); typed = await page.evaluate('document.getElementById("pad").value'); }
    assert(typed === 'desklink', `what the phone typed is in the desktop's field, once: ${JSON.stringify(typed)}`);
    // The page's own key log is the truth about delivery: one keydown per
    // character, and the page's mirror untouched because the field took them.
    const typedDowns = (await page.evaluate('keys')).slice(since).filter((key) => key.type === 'keydown');
    assert.deepEqual(typedDowns.map((key) => key.key), [...'desklink'],
        `the desktop received each character exactly once: ${JSON.stringify(typedDowns)}`);
    assert.equal(await page.evaluate('document.getElementById("typed").textContent'), mirrorBefore,
        'the notes line mirrors nothing: a focused field takes its own characters, so nothing is delivered twice');
    await step('04-typing', `typed "desklink" → desktop field reads ${JSON.stringify(typed)}, ${typedDowns.length} keydowns, no second copy`);

    // 5. sticky modifiers: latch, chord, release
    await clean();
    mac(`axe tap --id desklink-key-Control --udid ${udid}`);
    assert.equal((await waitForId(udid, 'desklink-key-Control', 'latched')).value, 'latched', 'one tap arms Ctrl');
    since = await page.evaluate('keys.length');
    mac(`axe key 4 --udid ${udid}`);
    let chorded = [];
    for (let i = 0; i < 50 && !chorded.some((key) => key.type === 'keyup' && key.key === 'a'); i++) {
        await sleep(100);
        chorded = (await page.evaluate('keys')).slice(since);
    }
    const chordDown = chorded.find((key) => key.type === 'keydown' && key.key === 'a');
    assert(chordDown?.ctrl, `Ctrl then A reaches the desktop as Control+A: ${JSON.stringify(chorded)}`);
    assert(chorded.some((key) => key.type === 'keyup' && key.key === 'a'), 'the chorded key is released, not left held');
    assert.equal(await page.evaluate('document.title'), 'Notes',
        'the desktop is still the page the phone was driving, chord and all');
    assert.equal((await waitForId(udid, 'desklink-key-Control', 'off')).value, 'off', 'the latch clears after the one key it was armed for');
    mac(`axe tap --id desklink-key-Control --udid ${udid}; axe tap --id desklink-key-Control --udid ${udid}`);
    assert.equal((await waitForId(udid, 'desklink-key-Control', 'locked')).value, 'locked', 'a second tap locks Ctrl');
    await step('05-sticky-modifier', 'Ctrl latched → next key sent as Control+A → latch cleared; two taps lock it');
    mac(`axe tap --id desklink-key-Control --udid ${udid}`);
    await waitForId(udid, 'desklink-key-Control', 'off');

    // 6. the desktop's clipboard comes over to the phone
    // The page may have moved under an earlier scroll, so aim at where the
    // button is now rather than where it was authored.
    const buttonSpot = await page.evaluate('(() => { const box = document.getElementById("copy-out").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()');
    since = await clean();
    tapDesktop(buttonSpot);
    let clickedOnButton = [];
    for (let i = 0; i < 30 && clickedOnButton.length < 2; i++) { await sleep(100); clickedOnButton = (await page.evaluate('clicks')).slice(since); }
    assert.equal(await page.evaluate('window.copied'), 'select this line',
        `the page put its selection on the desktop clipboard: ${await page.evaluate('window.copyAttempts ?? 0')} clicks on the button, ${JSON.stringify(clickedOnButton)} at the tap`);
    mac(`axe tap --id desklink-copy --udid ${udid}`);
    // The phone confirms the transfer with a pill on its own screen; the
    // simulator shares the Mac's pasteboard, so that pill is the phone's proof.
    let pill = '';
    for (let i = 0; i < 30 && !pill.includes('select this line'); i++) {
        await sleep(120);
        pill = visibleText(udid).find((text) => text.startsWith('Copied to phone')) ?? '';
    }
    assert(pill.includes('select this line'), `the phone's own screen confirms the desktop's clipboard and its text: ${JSON.stringify(pill)}; on screen now: ${JSON.stringify(visibleText(udid))}`);
    await step('06-clipboard-out', `desktop → phone, confirmed on screen: ${pill}`);

    // 7. and the phone's clipboard goes the other way, pasted into the focused field
    // The phone's clipboard holds what step 06 brought over, so this needs no
    // host pasteboard write and no operating system's paste consent prompt.
    since = await clean();
    tapDesktop(padSpot);
    await sleep(300);
    mac(`axe tap --id desklink-paste --udid ${udid}`);
    // The confirmation pill lives about a second and a half, so poll for it and
    // for the system's own paste consent in the same breath: the grant is to
    // the app under test, on this task's simulator, and to nothing else.
    let sent = '';
    let allowed = false;
    for (let i = 0; i < 30 && !sent.includes('select this line'); i++) {
        await sleep(120);
        const texts = visibleText(udid);
        sent = texts.find((text) => text.startsWith('Sent to desktop')) ?? '';
        if (sent === '' && !allowed && texts.includes('Allow Paste')) {
            mac(`axe tap --label "Allow Paste" --udid ${udid}`);
            allowed = true;
            log('allowed the app under test its own paste prompt on this simulator');
        }
    }
    assert(sent.includes('select this line'), `the phone's own screen confirms what it sent: ${JSON.stringify(sent)}; on screen now: ${JSON.stringify(visibleText(udid))}`);
    mac(`axe key-combo --modifiers 224 --key 25 --udid ${udid}`);
    let pastes = [];
    for (let i = 0; i < 40 && pastes.length === 0; i++) { await sleep(250); pastes = await page.evaluate('window.pastes'); }
    assert.equal(pastes.at(-1)?.text, 'select this line', `the desktop pasted the phone's clipboard: ${JSON.stringify(pastes)}`);
    const filled = await page.evaluate('document.getElementById("pad").value');
    assert(filled.endsWith('select this line'), `the desktop's field holds the phone's text: ${JSON.stringify(filled)}`);
    await step('07-clipboard-in', `phone → desktop: pasted ${JSON.stringify(filled)}`);

    // 8. the pointer mark: a real arrow, its tip where the desktop's pointer is
    // A one-finger drag on the whole desktop carries the pointer with no button,
    // so the mark can be read over bare paper, away from any click dot.
    since = await clean();
    // A finger travelling over bare paper, so the mark is read over clean
    // background: the press paints its dot 200 desktop pixels away.
    pointerSteps(udid, [{ action: 'dragTouch', ...screenPoint({ x: 700, y: 460 }), toX: screenPoint({ x: 900, y: 300 }).x, toY: screenPoint({ x: 900, y: 300 }).y }]);
    await sleep(600);
    const travelled = (await page.evaluate('pointer')).slice(since).filter((event) => event.x !== undefined);
    assert(travelled.length > 0, `a finger travelling over the picture carries the desktop's pointer: ${JSON.stringify(travelled)}`);
    const landed = travelled.at(-1);
    assert(within(landed, { x: 900, y: 300 }), `the pointer ends where the finger did: ${JSON.stringify(landed)}`);
    const tip = screenPoint({ x: landed.x, y: landed.y });
    const frame = capture(join(out, 'step-08-pointer-frame.png'));
    const density = frame.width / screenWidth;
    const half = Math.round(24 * density);
    const crop = new PNG({ width: half * 8, height: half * 8 });
    for (let cy = 0; cy < crop.height; cy++) {
        for (let cx = 0; cx < crop.width; cx++) {
            const sx = Math.round(tip.x * density) - half + Math.floor(cx / 4);
            const sy = Math.round(tip.y * density) - half + Math.floor(cy / 4);
            if (sx < 0 || sy < 0 || sx >= frame.width || sy >= frame.height) continue;
            const source = (sy * frame.width + sx) * 4;
            frame.data.copy(crop.data, (cy * crop.width + cx) * 4, source, source + 4);
        }
    }
    writeFileSync(join(out, 'step-08-pointer-arrow-4x.png'), PNG.sync.write(crop));
    // The page under the mark is warm paper; the arrow's ink is dark and its core white.
    const rows = [];
    for (let y = 0; y < crop.height; y++) {
        let first = -1; let last = -1;
        for (let x = 0; x < crop.width; x++) {
            const i = (y * crop.width + x) * 4;
            if (Math.abs(crop.data[i] - 251) + Math.abs(crop.data[i + 1] - 250) + Math.abs(crop.data[i + 2] - 247) > 90) {
                if (first < 0) first = x;
                last = x;
            }
        }
        if (first >= 0) rows.push([first, last, y]);
    }
    assert(rows.length >= 8, `the phone draws a pointer mark over the picture: ${rows.length} inked rows of 4x`);
    // The crop is 4x the device's own pixels, and the device is `density` points.
    const perPoint = 4 * density;
    const widthsPt = rows.map(([first, last]) => (last - first) / perPoint);
    const widest = Math.max(...widthsPt);
    const edge = (pick) => (Math.max(...rows.map(pick)) - Math.min(...rows.map(pick))) / perPoint;
    // A rectangle keeps one width and one straight edge from row to row; an
    // arrow starts at its tip and opens out to its widest row.
    assert(widest >= 3 * widthsPt[0] + 3, `the mark opens out from its tip: ${widthsPt[0].toFixed(1)} pt at the tip, ${widest.toFixed(1)} pt at its widest`);
    assert(edge((row) => row[1]) >= 4, `the mark's trailing edge runs diagonally, as an arrow's does: ${edge((row) => row[1]).toFixed(1)} pt, a rectangle's runs straight`);
    // The arrow's hotspot is 3 pt in from its own top-left corner.
    const tipPt = { x: tip.x - 24 + rows[0][0] / 4 / density, y: tip.y - 24 + rows[0][2] / 4 / density };
    assert(Math.abs(tipPt.x - tip.x) <= 2 && Math.abs(tipPt.y - tip.y) <= 2,
        `the arrow's tip is where the desktop's pointer is: ${(tipPt.x - tip.x).toFixed(1)} pt across, ${(tipPt.y - tip.y).toFixed(1)} pt down`);
    writeFileSync(join(out, 'step-08-pointer.json'), JSON.stringify({
        density, tip, markOrigin: tipPt, inkRows: rows.length, tipErrorPt: [tipPt.x - tip.x, tipPt.y - tip.y],
        widestPt: widest, trailingEdgeSpreadPt: edge((row) => row[1]), pointer: landed,
    }, null, 1));
    await step('08-pointer-arrow', `arrow over bare paper: ${widthsPt[0].toFixed(1)} pt at the tip, ${widest.toFixed(1)} pt at its widest, tip ${(tipPt.x - tip.x).toFixed(1)}/${(tipPt.y - tip.y).toFixed(1)} pt from the desktop pointer`);

    mac(`kill -INT "$(cat "$D/tmp/record.pid")" 2>/dev/null || true; sleep 2`);
    assert.equal(spawnSync('scp', ['-q', '-o', 'BatchMode=yes', `${MAC}:${DIR}/tmp/phone-control.mp4`, join(out, 'phone-control.mp4')]).status, 0,
        'copy the screen recording back');
    writeFileSync(join(out, 'phone-control.json'), JSON.stringify({ device: seen.frame, udid, steps, recording: 'phone-control.mp4' }, null, 1));
    log(`phone-only control proven over ${steps.length} steps, recorded as phone-control.mp4`);

    // ---- pan and rotation ----------------------------------------------------------------------
    pointerSteps(udid, [{ action: 'landscape', x: 0, y: 0 }]);
    await sleep(1500);
    // simctl saves the display's native portrait pixels; turned to landscapeLeft, the
    // picture's top-left lands at the screenshot's top-right. Turn it upright.
    const landscapeCapture = (name) => {
        const sideways = capture(join(out, 'simulator-landscape-native.png'));
        const landscape = new PNG({ width: sideways.height, height: sideways.width });
        for (let y = 0; y < sideways.height; y++) {
            for (let x = 0; x < sideways.width; x++) sideways.data.copy(landscape.data, ((sideways.width - 1 - x) * landscape.width + y) * 4, (y * sideways.width + x) * 4, (y * sideways.width + x) * 4 + 4);
        }
        writeFileSync(join(out, name), PNG.sync.write(landscape));
        const bars = barShare(landscape);
        assert(bars < 0.15, `black bars take under 15% of the landscape screen (${name}): ${(100 * bars).toFixed(1)}%`);
        return landscape;
    };
    const landscape = landscapeCapture('desklink-receiver-fill-landscape.png');
    const across = pictureBox(landscape, screenHeight);
    log(`landscape: ${(100 * barShare(landscape)).toFixed(1)}% black bars, picture from (${across.left.toFixed(1)}, ${across.top.toFixed(1)}) pt`);
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
        mac(`axe swipe --start-x ${(screenHeight * (dx < 0 ? 0.85 : 0.15)).toFixed(0)} --start-y ${(screenWidth * (dy < 0 ? 0.85 : 0.15)).toFixed(0)} --end-x ${(screenHeight * (dx < 0 ? 0.15 : 0.85)).toFixed(0)} --end-y ${(screenWidth * (dy < 0 ? 0.15 : 0.85)).toFixed(0)} --duration 0.6 --udid ${udid}`);
        await sleep(1000);
        landscapeCapture(`desklink-receiver-fill-landscape-panned-${dx}-${dy}.png`);
    }
    pointerSteps(udid, [{ action: 'portrait', x: 0, y: 0 }]);
    await sleep(1500);
    const back = pictureBox(capture(join(out, 'desklink-receiver-fill-portrait-rotated-back.png')), screenWidth);
    assert(Math.abs(back.top - box.top) <= 1 && back.left <= 1, `turned back, the picture starts at the top-left again: (${back.left.toFixed(1)}, ${back.top.toFixed(1)}) pt, first (${box.left.toFixed(1)}, ${box.top.toFixed(1)})`);
    log('rotated back: the picture starts at the top-left again');
    const clicksBefore = await page.evaluate('clicks.length');
    pointerSteps(udid, [{
        action: 'pinch', x: screenWidth * 0.25, y: back.top + (back.bottom - back.top) * 0.5,
        span: screenWidth * 0.24, scale: 2,
    }]);
    await sleep(1000);
    const zoomedShot = capture(join(out, 'simulator-zoomed.png'));
    const zoomedBox = pictureBox(zoomedShot, screenWidth);
    const zoomedScale = (zoomedBox.bottom - zoomedBox.top) / geometry.height;
    assert(zoomedScale > scale * 1.5, `the pinch visibly zooms to cropped content: ${zoomedScale / scale}x`);
    assert(zoomedScale * geometry.width > screenWidth, 'the zoomed desktop has horizontal content to pan');
    const dotAt = (shot) => {
        // Just above the click: the pointer arrow's outline, hanging from its
        // tip at the click, would split the dot's dark run there.
        const y = zoomedBox.top + targets[1].y * zoomedScale - 4;
        let best = { length: 0, x: null }; let start = null;
        for (let x = 0; x <= screenWidth; x += 0.5) {
            const dark = x < screenWidth && pixel(shot, { x, y }) < 200;
            if (dark && start === null) start = x;
            if (!dark && start !== null) { if (x - start > best.length) best = { length: x - start, x: (start + x) / 2 }; start = null; }
        }
        return best.length >= 10 ? best.x : null;
    };
    const dotFirst = dotAt(zoomedShot);
    assert(dotFirst !== null, 'the marker is visible on the zoomed desktop before panning');
    const panY = zoomedBox.top + (zoomedBox.bottom - zoomedBox.top) * 0.5;
    mac(`axe swipe --start-x ${(screenWidth * 0.4).toFixed(1)} --start-y ${panY.toFixed(1)} --end-x ${(screenWidth * 0.55).toFixed(1)} --end-y ${panY.toFixed(1)} --duration 0.6 --udid ${udid}`);
    await sleep(1000);
    const pannedShot = capture(join(out, 'simulator-pan-candidate.png'));
    const dotPanned = dotAt(pannedShot);
    assert(dotPanned !== null && dotPanned - dotFirst > 40, `the pan visibly moves the marker right: ${dotFirst} → ${dotPanned} pt`);
    assert.equal(await page.evaluate('clicks.length'), clicksBefore, 'zooming and one-finger panning click nothing');
    writeFileSync(join(out, 'desklink-receiver-fill-portrait-panned.png'), PNG.sync.write(pannedShot));
    log(`panned: the marker moved right from x ${dotFirst.toFixed(1)} to ${dotPanned.toFixed(1)} pt without a click`);
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
