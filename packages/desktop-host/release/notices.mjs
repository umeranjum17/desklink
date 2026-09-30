#!/usr/bin/env node
/**
 * The prebuilt engine's licence gate and its third-party notices.
 *
 * Reads `cargo metadata` and the crates' own sources, refuses any crate whose
 * licence cannot be satisfied by permissive licences alone, and prints every
 * licence text the executable carries: the crates it links, the Rust standard
 * library, and the two native libraries it links statically. Build-only crates
 * are gated too but not listed, because nothing of theirs ships.
 *
 *   node notices.mjs <inputs> > THIRD_PARTY_LICENSES.txt
 *
 * `<inputs>` is laid out by `linux-x64-gnu.Dockerfile`: cargo-metadata.json,
 * nv-codec-headers/, libva/,
 * libvpx/, inputtino/ and Apache-2.0.txt.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Permissive only. MPL, LGPL, GPL and every other copyleft licence fail.
const PERMITTED = new Set([
    '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC0-1.0', 'ISC',
    'MIT', 'MIT-0', 'Unicode-3.0', 'Unicode-DFS-2016', 'Unlicense', 'Zlib',
]);
const PERMITTED_EXCEPTIONS = new Set(['LLVM-exception']);
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|patents|unlicense)/i;

/** Whether an SPDX expression (or the older `A/B` form) is satisfiable by permissive licences. */
function permissive(expression) {
    const tokens = expression.replaceAll('/', ' OR ').match(/[()]|[^\s()]+/g) ?? [];
    let at = 0;
    const primary = () => {
        if (tokens[at] === '(') {
            at += 1;
            const value = anyOf();
            return tokens[at++] === ')' && value;
        }
        const id = tokens[at++];
        if (tokens[at] !== 'WITH') return PERMITTED.has(id);
        at += 1;
        return PERMITTED.has(id) && PERMITTED_EXCEPTIONS.has(tokens[at++]);
    };
    const allOf = () => {
        let value = primary();
        while (tokens[at] === 'AND') {
            at += 1;
            value = primary() && value;
        }
        return value;
    };
    const anyOf = () => {
        let value = allOf();
        while (tokens[at] === 'OR') {
            at += 1;
            value = allOf() || value;
        }
        return value;
    };
    return anyOf() && at === tokens.length;
}

function licenceTexts(directory) {
    return readdirSync(directory)
        .filter((name) => LICENCE_FILE.test(name))
        .sort()
        .flatMap((name) => {
            const path = join(directory, name);
            if (!statSync(path).isDirectory()) return [readFileSync(path, 'utf8').trim()];
            return readdirSync(path).sort().map((inner) => readFileSync(join(path, inner), 'utf8').trim());
        });
}

const inputs = process.argv[2];
if (inputs === undefined) throw new Error('usage: node notices.mjs <inputs>');
const metadata = JSON.parse(readFileSync(join(inputs, 'cargo-metadata.json'), 'utf8'));
const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));

/** Crates reachable from the engine through the given dependency kinds (`null` is a normal dependency). */
function reachable(kinds) {
    const seen = new Set();
    const pending = [metadata.resolve.root];
    while (pending.length > 0) {
        const id = pending.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const dep of nodes.get(id).deps) {
            if (dep.dep_kinds.some((kind) => kinds.includes(kind.kind))) pending.push(dep.pkg);
        }
    }
    seen.delete(metadata.resolve.root);
    return [...seen].map((id) => packages.get(id));
}

const refused = reachable([null, 'build']).filter((pkg) => typeof pkg.license !== 'string' || !permissive(pkg.license));
if (refused.length > 0) {
    for (const pkg of refused) process.stderr.write(`licence gate: ${pkg.name}@${pkg.version} is ${pkg.license ?? pkg.license_file ?? 'unlicensed'}\n`);
    process.exit(1);
}

const apache = readFileSync(join(inputs, 'Apache-2.0.txt'), 'utf8').trim();
const linked = reachable([null]).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, 'en', { numeric: true }));
// One entry per distinct text, so two hundred copies of the same licence print once.
const byText = new Map();
for (const pkg of linked) {
    let texts = licenceTexts(dirname(pkg.manifest_path));
    if (texts.length === 0) {
        // A crate that ships no licence file still carries its declared terms:
        // Apache-2.0 where that is an option, otherwise MIT in the authors' names.
        const options = pkg.license.replaceAll('/', ' OR ').split(/[\s()]+/);
        if (options.includes('Apache-2.0')) texts = [apache];
        else if (options.includes('MIT')) texts = [mitText(pkg.authors)];
        else if (options.includes('BSD-2-Clause')) texts = [bsd2Text(pkg.authors)];
        else throw new Error(`no licence text for ${pkg.name}@${pkg.version} (${pkg.license})`);
    }
    for (const text of texts) {
        const crates = byText.get(text) ?? [];
        crates.push(`${pkg.name} ${pkg.version}`);
        byText.set(text, crates);
    }
}

function mitText(authors) {
    const holders = authors.length > 0 ? authors.join(', ') : 'the authors';
    return `Copyright (c) ${holders}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}

function bsd2Text(authors) {
    const holders = authors.length > 0 ? authors.join(', ') : 'the authors';
    return `Copyright (c) ${holders}\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
}

const rule = (title) => `\n\n${title}\n${'='.repeat(title.length)}\n\n`;
let out = `Third-party notices for the desklink-host executable

The executable is licensed Apache-2.0. It links the components below into
itself; each keeps its own licence, reproduced here as that licence requires.
Libraries it loads from the system at run time (glibc, libstdc++, libpipewire,
libxkbcommon, libevdev, libXcursor, libX11, libXext, libwayland-client) are not part of it and are not reproduced.
Neither are the H.264 encoders it loads at run time only when present: the
NVIDIA driver's NVENC and CUDA libraries, libva with its driver, and Cisco's
prebuilt openh264 library, which the engine downloads from Cisco and never
ships (OpenH264 Video Codec provided by Cisco Systems, Inc.).`;
out += rule('libvpx (BSD-3-Clause), linked statically') + licenceTexts(join(inputs, 'libvpx')).join('\n\n');
out += rule('inputtino (MIT), vendored and linked statically') + licenceTexts(join(inputs, 'inputtino')).join('\n\n');
out += rule('NVENC API header from nv-codec-headers (MIT), vendored and compiled in') + licenceTexts(join(inputs, 'nv-codec-headers')).join('\n\n');
out += rule('libva public headers (MIT), vendored and compiled in') + licenceTexts(join(inputs, 'libva')).join('\n\n');
out += rule('The Rust standard library (MIT OR Apache-2.0), linked statically')
    + 'Its copyright and licence notices, and those of its own dependencies, are in\nCOPYRIGHT-rust-library.html beside this file, as the Rust project ships them.';
out += rule(`Rust crates (${linked.length})`) + linked.map((pkg) => `${pkg.name} ${pkg.version}  ${pkg.license}`).join('\n');
out += rule('Crate licence texts');
for (const [text, crates] of byText) out += `\n\n---- used by: ${crates.join(', ')}\n\n${text}`;
process.stdout.write(`${out}\n`);
