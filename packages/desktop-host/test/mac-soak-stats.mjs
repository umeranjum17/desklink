// Sampling maths for the macOS soak, kept apart so the dry run and the real run
// use the same code. The method matches the journey lane (`g2g-flow.mjs`,
// docs/phone-wifi-latency.md): fps is taken in one-second windows and reported as
// the median with the fifth percentile; latency is reported at p50 and p95. The
// soak adds the worst value of each, because an hour is judged by its bad second,
// not only its typical one.

/** Nearest-rank percentile of an already sorted array, as `g2g-flow.mjs` computes it. */
export function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const sortedNumbers = (values) => values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

/**
 * One-second windows over [startMs, endMs): how many presented frames fell in
 * each. A trailing partial window is dropped, never scaled up.
 */
export function fpsWindows(frameTimesMs, startMs, endMs) {
    const windows = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const counts = new Array(windows).fill(0);
    for (const t of frameTimesMs) {
        const index = Math.floor((t - startMs) / 1000);
        if (index >= 0 && index < windows) counts[index] += 1;
    }
    return counts.map((fps, i) => ({ at: startMs + i * 1000, fps }));
}

/** fps summary of a list of windows: median, p05 and the worst (lowest) window. */
export function fpsSummary(windows) {
    const sorted = sortedNumbers(windows.map((w) => w.fps));
    return {
        windows: sorted.length,
        median: percentile(sorted, 50),
        p05: percentile(sorted, 5),
        worst: sorted[0] ?? null,
    };
}

/** Latency summary of echo samples (ms, `null` = no echo within the deadline). */
export function latencySummary(samples) {
    const sorted = sortedNumbers(samples.map((s) => s.ms));
    return {
        samples: sorted.length,
        lost: samples.length - sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        worst: sorted[sorted.length - 1] ?? null,
    };
}

/** Round to one decimal so the JSON stays readable; leaves null alone. */
export const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);
