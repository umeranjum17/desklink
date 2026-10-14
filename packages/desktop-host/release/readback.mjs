import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The budget lives in readback-budget.json, the single source this module and
// readback.sh both read, so the manual route (release/publish.mjs) and the
// release workflow wait the same window for a just-published version.
const budget = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'readback-budget.json'), 'utf8'));
export const READBACK_ATTEMPTS = budget.attempts;
export const READBACK_INTERVAL_MS = budget.intervalSeconds * 1000;

/**
 * Poll `read` until `accept` holds or the shared budget is spent, then return
 * the last value read. npm states a freshly published version "may take a few
 * minutes to become available", so the budget spans that window; a value still
 * absent at the bound is returned as-is and the caller treats it as missing.
 * A `read` that throws is not swallowed: a registry, auth or network failure
 * aborts the caller rather than masquerading as an unpublished version.
 */
export async function waitForReadback(read, accept) {
    let value;
    for (let attempt = 0; attempt < READBACK_ATTEMPTS && !accept(value); attempt += 1) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, READBACK_INTERVAL_MS));
        value = read();
    }
    return value;
}
