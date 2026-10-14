#!/usr/bin/env node
/**
 * Fail the release workflow when the publishable packages disagree on version.
 *
 * @desklink/host, @desklink/react-native (packages/desktop-client) and
 * @desklink/axi ship as one release: release/pack.mjs packs the host against
 * the engine it pins, and release/publish.mjs refuses a tarball set whose
 * versions differ. This makes that same invariant a workflow gate, so a
 * half-bump fails on the branch instead of at publish time.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifests = [
    join(root, 'packages', 'desktop-host', 'package.json'),
    join(root, 'packages', 'desktop-client', 'package.json'),
    join(root, 'packages', 'axi', 'package.json'),
].map((path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return { name: manifest.name, version: manifest.version, hostPin: manifest.dependencies?.['@desklink/host'] };
});
const [first] = manifests;
let failed = false;
for (const entry of manifests.slice(1)) {
    if (entry.version !== first.version) {
        console.error(`::error::${entry.name} is ${entry.version}, but ${first.name} is ${first.version}. Bump @desklink/host, @desklink/react-native and @desklink/axi to one version before releasing, then re-run.`);
        failed = true;
    }
}
const axi = manifests.find((entry) => entry.name === '@desklink/axi');
if (axi.hostPin !== undefined && axi.hostPin !== first.version) {
    console.error(`::error::@desklink/axi pins @desklink/host@${axi.hostPin}, but @desklink/host is ${first.version}. Update the pin to the release version, then re-run.`);
    failed = true;
}
if (failed) process.exitCode = 1;
else console.log(`Version lockstep: @desklink/host, @desklink/react-native and @desklink/axi are all ${first.version}.`);
