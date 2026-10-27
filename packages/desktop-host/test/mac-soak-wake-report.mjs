#!/usr/bin/env node
/**
 * Which side is stuck after a display wake? Reads a soak `timeline.json` (its `probes`
 * and `events`) and prints one row per probe, seconds relative to the wake, then names
 * the first boundary whose counter stopped moving after each wake while the one before it kept moving:
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

/** One verdict per wake: the probes between it and the next sleep (or the end). */
export function diagnose(timeline) {
    const wakes = timeline.events.filter((e) => e.name === 'woke');
    const probes = (timeline.probes ?? []).filter((p) => p.engine !== undefined || p.error !== undefined);
    if (wakes.length === 0 || probes.length === 0) return { verdicts: ['no probes after a wake: nothing to diagnose'], rows: [] };
    const rows = [];
    // A session the engine ended (lease, transport, error) is dead whatever the display did: say so first.
    const revoked = probes.flatMap((p) => p.events ?? []).filter((e) => e.name === 'session.revoked')
        .map((e) => `session revoked (${e.detail?.code}: ${e.detail?.reason}) ${Math.round((e.at - wakes[0].at) / 1000)} s from the first wake`);
    const verdicts = revoked.concat(wakes.map((wake, n) => {
        const end = timeline.events.find((e) => e.name === 'sleep-requested' && e.at > wake.at)?.at ?? Infinity;
        const own = probes.filter((p) => p.at > wake.at && p.at < end && p.engine !== undefined);
        probes.filter((p) => p.at >= wake.at - 6000 && p.at < end).forEach((p) => rows.push({
            wake: n + 1,
            t: Math.round((p.at - wake.at) / 1000),
            ...Object.fromEntries(STAGES.map(([name, read]) => [name, read(p) ?? null])),
            conn: p.client ? `${p.client.connection}/${p.client.ice}` : null,
            visible: p.visibility ?? null,
            events: (p.events ?? []).map((e) => `${e.source}:${e.name}`).join(' '),
            error: p.error ?? p.engine?.error ?? (p.engine?.timeout ? 'engine metrics timed out' : undefined),
        }));
        const asleep = Math.round((wake.asleep_ms ?? 0) / 1000);
        if (own.length < 2) return `wake ${n + 1} (asleep ${asleep} s): fewer than two probes after it`;
        const [first, last] = [own[0], own.at(-1)];
        // A reopened session (the lease ran out, say) starts its counters again: a drop is progress, not a stall.
        const moved = (read) => own.some((p, i) => i > 0 && (read(p) ?? 0) !== (read(own[i - 1]) ?? 0));
        const stuck = STAGES.find(([, read]) => !moved(read));
        const span = Math.round((last.at - first.at) / 1000);
        return `wake ${n + 1} (asleep ${asleep} s): ` + (stuck === undefined
            ? `every counter moved over the ${span} s after it`
            : `${stuck[0]} did not advance over the ${span} s after it`
              + (stuck === STAGES[0] ? '' : ` although ${STAGES[STAGES.indexOf(stuck) - 1][0]} did`));
    }));
    return { verdicts, rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { verdicts, rows } = diagnose(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.table(rows);
    console.log(verdicts.join('\n'));
}
