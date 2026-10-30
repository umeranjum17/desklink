// Where did each stall of a macOS soak happen? Reads a soak's timeline.json (and, when the run set
// DESKLINK_MAC_CAPTURE_TRACE, its capture-trace.csv) and prints, for every run of one-second windows
// under --below fps, how many frames each stage handled in that stretch against the seconds around it:
// the ScreenCaptureKit callback (trace), the engine's capture/encode/drop counters and rate target
// (`--metrics-s 1` series), and the client's presented frames (fps_windows).
//
//   node packages/desktop-host/test/mac-soak-stalls.mjs <run dir> [--below 30] [--trace capture-trace.csv]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const dir = resolve(argv[0] ?? '.');
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const below = Number(option('--below', 30));
const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const tracePath = join(dir, option('--trace', 'capture-trace.csv'));
const trace = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8').trim().split('\n').slice(1).map((line) => line.split(',').map(Number))
    : [];

const windows = timeline.fps_windows.filter((w) => w.phase === 'soak');
const series = timeline.metric_series ?? [];
const origin = windows[0]?.at ?? 0;

const stalls = [];
for (const w of windows) {
    if (w.fps >= below) continue;
    const last = stalls.at(-1);
    if (last && w.at - last.end <= 2000) { last.end = w.at + 1000; last.fps.push(w.fps); } else stalls.push({ start: w.at, end: w.at + 1000, fps: [w.fps] });
}

// Frames each source counted in [from, to), as a rate per second.
const rate = (read, from, to) => (to > from ? read(from, to) / ((to - from) / 1000) : null);
const counter = (key) => (from, to) => {
    const at = (t) => series.findLast((m) => m.at <= t) ?? series[0];
    return at(to)[key] - at(from)[key];
};
const callbacks = (from, to) => trace.filter(([wall]) => wall >= from && wall < to).length;
const f1 = (v) => (v === null || Number.isNaN(v) ? '-' : v.toFixed(0));

console.log(`${stalls.length} stall(s) under ${below} fps in ${windows.length} one-second windows`);
for (const s of stalls) {
    const before = [s.start - 6000, s.start - 1000];
    const row = (from, to) => ({
        client: f1(rate((a, b) => windows.filter((w) => w.at >= a && w.at < b).reduce((n, w) => n + w.fps, 0), from, to)),
        sck: trace.length ? f1(rate(callbacks, from, to)) : '-',
        captured: series.length ? f1(rate(counter('captured_frames'), from, to)) : '-',
        encoded: series.length ? f1(rate(counter('encoded_frames'), from, to)) : '-',
        dropped: series.length ? f1(rate(counter('dropped_frames'), from, to)) : '-',
        keys: series.length ? counter('key_frames')(from, to) : '-',
        target_kbps: series.length ? series.findLast((m) => m.at <= to)?.target_kbps ?? '-' : '-',
    });
    const gaps = trace.filter(([wall]) => wall >= s.start - 1000 && wall < s.end).map(([, gap]) => gap / 1000);
    console.log(`\nstall at +${Math.round((s.start - origin) / 1000)} s for ${(s.end - s.start) / 1000} s, client fps ${s.fps.join(',')}`);
    console.log('  per-second rates:   before   during');
    const a = row(...before);
    const b = row(s.start, s.end);
    for (const k of Object.keys(a)) console.log(`  ${k.padEnd(18)} ${String(a[k]).padStart(7)} ${String(b[k]).padStart(8)}`);
    if (gaps.length) console.log(`  longest SCK callback gap in/around the stall: ${Math.max(...gaps).toFixed(0)} ms`);
}
