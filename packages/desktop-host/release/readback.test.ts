import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const releaseDir = dirname(fileURLToPath(import.meta.url));
const readbackSh = join(releaseDir, 'readback.sh');
const readbackMjs = pathToFileURL(join(releaseDir, 'readback.mjs')).href;
const budget = JSON.parse(readFileSync(join(releaseDir, 'readback-budget.json'), 'utf8')) as {
    attempts: number;
    intervalSeconds: number;
};

// readback.sh only runs in the ubuntu publish job, so its tests need a real
// POSIX shell; the windows-2025 vitest lane has none (a bare `bash` there is
// the WSL placeholder), so resolve one and skip with a reason where none exists.
const shell = process.platform === 'win32' ? undefined : ['bash', '/bin/bash', '/usr/bin/bash'].find((candidate) => {
    const probe = spawnSync(candidate, ['-c', 'printf ok'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0 && probe.stdout === 'ok';
});
if (shell === undefined) console.warn(`readback.sh tests skipped: no usable POSIX shell on ${process.platform}`);
// A shell test spawns real processes for up to the whole poll budget with
// `sleep` stubbed out, so its wall time scales with CPU load, not with any real
// wait; the bound only catches a hang.
const shellIt = (name: string, fn: () => void) => it.skipIf(shell === undefined)(name, fn, 60_000);

// A registry we control for the shell path: a real `npm` executable on PATH
// that logs every `view` call and answers per STUB_MODE, so registry_state and
// wait_published run unchanged. The 20x3s budget this replaced is 20 calls.
function runShell(body: string, env: Record<string, string>): { status: number | null; stdout: string } {
    if (shell === undefined) throw new Error('no POSIX shell to source readback.sh with');
    const setup = `
set -uo pipefail
work="$(mktemp -d)"
mkdir -p "$work/bin"
cat > "$work/bin/npm" <<'NPM'
#!/usr/bin/env bash
if [ "$1" = view ]; then
    n=0; [ -f "$COUNT" ] && n="$(<"$COUNT")"; n=$((n + 1)); echo "$n" > "$COUNT"
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
    const result = spawnSync(shell, ['-c', setup], {
        encoding: 'utf8',
        env: { ...process.env, READBACK_SH: readbackSh, ...env },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout };
}

const stubEnv = (mode: string, extra: Record<string, string> = {}) => ({ STUB_MODE: mode, ...extra });

shellIt('waits past the old 20-poll budget for a slow read and proceeds', () => {
    const { status, stdout } = runShell(
        `wait_published "@desklink/host@0.5.4"; printf 'rc=%s calls=%s\\n' "$?" "$(cat "$COUNT")"`,
        stubEnv('slow', { SLOW_AFTER: '25' }),
    );
    expect(status).toBe(0);
    expect(stdout).toContain(`rc=0 calls=26`);
});

shellIt('fails a genuinely missing package at the new bound, after more polls than the old budget', () => {
    const { stdout } = runShell(
        `wait_published "@desklink/host@0.5.4"; printf 'rc=%s calls=%s attempts=%s\\n' "$?" "$(cat "$COUNT")" "$READBACK_ATTEMPTS"`,
        stubEnv('missing'),
    );
    expect(stdout).toContain(`rc=1 calls=${budget.attempts} attempts=${budget.attempts}`);
    expect(stdout).not.toContain('rc=0');
});

shellIt('classifies a served version, an E404 and a registry error distinctly', () => {
    const body = `out="$(registry_state "@desklink/host@0.5.4" 2>"$work/err")"; printf 'state=%s stderr=%s\\n' "$out" "$(cat "$work/err")"`;
    expect(runShell(body, stubEnv('published')).stdout).toContain('state=published stderr=');
    expect(runShell(body, stubEnv('missing')).stdout).toContain('state=missing stderr=');
    const errored = runShell(body, stubEnv('error')).stdout;
    expect(errored).toContain('state=error');
    expect(errored).toContain('not a missing version');
});

shellIt('fails a persistent registry error at the bound instead of reporting a missing version', () => {
    const { stdout } = runShell(
        `wait_published "@desklink/host@0.5.4"; printf 'rc=%s calls=%s\\n' "$?" "$(cat "$COUNT")"`,
        stubEnv('error'),
    );
    expect(stdout).toContain(`rc=2 calls=${budget.attempts}`);
    expect(stdout).not.toContain('rc=1');
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

// publish-set.sh run as the workflow runs it, against a registry we control: a
// stub `npm` on PATH that keeps per-spec state in files, logs every call, and
// serves a just-published spec only after STUB_LAG views of it (for
// STUB_LAG_SPEC; every other spec is served on the first view). `sleep` is a
// no-op on PATH, so a 30-minute budget runs in well under a second.
const publishSetSh = join(releaseDir, 'publish-set.sh');
const versionOf = (dir: string) =>
    (JSON.parse(readFileSync(join(releaseDir, '..', '..', dir, 'package.json'), 'utf8')) as { version: string }).version;
const HOST_VER = versionOf('desktop-host');
const ENGINES = [`@desklink/host-linux-x64-gnu@${HOST_VER}`, `@desklink/host-darwin-arm64@${HOST_VER}`];
const SET = [...ENGINES, `@desklink/host@${HOST_VER}`, `@desklink/axi@${versionOf('axi')}`, `@desklink/react-native@${versionOf('desktop-client')}`];
const fileOf = (spec: string) => `${spec.slice(1, spec.lastIndexOf('@')).replace('/', '-')}-${spec.slice(spec.lastIndexOf('@') + 1)}.tgz`;

const STUB_NPM = `#!/usr/bin/env bash
reg="$STUB_REGISTRY"; echo "$*" >> "$reg/log"
case "$1" in
view)
    [ "$2" = "\${STUB_ERROR:-}" ] && { echo "npm ERR! code ENOTFOUND registry unreachable" >&2; exit 1; }
    k="$reg/\${2//[\\/@]/_}"
    if [ -f "$k" ]; then
        left="$(<"$k")"
        [ "$left" -le 0 ] && { echo "\${2##*@}"; exit 0; }
        echo $((left - 1)) > "$k"
    fi
    echo "npm ERR! code E404" >&2; exit 1 ;;
publish)
    spec="$(tar -xzOf "$2" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(m.name+"@"+m.version)})')"
    [ "$spec" = "\${STUB_PUBLISH_FAIL:-}" ] && { echo "npm ERR! code E403" >&2; exit 1; }
    lag=0; [ "$spec" = "\${STUB_LAG_SPEC:-}" ] && lag="$STUB_LAG"
    echo "$lag" > "$reg/\${spec//[\\/@]/_}"; echo "+ $spec" ;;
esac
`;

function runPublishSet(opts: { omit?: string; served?: string[]; env?: Record<string, string> } = {}) {
    if (shell === undefined) throw new Error('no POSIX shell to run publish-set.sh with');
    const work = mkdtempSync(join(tmpdir(), 'desklink-publish-set-'));
    try {
        const bin = join(work, 'bin');
        const registry = join(work, 'registry');
        const dist = join(work, 'dist');
        for (const dir of [bin, registry, dist]) mkdirSync(dir);
        writeFileSync(join(bin, 'npm'), STUB_NPM, { mode: 0o755 });
        writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        for (const spec of SET) {
            if (spec === opts.omit) continue;
            const at = spec.lastIndexOf('@');
            const manifest: Record<string, unknown> = { name: spec.slice(0, at), version: spec.slice(at + 1) };
            if (spec === SET[2]) manifest.optionalDependencies = Object.fromEntries(ENGINES.map((e) => [e.slice(0, e.lastIndexOf('@')), HOST_VER]));
            const stage = join(work, 'stage', fileOf(spec), 'package');
            mkdirSync(stage, { recursive: true });
            writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
            const packed = spawnSync('tar', ['-czf', join(dist, fileOf(spec)), '-C', dirname(stage), 'package']);
            expect(packed.status).toBe(0);
        }
        for (const spec of opts.served ?? []) writeFileSync(join(registry, spec.replace(/[/@]/g, '_')), '0');
        const result = spawnSync(shell, [publishSetSh, dist], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_REGISTRY: registry, ...opts.env },
        });
        expect(result.error).toBeUndefined();
        const calls = readFileSync(join(registry, 'log'), 'utf8').trim().split('\n');
        const publishCalls = calls.filter((c) => c.startsWith('publish ')).map((c) => SET.find((s) => c.includes(`/${fileOf(s)}`)));
        return { status: result.status, stdout: result.stdout, calls, publishCalls };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

// 0.5.10: npm recorded the linux engine 7m20s after its publish returned, and
// the packument is CDN-cached for up to 300s more; the 60x5s budget then held
// the host and axi while react-native went out alone.
const INCIDENT_LAG_VIEWS = Math.ceil((7 * 60 + 20 + 300) / budget.intervalSeconds);

shellIt('publishes the whole set in order when an engine lags as long as it did in 0.5.10', () => {
    const { status, stdout, calls, publishCalls } = runPublishSet({ env: { STUB_LAG_SPEC: ENGINES[0], STUB_LAG: String(INCIDENT_LAG_VIEWS) } });
    expect(stdout).toContain(`Published and served: ${SET.join(' ')}.`);
    expect(status).toBe(0);
    expect(publishCalls).toEqual(SET);
    const engineViews = calls.filter((c) => c === `view ${ENGINES[0]} version`).length;
    expect(engineViews).toBe(1 + INCIDENT_LAG_VIEWS + 1);
    expect(engineViews).toBeGreaterThan(60);
    expect(calls.findIndex((c) => c.startsWith('publish ') && c.includes(fileOf(SET[2])))).toBeGreaterThan(calls.lastIndexOf(`view ${ENGINES[0]} version`));
});

shellIt('publishes nothing when a tarball of the set is missing', () => {
    const { status, stdout, publishCalls } = runPublishSet({ omit: SET[4] });
    expect(status).toBe(1);
    expect(publishCalls).toEqual([]);
    expect(stdout).toContain(`::error::Nothing was published`);
    expect(stdout).toContain(fileOf(SET[4]));
});

shellIt('publishes nothing when the registry check fails for any package of the set', () => {
    const { status, stdout, publishCalls } = runPublishSet({ env: { STUB_ERROR: SET[4] } });
    expect(status).toBe(1);
    expect(publishCalls).toEqual([]);
    expect(stdout).toContain(`::error::Nothing was published`);
});

shellIt('stops before every dependent when an engine is never served, and names what is out', () => {
    const { status, stdout, calls, publishCalls } = runPublishSet({ env: { STUB_LAG_SPEC: ENGINES[0], STUB_LAG: '100000' } });
    expect(status).toBe(1);
    expect(publishCalls).toEqual([ENGINES[0]]);
    expect(calls.filter((c) => c === `view ${ENGINES[0]} version`).length).toBe(1 + budget.attempts);
    expect(stdout).toContain(`::error::${ENGINES[0]}: was published but the registry still does not serve it after ${(budget.attempts * budget.intervalSeconds) / 60} minutes. Served before it: none. Not attempted: ${SET.slice(1).join(' ')}.`);
});

shellIt('stops at a failed publish without publishing the packages after it', () => {
    const { status, stdout, publishCalls } = runPublishSet({ env: { STUB_PUBLISH_FAIL: SET[2] } });
    expect(status).toBe(1);
    expect(publishCalls).toEqual(SET.slice(0, 3));
    expect(stdout).toContain(`::error::${SET[2]}: npm publish failed. Served before it: ${ENGINES.join(' ')}. Not attempted: ${SET.slice(3).join(' ')}.`);
});

shellIt('a re-run skips what the registry serves and finishes the set', () => {
    const { status, stdout, publishCalls } = runPublishSet({ served: SET.slice(0, 3) });
    expect(status).toBe(0);
    expect(publishCalls).toEqual(SET.slice(3));
    for (const spec of SET.slice(0, 3)) expect(stdout).toContain(`${spec} is already on the registry; skipping publish.`);
});
