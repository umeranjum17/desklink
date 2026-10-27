#!/usr/bin/env node
/**
 * Which side is stuck after a display wake? Reads a soak `timeline.json` (its `probes`
 * and `events`) and prints one row per probe, seconds relative to the wake, then names
 * the first boundary whose counter stopped moving while the one before it kept moving:
 *   engine capture -> engine encoder -> transport (client packets) -> client decode -> client presentation
 *
 *   node mac-soak-wake-report.mjs <timeline.json>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STAGES = [
    ['capture', (p) => p.engine?.captured_frames],
    ['encoder', (p) => p.engine?.encoded_frames],
    ['transport', (p) => p.client?.inbound?.packetsReceived],
    ['decode', (p) => p.client?.inbound?.framesDecoded],
];

export function diagnose(timeline) {
    const wake = timeline.events.find((e) => e.name === 'woke');
    const probes = (timeline.probes ?? []).filter((p) => p.engine !== undefined || p.error !== undefined);
    if (wake === undefined || probes.length === 0) return { verdict: 'no probes after a wake: nothing to diagnose', rows: [] };
    const after = probes.filter((p) => p.at > wake.at && p.engine !== undefined);
    const rows = probes.map((p) => ({
        t: Math.round((p.at - wake.at) / 1000),
        ...Object.fromEntries(STAGES.map(([name, read]) => [name, read(p) ?? null])),
        conn: p.client ? `${p.client.connection}/${p.client.ice}` : null,
        visible: p.visibility ?? null,
        events: (p.events ?? []).map((e) => `${e.source}:${e.name}`).join(' '),
        error: p.error ?? p.engine?.error ?? (p.engine?.timeout ? 'engine metrics timed out' : undefined),
    }));
    if (after.length < 2) return { verdict: 'fewer than two probes after the wake', rows };
    const first = after[0];
    const last = after.at(-1);
    const moved = (read) => (read(last) ?? 0) > (read(first) ?? 0);
    const stuck = STAGES.find(([, read]) => !moved(read));
    const verdict = stuck === undefined
        ? 'every counter moved after the wake; a stuck picture would be presentation (check `visible`)'
        : `${stuck[0]} did not advance between ${rows.find((r) => r.t > 0)?.t ?? '?'} s and ${rows.at(-1).t} s after the wake`
          + (stuck === STAGES[0] ? '' : ` although ${STAGES[STAGES.indexOf(stuck) - 1][0]} did`);
    return { verdict, rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { verdict, rows } = diagnose(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.table(rows);
    console.log(verdict);
}
