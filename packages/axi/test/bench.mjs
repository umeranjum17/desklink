// Comparative bench (build-plan item 6, scoped to items 1/2/5): the report's
// form / two-tab / native-X11 fixtures run under both lanes — the browser lane
// (desklink-axi browser …) and the AXI desktop fallback (desklink-axi screen /
// click / type) — on one task-owned private Xvfb with a task-owned Chromium.
// Measures p50/p95 wall time over 3 warmup + >=20 measured runs per task,
// per-call retries, and a labeled text-token proxy (ceil(stdout chars/4) —
// NOT a real tokenizer). Native typing is AXI-only.
// Usage: DESKLINK_AXI_ENGINE=/path/to/desklink-host node test/bench.mjs [runs]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { assertNoAmbientDesktop, claimPrivateDisplay, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();

const axiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(axiRoot, '../..');
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to the task-built engine');
const RUNS = Math.max(20, Number(process.argv[2] ?? 20));
const WARMUP = 3;

// --- fixture (same shape as the benchmark report's local site) ---
const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-bench-'));
const fixture = join(dir, 'site');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'index.html'), `<!doctype html><title>Research Index</title>
<style>body{font-size:24px} a,button,input,label{font-size:24px}</style>
<h1>Research Index</h1>
<a href="cobalt.html" target="_blank">cobalt</a>
<a href="heron.html" target="_blank">heron</a>
<form onsubmit="event.preventDefault();document.getElementById('saved').textContent='Saved '+document.getElementById('name').value">
  <label>Name <input id="name" autofocus></label>
  <button id="save">Save</button>
</form>
<span id="saved"></span>`);
writeFileSync(join(fixture, 'cobalt.html'), '<!doctype html><title>cobalt</title><h1>cobalt answer</h1>');
writeFileSync(join(fixture, 'heron.html'), '<!doctype html><title>heron</title><h1>heron answer</h1>');
const indexUrl = `file://${join(fixture, 'index.html')}`;

// --- task-owned private Xvfb ---
const build = spawnSync('cargo', ['build', '-q', '--manifest-path', 'packages/desktop-host/engine/Cargo.toml', '--example', 'x11_target'], { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(repoRoot, '.bench-target') } });
assert.equal(build.status, 0, 'x11_target example build failed');
const example = join(process.env.CARGO_TARGET_DIR ?? join(repoRoot, '.bench-target'), 'debug', 'examples', 'x11_target');
const claim = claimPrivateDisplay({ from: 170, count: 30 });
const { number, display } = claim;
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir, 'Xauthority');
assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' }).status, 0, 'xauth failed');
let xvfb;

const sessionName = `bench-${process.pid}-${randomBytes(16).toString('hex')}`;
const marker = `DESKLINK_AXI_SESSION=${sessionName}`;
const owned = new Map(); // PID -> start time
const env = { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', XAUTHORITY: authority, DESKLINK_AXI_SESSION: sessionName, DESKLINK_AXI_ENGINE: enginePath,
  DESKLINK_AXI_PID_FILE: join(dir, 'bridges.pid'), DESKLINK_AXI_ENGINE_PID_FILE: join(dir, 'engines.pid') };
function proc(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { state: fields[0], started: fields[19] };
  } catch { return undefined; }
}
const alive = pid => { const s = proc(pid); return s !== undefined && s.state !== 'Z' && s.started === owned.get(pid); };
async function stopProcess(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise(r => setTimeout(r, 50));
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => setTimeout(r, 25));
}
function childrenOf(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}
function sessionStrays() {
  const strays = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || owned.has(pid) || pid === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(marker)) continue;
      strays.push({ pid, cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') });
    } catch { /* vanished */ }
  }
  return strays;
}
function rememberTree(pid) {
  const state = proc(pid);
  if (!state || state.state === 'Z') return;
  if (owned.has(pid) && owned.get(pid) !== state.started) return;
  owned.set(pid, state.started);
  for (const kid of childrenOf(pid)) if (!owned.has(kid)) rememberTree(kid);
}
function recordProcesses() {
  // These files are written by this run's bridge, inside its fresh private dir.
  for (const [file, command] of [[env.DESKLINK_AXI_PID_FILE, '--bridge'], [env.DESKLINK_AXI_ENGINE_PID_FILE, enginePath]]) {
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
      const state = proc(pid);
      if (!state || state.state === 'Z' || (owned.has(pid) && owned.get(pid) !== state.started)) continue;
      let cmdline, environment;
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
        environment = readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0');
      } catch (error) {
        const current = proc(pid);
        if (!current || current.state === 'Z' || current.started !== state.started) continue;
        throw error;
      }
      const current = proc(pid);
      if (!current || current.state === 'Z' || current.started !== state.started) continue;
      assert(cmdline.includes(command), 'unexpected recorded process');
      assert(environment.includes(marker), 'recorded process is outside our session');
      owned.set(pid, state.started);
      rememberTree(pid);
    }
  }
  for (const pid of owned.keys()) if (alive(pid)) rememberTree(pid);
}

const cli = resolve(axiRoot, 'bin/desklink-axi.js');
// Every call is bounded: a hard 20s spawn kill plus the current run deadline.
const CALL_TIMEOUT_MS = 20000;
let runDeadline = Infinity;
async function call(...args) {
  if (performance.now() > runDeadline) throw new Error('run-deadline exceeded');
  recordProcesses();
  const started = performance.now();
  const child = spawn(process.execPath, [cli, ...args], { env, timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
  rememberTree(child.pid);
  let out = ''; for await (const part of child.stdout) out += part;
  const code = child.exitCode ?? await new Promise(r => child.on('exit', r));
  recordProcesses();
  return { ms: performance.now() - started, chars: out.length, out, code };
}
const tokenProxy = chars => Math.ceil(chars / 4); // labeled proxy, not a tokenizer
// Snapshot lines can carry annotations between role and ref (e.g. [active])
// and a value suffix after the ref; find the ref on the matching line.
const lineRef = (yaml, roleAndName) => {
  const line = yaml.split('\n').find(l => l.includes(roleAndName));
  return line ? /\[ref=(e\d+)\]/.exec(line)?.[1] : undefined;
};

// --- run harness ---
const stats = new Map(); // task|lane -> { ms: [], retries: 0, calls: 0, chars: 0, failures: 0 }
function record(key, run) {
  const s = stats.get(key) ?? { ms: [], retries: 0, calls: 0, chars: 0, failures: 0 };
  if (run.ok) { s.ms.push(run.ms); s.calls += run.calls; s.chars += run.chars; s.retries += run.retries; }
  else s.failures++;
  if (run.timeout) s.hadTimeout = true;
  stats.set(key, s);
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
};

let browserProfile;

async function setupChromium() {
  // No window manager exists on the bare Xvfb, so pin the window geometry;
  // otherwise Chromium picks a nondeterministic size and clips the fixture.
  const launched = await call('browser', 'launch', '--profile', join(dir, 'chromium-profile'),
    '--arg=--window-position=0,0', '--arg=--window-size=1280,640');
  assert.equal(launched.code, 0, launched.out);
  browserProfile = join(dir, 'chromium-profile');
  const pid = Number(/pid=(\d+)/.exec(launched.out)?.[1]);
  rememberTree(pid);
  const opened = await call('browser', 'open', indexUrl);
  assert.equal(opened.code, 0, opened.out);
}

// --- task definitions; each returns {ms, calls, chars, retries} ---
const tasks = {
  // Native X11 typing through the engine client (AXI lane only).
  async native(runIndex) {
    const typedPath = join(dir, `native-${runIndex}.txt`);
    const target = spawn(example, ['--record-text', typedPath], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    owned.set(target.pid, proc(target.pid)?.started);
    await new Promise(r => setTimeout(r, 300));
    const text = `native bench ${runIndex}`;
    let retries = 0;
    let result = await call('batch', JSON.stringify([['type', text]]));
    let calls = 1, chars = result.chars;
    let read = readFileSync(typedPath, 'utf8') === text;
    if (!read) { retries++; calls++; chars += (result = await call('type', text)).chars; read = readFileSync(typedPath, 'utf8') === text; }
    target.kill('SIGTERM');
    await new Promise(r => target.once('exit', r));
    return { ok: read, ms: result.ms, calls, chars, retries };
  },
  // Open the fixture and verify the heading.
  async open(runIndex, lane) {
    if (lane === 'browser') {
      let retries = 0, calls = 0, chars = 0, ms = 0;
      const nav = await call('browser', 'navigate', indexUrl); calls++; chars += nav.chars; ms += nav.ms;
      let snap = await call('browser', 'snapshot'); calls++; chars += snap.chars; ms += snap.ms;
      let ok = snap.out.includes('heading "Research Index"');
      if (!ok) { retries++; snap = await call('browser', 'snapshot'); calls++; chars += snap.chars; ms += snap.ms; ok = snap.out.includes('heading "Research Index"'); }
      return { ok, ms, calls, chars, retries };
    }
    let retries = 0, calls = 0, chars = 0, ms = 0;
    let batch = await call('batch', JSON.stringify([['press', 'ctrl+l'], ['type', indexUrl], ['press', 'Return'], ['wait', 'change']])); calls++; chars += batch.chars; ms += batch.ms;
    let verify = await call('screen', '--query', 'Research Index'); calls++; chars += verify.chars; ms += verify.ms;
    let ok = !verify.out.includes('text: 0 items match');
    if (!ok) { retries++; verify = await call('screen', '--query', 'Research Index'); calls++; chars += verify.chars; ms += verify.ms; ok = !verify.out.includes('text: 0 items match'); }
    return { ok, ms, calls, chars, retries };
  },
  // Fill the name, save, verify the saved text.
  async form(runIndex, lane) {
    const name = `Ada ${runIndex}`;
    if (lane === 'browser') {
      let retries = 0, calls = 0, chars = 0, ms = 0;
      let snap = await call('browser', 'snapshot'); calls++; chars += snap.chars; ms += snap.ms;
      let nameRef = lineRef(snap.out, 'textbox "Name"');
      let saveRef = lineRef(snap.out, 'button "Save"');
      if (!nameRef || !saveRef) { retries++; snap = await call('browser', 'snapshot'); calls++; chars += snap.chars; ms += snap.ms; nameRef = lineRef(snap.out, 'textbox "Name"'); saveRef = lineRef(snap.out, 'button "Save"'); }
      if (!nameRef || !saveRef) { if (process.env.DESKLINK_AXI_BENCH_DEBUG) console.error(`[form-browser] no refs:\n${snap.out.slice(0, 600)}`); return { ok: false, ms, calls, chars, retries }; }
      const filled = await call('browser', 'fill', `@${nameRef}`, name); calls++; chars += filled.chars; ms += filled.ms;
      const clicked = await call('browser', 'click', `@${saveRef}`); calls++; chars += clicked.chars; ms += clicked.ms;
      let verify = await call('browser', 'snapshot'); calls++; chars += verify.chars; ms += verify.ms;
      let ok = verify.out.includes(`Saved ${name}`);
      if (!ok) { retries++; verify = await call('browser', 'snapshot'); calls++; chars += verify.chars; ms += verify.ms; ok = verify.out.includes(`Saved ${name}`); }
      if (!ok && process.env.DESKLINK_AXI_BENCH_DEBUG) console.error(`[form-browser] verify miss:\n${verify.out.slice(0, 600)}`);
      return { ok, ms, calls, chars, retries };
    }
    let retries = 0, calls = 0, chars = 0, ms = 0;
    // Wait for a post-key frame change: standalone settle can accept the old
    // page while reload is pending and discard the typing that follows.
    let reload = await call('batch', JSON.stringify([['press', 'ctrl+r', '--wait', 'settle']])); calls++; chars += reload.chars; ms += reload.ms;
    // The fixture focuses its input on reload; Enter submits the form.
    // OCR can return overlapping rows for the inline labels.
    let act = await call('batch', JSON.stringify([
      ['type', name, '--submit'],
      ['wait', '300'],
    ])); calls++; chars += act.chars; ms += act.ms;
    let verify = await call('screen', '--query', `Saved ${name}`); calls++; chars += verify.chars; ms += verify.ms;
    let ok = !verify.out.includes('text: 0 items match');
    if (!ok) { retries++; verify = await call('screen', '--query', `Saved ${name}`); calls++; chars += verify.chars; ms += verify.ms; ok = !verify.out.includes('text: 0 items match'); }
    return { ok, ms, calls, chars, retries };
  },
  // Open both research tabs and read both answers.
  async tabs(runIndex, lane) {
    if (lane === 'browser') {
      let retries = 0, calls = 0, chars = 0, ms = 0;
      const selectIndex = async () => {
        const tabs = await call('browser', 'tabs'); calls++; chars += tabs.chars; ms += tabs.ms;
        const pos = /(\d+),[^,]*,[^,]*index\.html,/m.exec(tabs.out)?.[1];
        if (pos && !new RegExp(`^  ${pos},[^,]*,[^,]*,yes,`, 'm').test(tabs.out)) {
          const selected = await call('browser', 'select', pos); calls++; chars += selected.chars; ms += selected.ms;
        }
      };
      await selectIndex();
      const snap0 = await call('browser', 'snapshot'); calls++; chars += snap0.chars; ms += snap0.ms;
      const cobaltRef = lineRef(snap0.out, 'link "cobalt"');
      const heronRef = lineRef(snap0.out, 'link "heron"');
      if (!cobaltRef || !heronRef) { retries++; if (process.env.DESKLINK_AXI_BENCH_DEBUG) console.error(`[tabs-browser] no link refs:\n${snap0.out.slice(0, 600)}`); return { ok: false, ms, calls, chars, retries }; }
      const selectAndVerify = async (urlPart, answer) => {
        const tabs = await call('browser', 'tabs'); calls++; chars += tabs.chars; ms += tabs.ms;
        const pos = new RegExp(`(\\d+),[^,]*,[^,]*${urlPart},`, 'm').exec(tabs.out)?.[1];
        if (!pos) return false;
        const selected = await call('browser', 'select', pos); calls++; chars += selected.chars; ms += selected.ms;
        const snap = await call('browser', 'snapshot'); calls++; chars += snap.chars; ms += snap.ms;
        return snap.out.includes(answer);
      };
      const clicked1 = await call('browser', 'click', `@${cobaltRef}`); calls++; chars += clicked1.chars; ms += clicked1.ms;
      await new Promise(r => setTimeout(r, 300));
      const okCobalt = await selectAndVerify('cobalt\\.html', 'cobalt answer');
      await selectIndex();
      const clicked2 = await call('browser', 'click', `@${heronRef}`); calls++; chars += clicked2.chars; ms += clicked2.ms;
      await new Promise(r => setTimeout(r, 300));
      const okHeron = await selectAndVerify('heron\\.html', 'heron answer');
      // Close the popups so runs stay O(1).
      for (;;) {
        const tabsN = await call('browser', 'tabs'); calls++; chars += tabsN.chars; ms += tabsN.ms;
        const popup = /(\d+),[^,]*,[^,]*(cobalt|heron)\.html,/m.exec(tabsN.out)?.[1];
        if (!popup) break;
        const closed = await call('browser', 'close', popup); calls++; chars += closed.chars; ms += closed.ms;
      }
      return { ok: okCobalt && okHeron, ms, calls, chars, retries };
    }
    let retries = 0, calls = 0, chars = 0, ms = 0;
    // Popups from earlier runs are closed with ctrl+w, so exactly one popup is open at a time.
    let snap = await call('screen', '--query', 'cobalt'); calls++; chars += snap.chars; ms += snap.ms;
    let click1 = await call('click', 'cobalt', '--wait', 'change'); calls++; chars += click1.chars; ms += click1.ms;
    let verify1 = await call('screen', '--query', 'cobalt answer'); calls++; chars += verify1.chars; ms += verify1.ms;
    let okCobalt = !verify1.out.includes('text: 0 items match');
    if (!okCobalt) { retries++; await new Promise(r => setTimeout(r, 400)); verify1 = await call('screen', '--query', 'cobalt answer'); calls++; chars += verify1.chars; ms += verify1.ms; okCobalt = !verify1.out.includes('text: 0 items match'); }
    if (!okCobalt && process.env.DESKLINK_AXI_BENCH_DEBUG) console.error(`[tabs-axi] cobalt answer miss:\n${verify1.out.slice(0, 500)}`);
    let close1 = await call('press', 'ctrl+w'); calls++; chars += close1.chars; ms += close1.ms;
    await new Promise(r => setTimeout(r, 300));
    snap = await call('screen', '--query', 'heron'); calls++; chars += snap.chars; ms += snap.ms;
    let click2 = await call('click', 'heron', '--wait', 'change'); calls++; chars += click2.chars; ms += click2.ms;
    let verify2 = await call('screen', '--query', 'heron answer'); calls++; chars += verify2.chars; ms += verify2.ms;
    let okHeron = !verify2.out.includes('text: 0 items match');
    if (!okHeron) { retries++; await new Promise(r => setTimeout(r, 400)); verify2 = await call('screen', '--query', 'heron answer'); calls++; chars += verify2.chars; ms += verify2.ms; okHeron = !verify2.out.includes('text: 0 items match'); }
    if (!okHeron && process.env.DESKLINK_AXI_BENCH_DEBUG) console.error(`[tabs-axi] heron answer miss:\n${verify2.out.slice(0, 500)}`);
    let close2 = await call('press', 'ctrl+w'); calls++; chars += close2.chars; ms += close2.ms;
    return { ok: okCobalt && okHeron, ms, calls, chars, retries };
  },
};

try {
  xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  trackOwnedXvfb(xvfb, display);
  owned.set(xvfb.pid, proc(xvfb.pid)?.started);
  await verifyOwnedXvfb(xvfb);
  // AXI desktop session on the private display (control input, OCR refs).
  const start = await call('start', '--source', 'x11', '--display', display);
  assert.equal(start.code, 0, start.out);

  // Native task first: no Chromium, x11_target owns X input focus.
  const nativeKey = 'native typing';
  const RUN_DEADLINE_MS = 120000;
  const notCompleted = [];
  let nativeAborted = false;
  const runNativeBounded = async (i) => {
    runDeadline = performance.now() + RUN_DEADLINE_MS;
    try {
      record(nativeKey + '|axi', await tasks.native(i));
      return true;
    } catch (error) {
      record(nativeKey + '|axi', { ok: false, ms: RUN_DEADLINE_MS, calls: 0, chars: 0, retries: 0, timeout: true });
      return !String(error).includes('run-deadline');
    } finally { runDeadline = Infinity; }
  };
  for (let i = 0; i < WARMUP && !nativeAborted; i++) nativeAborted = !(await runNativeBounded(i));
  for (let i = 0; i < RUNS && !nativeAborted; i++) nativeAborted = !(await runNativeBounded(WARMUP + i));
  if (nativeAborted) notCompleted.push(nativeKey + '|axi');

  await setupChromium();
  const runBounded = async (key, task, i, lane) => {
    runDeadline = performance.now() + RUN_DEADLINE_MS;
    try {
      record(key, await tasks[task](i, lane));
      return true;
    } catch (error) {
      record(key, { ok: false, ms: RUN_DEADLINE_MS, calls: 0, chars: 0, retries: 0, timeout: true });
      if (String(error).includes('run-deadline')) return false;
      return true;
    } finally { runDeadline = Infinity; }
  };
  for (const [task, lane] of [['open', 'browser'], ['open', 'axi'], ['form', 'browser'], ['form', 'axi'], ['tabs', 'browser'], ['tabs', 'axi']]) {
    const key = `${task}|${lane}`;
    let aborted = false;
    for (let i = 0; i < WARMUP && !aborted; i++) aborted = !(await runBounded(key, task, i, lane));
    for (let i = 0; i < RUNS && !aborted; i++) aborted = !(await runBounded(key, task, WARMUP + i, lane));
    if (aborted) notCompleted.push(key);
  }

  const detach = await call('browser', 'detach');
  assert.equal(detach.code, 0, detach.out);
  const stop = await call('stop');
  assert.equal(stop.code, 0, stop.out);

  console.log(`\n${RUNS} measured runs per task (after ${WARMUP} warmup), CLI wall time per run, private Xvfb :${number}. Text-token proxy = ceil(stdout chars/4) — a proxy, not a real tokenizer or billing.\n`);
  console.log('| task | lane | p50 ms | p95 ms | calls/run | retries | text-token proxy/run | failures |');
  console.log('|---|---|---|---|---|---|---|---|');
  const report = {};
  for (const [key, s] of stats) {
    const [task, lane] = key.split('|');
    const runs = s.ms.length + s.failures;
    const p50 = s.ms.length ? percentile(s.ms, 0.5) : 'n/a';
    const p95 = s.ms.length ? percentile(s.ms, 0.95) : 'n/a';
    const callsPerRun = s.ms.length ? (s.calls / s.ms.length).toFixed(1) : 'n/a';
    const tokensPerRun = s.ms.length ? Math.round(s.chars / s.ms.length / 4) : 'n/a';
    console.log(`| ${task} | ${lane} | ${p50} | ${p95} | ${callsPerRun} | ${s.retries} | ${tokensPerRun} | ${s.failures}/${runs}${s.hadTimeout ? ' (timeouts)' : ''} |`);
    report[key] = { runs: s.ms.length, failures: s.failures, p50_ms: p50, p95_ms: p95, callsPerRun, retries: s.retries, tokenProxyPerRun: tokensPerRun, hadTimeout: !!s.hadTimeout };
  }
  for (const key of notCompleted) console.log(`| ${key.split('|')[0]} | ${key.split('|')[1]} | not completed | - | - | - | - | run deadline hit |`);
  if (process.env.DESKLINK_AXI_BENCH_PATH) writeFileSync(process.env.DESKLINK_AXI_BENCH_PATH, JSON.stringify({ ...report, notCompleted }, null, 1));
  // Only recorded PID/start-time identities may be reaped; tags detect leaks.
  const strays = sessionStrays();
  assert.equal(strays.length, 0, `stray session members: ${JSON.stringify(strays)}`);
  console.log(`\nbench: ${RUNS}-run comparison recorded; no task-owned survivors on Xvfb :${number}`);
} finally {
  try {
    if (browserProfile) await call('browser', 'detach').catch(() => { });
    recordProcesses();
  } finally {
    for (const pid of [...owned.keys()]) if (pid !== xvfb?.pid) await stopProcess(pid);
    if (xvfb) await stopOwnedXvfb(xvfb);
    claim.release();
    assert.equal(sessionStrays().length, 0, 'unrecorded session processes survived');
    rmSync(dir, { recursive: true, force: true });
  }
}
