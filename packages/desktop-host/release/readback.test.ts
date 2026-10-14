import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const releaseDir = dirname(fileURLToPath(import.meta.url));
const readbackSh = join(releaseDir, 'readback.sh');
const readbackMjs = pathToFileURL(join(releaseDir, 'readback.mjs')).href;
const budget = JSON.parse(readFileSync(join(releaseDir, 'readback-budget.json'), 'utf8')) as {
    attempts: number;
    intervalSeconds: number;
};

// A registry we control for the shell path: a real `npm` executable on PATH
// that logs every `view` call and answers per STUB_MODE, so registry_state and
// wait_published run unchanged. The 20x3s budget this replaced is 20 calls.
function runShell(body: string, env: Record<string, string>): { status: number | null; stdout: string } {
    const setup = `
set -uo pipefail
work="$(mktemp -d)"
mkdir -p "$work/bin"
cat > "$work/bin/npm" <<'NPM'
#!/usr/bin/env bash
if [ "$1" = view ]; then
    n=0; [ -f "$COUNT" ] && n="$(cat "$COUNT")"; n=$((n + 1)); echo "$n" > "$COUNT"
    case "\${STUB_MODE}" in
        slow) [ "$n" -le "\${SLOW_AFTER:-0}" ] && { echo "npm ERR! code E404" >&2; exit 1; } ;;
        missing) echo "npm ERR! code E404" >&2; exit 1 ;;
        error) echo "npm ERR! code ENOTFOUND registry unreachable" >&2; exit 1 ;;
    esac
    echo "0.5.4"; exit 0
fi
exit 0
NPM
chmod +x "$work/bin/npm"
export PATH="$work/bin:$PATH" COUNT="$work/calls"
source "$READBACK_SH"
sleep() { :; }
${body}
rm -rf "$work"
`;
    const result = spawnSync('bash', ['-c', setup], {
        encoding: 'utf8',
        env: { ...process.env, READBACK_SH: readbackSh, ...env },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout };
}

const stubEnv = (mode: string, extra: Record<string, string> = {}) => ({ STUB_MODE: mode, ...extra });

it('waits past the old 20-poll budget for a slow read and proceeds', () => {
    const { status, stdout } = runShell(
        `wait_published "@desklink/host@0.5.4"; printf 'rc=%s calls=%s\\n' "$?" "$(cat "$COUNT")"`,
        stubEnv('slow', { SLOW_AFTER: '25' }),
    );
    expect(status).toBe(0);
    expect(stdout).toContain(`rc=0 calls=26`);
});

it('fails a genuinely missing package at the new bound, after more polls than the old budget', () => {
    const { stdout } = runShell(
        `wait_published "@desklink/host@0.5.4"; printf 'rc=%s calls=%s attempts=%s\\n' "$?" "$(cat "$COUNT")" "$READBACK_ATTEMPTS"`,
        stubEnv('missing'),
    );
    expect(stdout).toContain(`rc=1 calls=${budget.attempts} attempts=${budget.attempts}`);
    expect(stdout).not.toContain('rc=0');
});

it('classifies a served version, an E404 and a registry error distinctly', () => {
    const body = `out="$(registry_state "@desklink/host@0.5.4" 2>"$work/err")"; printf 'state=%s stderr=%s\\n' "$out" "$(cat "$work/err")"`;
    expect(runShell(body, stubEnv('published')).stdout).toContain('state=published stderr=');
    expect(runShell(body, stubEnv('missing')).stdout).toContain('state=missing stderr=');
    const errored = runShell(body, stubEnv('error')).stdout;
    expect(errored).toContain('state=error');
    expect(errored).toContain('not a missing version');
});

it('waits the same budget in release/publish.mjs and reports it in one place', async () => {
    const { waitForReadback, READBACK_ATTEMPTS, READBACK_INTERVAL_MS } = await import(readbackMjs);
    expect(READBACK_ATTEMPTS).toBe(budget.attempts);
    expect(READBACK_INTERVAL_MS).toBe(budget.intervalSeconds * 1000);

    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((done: () => void) => {
        done();
        return 0;
    }) as unknown as typeof globalThis.setTimeout;
    try {
        let calls = 0;
        const accepted = await waitForReadback(
            () => (++calls >= 26 ? 'sha512-x' : undefined),
            (value: string | undefined) => value === 'sha512-x',
        );
        expect(accepted).toBe('sha512-x');
        expect(calls).toBe(26);

        let missingCalls = 0;
        const stillMissing = await waitForReadback(() => (missingCalls += 1, undefined), () => false);
        expect(stillMissing).toBeUndefined();
        expect(missingCalls).toBe(READBACK_ATTEMPTS);
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
});

it('does not swallow a registry error on the manual route', async () => {
    const { waitForReadback } = await import(readbackMjs);
    const failure = new Error('registry unreachable');
    await expect(waitForReadback(() => { throw failure; }, () => false)).rejects.toBe(failure);
});
