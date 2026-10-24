#!/usr/bin/env node
// Real CLI + engine + reference-client version journey, in an owned Xvfb.
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY node <this-file> <new-evidence-dir>
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from './lab-safety.mjs';
import { recordSteps } from './step-record.mjs';

assertNoAmbientDesktop();
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(process.argv[2]);
assert(!existsSync(out), 'refusing to overwrite evidence');
mkdirSync(out, { recursive: true });
const cache = join(process.env.HOME, '.cache/fm-scratch/dl-show-versions');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'lab-'));
const execute = promisify(execFile);
const engine = resolve(process.env.DESKLINK_ENGINE ?? join(repo, 'packages/desktop-host/engine/target/debug/desklink-host'));
const fixture = resolve(process.env.DESKLINK_VERIFY_TARGET ?? join(repo, 'packages/desktop-host/engine/target/debug/examples/x11_target'));
const manifest = name => JSON.parse(readFileSync(join(repo, `packages/${name}/package.json`), 'utf8'));
const env = { ...process.env, WAYLAND_DISPLAY: '', TMPDIR: scratch,
    CHROME_DEVTOOLS_AXI_SESSION: `dl-versions-${process.pid}`, CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(scratch, 'profile'), CHROME_DEVTOOLS_AXI_HEADED: '0' };
delete env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
const chrome = async (...args) => (await execute('chrome-devtools-axi', args, { env, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout;
const children = [];
let bridge, xvfb, display, chromeStarted = false;
const wait = async (predicate, message) => {
    for (let i = 0; i < 300; i++) { if (await predicate()) return; await sleep(100); }
    throw Error(message);
};
try {
    for (const [name, command, args, expected] of [
        ['cli-version', process.execPath, ['packages/axi/bin/desklink-axi.js', '--version'], `desklink-axi: ${manifest('axi').version}`],
        ['cli-help', process.execPath, ['packages/axi/bin/desklink-axi.js', '--help'], `desklink-axi ${manifest('axi').version}:`],
        ['host-version', engine, ['--version'], manifest('desktop-host').version],
    ]) {
        const { stdout } = await execute(command, args, { cwd: repo, env });
        writeFileSync(join(out, `${name}.log`), stdout);
        assert(stdout.startsWith(expected), `${name}: expected ${expected}, got ${stdout}`);
    }
    display = claimPrivateDisplay();
    const authority = join(scratch, 'Xauthority');
    await execute('xauth', ['-f', authority, 'add', display.display, '.', '0123456789abcdef0123456789abcdef']);
    xvfb = spawn('Xvfb', [display.display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { env, stdio: 'ignore' });
    trackOwnedXvfb(xvfb, display.display);
    await wait(() => readFileSync(`/proc/${xvfb.pid}/stat`, 'utf8').split(') ')[1].startsWith('T '), 'Xvfb startup stop not reached');
    await verifyOwnedXvfb(xvfb); xvfb.kill('SIGCONT');
    const xenv = { ...env, DISPLAY: display.display, XAUTHORITY: authority };
    process.env.DISPLAY = display.display;
    process.env.XAUTHORITY = authority;
    process.env.WAYLAND_DISPLAY = '';
    const target = spawn(fixture, [], { env: xenv, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(target);
    let fixtureLog = '';
    for (const stream of [target.stdout, target.stderr]) stream.on('data', chunk => { fixtureLog += chunk; });
    target.on('exit', code => { if (code !== null) fixtureLog += `\nfixture exited ${code}`; });
    await wait(() => fixtureLog.includes('"ready"'), 'fixture did not become ready');
    chromeStarted = true;
    await chrome('start');
    const rows = [];
    for (const dev of [false, true]) {
        let module = pathToFileURL(join(repo, 'packages/desktop-host/dist/bridge.js')).href;
        const clientVersion = dev ? `${manifest('desktop-host').version}-dev` : manifest('desktop-host').version;
        if (dev) {
            // A real independently versioned client installation, not a patched DOM or engine reply.
            const install = join(scratch, 'host'); mkdirSync(install);
            for (const part of ['dist', 'examples']) cpSync(join(repo, 'packages/desktop-host', part), join(install, part), { recursive: true });
            writeFileSync(join(install, 'package.json'), JSON.stringify({ ...manifest('desktop-host'), version: clientVersion }));
            symlinkSync(join(repo, 'node_modules'), join(install, 'node_modules'));
            module = pathToFileURL(join(install, 'dist/bridge.js')).href;
        }
        const { Bridge } = await import(module);
        bridge = await Bridge.start({ engineCommand: engine, engineArgs: ['serve'], token: 'private-version-lab',
            listen: '127.0.0.1:0', source: { kind: 'x11', display: display.display } });
        // EngineClient inherits the process environment; only this owned display is ever exposed.
        await chrome('open', `http://127.0.0.1:${bridge.port}/?token=private-version-lab`);
        await wait(async () => (await chrome('eval', 'Boolean(document.querySelector("#video")?.videoWidth && document.querySelector("#video").readyState >= 2)')).includes('true'), 'live desktop picture did not arrive');
        const expected = `Client ${clientVersion} · Host ${manifest('desktop-host').version}${dev ? ' · Version mismatch' : ''}`;
        for (const [width, height] of dev ? [[390, 844]] : [[1340, 860], [390, 844]]) {
            await chrome('resize', String(width), String(height));
            const label = await chrome('eval', 'document.querySelector("#versions").textContent');
            assert(label.includes(expected), `wrong footer: ${label}`);
            // Wait for the same real presentation callback in both installations, not a sleep.
            const presentation = await chrome('eval', `async () => {
                const video = document.querySelector('#video');
                const frame = await new Promise(resolve => video.requestVideoFrameCallback((_now, metadata) => resolve(metadata)));
                return { frames: frame.presentedFrames, width: frame.width, height: frame.height,
                    hidden: document.hidden, rect: video.getBoundingClientRect().toJSON(), display: getComputedStyle(video).display };
            }`);
            writeFileSync(join(out, `${dev ? 'dev-mismatch' : 'matching'}-${width}-presentation.log`), presentation);
            await wait(async () => (await chrome('eval', `async () => {
                const video = document.querySelector('#video');
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
                const lit = context.getImageData(0, 0, 1, 1).data.slice(0, 3).some(value => value > 60);
                await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
                return lit;
            }`)).includes('true'), 'decoded fixture pixels are not visible');
            const file = `${dev ? 'dev-mismatch' : 'matching'}-${width}.png`;
            await chrome('screenshot', join(out, file));
            rows.push({ file, expected });
        }
        await bridge.close(); bridge = null;
    }
    writeFileSync(join(out, 'versions.json'), JSON.stringify(rows, null, 2));
    recordSteps(out, { start: 'an owned private Xvfb desktop with the real fixture app',
        steps: ['Run desklink-axi --version and --help, and desklink-host --version; read manifest-backed running versions.',
            'Open the reference client and see the live desktop picture with matching Client and Host versions at desktop and phone widths.',
            'Open an independently versioned dev client installation and see its -dev suffix and Version mismatch hint beside the real host version.'],
        result: 'The CLI help and version output identify the running build. The live browser client footer shows Client and Host versions, preserving dev suffixes and warning on a mismatch.' });
    console.log('PASS: CLI, host and live client versions, including dev mismatch');
} finally {
    if (chromeStarted) await chrome('stop');
    if (bridge) await bridge.close();
    for (const child of children) { child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); }
    if (xvfb) await stopOwnedXvfb(xvfb);
    display?.release();
    rmSync(scratch, { recursive: true, force: true });
}
