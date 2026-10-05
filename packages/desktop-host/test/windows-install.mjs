// Hosted Windows install proof: the published packages, packed the way
// release/pack.mjs packs them and installed the way release/check-install.sh
// installs them, into an empty project with nothing of this repository on the
// resolution path. It proves installation and engine startup on a hosted
// machine; capture, input, encoding quality and desktop access stay with the
// dedicated rig lanes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'run this proof on Windows');
const engine = process.env.DESKLINK_ENGINE;
assert.ok(engine, 'DESKLINK_ENGINE must name the compiled Windows engine');
assert.ok(existsSync(engine), `the compiled engine is missing: ${engine}`);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Windows engines are an opt-in preview, exactly as a consumer installs them.
process.env.DESKLINK_WINDOWS = '1';
// Every package release/pack.mjs publishes for a release, so this installs the
// set a consumer installs rather than a convenient subset.
const published = ['desktop-host', 'desktop-client', 'axi'];

// npm and the installed bin shims are .cmd files on Windows, which Node will
// not exec directly.
function cmd(line, cwd) {
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
        cwd, encoding: 'utf8', windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`${line} failed (${result.status ?? result.error?.message}): ${(result.stderr || result.stdout || '').trim().slice(-800)}`);
    return result.stdout;
}
// cmd quoting, not JSON: a doubled backslash inside quotes is a wrong path.
const quoted = (part) => (/[\s&()^|<>"]/.test(part) ? `"${part}"` : part);
function npm(args, cwd) {
    return cmd(['npm', ...args].map(quoted).join(' '), cwd);
}
// npm 10 reports a pack in an array, npm 11 and later keyed by name.
const first = (report) => (Array.isArray(report) ? report[0] : Object.values(report)[0]);
const packJson = (args, cwd) => first(JSON.parse(npm(['pack', '--json', '--ignore-scripts', ...args], cwd)));

function filesUnder(root) {
    const found = new Set();
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else found.add(relative(root, path).split(sep).join('/'));
        }
    };
    walk(root);
    return found;
}

const release = mkdtempSync(join(tmpdir(), 'desklink-release-'));
const project = mkdtempSync(join(tmpdir(), 'desklink-project-'));
try {
    const tarballs = published.map((name) => {
        const dir = join(repo, 'packages', name);
        const { name: spec, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        return { spec, version, file: join(release, packJson(['--pack-destination', release], dir).filename) };
    });
    // What would be published, so an install that silently lost a file shows here.
    const packed = packJson(['--dry-run'], join(repo, 'packages', 'desktop-host'));
    const expected = new Set(packed.files.map((file) => file.path));
    expected.add('dist/a-file-the-release-never-shipped.js'); // deliberate break: red-check only

    npm(['init', '-y'], project);
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.map((tarball) => tarball.file)], project);

    for (const { spec, version } of tarballs) {
        const installed = JSON.parse(readFileSync(join(project, 'node_modules', ...spec.split('/'), 'package.json'), 'utf8'));
        assert.equal(installed.name, spec);
        assert.equal(installed.version, version, `installed ${spec} is not the release version`);
    }
    // The pack manifest is what a user actually gets: same files, no more.
    const hostRoot = join(project, 'node_modules', '@desklink', 'host');
    const installed = filesUnder(hostRoot);
    assert.deepEqual({
        missing: [...expected].filter((path) => !installed.has(path)),
        extra: [...installed].filter((path) => !expected.has(path)),
    }, { missing: [], extra: [] }, 'the installed @desklink/host tree differs from its pack manifest');

    // From here the only @desklink/host in scope is the installed one.
    writeFileSync(join(project, 'consumer.mjs'), `import assert from 'node:assert/strict';
import { EngineClient, platformTag, resolveEngine } from '@desklink/host';

assert.equal(platformTag(), 'win32-x64-msvc');
const resolved = resolveEngine();
assert.equal(resolved?.origin, 'configured', 'the installed package resolved the engine: ' + JSON.stringify(resolved));
let exitDetail = null;
const client = await EngineClient.start(resolved.command, resolved.args, { onExit: (detail) => { exitDetail = detail; } });
const capabilities = await client.capabilities();
assert.equal(capabilities.platform, 'windows');
assert.equal(capabilities.protocol, 3);
assert.ok(capabilities.encode.codecs.includes('vp9'), 'the static-libvpx build serves VP9');
await client.request('shutdown', {}, 15_000).then(() => undefined, () => undefined);
const deadline = Date.now() + 5_000;
while (exitDetail === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
assert.deepEqual(exitDetail, { code: 0, signal: null });
await client.stop();
console.log(JSON.stringify({ resolved, capabilities }));
`);
    const startup = spawnSync(process.execPath, ['consumer.mjs'], {
        cwd: project, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(startup.status, 0, startup.stderr || startup.stdout);
    const shim = join(project, 'node_modules', '.bin', 'desklink-host.cmd');
    assert.ok(existsSync(shim), `the published bin shim is missing: ${shim}`);
    assert.equal(cmd(`${quoted(shim)} path`, project).trim(), engine);
    assert.match(cmd(`${quoted(shim)} version`, project), /^\d+\.\d+\.\d+/);
    console.log(`PASS: ${expected.size} packed files installed into an empty project, versions match, and the installed package started the engine.`);
    console.log(startup.stdout.trim());
} finally {
    rmSync(release, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
}
