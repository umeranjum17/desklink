// Clean-tree smoke (build-plan item 1): rebuild @desklink/host and
// @desklink/axi from scratch — no stale dist — then run `batch` and `click`
// against a task-owned private Xvfb. Effect-level proof lives in flow.mjs;
// this only proves the freshly built dist serves the two core commands.
// Usage: DESKLINK_AXI_ENGINE=/path/to/desklink-host node test/smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();

const axiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(axiRoot, '../..');
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to the task-built engine');

// 1. Clean tree: no dist, no tsbuildinfo survives.
for (const dir of [join(axiRoot, 'dist'), join(repoRoot, 'packages/desktop-host/dist')]) rmSync(dir, { recursive: true, force: true });
for (const root of [axiRoot, join(repoRoot, 'packages/desktop-host'), repoRoot]) {
  for (const name of readdirSync(root)) if (name.endsWith('.tsbuildinfo')) rmSync(join(root, name), { force: true });
}

// 2. Build host first, then axi — the workspace build order axi's own build
// script now chains, so a bare `npm run build --workspace @desklink/axi`
// can never compile against stale host types again.
for (const [workspace, script] of [['@desklink/host', 'build'], ['@desklink/axi', 'build']]) {
  const build = spawnSync('npm', ['run', script, `--workspace=${workspace}`], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, `${workspace} build failed: ${build.stdout}\n${build.stderr}`);
}
assert(existsSync(join(axiRoot, 'dist/index.js')), 'axi dist was not produced by the clean build');

// 3. Task-owned private Xvfb on a verified high display.
const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-smoke-'));
const number = Array.from({ length: 30 }, (_, i) => 170 + i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir, 'Xauthority');
assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' }).status, 0, 'xauth failed');
const xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
trackOwnedXvfb(xvfb, display);

const owned = new Map(); // PID -> /proc start time; never signal a reused PID.
const sessionName = `smoke-${process.pid}-${randomBytes(16).toString('hex')}`;
const marker = `DESKLINK_AXI_SESSION=${sessionName}`;
const pidFile = join(dir, 'bridges.pid');
const enginePidFile = join(dir, 'engines.pid');
const env = { ...process.env, DISPLAY: display, XAUTHORITY: authority, DESKLINK_AXI_SESSION: sessionName, DESKLINK_AXI_ENGINE: enginePath, DESKLINK_AXI_PID_FILE: pidFile, DESKLINK_AXI_ENGINE_PID_FILE: enginePidFile };

function proc(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { state: fields[0], started: fields[19] };
  } catch { return undefined; }
}
function remember(pid, needle) {
  assert(Number.isSafeInteger(pid) && pid > 1, `invalid recorded PID: ${pid}`);
  if (owned.has(pid)) return;
  const state = proc(pid);
  if (!state || state.state === 'Z') { owned.set(pid, undefined); return; }
  assert(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').includes(needle), `unexpected child ${pid}`);
  owned.set(pid, state.started);
}
function childrenOf(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}
async function goneOwned(pid) {
  const started = owned.get(pid);
  for (let i = 0; i < 40 && proc(pid)?.started === started && proc(pid)?.state !== 'Z'; i++) await new Promise(r => setTimeout(r, 50));
  assert(!started || proc(pid)?.started !== started || proc(pid)?.state === 'Z', `task process ${pid} survived stop`);
}
async function stopProcess(pid) {
  const started = owned.get(pid);
  if (!started) return;
  const alive = () => { const state = proc(pid); return state?.started === started && state.state !== 'Z'; };
  if (!alive()) return;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (alive()) throw error; }
  for (let i = 0; i < 40 && alive(); i++) await new Promise(r => setTimeout(r, 25));
  assert(!alive(), `task-owned process ${pid} survived cleanup`);
}
async function stopXvfb() { await stopOwnedXvfb(xvfb); }
// Detect unrecorded session members without adopting them for cleanup.
function sessionStrays() {
  const strays = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || owned.has(pid) || pid === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(marker)) continue;
      strays.push({ pid, cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') });
    } catch { /* vanished or not readable */ }
  }
  return strays;
}

const cli = resolve(axiRoot, 'bin/desklink-axi.js');
async function run(...args) {
  const child = spawn(process.execPath, [cli, ...args], { env });
  let out = ''; for await (const part of child.stdout) out += part;
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, `${args.join(' ')}: ${out}`);
  return out;
}

try {
  for (let i = 0; i < 100 && !existsSync(socket) && xvfb.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert(xvfb.pid && xvfb.exitCode === null && existsSync(socket), 'private Xvfb did not start');
  await verifyOwnedXvfb(xvfb);
  remember(xvfb.pid, 'Xvfb');

  assert.match(await run('start', '--control', '--source', 'x11', '--display', display), /permissions=view,control/);
  if (existsSync(pidFile)) for (const pid of readFileSync(pidFile, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) remember(pid, '--bridge');
  if (existsSync(enginePidFile)) for (const pid of readFileSync(enginePidFile, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) remember(pid, enginePath);
  const batched = await run('batch', JSON.stringify([['press', 'a'], ['type', 'smoke-batch'], ['wait', '50']]));
  assert.match(batched, /batch: 3\/3 steps/);
  assert.match(batched, /1: input: applied/);
  assert.match(await run('click', '100,100'), /input: applied/);
  // The engine spawns agent-overlay children; remember them before the
  // engine is stopped, they can outlive it.
  const overlays = new Set();
  for (const pid of [...owned.keys()]) for (const child of childrenOf(pid)) {
    try {
      const cmdline = readFileSync(`/proc/${child}/cmdline`,'utf8').replaceAll('\0',' ');
      if (cmdline.includes(enginePath) && cmdline.includes('agent-overlay')) {
        remember(child, enginePath);
        overlays.add(child);
      }
    } catch { /* Already exited. */ }
  }
  await run('stop');
  for (const pid of overlays) await stopProcess(pid);
  for (const pid of [...owned.keys()]) if (pid !== xvfb.pid) await goneOwned(pid);
  assert.equal(sessionStrays().length, 0, `stray session members: ${JSON.stringify(sessionStrays())}`);
  await stopXvfb();
  assert(!existsSync(socket) && !existsSync(`/tmp/.X${number}-lock`), 'private Xvfb socket survived');
  rmSync(dir, { recursive: true, force: true });
  console.log(`smoke: clean host+axi build; batch and click applied on private Xvfb :${number}; no survivors`);
} finally {
  for (const pid of [...owned.keys()]) { try { await stopProcess(pid); } catch { /* reported by the try block */ } }
  await stopOwnedXvfb(xvfb);
}
