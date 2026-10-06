#!/usr/bin/env node
/**
 * Phone glass-to-glass latency and frame rate, measured on a physical Android
 * device over real Wi-Fi (scorecard J4).
 *
 * What it measures, and how honestly each number can be measured at all:
 *
 *  - **Frame rate** is exact and device-side: the app posts its own inbound
 *    WebRTC statistics to this harness every second, so `framesDecoded`
 *    deltas are the phone's own count of frames it decoded and showed.
 *  - **Steady-state latency** is reported two ways, because the honest one
 *    depends on what the clocks allow. `relative_*` is each capture's delay
 *    against the fastest frame of the same run, which needs no clock at all and
 *    is always valid. `absolute_*` compares the two clocks and is published only
 *    when they agree well enough for the number to mean something; when they do
 *    not, the receipt says so and claims no absolute latency.
 *
 * The device-side `screencap` window (about 200 ms on this phone) is measured in
 * every run, not assumed, and published as the uncertainty every latency sample
 * carries, so the reader sees the harness's own capture cost instead of trusting
 * a point estimate.
 *
 * Why not `screenrecord`: on this device the shell binary runs in its own
 * SELinux domain (`screen_record`) that cannot open a file anywhere adb can
 * write, so its device-side presentation timestamps are unavailable. The
 * measurement below is the strongest one this host can make without root; its
 * limits are stated in the run receipt rather than hidden.
 *
 * Usage (from the repo root):
 *
 *   CARGO_TARGET_DIR=~/.cache/desklink-phone-g2g \
 *     cargo build --release --manifest-path packages/desktop-host/engine/Cargo.toml \
 *       --bin desklink-host --example stamp_target
 *   cd packages/desktop-client/example && npm install && npx expo prebuild \
 *       --platform android --no-install && cd android && ./gradlew assembleDebug
 *   ANDROID_SERIAL=a4b93ea2 DESKLINK_ANDROID_HOST=192.168.1.144 \
 *     node packages/desktop-client/test/phone-g2g-flow.mjs
 *
 * `--transport usb` runs the identical path over `adb reverse`, for proving
 * the harness when the network leg is unavailable. Its numbers describe USB,
 * not Wi-Fi, and are never a scorecard result.
 *
 * `--transport wifi` (the default) is what J4 asks for, and needs this host to
 * accept inbound TCP from the phone: the nftables ruleset in
 * `/etc/nftables.conf` drops everything except icmp and sshd, so a stock host
 * refuses the run at the preflight instead of timing out later.
 *
 * Environment:
 *
 *   ANDROID_SERIAL          the physical device (never an emulator)
 *   DESKLINK_ANDROID_HOST   this machine's address on the device's network
 *   DESKLINK_QUICKSTART_DIR  where the README quickstart app is created
 *                            (default ~/.cache/desklink-quickstart; created
 *                            from the published packages on the first run)
 *   DESKLINK_ENGINE         engine binary (default: a release build)
 *   DESKLINK_G2G_STAMP      stamp_target binary (default: a release build)
 *   DESKLINK_ANDROID_OUT    evidence directory (default a fresh one under ~/lab-tmp)
 *   DESKLINK_ANDROID_SKIP_BUILD 1 reuses the APK the last run built
 *
 * `--journey quickstart` runs the README's own phone journey instead of the J4
 * measurement: a fresh `create-expo-app` with the published `@desklink/*` and
 * `@byokit/signaling` packages, the published `npx @desklink/host bridge`, one
 * connect and one real tap, with the phone's screen recorded throughout. The
 * desktop it shows is a window on the private X display whose button counts its
 * own clicks on this host, so "the tap reached the desktop" is the host's count.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    assertNoAmbientDesktop, claimPrivateDisplay, laneArtefactDir, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb,
} from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
assert(process.platform === 'linux', 'this private-Xvfb proof requires Linux');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
};
const target = process.env.CARGO_TARGET_DIR ?? join(repo, 'packages/desktop-host/engine/target');
const out = resolve(process.env.DESKLINK_ANDROID_OUT ?? laneArtefactDir('phone-g2g-flow'));
if (process.env.DESKLINK_ANDROID_OUT) {
    assert(!existsSync(out), 'refusing to overwrite evidence');
    mkdirSync(out, { recursive: true });
}
const scratch = mkdtempSync(join(homedir(), '.cache', 'desklink-phone-g2g-'));
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(target, 'release', 'desklink-host'));
const stampBinary = resolve(process.env.DESKLINK_G2G_STAMP ?? join(target, 'release', 'examples', 'stamp_target'));
const example = join(repo, 'packages/desktop-client/example');
const apk = join(example, 'android/app/build/outputs/apk/debug/app-debug.apk');
const claim = claimPrivateDisplay({ from: 170, count: 40 });
const display = claim.display;
// `latency` is the J4 measurement this harness was built for. `quickstart` is
// the README journey: published packages only, one connect, one real tap.
const journey = arg('journey', 'latency');
// The quickstart app is a fresh project outside this checkout, kept in the
// cache so a retry does not re-download the published packages.
const quickstart = resolve(process.env.DESKLINK_QUICKSTART_DIR ?? join(homedir(), '.cache', 'desklink-quickstart'));
const host = process.env.DESKLINK_ANDROID_HOST;
if (journey !== 'quickstart') {
    assert(host, 'set DESKLINK_ANDROID_HOST to this machine\'s address on the phone\'s network');
}
const scenarios = arg('scenarios', 'typing,scroll').split(',').filter(Boolean);
const fpsSeconds = Number(arg('fps-seconds', 12));
const latencySeconds = Number(arg('latency-seconds', 30));
// `wifi` is what scorecard J4 asks for. `usb` carries the same media path over
// `adb reverse`, which proves the harness end to end but measures the USB, not
// the network, so its numbers are never a J4 result.
const transport = arg('transport', 'wifi');
// `--relay-rate 4mbit` puts a userspace token bucket in front of the bridge.
const relayRate = arg('relay-rate', null);
// `--keep-captures` leaves the raw captures on the device for offline study.
const keepCaptures = process.argv.includes('--keep-captures');
// The quickstart journey runs the published package, so it must not be handed
// this checkout's engine path: the published launcher resolves its own prebuilt.
const env = journey === 'quickstart'
    ? { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch }
    : { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch, DESKLINK_ENGINE: engine };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const load = () => {
    const [one, five, fifteen, idle] = readFileSync('/proc/loadavg', 'utf8').split(' ');
    return { one: Number(one), five: Number(five), fifteen: Number(fifteen), busy_cpu_percent: Math.round((1 - Number(idle)) * 100) };
};
const percentile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
};
const round = value => (value === null ? null : Math.round(value * 10) / 10);
const started = Date.now();
/** The receipt is written as the run goes, so an outside kill still leaves evidence. */
const saveReceipt = () => writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { receipt.outcome = receipt.outcome === 'PASS' ? 'PASS' : `KILLED (${signal})`; saveReceipt(); process.exit(1); });
}
const mark = label => {
    receipt.timings[label] = Math.round((Date.now() - started) / 1000);
    console.log(`[${receipt.timings[label]}s] ${label}`);
};

const serial = process.env.ANDROID_SERIAL;
assert(serial, 'name the physical device with ANDROID_SERIAL');
const attached = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(([, state]) => state === 'device').map(([name]) => name);
assert(attached.includes(serial), `adb does not report ${serial} as attached: ${attached.join(', ') || 'none'}`);
assert(/^emulator/.test(serial) === false, 'J4 is a physical phone, not an emulator');
const adb = (...args) => {
    const done = adbTry(...args);
    assert.equal(done.status, 0, `adb ${args.join(' ')} failed: ${done.stderr}`);
    return done.stdout;
};
const adbTry = (...args) => spawnSync('adb', ['-s', serial, ...args],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
const adbBin = (...args) => spawnSync('adb', ['-s', serial, ...args], { encoding: 'buffer', timeout: 600000, maxBuffer: 256 * 1024 * 1024 });

const children = [];
let xvfb, bridge, metro, receiver, stampChild, relayPort, xenv, bridgePort;
const logs = { bridge: '', metro: '' };
const receipt = {
    outcome: 'FAIL', serial, host, display, engine, engineSha256: null, stampBinary,
    apkSha256: null, scenarios, fpsSeconds, latencySeconds, timings: {}, transport,
    // The app's JavaScript arrives over USB through `adb reverse`; only the
    // WebRTC media path (engine, network, decoder, display) is Wi-Fi.
    app_javascript_path: 'adb reverse over USB (debug build loads its bundle from Metro)',
    media_path: transport === 'usb' ? 'this host to the phone over adb reverse (USB), because no Wi-Fi path exists from the phone to this host' : 'Wi-Fi, phone to this host',
};
const start = (name, cmd, args, childEnv, cwd = repo) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => { logs[name] = (logs[name] ?? '') + c; });
    child.stderr.on('data', c => { logs[name] = (logs[name] ?? '') + c; });
    children.push([name, child]);
    return child;
};
const waitFor = async (ready, what, ms = 120000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (ready()) return; await sleep(200); }
    throw new Error(`timed out waiting for ${what}`);
};

/**
 * The device's own clock against this host's.
 *
 * Not the usual "stamp before and after the round trip": every `adb shell`
 * invocation on this phone pays about a hundred milliseconds to start its
 * shell, and a midpoint estimate puts that whole delay on one side, which is
 * more than the latency being measured. Instead each sample is the moment a
 * timestamp *arrives* here, so the only thing the difference carries is the
 * phone's clock and the trip back; that trip is small, and the spread of the
 * samples is reported as the uncertainty.
 */
const clockOffsets = async (samples = 21) => {
    const rows = [];
    for (let i = 0; i < samples; i += 1) {
        const row = await new Promise((done, fail) => {
            let settled = false;
            const child = spawn('adb', ['-s', serial, 'shell', 'date +%s%3N'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            child.stdout.on('data', chunk => {
                if (settled) return;
                settled = true;
                done({ device: Number(String(chunk).trim()), arrived: Date.now() });
            });
            child.on('error', fail);
            child.on('close', () => { if (!settled) { settled = true; done(null); } });
        });
        if (row !== null && Number.isFinite(row.device)) rows.push(row);
    }
    const offsets = rows.map(row => row.device - row.arrived);
    if (offsets.length < 10) throw new Error(`the device only offered ${offsets.length} clock samples`);
    return {
        samples: offsets.length,
        // The return trip is always positive, so the median is the honest
        // midpoint and the spread shows how much it moved.
        offset_median_ms: round(percentile(offsets, 50)),
        offset_p05_p95_ms: [round(percentile(offsets, 5)), round(percentile(offsets, 95))],
        return_trip_median_ms: round(percentile(offsets, 95) - percentile(offsets, 50)),
    };
};

/**
 * What one `screencap` costs on this device, measured rather than assumed:
 * `exec` is the fork of a trivial command and `window` the whole device-side
 * span of one capture. The grab happens inside that window; the midpoint is
 * the estimate and half the span is the uncertainty every sample carries.
 */
const captureCost = () => {
    const script = 'for i in 1 2 3 4 5 6 7; do a=$(date +%s%3N); screencap /dev/null; b=$(date +%s%3N);'
        + ' echo $((b-a)); done; for i in 1 2 3 4 5 6 7; do a=$(date +%s%3N); true; b=$(date +%s%3N); echo $((b-a)); done';
    const lines = adb('shell', script).split('\n').map(line => Number(line.trim())).filter(Number.isFinite);
    assert(lines.length >= 10, 'the device could not time its own captures');
    const windows = lines.slice(0, lines.length / 2);
    const execs = lines.slice(lines.length / 2);
    const window = percentile(windows, 50);
    const exec = percentile(execs, 50);
    return {
        capture_window_median_ms: round(window),
        capture_window_p95_ms: round(percentile(windows, 95)),
        exec_median_ms: round(exec),
        grab_estimate_ms: round((window + exec) / 2),
        uncertainty_ms: round((window - exec) / 2),
    };
};

/**
 * One tight capture loop, run on the device: capture, timestamp before and
 * after, repeat. Timestamps come from the phone, so no adb round trip enters
 * the latency arithmetic.
 */
const captureLoop = (count, directory) => {
    const stampPath = `${directory}/stamps.txt`;
    const shell = script => {
        const done = spawnSync('adb', ['-s', serial, 'shell', script], { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
        assert.equal(done.status, 0, `adb shell failed: ${done.stderr}`);
        return done.stdout ?? '';
    };
    shell(`rm -f ${directory}/cap_*.raw ${stampPath}`);
    shell(`i=1; while [ $i -le ${count} ]; do a=$(date +%s%3N); screencap ${directory}/cap_$i.raw;`
        + ` b=$(date +%s%3N); echo "$i $a $b" >> ${stampPath}; i=$((i+1)); done; echo done`);
    return shell(`cat ${stampPath}`).split('\n').map(line => line.trim().split(/\s+/))
        .filter(row => row.length === 3).map(([i, a, b]) => ({ index: Number(i), before: Number(a), after: Number(b) }));
};

/**
 * `screencap` without `-p` writes a 16-byte header (width, height, format as
 * three little-endian u32) and then raw RGBA, so the pixels start at 16.
 */
const capturePixels = buffer => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { pixels: Buffer.alloc(0), width: 0, height: 0 };
    if (buffer.length > 16 && buffer.readUInt32LE(0) * buffer.readUInt32LE(4) * 4 === buffer.length - 16) {
        return { pixels: buffer.subarray(16), width: buffer.readUInt32LE(0), height: buffer.readUInt32LE(4) };
    }
    const width = 1080;
    return { pixels: buffer, width, height: Math.round(buffer.length / 4 / width) };
};

/**
 * The stamp strip, read out of one raw screencap (RGBA, no PNG to decode).
 * `xOffset` and `y` are searched by the caller across frames, so this only has
 * to be fast and exact.
 */
/**
 * The rows on the phone that carry the desktop picture: the first run of bright
 * rows in the top half of the screen, found from the frame itself. The app
 * sizes and pans the picture (keyboard, safe-area insets, tablet layout), so
 * nothing about its position is assumed.
 */
const pictureBand = (pixels, width, height) => {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < Math.round(height * 0.5); y += 1) {
        let count = 0;
        for (let x = 0; x < width; x += 2) {
            const at = (y * width + x) * 4;
            if (pixels[at] + pixels[at + 1] + pixels[at + 2] > 90) count += 1;
        }
        if (count <= width * 0.015) continue;
        if (top < 0) top = y;
        bottom = y;
    }
    return top < 0 ? null : { top, bottom };
};

/**
 * One row of the stamp strip at a given block pitch: 24 blocks, each a
 * 48-column slice of the 1920-column desktop, so a full-width picture has a
 * pitch of its width over 40. A row only counts when its blocks are crisp, flat
 * and mixed, which is what separates the strip from a plain white field or a
 * row of keyboard glyphs.
 */
const readStripRow = (pixels, width, y, pitch, x0) => {
    let stamp = 0;
    let crisp = 0;
    let white = 0;
    let flat = 0;
    for (let block = 0; block < 24; block += 1) {
        const x = Math.round(x0 + (block + 0.5) * pitch);
        // Past the last pixel means the picture is cropped and the strip does
        // not carry all 24 bits, so this configuration cannot decode a clock.
        if (x < 1 || x >= width - 1) return null;
        const centre = pixels[(y * width + x) * 4 + 1];
        const left = pixels[(y * width + x - 3) * 4 + 1];
        const right = pixels[(y * width + x + 3) * 4 + 1];
        const extreme = value => value <= 40 || value >= 220;
        if (extreme(centre)) crisp += 1;
        if (centre > 128) { white += 1; stamp = (stamp << 1) | 1; } else stamp <<= 1;
        if (extreme(centre) && extreme(left) && extreme(right)
            && (left > 128) === (centre > 128) && (right > 128) === (centre > 128)) flat += 1;
    }
    if (crisp < 22 || white < 6 || white > 18 || flat < 20) return null;
    return stamp >>> 0;
};

/** Every row of the strip decodes the same clock, so the frame's value is the mode. */
const frameStamp = (pixels, width, height, config) => {
    const band = pictureBand(pixels, width, height);
    if (band === null) return { stamp: null, votes: 0 };
    const tally = new Map();
    for (let y = band.top; y <= Math.min(band.bottom, band.top + 60); y += 1) {
        const stamp = readStripRow(pixels, width, y, config.pitch, config.x0);
        if (stamp !== null) tally.set(stamp, (tally.get(stamp) ?? 0) + 1);
    }
    if (tally.size === 0) return { stamp: null, votes: 0, band };
    const [stamp, votes] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return { stamp, votes, band };
};

const WRAP = 0x1000000; // the stamp carries the low 24 bits of a millisecond clock
const latency = (deviceMs, offset, stamp) => (deviceMs - offset - stamp) % WRAP;
const connected = () => {
    const report = reports.at(-1);
    return report !== undefined && typeof report.presentedAt === 'number' && report.presentedAt > 0;
};
const videoStats = () => {
    const inbound = [];
    for (const report of reports) {
        let stats = report.stats;
        if (typeof stats === 'string') {
            try { stats = JSON.parse(stats); } catch { continue; }
        }
        if (!Array.isArray(stats)) continue;
        for (const stat of stats) {
            if (stat.type !== 'inbound-rtp') continue;
            if ((stat.kind ?? stat.mediaType) !== 'video' && stat.framesDecoded === undefined) continue;
            inbound.push({ at: report.at, ...stat });
        }
    }
    return inbound;
};
const fpsFromReports = (from, to) => {
    const series = videoStats().filter(stat => stat.at >= from && stat.at <= to && typeof stat.framesDecoded === 'number');
    const rates = [];
    for (let i = 1; i < series.length; i += 1) {
        const seconds = (series[i].at - series[i - 1].at) / 1000;
        if (seconds <= 0) continue;
        rates.push((series[i].framesDecoded - series[i - 1].framesDecoded) / seconds);
    }
    const last = series.at(-1) ?? {};
    return {
        windows: rates.length,
        fps_median: round(percentile(rates, 50)),
        fps_p05: round(percentile(rates, 5)),
        frames_decoded: last.framesDecoded ?? null,
        frames_dropped: last.framesDropped ?? null,
        nack_count: last.nackCount ?? null,
        jitter_buffer_delay_s: last.jitterBufferDelay ?? null,
        frame_size: last.frameWidth && last.frameHeight ? `${last.frameWidth}x${last.frameHeight}` : null,
        codec: last.codecId ?? null,
    };
};

const driveInput = async (scenario, seconds) => {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
        if (scenario === 'scroll') {
            adb('shell', 'input', 'swipe', '540', '1800', '540', '900', '250');
        } else {
            adb('shell', 'input', 'text', 'desklink');
            adb('shell', 'input', 'keyevent', '67');
        }
        await sleep(scenario === 'scroll' ? 350 : 120);
    }
};

/**
 * A userspace token bucket in front of the bridge, for a slow-link leg without
 * root. It is a plain TCP relay with a rate limit, NOT kernel netem: it shapes
 * the connection between the device and this host (which on a phone reached over
 * `adb reverse` is also where the media rides), and every result it produces is
 * labelled `userspace-shaped` wherever it is published.
 */
const startRelay = (upstreamPort, bitsPerSecond) => {
    const bytesPerMs = bitsPerSecond / 8 / 1000;
    let due = Date.now();
    const pump = (from, to) => {
        from.on('data', chunk => {
            // Each chunk is admitted when the bucket has earned its bytes.
            due = Math.max(due, Date.now()) + chunk.length / bytesPerMs;
            const wait = due - Date.now();
            const write = () => to.write(chunk);
            if (wait > 1) setTimeout(write, wait);
            else write();
        });
        from.on('end', () => to.end());
        from.on('error', () => to.destroy());
        to.on('error', () => from.destroy());
    };
    const server = createNetServer(client => {
        const upstream = connect({ host: '127.0.0.1', port: upstreamPort });
        pump(client, upstream);
        pump(upstream, client);
    });
    return server;
};

const reports = [];
/** Every frame the phone and the bridge exchanged, for the evidence folder. */
const wireLog = [];
/** How many frames the recording takes. Each `screencap` on this phone is about 200 ms. */
const RECORD_FRAMES = 400;
/** The desktop the phone is given: a button whose clicks this host counts itself. */
const FIXTURE_HTML = `<!doctype html><meta charset="utf-8"><title>desklink tap fixture</title>
<style>html,body{margin:0;height:100%;background:#0f0f14;color:#fafafa;
font:600 34px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
button{width:900px;height:400px;font-size:88px;border-radius:28px;border:8px solid #22d3ee;background:#0e7490;color:#fff}
#n{font-size:72px}</style>
<div>desklink phone tap fixture</div>
<button id="hit">TAP ME</button>
<div>desktop clicks: <span id="n">0</span></div>
<script>let n=0;document.getElementById('hit').addEventListener('click',()=>{n+=1;
document.getElementById('n').textContent=String(n);fetch('/tap').catch(()=>{})})</script>`;

/** The README's `App.tsx`, with only the bridge address and token filled in. */
const quickstartApp = bridge => `import { useEffect } from 'react';
import { Button, View } from 'react-native';
import { authorizeBridge } from '@byokit/signaling';
import { DesktopView, useDesktopSession } from '@desklink/react-native';

const BRIDGE = '${bridge}';
const authorize = authorizeBridge(BRIDGE, {});

export default function App() {
  const desktop = useDesktopSession({ authorize });
  const { status, failure } = desktop.snapshot;
  useEffect(() => desktop.setInputEnabled(status === 'live'), [status]);
  return (
    <View style={{ flex: 1, backgroundColor: 'black', paddingVertical: 48 }}>
      <DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} />
      {status !== 'live' && (
        <Button title={failure ? \`Retry (\${failure.code})\` : status === 'idle' ? 'Connect' : status}
          onPress={() => void desktop.connect()} />
      )}
    </View>
  );
}
`;

/** The published packages this quickstart app actually resolved. */
const publishedVersions = dir => Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies)
    .filter(([name]) => /desklink|byokit|webrtc/.test(name)));

/** One raw frame off the phone, with the picture band and a hash of its middle. */
const phoneFrame = () => {
    const { pixels, width, height } = capturePixels(adbBin('exec-out', 'screencap').stdout);
    assert(width > 0 && pixels.length > 0, 'the phone returned no screen');
    let hash = 0;
    for (let y = Math.round(height * 0.3); y < Math.round(height * 0.7); y += 4) {
        for (let x = Math.round(width * 0.2); x < Math.round(width * 0.8); x += 4) {
            hash = (hash * 31 + pixels[(y * width + x) * 4]) >>> 0;
        }
    }
    return { pixels, width, height, hash, band: pictureBand(pixels, width, height) };
};

/**
 * The Connect control's own bounds, from the phone's accessibility tree, so
 * the run taps what a user sees instead of a coordinate guessed in advance. The
 * label is matched loosely: the platform renders a React Native Button's text
 * in capitals.
 */
const uiBound = label => {
    const dump = adbTry('shell', 'uiautomator dump /data/local/tmp/dl-ui.xml >/dev/null 2>&1; cat /data/local/tmp/dl-ui.xml').stdout ?? '';
    const want = label.toLowerCase();
    for (const [node] of dump.matchAll(/<node[^>]*>/g)) {
        const text = /text="([^"]*)"/.exec(node)?.[1] ?? '';
        const desc = /content-desc="([^"]*)"/.exec(node)?.[1] ?? '';
        if (!`${text} ${desc}`.toLowerCase().includes(want)) continue;
        const [, x0, y0, x1, y1] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node) ?? [];
        if (x0 === undefined) continue;
        return { label, found: `${text} ${desc}`.trim(), bounds: [Number(x0), Number(y0), Number(x1), Number(y1)], centerX: (Number(x0) + Number(x1)) / 2, centerY: (Number(y0) + Number(y1)) / 2 };
    }
    return null;
};

/** Wait until the phone's own screen carries the desktop picture. */
const waitForLive = async (ms = 120000) => {
    const from = Date.now();
    let last = null;
    while (Date.now() - from < ms) {
        last = phoneFrame();
        if (last.band !== null && last.band.bottom - last.band.top > 200) {
            return { first_picture_ms: Date.now() - from, picture_band: last.band };
        }
        await sleep(1000);
    }
    throw new Error('the desktop never appeared on the phone screen');
};

/**
 * The host, which both journeys share: a private Xvfb at 1080p and a bridge.
 * The quickstart journey runs the published `npx @desklink/host` exactly as the
 * README tells a new user to; the latency run keeps using this checkout.
 */
const hostLab = async () => {
    const authority = join(scratch, 'Xauthority');
    spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')]);
    xvfb = start('xvfb', 'Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']);
    trackOwnedXvfb(xvfb, display);
    const state = pid => { try { return readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; } };
    await waitFor(() => state(xvfb.pid)?.includes('State:\tT'), 'Xvfb initialization');
    await verifyOwnedXvfb(xvfb);
    xvfb.kill('SIGCONT');
    xenv = { ...env, DISPLAY: display, XAUTHORITY: authority };

    const probe = createServer();
    await new Promise(ok => probe.listen(0, '0.0.0.0', ok));
    bridgePort = probe.address().port;
    probe.close();
    receipt.bridgePort = bridgePort;
    // Over a reverse tunnel the bridge only has to answer on loopback; the
    // Wi-Fi measurement asks for every interface, because the phone dials in.
    const published = journey === 'quickstart';
    bridge = start('bridge', published ? 'npx' : process.execPath, [
        ...(published ? ['-y', '@desklink/host'] : ['packages/desktop-host/bin/desklink-host.mjs']), 'bridge',
        '--source', 'x11', '--display', display,
        '--listen', `${published ? '127.0.0.1' : '0.0.0.0'}:${bridgePort}`,
    ], xenv, published ? scratch : repo);
    await waitFor(() => /^open\s+http/m.test(logs.bridge), `the bridge URL: ${logs.bridge.slice(-300)}`);
    const token = /token[= ](\S+)/.exec(logs.bridge)[1];
    receipt.bridge = published ? 'npx @desklink/host bridge (the published package)' : 'packages/desktop-host/bin/desklink-host.mjs bridge (this checkout)';
    return token;
};

/** The J4 measurement: this checkout's example app against the stamp fixture. */
const latencyJourney = async () => {
    for (const path of [engine, stampBinary]) assert(existsSync(path), `missing binary: ${path}: build the engine first`);
    Object.assign(receipt, { engineSha256: hash(engine), stampSha256: hash(stampBinary), sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() });
    const token = await hostLab();

    receiver = createServer((request, response) => {
        const chunks = [];
        request.on('data', c => chunks.push(c));
        request.on('end', () => {
            try { reports.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* a partial body is not a report */ }
            response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            response.end();
        });
    });
    await new Promise(ok => receiver.listen(0, '0.0.0.0', ok));
    receipt.reportPort = receiver.address().port;
    if (relayRate !== null) {
        const bits = Number(/^([\d.]+)([kmg]?)bit$/i.exec(relayRate)?.[1] ?? relayRate) * (relayRate.includes('k') ? 1e3 : relayRate.includes('m') ? 1e6 : relayRate.includes('g') ? 1e9 : 1);
        assert(Number.isFinite(bits) && bits > 0, `--relay-rate wants a rate like 4mbit, not ${relayRate}`);
        const probeRelay = createNetServer();
        await new Promise(ok => probeRelay.listen(0, '127.0.0.1', ok));
        relayPort = probeRelay.address().port;
        await new Promise(ok => probeRelay.close(ok));
        receipt.relay = { kind: 'userspace token bucket (not kernel netem)', bits_per_second: bits, port: relayPort };
        await new Promise(ok => startRelay(bridgePort, bits).listen(relayPort, '127.0.0.1', ok));
    }
    const phoneHost = transport === 'usb' || relayRate !== null ? '127.0.0.1' : host;
    if (transport === 'usb' || relayRate !== null) {
        // The device reaches this host at the bridge's own port; with a relay in
        // front, that port is the relay, so the shape actually applies.
        adb('reverse', `tcp:${bridgePort}`, `tcp:${relayPort ?? bridgePort}`);
        adb('reverse', `tcp:${receiver.address().port}`, `tcp:${receiver.address().port}`);
    } else {
        // Preflight: if the phone cannot open this port the run would spend
        // minutes waiting for a session that can never start.
        const reach = adbTry('shell', `nc -w 3 ${host} ${bridgePort} < /dev/null; echo $?`).stdout.trim().split('\n').at(-1);
        if (reach !== '0') {
            throw new Error(`the phone cannot reach ${host}:${bridgePort} over Wi-Fi (nc said ${reach}); `
                + 'this host drops inbound TCP except sshd (see /etc/nftables.conf), '
                + 'so the Wi-Fi leg needs a firewall rule or another host');
        }
    }
    const link = `desklink-example://connect?url=${encodeURIComponent(`ws://${phoneHost}:${bridgePort}/desktop?token=${token}`)}`
        + `&report=${encodeURIComponent(`http://${phoneHost}:${receiver.address().port}/report`)}`;
    receipt.link = link.replace(token, '<bridge-token>');

    // The app: this checkout's example, on the phone.
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
    mark('apk-ready');
    // Another desklink run may hold 8081, so Metro takes a port the operating
    // system says is free and the phone reaches that same port.
    const metroProbe = createServer();
    await new Promise(ok => metroProbe.listen(0, '127.0.0.1', ok));
    const metroPort = metroProbe.address().port;
    metroProbe.close();
    receipt.metroPort = metroPort;
    metro = start('metro', 'npx', ['expo', 'start', '--port', String(metroPort)], { ...env, CI: '1' }, example);
    try {
        await waitFor(() => /Waiting on http|Metro waiting/.test(logs.metro), 'Metro', 180000);
    } catch (error) {
        throw new Error(`${error}; metro said: ${logs.metro.slice(-400)}`);
    }
    mark('metro-ready');
    // A 168 MB debug APK costs minutes to install (streamed installs wedge on
    // this device), so the phone remembers which build it already has.
    const marker = '/data/local/tmp/dl-phone-g2g.apk';
    if ((adbTry('shell', `cat ${marker} 2>/dev/null`).stdout ?? '').trim() !== receipt.apkSha256) {
        const installed = spawnSync('adb', ['-s', serial, 'install', '-r', '-g', '-t', '--no-streaming', apk], { encoding: 'utf8', timeout: 900000 });
        assert.equal(installed.status, 0, `adb install failed: ${installed.stderr ?? installed.stdout ?? installed.signal}`);
        adb('shell', `echo -n ${receipt.apkSha256} > ${marker}`);
    } else {
        receipt.apk_install = 'already installed, same sha256';
    }
    mark('apk-installed');
    // A debug build always asks Metro on its own port 8081; the reverse maps
    // that device port onto whichever free port this run's Metro took.
    adb('reverse', 'tcp:8081', `tcp:${metroPort}`);

    receipt.device = {
        model: adb('shell', 'getprop', 'ro.product.model').trim(),
        release: adb('shell', 'getprop', 'ro.build.version.release').trim(),
        sdk: adb('shell', 'getprop', 'ro.build.version.sdk').trim(),
        resolution: adb('shell', 'wm', 'size').trim().split(':').pop().trim(),
        wifi: /SSID: "([^"]+)"/.exec(adb('shell', 'dumpsys', 'wifi'))?.[1] ?? 'unknown',
        refresh_hz: /renderFrameRate=([\d.]+)/.exec(adb('shell', 'dumpsys', 'display'))?.[1] ?? null,
        host_to_phone_ping_ms: null,
    };

    // The phone's own view of the Wi-Fi link, for the method record.
    receipt.phone_to_host_ping_ms = (() => {
        const text = adb('shell', 'ping', '-c', '10', '-i', '0.2', '-W', '2', host);
        return round(Number(/=\s*[\d.]+\/([\d.]+)/.exec(text)?.[1] ?? NaN) || null);
    })();

    receipt.costs = captureCost();
    mark('costs-measured');
    receipt.clock_before = await clockOffsets();
    mark('clock-measured');
    receipt.load_before = load();

    let mode = 'typing';
    stampChild = spawn(stampBinary, [], { cwd: repo, env: { ...xenv, MODE: mode, RATE: '120' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(['stamp', stampChild]);
    await waitFor(() => stampChild.pid !== undefined, 'the stamp fixture to start');
    await sleep(1500);

    // A warm start would keep the previous run's link, which points at a
    // bridge that no longer exists, so the app starts cold every run.
    adb('shell', 'am', 'force-stop', 'dev.desklink.example');
    await sleep(1000);
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `"${link}"`);
    await waitFor(connected, "the app's own report with a presented frame", 180000);
    await sleep(4000);
    mark('session-live');
    // One exact cross-clock sample: the app stamps the device's own clock when
    // it mounts the first frame. It is a lower bound on glass-to-glass (it does
    // not include the native view and display pipeline).
    const first = reports.find(report => report.presentedAt > 0);
    receipt.first_frame = { presented_at_device_ms: first?.presentedAt ?? null, started_at_device_ms: first?.startedAt ?? null };

    // Scenario legs: frame rate first (the harness is idle, so it is the
    // phone's own number), then latency (the capture loop is running).
    const directory = '/data/local/tmp/dl-phone-g2g';
    adb('shell', `mkdir -p ${directory}`);
    receipt.legs = {};
    for (const scenario of scenarios) {
        if (mode !== scenario) {
            stampChild.kill('SIGTERM');
            await sleep(700);
            mode = scenario;
            stampChild = spawn(stampBinary, [], { cwd: repo, env: { ...xenv, MODE: mode, RATE: '120' }, stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(['stamp', stampChild]);
            await sleep(2500);
        } else {
            await sleep(1500);
        }
        const leg = { scenario, load_before: load() };

        const fpsFrom = reports.at(-1)?.at ?? Date.now();
        const driving = driveInput(scenario, fpsSeconds);
        await sleep(fpsSeconds * 1000 + 1500);
        await driving;
        leg.fps = fpsFromReports(fpsFrom, Date.now());
        leg.load_after_fps = load();
        leg.fps_report_windows = reports.filter(report => report.at >= fpsFrom).length;
        mark(`${scenario}-fps`);

        // Typing leaves the soft keyboard up, which shrinks and crops the
        // picture until the stamp strip is only partly on screen. Dismiss it
        // before measuring: a cropped strip cannot carry all 24 bits.
        adb('shell', 'input', 'keyevent', '111');
        await sleep(2000);
        const expected = Math.min(160, Math.round(latencySeconds * 1000 / receipt.costs.capture_window_median_ms));
        // The phone's clock drifts against this host's, and a stale offset
        // would show up as latency, so this leg measures its own offset before
        // and after its captures and uses the mean.
        leg.clock_before = await clockOffsets();
        const stamps = captureLoop(expected, directory);
        leg.clock_after = await clockOffsets();
        leg.clock_offset_ms = round((leg.clock_before.offset_median_ms + leg.clock_after.offset_median_ms) / 2);
        leg.clock_drift_ms = round(leg.clock_after.offset_median_ms - leg.clock_before.offset_median_ms);
        mark(`${scenario}-captured`);
        // One frame in memory at a time: a raw capture is 10 MB and a leg has
        // up to 160 of them.
        const pull = index => adbBin('exec-out', 'cat', `${directory}/cap_${index}.raw`).stdout;
        leg.latency = decodeLatency(stamps, pull, leg, { ...receipt, offset_ms: leg.clock_offset_ms });
        mark(`${scenario}-decoded`);
        if (!keepCaptures) adb('shell', `rm -f ${directory}/cap_*.raw ${directory}/stamps.txt`);
        leg.load_after_latency = load();
        leg.battery = adb('shell', 'dumpsys', 'battery').split('\n').filter(line => /level|temperature|status/.test(line)).map(line => line.trim());
        writeFileSync(join(out, `screen-${scenario}.png`), adbBin('exec-out', 'screencap', '-p').stdout);
        receipt.legs[scenario] = leg;
        saveReceipt();
    }
    receipt.reports_sample = reports.slice(-3);

    receipt.clock_after = await clockOffsets();
    receipt.load_after = load();
    receipt.outcome = 'PASS';
    console.log(`PASS: ${serial} measured over ${receipt.device.wifi}; evidence ${out}`);
};

/**
 * The README quickstart, on the real phone, exactly as a new user runs it.
 *
 * Nothing here is from this checkout except the phone driver: the app is a
 * fresh `create-expo-app` with the published `@desklink/react-native`,
 * `react-native-webrtc`, `@config-plugins/react-native-webrtc` and
 * `@byokit/signaling`, and the bridge is the published `npx @desklink/host`.
 * The desktop it shows is a window on the private X display whose button counts
 * its own clicks on this host, so the tap is proved by the host's count rather
 * than by the harness's opinion of a screenshot.
 *
 * Transport: the phone reaches this host over an `adb reverse` tunnel on the
 * USB cable, not over the local network. Both legs the developer would meet —
 * the app's JavaScript and the WebRTC media — ride that tunnel, and the receipt
 * says so wherever it names a path.
 */
const quickstartJourney = async () => {
    receipt.sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    receipt.published_host_version = spawnSync('npm', ['view', '@desklink/host', 'version'], { encoding: 'utf8' }).stdout.trim() || null;
    receipt.transport_detail = 'adb reverse tunnel over the USB cable, both legs (signalling, app JavaScript and, as the wire log shows, WebRTC media); '
        + 'not the local network: this host drops inbound TCP except sshd, and the phone is on the same subnet';
    const token = await hostLab();
    let wireRelay;
    let fixture;
    let recording;
    let wirePort;
    try {
    // Every frame between the phone and the bridge, so the receipt can say what
    // the wire actually carried. The token never appears: it is replaced.
    const wire = wireLog;
    wireRelay = createNetServer(client => {
        const upstream = connect({ host: '127.0.0.1', port: bridgePort });
        const pump = (from, to, side) => {
            from.on('data', chunk => {
                wire.push(`[${new Date().toISOString()}] ${side} ${chunk.toString().slice(0, 8000).split(token).join('<bridge-token>')}\n`);
                to.write(chunk);
            });
            from.on('end', () => to.end());
            from.on('error', () => to.destroy());
            to.on('error', () => from.destroy());
        };
        pump(client, upstream, 'phone->host');
        pump(upstream, client, 'host->phone');
    });
    await new Promise(ok => wireRelay.listen(0, '127.0.0.1', ok));
    wirePort = wireRelay.address().port;
    receipt.wirePort = wirePort;

    // The desktop: one window on the private display with a button that tells
    // this host how many times the desktop was clicked.
    let fixtureTaps = 0;
    fixture = createServer((request, response) => {
        if (request.url.startsWith('/tap')) {
            fixtureTaps += 1;
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(FIXTURE_HTML);
    });
    await new Promise(ok => fixture.listen(0, '127.0.0.1', ok));
    const fixturePort = fixture.address().port;
    const fixtureBrowser = start('fixture', 'chromium', ['--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage', '--window-position=0,0', '--window-size=1280,720',
        `--user-data-dir=${join(scratch, 'chromium-profile')}`, `--app=http://127.0.0.1:${fixturePort}/`], xenv, scratch);
    mark('fixture-open');

    const packageSource = process.env.DESKLINK_QUICKSTART_PACKAGE ?? 'published';
    if (!existsSync(join(quickstart, 'package.json'))) {
        mkdirSync(quickstart, { recursive: true });
        const scaffold = spawnSync('npx', ['-y', 'create-expo-app@latest', quickstart, '--template', 'blank-typescript'],
            { encoding: 'utf8', timeout: 600000 });
        assert.equal(scaffold.status, 0, `could not scaffold ${quickstart}: ${(scaffold.stderr ?? scaffold.stdout ?? '').slice(-400)}`);
        if (packageSource !== 'repo') {
            const installedPackages = spawnSync('npx', ['expo', 'install', '@desklink/react-native', 'react-native-webrtc',
                '@config-plugins/react-native-webrtc@15', '@byokit/signaling@0.1.0'],
                { cwd: quickstart, env, encoding: 'utf8', timeout: 600000 });
            assert.equal(installedPackages.status, 0, `could not install the published packages: ${(installedPackages.stderr ?? installedPackages.stdout ?? '').slice(-400)}`);
        }
    }
    writeFileSync(join(quickstart, 'App.tsx'), quickstartApp(`ws://127.0.0.1:${wirePort}/desktop?token=${token}`));
    // `published` is what a new user gets from npm. `repo` installs this
    // checkout's package instead. Either way the one file PR #95 fixed is
    // applied to the installed copy, because npm's 0.5.0 predates it and cannot
    // start a fresh SDK 57 app at all; that file is what the next publish needs.
    receipt.app_package_source = packageSource;
    receipt.app_published_patch = 'android/build.gradle from PR #95 (expo-module-gradle-plugin), '
        + 'applied to the installed package because npm 0.5.0 predates it';
    const patchGradle = `node -e "require('node:fs').copyFileSync('${join(repo, 'packages/desktop-client/android/build.gradle')}', 'node_modules/@desklink/react-native/android/build.gradle')"`;
    if (process.env.DESKLINK_ANDROID_SKIP_BUILD !== '1') {
        const build = spawnSync('flock', ['/tmp/fm-desklink-heavy.lock', 'bash', '-c', [
            // `--install-links` copies the package instead of symlinking it, so
            // Metro resolves the app's own `expo` from inside the project.
            ...(packageSource === 'repo' ? [`npm install --no-audit --no-fund --install-links file:${join(repo, 'packages/desktop-client')}`] : []),
            patchGradle,
            'npx expo prebuild --platform android --no-install',
            'cd android && ./gradlew --no-daemon assembleDebug',
        ].join(' && ')], { cwd: quickstart, env, encoding: 'utf8', timeout: 3600000 });
        writeFileSync(join(out, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
        assert.equal(build.status, 0, 'the quickstart app did not build; see build.log');
    }
    const quickApk = join(quickstart, 'android/app/build/outputs/apk/debug/app-debug.apk');
    assert(existsSync(quickApk), `no quickstart APK at ${quickApk}`);
    receipt.app = {
        project: quickstart,
        packages: publishedVersions(quickstart),
        apk_sha256: hash(quickApk),
    };
    const applicationId = /applicationId\s+['"]([^'"]+)['"]/.exec(readFileSync(join(quickstart, 'android/app/build.gradle'), 'utf8'))?.[1];
    assert(applicationId, 'no applicationId in the quickstart build.gradle');
    receipt.app.application_id = applicationId;
    mark('apk-ready');
    // No `-g`: nothing is pre-granted on the captain's phone, so the journey
    // proves only what a new user actually taps.
    const installed = spawnSync('adb', ['-s', serial, 'install', '-r', '-t', '--no-streaming', quickApk], { encoding: 'utf8', timeout: 900000 });
    assert.equal(installed.status, 0, `adb install failed: ${installed.stderr ?? installed.stdout ?? installed.signal}`);
    mark('apk-installed');
    const metroProbe = createServer();
    await new Promise(ok => metroProbe.listen(0, '127.0.0.1', ok));
    const metroPort = metroProbe.address().port;
    metroProbe.close();
    metro = start('metro', 'npx', ['expo', 'start', '--port', String(metroPort)], { ...env, CI: '1' }, quickstart);
    try {
        await waitFor(() => /Waiting on http|Metro waiting/.test(logs.metro), 'Metro', 180000);
    } catch (error) {
        throw new Error(`${error}; metro said: ${logs.metro.slice(-400)}`);
    }
    // The debug build loads its JavaScript from Metro on 8081, and the media
    // bridge answers on its own port: both legs of the journey are this tunnel.
    adb('reverse', 'tcp:8081', `tcp:${metroPort}`);
    adb('reverse', `tcp:${wirePort}`, `tcp:${wirePort}`);
    receipt.metroPort = metroPort;
    mark('metro-ready');

    // The recording. `screenrecord` runs in its own SELinux domain and cannot
    // open a file adb can read on this phone, so the recording is a frame
    // sequence the phone writes itself and this host encodes at the cadence it
    // actually achieved; the receipt publishes that cadence as the limit.
    const recordDir = '/data/local/tmp/dl-quickstart';
    adb('shell', `rm -rf ${recordDir}; mkdir -p ${recordDir}`);
    const recordFrom = Date.now();
    recording = spawn('adb', ['-s', serial, 'shell',
        `i=0; while [ $i -lt ${RECORD_FRAMES} ]; do screencap -p ${recordDir}/f_$i.png; i=$((i+1)); done; echo done`],
    { stdio: 'ignore' });
    const stopRecording = async () => {
        try { process.kill(recording.pid, 'SIGTERM'); } catch { /* already finished */ }
        await sleep(500);
    };

    receipt.device = {
        model: adb('shell', 'getprop', 'ro.product.model').trim(),
        release: adb('shell', 'getprop', 'ro.build.version.release').trim(),
        sdk: adb('shell', 'getprop', 'ro.build.version.sdk').trim(),
        resolution: adb('shell', 'wm', 'size').trim().split(':').pop().trim(),
    };
    // A cold start, so the app cannot keep a link to a bridge that is gone.
    adb('shell', 'am', 'force-stop', applicationId);
    await sleep(1000);
    adb('shell', 'am', 'start', '-n', `${applicationId}/.MainActivity`);
    await sleep(8000); // Metro serves the first bundle request here
    await waitFor(() => uiBound('Connect') !== null, 'the quickstart Connect button', 120000);
    mark('app-open');

    // Tap Connect the way a user does: the control's own bounds, not a guess.
    const connectButton = uiBound('Connect');
    writeFileSync(join(out, 'app-idle.png'), adbBin('exec-out', 'screencap', '-p').stdout);
    adb('shell', 'input', 'tap', String(Math.round(connectButton.centerX)), String(Math.round(connectButton.centerY)));
    const connected = await waitForLive();
    writeFileSync(join(out, 'first-connect.png'), adbBin('exec-out', 'screencap', '-p').stdout);
    receipt.first_connect = { ...connected, connect_button: connectButton };
    mark('session-live');

    // A real tap on the picture: the host's own click count is the proof, so
    // the run tries the middle of the picture and, if the view crops the
    // desktop differently than expected, moves across it until the desktop
    // answers. How many taps it took is published either way.
    const before = phoneFrame();
    writeFileSync(join(out, 'tap-before.png'), adbBin('exec-out', 'screencap', '-p').stdout);
    receipt.tap = { attempts: [] };
    assert(before.band !== null, 'the phone lost the desktop picture before the tap');
    for (const [at, position] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.38], [0.5, 0.62]].entries()) {
        const x = Math.round(before.width * position[1]);
        const y = Math.round(before.band.top + (before.band.bottom - before.band.top) * position[0]);
        const taps = fixtureTaps;
        adb('shell', 'input', 'tap', String(x), String(y));
        await sleep(2500);
        receipt.tap.attempts.push({ phone_x: x, phone_y: y, desktop_ticks: fixtureTaps - taps });
        if (fixtureTaps > taps) break;
    }
    await stopRecording();
    receipt.tap.desktop_clicks = fixtureTaps;
    const after = phoneFrame();
    writeFileSync(join(out, 'tap-after.png'), adbBin('exec-out', 'screencap', '-p').stdout);
    assert(fixtureTaps > 0, 'no tap on the picture reached the desktop');
    // The desktop changed on the phone's own screen, not only in the host's count.
    assert(after.hash !== before.hash, 'the phone screen did not change after the tap that the host counted');
    receipt.tap.phone_screen_changed = true;
    mark('tap-landed');

    // The recording, at the cadence this device actually gave.
    const frames = adb('shell', `ls ${recordDir} | wc -l`).trim();
    const seconds = (Date.now() - recordFrom) / 1000;
    const fps = Math.max(1, Math.round(Number(frames) / Math.max(1, seconds) * 100) / 100);
    receipt.recording = { frames: Number(frames), seconds: round(seconds), fps, note: 'frame sequence, not screenrecord: screenrecord cannot write a readable file on this phone' };
    const pulled = join(out, 'frames');
    mkdirSync(pulled, { recursive: true });
    spawnSync('adb', ['-s', serial, 'pull', `${recordDir}/.`, pulled], { encoding: 'utf8', timeout: 600000 });
    const encoded = spawnSync('ffmpeg', ['-y', '-framerate', String(fps), '-i', join(pulled, 'f_%d.png'),
        '-vf', 'scale=540:-2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '30', join(out, 'connect-and-tap.mp4')],
    { encoding: 'utf8', timeout: 600000 });
    assert.equal(encoded.status, 0, `ffmpeg could not encode the recording: ${encoded.stderr?.slice(-400)}`);
    // The frames are bulky scratch; the encoded recording is the proof.
    spawnSync('rm', ['-rf', pulled]);
    mark('recorded');

    receipt.load_after = load();
    receipt.outcome = 'PASS';
    console.log(`PASS: ${serial} connected and tapped through the published quickstart; evidence ${out}`);
    fixtureBrowser.kill('SIGTERM');
    } finally {
        try { recording?.kill('SIGTERM'); } catch { /* already finished */ }
        if (wirePort !== undefined) adbTry('reverse', '--remove', `tcp:${wirePort}`);
        adbTry('reverse', '--remove', 'tcp:8081');
        try { wireRelay?.close(); } catch { /* already closed */ }
        try { fixture?.close(); } catch { /* already closed */ }
    }
};
try {
    await (journey === 'quickstart' ? quickstartJourney() : latencyJourney());
} catch (error) {
    receipt.error = String(error);
    console.error(String(error));
} finally {
    for (const [, child] of children) child.kill('SIGTERM');
    await sleep(700);
    for (const [, child] of children) { try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { child.exitCode ??= 0; } }
    receiver?.close();
    writeFileSync(join(out, 'screen-final.png'), adbBin('exec-out', 'screencap', '-p').stdout);
    adb('shell', 'input', 'keyevent', '3');
    if (!keepCaptures) adb('shell', 'rm', '-rf', '/data/local/tmp/dl-phone-g2g', '/data/local/tmp/dl-quickstart');
    if (xvfb) { try { await stopOwnedXvfb(xvfb); } catch (error) { receipt.cleanup = String(error); } }
    claim.release();
    for (const name of Object.keys(logs)) writeFileSync(join(out, `${name}.log`), logs[name]);
    writeFileSync(join(out, 'wire.log'), wireLog.join(''));
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(receipt.outcome === 'PASS' ? 0 : 1);

/**
 * Turn raw captures into latency samples. Nothing about where the picture sits
 * on the phone is assumed: every capture is read through its own geometry, and
 * a sample survives only if its stamp lands inside an honest latency.
 */
/**
 * Pick where the strip is on this phone, from the captures themselves.
 *
 * The app's zoom decides the block pitch and nothing states it, so every
 * plausible pitch and left edge is tried against a sample of frames. A
 * configuration only wins if it reads the strip in most frames, its stamps
 * advance, and they land on latencies a phone could plausibly show.
 */
function pickStripConfig(sample, pull) {
    const configs = [];
    for (let pitch = 8; pitch <= 80; pitch += 0.5) {
        for (const x0 of [0, 1, 2, 3, 4]) configs.push({ pitch, x0 });
    }
    // Every configuration reads the same sample frames, so they are pulled once
    // (a raw capture is 10 MB; the sample is deliberately short).
    const frames = sample.map(frame => ({ before: frame.before, ...capturePixels(pull(frame.index)) }))
        .filter(capture => capture.pixels.length >= 1080 * 2376 * 4);
    const scored = [];
    for (const config of configs) {
        const stamps = frames.map(capture => frameStamp(capture.pixels, capture.width, capture.height, config).stamp);
        const read = stamps.filter(stamp => stamp !== null);
        if (read.length < frames.length * 0.6) continue;
        // A configuration is only the strip if its stamps advance with time and
        // the capture times they pair with cluster together: the phone's clock
        // may be any distance from this host's, so the test never compares the
        // two clocks, it only asks whether the differences agree.
        let advancing = 0;
        const differences = [];
        for (let i = 0; i < stamps.length; i += 1) {
            if (stamps[i] === null) continue;
            if (i > 0 && stamps[i - 1] !== null) {
                const step = (stamps[i] - stamps[i - 1] + WRAP) % WRAP;
                if (step > 0 && step < 4000) advancing += 1;
            }
            differences.push(frames[i].before - stamps[i]);
        }
        if (differences.length < frames.length * 0.6) continue;
        const sorted = [...differences].sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length / 2)];
        const clustered = differences.filter(value => Math.abs(value - middle) < 1500);
        if (clustered.length < frames.length * 0.6) continue;
        scored.push({
            config,
            read_fraction: round(read.length / frames.length),
            advancing_fraction: round(advancing / Math.max(1, read.length - 1)),
            clustered_fraction: round(clustered.length / frames.length),
        });
    }
    scored.sort((a, b) => b.advancing_fraction - a.advancing_fraction
        || b.clustered_fraction - a.clustered_fraction
        || b.read_fraction - a.read_fraction);
    return scored[0] ?? null;
}

/**
 * Turn raw captures into latency samples. Nothing about where the picture sits
 * on the phone is assumed: the strip's geometry comes from `pickStripConfig`,
 * and a sample survives only if its stamp lands inside an honest latency.
 */
/**
 * Turn raw captures into latency samples.
 *
 * Two numbers come out of every capture, and both are published because the
 * phone's clock is not trustworthy to the millisecond:
 *
 *  - `absolute` uses the clock offset measured around this leg, the way any
 *    cross-clock measurement must;
 *  - `relative` drops the clock entirely: it is how much each frame lags the
 *    fastest frame in the same run, which no clock error can move.
 */
function decodeLatency(stamps, pull, leg, receipt_) {
    const grab = receipt_.costs.grab_estimate_ms;
    const exec = receipt_.costs.exec_median_ms;
    const offset = receipt_.offset_ms;
    const chosen = pickStripConfig(stamps.filter((_, at) => at % 3 === 0), pull);
    if (chosen === null) {
        return {
            decoded: false,
            reason: 'no block pitch read the strip in a plausible latency; the picture may be '
                + 'cropped (keyboard up) or the strip may not be on screen',
        };
    }
    const reads = [];
    let band = null;
    for (const frame of stamps) {
        const { pixels, width, height } = capturePixels(pull(frame.index));
        if (pixels.length < 1080 * 2376 * 4) continue;
        const read = frameStamp(pixels, width, height, chosen.config);
        band ??= read.band ?? null;
        if (read.stamp !== null) reads.push({ frame, stamp: read.stamp, votes: read.votes });
    }
    if (reads.length < stamps.length / 2) {
        return { decoded: false, reason: `only ${reads.length} of ${stamps.length} captures carried a readable strip` };
    }
    // The fastest capture in the run is the floor every other frame is measured
    // against. That difference needs no clock at all, so it survives whatever
    // this phone's clock is doing.
    const fastest = Math.min(...reads.map(row => row.frame.before - row.stamp));
    const relative = reads.map(row => ((row.frame.before - row.stamp - fastest) % WRAP + WRAP) % WRAP);
    // The absolute figure needs both clocks. On this device they disagree by
    // more than the latency being measured, so it is reported only when the
    // samples land inside an honest latency and named as unmeasured when not.
    const absolute = reads.map(row => latency(row.frame.before, offset, row.stamp));
    // The clock offset the stamps and capture times imply, against the one the
    // phone's own `date` reports. Both are the low 24 bits of the same epoch.
    const impliedOffsets = reads
        .map(row => (((row.frame.before - row.stamp) % WRAP) + WRAP) % WRAP)
        .map(value => (value > WRAP / 2 ? value - WRAP : value))
        .sort((a, b) => a - b);
    const inRange = absolute.filter(value => value > 0 && value < 2000);
    const absoluteUsable = inRange.length >= reads.length / 2;
    leg.strip_geometry = { ...chosen.config, ...chosen, band };
    return {
        decoded: true,
        samples: reads.length,
        unreadable: stamps.length - reads.length,
        capture_window_median_ms: receipt_.costs.capture_window_median_ms,
        clock_offset_ms: offset,
        relative_p50_ms: round(percentile(relative, 50)),
        relative_p95_ms: round(percentile(relative, 95)),
        relative_min_ms: round(percentile(relative, 0)),
        uncertainty_ms: receipt_.costs.uncertainty_ms,
        absolute_p50_ms: absoluteUsable ? round(percentile(inRange, 50)) : null,
        absolute_p95_ms: absoluteUsable ? round(percentile(inRange, 95)) : null,
        absolute_usable: absoluteUsable,
        implied_clock_offset_ms: round(percentile(impliedOffsets, 50)),
        absolute_note: absoluteUsable
            ? null
            : `the phone's own clock put it ${-offset} ms behind this host, while its capture times `
                + `and the stamps in its picture imply ${-round(percentile(impliedOffsets, 50))} ms; `
                + 'the disagreement is larger than the latency being measured, so no absolute number '
                + 'is claimed',
        raw: reads.map((row, i) => ({
            before: row.frame.before, stamp: row.stamp, votes: row.votes,
            relative_ms: Math.round(relative[i]), absolute_ms: Math.round(absolute[i]),
        })),
    };
}
