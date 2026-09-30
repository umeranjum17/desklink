#!/usr/bin/env node
/**
 * Pack the host, platform engine, receiver and CLI tarballs. Publishes nothing.
 *
 * For engine builds, compilation prerequisites and release sequencing, see
 * ../README.md, "Building and packing a release".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { engine: { type: 'string' }, platform: { type: 'string' } } });
const platforms = {
    'linux-x64-gnu': {
        os: 'linux', cpu: 'x64', libc: 'glibc', tag: 'linux-x64-gnu',
        description: 'Linux x64 (glibc 2.36 or newer)',
        readme: 'At run time the engine loads libpipewire-0.3, libxkbcommon, libevdev, libXcursor, libX11, libwayland-client and libstdc++ from the system. libvpx and inputtino are linked into it; their licences are in the included notices.',
    },
    'darwin-arm64': {
        os: 'darwin', cpu: 'arm64', tag: 'darwin-arm64',
        description: 'macOS arm64',
        readme: 'This is an unsigned CLI binary. Screen Recording and Accessibility permissions belong to the responsible app that launches it (for example Terminal, iTerm, or a Node.js host), not to a DesklinkHost.app bundle. The macOS engine is enabled by default; DESKLINK_MACOS=0 opts out. libvpx is linked statically; notices are included.',
    },
};
const platformTagValue = values.platform ?? 'linux-x64-gnu';
const platform = platforms[platformTagValue];
if (platform === undefined) throw new Error(`unsupported platform package: ${platformTagValue}`);
const out = join(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot, encoding: 'utf8' }).trim(), 'dist-desklink');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
if (!values.engine) throw new Error('engine output missing: pass --engine <dir> from release/build-engine.sh');
const engine = resolve(values.engine);
const notices = ['THIRD_PARTY_LICENSES.txt', 'COPYRIGHT-rust-library.html'];
for (const file of ['desklink-host', ...notices, 'provenance.json']) {
    if (!existsSync(join(engine, file))) throw new Error(`engine output missing: ${join(engine, file)}`);
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const provenance = JSON.parse(readFileSync(join(engine, 'provenance.json'), 'utf8'));
if (provenance.target !== (platformTagValue === 'darwin-arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu')) {
    throw new Error(`${engine}/provenance.json targets ${provenance.target}, not ${platformTagValue}`);
}
if (provenance.sha256 !== sha256(join(engine, 'desklink-host'))) {
    throw new Error(`${engine}/desklink-host is not the executable its provenance.json describes`);
}
if (provenance.engine !== manifest.version) {
    throw new Error(`the engine is version ${provenance.engine}, but ${manifest.name} is ${manifest.version}`);
}
const compiled = join(packageRoot, 'dist', 'resolveEngine.js');
if (!existsSync(compiled)) throw new Error(`${manifest.name} is not compiled: run tsc --build first`);
const axiEntry = resolve(packageRoot, '..', 'axi', 'dist', 'index.js');
if (!existsSync(axiEntry)) throw new Error('@desklink/axi is not compiled: run npm run build first');
// The same tag the runtime resolver looks for, so the two cannot disagree.
const { platformTag } = await import(pathToFileURL(compiled).href);
if (platformTag(platform.os, platform.cpu, platform.libc !== undefined) !== platform.tag) {
    throw new Error(`runtime tag disagrees with release platform ${platform.tag}`);
}
const platformName = `${manifest.name}-${platform.tag}`;
const stage = join(out, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
// npm 10 reports a packed package in an array, npm 11 and later keyed by name.
const npmPack = (args, options) => {
    const report = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', ...args], { encoding: 'utf8', ...options }));
    return Array.isArray(report) ? report[0] : Object.values(report)[0];
};
function pack(directory) {
    const packed = npmPack([directory, '--pack-destination', out]);
    const tarball = join(out, packed.filename);
    process.stdout.write(`packed  ${tarball}  sha256 ${sha256(tarball)}\n`);
    return tarball;
}

// Add pins only in the release stage: unpublished optional dependencies would
// leave the workspace's frozen install without a complete locked inventory.
const hostStage = join(stage, 'host');
const listing = npmPack(['--dry-run'], { cwd: packageRoot });
for (const { path } of listing.files) {
    mkdirSync(dirname(join(hostStage, path)), { recursive: true });
    copyFileSync(join(packageRoot, path), join(hostStage, path));
}
writeJson(join(hostStage, 'package.json'), {
    ...manifest,
    optionalDependencies: { ...manifest.optionalDependencies, ...Object.fromEntries(Object.keys(platforms).map((tag) => [`${manifest.name}-${tag}`, manifest.version])) },
});
const platformStage = join(stage, 'platform');
mkdirSync(platformStage);
for (const file of ['desklink-host', ...notices, 'provenance.json']) {
    copyFileSync(join(engine, file), join(platformStage, file));
}
chmodSync(join(platformStage, 'desklink-host'), 0o755);
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(packageRoot, file), join(platformStage, file));
writeFileSync(join(platformStage, 'README.md'), `# ${platformName}

The prebuilt engine executable for [\`${manifest.name}\`](https://www.npmjs.com/package/${manifest.name})
on ${platform.description}. Install \`${manifest.name}\`, not this: it is selected and found automatically.

${platform.readme}

Licences for the engine's linked dependencies are in \`THIRD_PARTY_LICENSES.txt\`,
and the Rust standard library's in \`COPYRIGHT-rust-library.html\`.
\`provenance.json\` records the target and source commit.
`);
writeJson(join(platformStage, 'package.json'), {
    name: platformName,
    version: manifest.version,
    description: `Prebuilt ${manifest.name} engine for ${platform.description}`,
    license: manifest.license,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
    executable: 'desklink-host',
    files: ['desklink-host', ...notices, 'provenance.json', 'NOTICE'],
});
pack(platformStage);
pack(hostStage);
rmSync(stage, { recursive: true, force: true });

// Pack the receivers and CLI from the same release checkout.
for (const sibling of ['desktop-client', 'axi']) {
    pack(resolve(packageRoot, '..', sibling));
}
