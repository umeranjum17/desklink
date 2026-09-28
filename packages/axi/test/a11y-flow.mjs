// Linux accessibility + marks integration proof for desklink-axi.
// All capture and input is confined to a task-owned private Xvfb, private
// session bus, and private AT-SPI bus (task-owned XDG_RUNTIME_DIR) so the
// user's live desktop is never touched. Gracefully skips when the a11y
// prerequisites are absent (e.g. CI without dbus/at-spi/gtk).
//
// Usage: node packages/axi/test/a11y-flow.mjs [--measure N]
// Requires DESKLINK_AXI_ENGINE pointing at a built desklink-host binary.

import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const measureRuns = (() => {
  const index = process.argv.indexOf('--measure');
  return index >= 0 ? Number(process.argv[index + 1]) : 0;
})();

const which = (name) => spawnSync('which', [name], { encoding: 'utf8' }).status === 0;
const haveGtk3 = spawnSync('python3', ['-c', 'import gi;gi.require_version("Gtk","3.0");from gi.repository import Gtk'], { encoding: 'utf8' }).status === 0;
const firstPath = (paths) => paths.find(path => existsSync(path));

const prerequisites = process.platform === 'linux' && [which('busctl'), which('dbus-daemon'), which('Xvfb'), which('xauth'), which('tesseract'), haveGtk3].every(Boolean)
  && firstPath(['/usr/share/defaults/at-spi2/accessibility.conf', '/usr/share/at-spi2/accessibility.conf', '/etc/at-spi2/accessibility.conf']) !== undefined
  && firstPath(['/usr/lib/at-spi2-registryd', '/usr/libexec/at-spi2-registryd']) !== undefined;
if (!prerequisites) {
  console.log('skipped: a11y fixture prerequisites missing (needs busctl, dbus-daemon, Xvfb, xauth, tesseract, python3-gi with Gtk 3, at-spi2-core)');
  process.exit(0);
}
const a11yConf = firstPath(['/usr/share/defaults/at-spi2/accessibility.conf', '/usr/share/at-spi2/accessibility.conf', '/etc/at-spi2/accessibility.conf']);
const registrydBin = firstPath(['/usr/lib/at-spi2-registryd', '/usr/libexec/at-spi2-registryd']);

const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-a11y-'));
for (const leaf of ['xdg', 'home', 'cache']) mkdirSync(join(dir, leaf), { recursive: true });

const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to this task’s built engine');
assert(existsSync(resolve('packages/axi/bin/desklink-axi.js')), 'run from the repository root');

const number = Array.from({ length: 29 }, (_, i) => 171 + i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir, 'Xauthority');
assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' }).status, 0);

const xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
let xvfbError = '';
xvfb.stderr.on('data', part => xvfbError += part);

function proc(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { state: fields[0], started: fields[19] };
  } catch { return undefined; }
}
const owned = new Map(); // PID -> /proc start time; never signal a reused PID.
function remember(pid, command) {
  assert(Number.isSafeInteger(pid) && pid > 1, `invalid recorded PID: ${pid}`);
  if (owned.has(pid)) return;
  const state = proc(pid);
  if (!state || state.state === 'Z') { owned.set(pid, undefined); return; }
  assert(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').includes(command), `unexpected child ${pid}`);
  owned.set(pid, state.started);
}
function childrenOf(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
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
// SIGTERM lets Xvfb remove its own lock and socket; SIGKILL only as fallback.
async function stopXvfb() {
  const started = owned.get(xvfb.pid);
  if (!started) return;
  const alive = () => { const state = proc(xvfb.pid); return state?.started === started && state.state !== 'Z'; };
  if (alive()) {
    try { process.kill(xvfb.pid, 'SIGTERM'); } catch { /* fallback below */ }
    for (let i = 0; i < 40 && alive(); i++) await new Promise(r => setTimeout(r, 25));
  }
  if (alive()) await stopProcess(xvfb.pid);
  try { unlinkSync(`/tmp/.X${number}-lock`); } catch { /* removed by Xvfb */ }
  try { unlinkSync(socket); } catch { /* removed by Xvfb */ }
}
function daemonFromPrinted(text, token) {
  const lines = text.trim().split('\n').filter(Boolean);
  const address = lines[0].split(',')[0]; // unix:path=..., strips the guid
  const pid = Number(lines[1]);
  assert(Number.isSafeInteger(pid) && pid > 1, `could not parse daemon pid from ${JSON.stringify(text)}`);
  assert(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').includes(token), `pid ${pid} is not ${token}`);
  return { address, pid };
}
function spawnDaemon(args, token, extraEnv = {}) {
  const child = spawn('dbus-daemon', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...cageEnv, ...extraEnv } });
  let out = '';
  child.stdout.on('data', part => out += part);
  child.stderr.on('data', part => out += part);
  return new Promise((resolveDaemon, rejectDaemon) => {
    child.on('exit', code => code === 0 ? resolveDaemon(daemonFromPrinted(out, token)) : rejectDaemon(new Error(`${token} exited ${code}: ${out.slice(0, 300)}`)));
  });
}

// Task-owned runtime dirs keep dconf/portals away from the user's session.
const cageEnv = {
  ...process.env,
  DISPLAY: display, XAUTHORITY: authority,
  XDG_RUNTIME_DIR: join(dir, 'xdg'), XDG_CONFIG_HOME: join(dir, 'home', '.config'),
  XDG_DATA_HOME: join(dir, 'home', '.local', 'share'), XDG_CACHE_HOME: join(dir, 'cache'),
  HOME: join(dir, 'home'), GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '0',
  DESKLINK_AXI_SESSION: `a11y-${process.pid}`, DESKLINK_AXI_ENGINE: enginePath,
  DESKLINK_AXI_PID_FILE: join(dir, 'bridges.pid'), DESKLINK_AXI_ENGINE_PID_FILE: join(dir, 'engines.pid'),
};

const observations = [];
const cli = resolve('packages/axi/bin/desklink-axi.js');
let fixture, qtFixture, registryd, a11yBusAddress = '';
const fixtureLines = [];
let fixtureBuffer = '';
// Wait until `count` lines contain the needle; returns the newest match.
async function waitForFixtureLine(needle, count = 1, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    const matches = fixtureLines.filter(line => line.includes(needle));
    if (matches.length >= count) return matches.at(-1);
    if (fixture?.exitCode !== null && fixture?.exitCode !== undefined) break;
    await sleep(25);
  }
  throw new Error(`fixture line ${JSON.stringify(needle)} x${count} not seen; got: ${fixtureLines.slice(-8).join(' | ')}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run(...args) {
  const started = performance.now();
  const child = spawn(process.execPath, [cli, ...args], { env: cageEnv });
  let out = '';
  for await (const part of child.stdout) out += part;
  let err = '';
  for await (const part of child.stderr) err += part;
  const code = await new Promise(r => child.on('exit', r));
  const ms = Math.round(performance.now() - started);
  return { code, out, err, ms, args };
}
async function runOk(...args) {
  const result = await run(...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.out}${result.err}`);
  return result;
}
// Semantic step with bounded retry: stale refs are re-queried once, counted.
let retries = 0;
async function runStep(kind, ...args) {
  let result = await run(...args);
  if (result.code !== 0 && /stale-ref|ambiguous|not-found/.test(result.out)) {
    retries++;
    result = await run(...args);
  }
  return { kind, ...result };
}

const pctl = (samples) => (p) => {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] ?? NaN;
};

async function verifyXvfb() {
  for (let i = 0; i < 100 && !existsSync(socket) && xvfb.exitCode === null; i++) await sleep(50);
  assert(xvfb.pid && xvfb.exitCode === null && existsSync(socket), `private Xvfb did not start (exit ${xvfb.exitCode}): ${xvfbError.slice(-300)}`);
  assert.equal(Number(readFileSync(`/tmp/.X${number}-lock`, 'utf8').trim()), xvfb.pid, 'X lock belongs to another server');
  const line = readFileSync('/proc/net/unix', 'utf8').split('\n').find(line => line.endsWith(` ${socket}`));
  assert(line, 'X socket missing from proc socket table');
  const inode = line.trim().split(/\s+/)[6];
  assert(readdirSync(`/proc/${xvfb.pid}/fd`).some(fd => {
    try { return readlinkSync(`/proc/${xvfb.pid}/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
  }), 'X server socket is not held by the spawned Xvfb PID');
}

let cleanupDone = false;
async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (fixture) { fixture.kill('SIGTERM'); }
  if (qtFixture) { qtFixture.kill('SIGTERM'); }
  // Stop the CLI session by its socket command so the bridge exits cleanly.
  await run('stop').catch(() => {});
  const failures = [];
  if (existsSync(join(dir, 'bridges.pid'))) for (const pid of readFileSync(join(dir, 'bridges.pid'), 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
    try { remember(pid, '--bridge'); } catch (error) { failures.push(error); }
  }
  if (existsSync(join(dir, 'engines.pid'))) for (const pid of readFileSync(join(dir, 'engines.pid'), 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
    try { remember(pid, enginePath); } catch (error) { failures.push(error); }
  }
  for (const pid of [process.pid]) for (const child of childrenOf(pid)) {
    try {
      const cmd = readFileSync(`/proc/${child}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (cmd.includes(enginePath) && (cmd.includes('serve') || cmd.includes('agent-overlay'))) remember(child, enginePath);
    } catch { /* exited */ }
  }
  if (registryd) try { remember(registryd.pid, 'at-spi2-registryd'); } catch (error) { failures.push(error); }
  for (const pid of owned.keys()) if (pid !== xvfb.pid) {
    try { await stopProcess(pid); } catch (error) { failures.push(error); }
  }
  await stopXvfb().catch(error => failures.push(error));
  if (a11yBusAddress.startsWith('unix:path=')) { try { unlinkSync(a11yBusAddress.slice('unix:path='.length)); } catch { /* reaped with the daemon */ } }
  assert([...owned].every(([pid, started]) => !started || proc(pid)?.started !== started || proc(pid)?.state === 'Z'), 'a task-owned child survived');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* /tmp dbus socket already unlinked above */ }
  if (failures.length) throw new AggregateError(failures, 'cleanup failures');
}
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => {
  void cleanup().then(() => process.exit(code), error => { console.error(error); process.exit(1); });
});

// --- cage up ---
try {
  remember(xvfb.pid, 'Xvfb');
  await verifyXvfb();
  // Explicit fd 1: Debian's dbus-daemon rejects the bare flag forms.
  const session = await spawnDaemon(['--session', '--fork', '--print-address=1', '--print-pid=1'], 'dbus-daemon');
  remember(session.pid, 'dbus-daemon');
  cageEnv.DBUS_SESSION_BUS_ADDRESS = session.address;
  const a11y = await spawnDaemon(['--config-file', a11yConf, '--fork', '--print-address=1', '--print-pid=1'], 'dbus-daemon');
  remember(a11y.pid, 'dbus-daemon');
  a11yBusAddress = a11y.address;
  cageEnv.AT_SPI_BUS_ADDRESS = a11yBusAddress;
  registryd = spawn(registrydBin, ['--use-gnome-session'], { env: { ...cageEnv, DBUS_SESSION_BUS_ADDRESS: a11yBusAddress }, stdio: ['ignore', 'pipe', 'pipe'] });
  remember(registryd.pid, 'at-spi2-registryd');
  await sleep(700);
  assert(registryd.exitCode === null, 'at-spi2-registryd died at startup');

  fixture = spawn('python3', ['-u', resolve('packages/axi/test/fixtures/gtk_bench.py')], { env: cageEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  remember(fixture.pid, 'gtk_bench.py');
  fixture.stdout.on('data', part => { fixtureBuffer += part; for (const line of fixtureBuffer.split('\n').slice(0, -1)) fixtureLines.push(line); fixtureBuffer = fixtureBuffer.split('\n').at(-1) ?? ''; });
  let fixtureErr = '';
  fixture.stderr.on('data', part => { fixtureErr += part; });
  await new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      if (fixtureLines.includes('ready')) { clearInterval(poll); resolveReady(); }
      else if (Date.now() > deadline || fixture.exitCode !== null) { clearInterval(poll); rejectReady(new Error(`gtk fixture did not start: ${fixtureErr.slice(-300)}`)); }
    }, 25);
  });

  const started = await runOk('start', '--control', '--source', 'x11', '--display', display);
  assert.match(started.out, /permissions=view,control/);

  // --- item 3: the accessibility tree over semantic refs ---
  const tree1 = await runOk('tree', '--full');
  assert.match(tree1.out, /ax\[\d+ of \d+\]\{ref,role,name,value,x,y,w,h,states\}:/);
  const row = (out, name) => new RegExp(`\\s+"?(@a\\d+\\.\\d+)"?,[^,]+,"${name}"`).exec(out)?.[1];
  const refOf = (out, name) => row(out, name);
  const saveRef = refOf(tree1.out, 'Save button');
  const nameRef = refOf(tree1.out, 'Name field');
  const agreeRef = refOf(tree1.out, 'Agree');
  const chooseRef = refOf(tree1.out, 'Choose button');
  const growRef = refOf(tree1.out, 'Grow button');
  const frameRef = refOf(tree1.out, 'AXI A11y Bench');
  assert(saveRef && nameRef && agreeRef && chooseRef && growRef && frameRef, `tree rows incomplete:\n${tree1.out}`);
  // Icon-only button: a button row with an empty name must exist (OCR cannot name it).
  const iconRef = /  "?(@a\d+\.\d+)","(?:push )?button","",/.exec(tree1.out)?.[1];
  assert(iconRef, `icon-only button missing from tree:\n${tree1.out}`);

  // Coordinate and OCR fallbacks still exist next to the semantic path.
  const coords = await runOk('click', '10,10');
  assert.match(coords.out, /^input: applied/);

  // Type through an AT-SPI focus; the entry content change is reported by the
  // fixture over stdout (independent of pixels or AXI's own read-back).
  const typed = await runOk('type', 'AXI a11y', '--into', nameRef);
  assert.match(typed.out, /input: applied \(atspi focus\)/, typed.out);
  assert.equal(await waitForFixtureLine('typed AXI a11y'), 'typed AXI a11y');

  // Click through a semantic ref: DoAction, verified by the fixture.
  const clicked = await runOk('click', saveRef);
  assert.match(clicked.out, /input: applied \(atspi action "Click"\)/, clicked.out);
  assert.equal(await waitForFixtureLine('saved AXI a11y'), 'saved AXI a11y agree=false');

  // Read-back through the tree agrees with the fixture's own report.
  const tree2 = await runOk('tree', '--query', 'Name field');
  assert.match(tree2.out, /"AXI a11y"/, `entry value not in tree read-back:\n${tree2.out}`);
  // Focus check: the entry reports the focused state after AT-SPI focus.
  const statusRef = row(tree1.out, 'Status');
  const treeStatus = await runOk('tree', '--query', 'Status');
  assert.match(treeStatus.out, /"Saved AXI a11y"/, 'status label not updated');
  const treeFocus = await runOk('tree', '--query', 'Name field');
  assert.match(treeFocus.out, /focused/, `entry does not report focus:\n${treeFocus.out}`);

  const checked = await runOk('click', agreeRef);
  assert.match(checked.out, /atspi action/);
  await runOk('click', saveRef);
  assert.equal(await waitForFixtureLine('saved AXI a11y'), 'saved AXI a11y agree=true');

  // Actionability: the Status label has no AT-SPI action → coordinate fallback.
  assert(statusRef, 'status label missing from tree');
  const fallback = await runOk('click', statusRef);
  assert.match(fallback.out, /input: applied \(coordinate fallback/);

  // A GTK file dialog driven entirely through semantic refs.
  await runOk('click', chooseRef);
  assert.equal(await waitForFixtureLine('dialog open'), 'dialog open');
  const treeDialog = await runOk('tree', '--full');
  const exportRef = refOf(treeDialog.out, 'Export');
  const dialogEntryRef = /  "?(@a\d+\.\d+)","text","[^"]*","bench-export\.txt"/.exec(treeDialog.out)?.[1];
  assert(exportRef, `dialog Export button missing:\n${treeDialog.out}`);
  assert(dialogEntryRef, `dialog filename entry missing:\n${treeDialog.out}`);
  const exportPath = join(dir, 'exported.txt');
  await runOk('type', 'x', '--into', dialogEntryRef);
  const dialogBatch = await runOk('batch', JSON.stringify([['press', 'ctrl+a'], ['type', exportPath], ['click', exportRef]]));
  assert.match(dialogBatch.out, /batch: 3\/3 steps/);
  assert.equal(await waitForFixtureLine('file chosen'), `file chosen ${exportPath}`);
  assert.equal(readFileSync(exportPath, 'utf8'), 'bench export\n', 'exported file content mismatch');
  assert.equal(await waitForFixtureLine('dialog closed'), 'dialog closed');
  // The dialog is gone: its refs must now be stale, not silently clickable.
  const staleDialog = await run('click', exportRef);
  assert.equal(staleDialog.code, 1);
  assert.match(staleDialog.out, /error: stale-ref/);

  // Geometry staleness: after the window grows, old refs are rejected.
  const treeBeforeGrow = await runOk('tree', '--full');
  const saveBeforeGrow = refOf(treeBeforeGrow.out, 'Save button');
  await runOk('click', growRef);
  await waitForFixtureLine('resized ', 1);
  const staleAfterGrow = await run('click', saveBeforeGrow);
  assert.equal(staleAfterGrow.code, 1);
  assert.match(staleAfterGrow.out, /error: stale-ref/);

  // --- item 4: numbered marks over a crop ---
  const marksPath = join(dir, 'marks.png');
  const marks = await runOk('marks', '--out', marksPath);
  assert.match(marks.out, /marks: \d+ candidates region=0,0,1280,720 dimensions=1280x720 cost: ~\d+ tokens frame=\d+/);
  assert.match(marks.out, /image: .+/);
  const marksImage = /image: (.+)/.exec(marks.out)?.[1];
  let marksBytes = Buffer.alloc(0);
  try { marksBytes = readFileSync(marksImage); } catch { /* asserted below */ }
  assert(marksBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `marks artifact is not a PNG (${JSON.stringify(marksImage)}): ${JSON.stringify(marksBytes.subarray(0, 16))}\n${marks.out}`);
  assert.match(marks.out, /marks\[\d+\]\{mark,ref,label,role\}:/);
  // The icon-only button: chosen through the marks map, not by pixels. Its AX
  // name is empty so its mark label falls back to the action name "Click".
  const iconMarkRef = /^\s+\d+,"(@a\d+\.\d+)","Click","(?:push )?button"$/m.exec(marks.out)?.[1];
  assert(iconMarkRef, `icon-only button not marked:\n${marks.out}`);
  // OCR-blindness: no text AXI can read falls inside the icon button's box.
  const treeMarks = await runOk('tree', '--full');
  const iconBox = /  "?(@a\d+\.\d+)","(?:push )?button","","",(\d+),(\d+),(\d+),(\d+)/.exec(treeMarks.out);
  assert(iconBox, `icon button box missing from tree:\n${treeMarks.out}`);
  const screenFull = await runOk('screen', '--full');
  const inside = [...screenFull.out.matchAll(/^\s+"@\d+\.\d+",.*?,(\d+),(\d+)$/gm)]
    .map(m => [Number(m[1]), Number(m[2])])
    .filter(([x, y]) => x >= Number(iconBox[2]) && x <= Number(iconBox[2]) + Number(iconBox[4]) && y >= Number(iconBox[3]) && y <= Number(iconBox[3]) + Number(iconBox[5]));
  assert.equal(inside.length, 0, `OCR text overlaps the icon-only button: ${JSON.stringify(inside)}`);
  await runOk('click', iconMarkRef);
  assert.equal(await waitForFixtureLine('icon pressed'), 'icon pressed');

  // Stale marks: after geometry changes, the marked ref is rejected.
  const treeForGrow = await runOk('tree', '--query', 'Grow button');
  const growRef2 = refOf(treeForGrow.out, 'Grow button');
  assert(growRef2, 'fresh Grow ref missing');
  await runOk('click', growRef2);
  await waitForFixtureLine('resized ', 2);
  const staleMark = await run('click', iconMarkRef);
  assert.equal(staleMark.code, 1);
  assert.match(staleMark.out, /error: stale-ref/);

  // --- Qt exposure (measured fact, soft check) ---
  await reportQtExposure();

  // --- measurement: p50/p95 wall time and retry count over N warm runs ---
  if (measureRuns > 0) {
    const samples = { tree: [], type: [], click: [], marks: [], total: [] };
    for (let i = 0; i < measureRuns; i++) {
      const label = `AXI_m${i}`;
      const iterationStart = performance.now();
      const t = await runStep('tree', 'tree', '--full');
      assert.equal(t.code, 0, `tree failed: ${t.out}`);
      const ref = refOf(t.out, 'Name field');
      const save = refOf(t.out, 'Save button');
      assert(ref && save, `measurement tree incomplete:\n${t.out}`);
      const ty = await runStep('type', 'type', label, '--into', ref);
      assert.equal(ty.code, 0, `type failed: ${ty.out}`);
      const cl = await runStep('click', 'click', save);
      assert.equal(cl.code, 0, `click failed: ${cl.out}`);
      const mk = await runStep('marks', 'marks', '--out', join(dir, `marks-${i}.png`));
      assert.equal(mk.code, 0, `marks failed: ${mk.out}`);
      assert((await waitForFixtureLine(`typed ${label}`, 1, 100)).includes(label));
      assert((await waitForFixtureLine(`saved ${label}`, 1, 100)).includes(label));
      samples.tree.push(t.ms); samples.type.push(ty.ms); samples.click.push(cl.ms); samples.marks.push(mk.ms);
      samples.total.push(Math.round(performance.now() - iterationStart));
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([kind, values]) =>
      [kind, { n: values.length, p50: pctl(values)(50), p95: pctl(values)(95) }]));
    summary.retries = retries;
    console.log(`measure: ${JSON.stringify(summary)}`);
    if (process.env.DESKLINK_AXI_MEASURE_PATH) writeFileSync(process.env.DESKLINK_AXI_MEASURE_PATH, JSON.stringify(observations.concat([{ measure: summary }])));
  }

  console.log('a11y: semantic tree refs drove form controls and a GTK file dialog with verified effects; marks chose an icon-only control; stale refs rejected');
} finally {
  await cleanup();
}

async function reportQtExposure() {
  const pkg = spawnSync('pkg-config', ['--exists', 'Qt6Widgets']);
  const compiler = which('g++');
  if (pkg.status !== 0 || !compiler) {
    console.log('qt: skipped (g++ or Qt6Widgets not available)');
    return;
  }
  const binary = join(dir, 'qt_bench');
  const build = spawnSync('g++', ['-fPIC', resolve('packages/axi/test/fixtures/qt_bench.cpp'), '-o', binary,
    ...spawnSync('pkg-config', ['--cflags', '--libs', 'Qt6Widgets'], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean)], { encoding: 'utf8', timeout: 120000 });
  if (build.status !== 0) { console.log(`qt: skipped (build failed: ${build.stderr.slice(-200)})`); return; }
  qtFixture = spawn(binary, [], { env: cageEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  remember(qtFixture.pid, 'qt_bench');
  let ready = false, out = '';
  qtFixture.stdout.on('data', part => { out += part; if (out.includes('ready')) ready = true; });
  for (let i = 0; i < 160 && !ready && qtFixture.exitCode === null; i++) await sleep(25);
  if (!ready) { console.log('qt: fixture did not start; exposure not measured'); return; }
  const qtTree = await run('tree', '--full');
  if (qtTree.code !== 0) { console.log(`qt: tree failed (${qtTree.out.trim().split('\n')[0]}); exposure not measured`); return; }
  const apps = /tree: (\d+) apps/.exec(qtTree.out)?.[1] ?? '0';
  const nodes = /(\d+) nodes/.exec(qtTree.out)?.[1] ?? '0';
  const named = ['Name field', 'Agree', 'Save button'].filter(name => new RegExp(`"?(@a\d+\.\d+)"?,[^,]+,"${name}"`).test(qtTree.out)).length;
  console.log(`qt: apps=${apps} nodes=${nodes} named form controls visible=${named}/3 (measured fact; Qt6 ${process.env.QT6_VERSION ?? ''})`.trim());
}
