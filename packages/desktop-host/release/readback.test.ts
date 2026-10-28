import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseDir = dirname(fileURLToPath(import.meta.url));
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

shellIt('stops before every dependent when an engine is never served, and names what is out', () => {
    const { status, stdout, calls, publishCalls } = runPublishSet({ env: { STUB_LAG_SPEC: ENGINES[0], STUB_LAG: '100000' } });
    expect(status).toBe(1);
    expect(publishCalls).toEqual([ENGINES[0]]);
    expect(calls.filter((c) => c === `view ${ENGINES[0]} version`).length).toBe(1 + budget.attempts);
    expect(stdout).toContain(`::error::${ENGINES[0]}: was published but the registry still does not serve it after ${(budget.attempts * budget.intervalSeconds) / 60} minutes. Served before it: none. Not attempted: ${SET.slice(1).join(' ')}.`);
});
