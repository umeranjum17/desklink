// Browser-lane integration proof (build-plan item 2): the benchmark report's
// local open / form / two-tab fixture, driven end to end through the
// desklink-axi browser commands with semantic refs. All rendering stays on a
// task-owned private Xvfb with a task-owned Chromium profile under the task
// temp directory; observations are compact accessibility text — no full
// screenshots anywhere.
// Usage: node test/browser-flow.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();

const axiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-browser-flow-'));
const profile = join(dir, 'chromium-profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });

// Deterministic local fixture: index with heading, two target=_blank research
// links, a Name/Save form, and a labelled file input.
const fixture = join(dir, 'site');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'index.html'), `<!doctype html><title>Research Index</title>
<h1>Research Index</h1>
<a href="cobalt.html" target="_blank">cobalt</a>
<a href="heron.html" target="_blank">heron</a>
<form onsubmit="event.preventDefault();document.getElementById('saved').textContent='Saved '+document.getElementById('name').value">
  <label>Name <input id="name"></label>
  <button id="save">Save</button>
</form>
<span id="saved"></span>
<label>Attach file <input type="file" onchange="document.getElementById('chosen').textContent=this.files[0]?.name ?? ''"></label>
<span id="chosen"></span>`);
writeFileSync(join(fixture, 'cobalt.html'), '<!doctype html><title>cobalt</title><h1>cobalt answer</h1>');
writeFileSync(join(fixture, 'heron.html'), '<!doctype html><title>heron</title><h1>heron answer</h1>');

// Task-owned private Xvfb on a verified high display (never :0/wayland-1).
const number = Array.from({ length: 30 }, (_, i) => 170 + i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const authority = join(dir, 'Xauthority');
assert.equal(spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' }).status, 0, 'xauth failed');
let xvfb;

const sessionName = `broflow-${process.pid}-${randomBytes(16).toString('hex')}`;
const marker = `DESKLINK_AXI_SESSION=${sessionName}`;
// Chromium cannot start with an overridden XDG_RUNTIME_DIR; isolation comes
// from the unique session name and the task-owned profile, like flow.mjs.
const env = {
  ...process.env, DISPLAY: display, XAUTHORITY: authority, WAYLAND_DISPLAY: '',
  DESKLINK_AXI_SESSION: sessionName,
};
const owned = new Map(); // PID -> start time; never signal a reused PID.
function proc(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { state: fields[0], started: fields[19] };
  } catch { return undefined; }
}
function alive(pid) {
  const state = proc(pid);
  return state !== undefined && state.state !== 'Z' && state.started === owned.get(pid);
}
async function stopProcess(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise(r => setTimeout(r, 50));
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => setTimeout(r, 25));
  assert(!alive(pid), `task-owned process ${pid} survived cleanup`);
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

const cli = resolve(axiRoot, 'bin/desklink-axi.js');
async function run(...args) {
  const child = spawn(process.execPath, [cli, ...args], { env });
  let out = ''; for await (const part of child.stdout) out += part;
  const code = await new Promise(r => child.on('exit', r));
  return { code, out };
}
async function ok(...args) {
  const { code, out } = await run(...args);
  assert.equal(code, 0, `${args.join(' ')} failed: ${out}`);
  assert(out.length < 20000, `unbounded output from ${args.join(' ')}`);
  return out;
}
const ref = (snapshot, pattern) => {
  const found = new RegExp(`${pattern} \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
  assert(found, `no ref for ${pattern} in:\n${snapshot}`);
  return `@${found}`;
};

try {
  xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  trackOwnedXvfb(xvfb, display);
  await verifyOwnedXvfb(xvfb);
const indexOfUrl = async (urlPart) => {
  const tabs = await ok('browser', 'tabs');
  const position = new RegExp(`^  (\\d+),[^,]*,([^,]*${urlPart}[^,]*),`, 'm').exec(tabs)?.[1];
  assert(position !== undefined, `tab matching ${urlPart} missing:\n${tabs}`);
  return position;
};
  // Launch through the adapter itself: loopback-only port, task-owned profile.
  // CI runners disable chromium's sandbox namespaces, so drop the sandbox there.
  const launched = await ok('browser', 'launch', '--profile', profile, ...(process.env.CI ? ['--arg=--no-sandbox'] : []));
  const launchInfo = /browser: launched (127\.0\.0\.1:\d+) pid=(\d+) profile=(\S+)/.exec(launched);
  assert(launchInfo, `unexpected launch output: ${launched}`);
  const browserPid = Number(launchInfo[2]);
  owned.set(browserPid, proc(browserPid)?.started);
  assert(alive(browserPid), 'chromium pid recorded at launch');

  const indexUrl = `file://${join(fixture, 'index.html')}`;
  await ok('browser', 'open', indexUrl);
  const tabs1 = await ok('browser', 'tabs');
  assert.match(tabs1, /tabs\[2\]/, `expected the launch tab plus the fixture:\n${tabs1}`);
  const indexTab = /^  (\d+),[^,]*,(file:\/\/.*index\.html),yes,/m.exec(tabs1)?.[1];
  assert(indexTab !== undefined, `fixture tab not selected:\n${tabs1}`);

  // Compact accessibility snapshot with semantic refs; no screenshots.
  const snap1 = await ok('browser', 'snapshot');
  assert.match(snap1, /heading "Research Index" \[level=1\]/, snap1);
  assert.match(snap1, /\[ref=e\d+\]/, snap1);
  assert.doesNotMatch(snap1, /image:/, 'the browser lane must not return screenshots');
  assert(snap1.length < 6000, `snapshot not compact: ${snap1.length} chars`);

  // Two-tab fixture: click a target=_blank link; our selection stays put while
  // the popup becomes the browser's actual front tab — reported as separate
  // columns from the browser's own target order, not our bookkeeping.
  await ok('browser', 'click', ref(snap1, 'link "cobalt"'));
  await new Promise(r => setTimeout(r, 400));
  const tabs2 = await ok('browser', 'tabs');
  assert.match(tabs2, /tabs\[3\]/, `popup missing:\n${tabs2}`);
  const selectedRows = [...tabs2.matchAll(/^  (\d+),[^,]*,[^,]*,yes,/gm)].map(m => m[1]);
  const frontRows = [...tabs2.matchAll(/^  (\d+),[^,]*,[^,]*,no,yes/gm)].map(m => m[1]);
  assert.equal(selectedRows.length, 1, `one selected tab expected:\n${tabs2}`);
  assert.equal(frontRows.length, 1, `one front tab expected:\n${tabs2}`);
  assert.notEqual(selectedRows[0], frontRows[0], `selection and front state must be reported separately:\n${tabs2}`);
  const cobaltTab = frontRows[0];
  assert.match(tabs2, new RegExp(`^  ${cobaltTab},cobalt,`, "m"), tabs2);

  await ok('browser', 'select', cobaltTab);
  const cobaltSnap = await ok('browser', 'snapshot');
  assert.match(cobaltSnap, /heading "cobalt answer"/, cobaltSnap);

  // Stale-ref rejection survives the lane switch: an index-page ref is stale on cobalt.
  const indexRef = ref(snap1, 'link "heron"');
  const stale = await run('browser', 'click', indexRef);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /stale-ref:/, stale.out);

  await ok('browser', 'select', await indexOfUrl('index\\.html'));
  const snap2 = await ok('browser', 'snapshot');
  await ok('browser', 'click', ref(snap2, 'link "heron"'));
  await new Promise(r => setTimeout(r, 400));
  const tabs3 = await ok('browser', 'tabs');
  const heronRow = [...tabs3.matchAll(/^  (\d+),heron,/gm)].map(m => m[1]);
  assert.equal(heronRow.length, 1, `heron tab missing:\n${tabs3}`);
  await ok('browser', 'select', String(heronRow[0]));
  assert.match(await ok('browser', 'snapshot'), /heading "heron answer"/);

  // Form fixture with semantic refs: fill by ref, click Save by ref, verify.
  await ok('browser', 'select', await indexOfUrl('index\\.html'));
  const snap3 = await ok('browser', 'snapshot');
  await ok('browser', 'fill', ref(snap3, 'textbox "Name"'), 'Ada Lovelace');
  const saveRef = ref(snap3, 'button "Save"');
  await ok('browser', 'click', saveRef);
  const snap4 = await ok('browser', 'snapshot');
  assert.match(snap4, /Saved Ada Lovelace/, `form save not verified:\n${snap4}`);

  // Upload fixture: DOM upload through the labelled file input.
  const fileRef = ref(snap3, 'button "Attach file"');
  const uploadTarget = join(dir, 'pay slip.txt');
  writeFileSync(uploadTarget, 'attachment');
  assert.match(await ok('browser', 'upload', fileRef, uploadTarget), /upload: applied/);
  assert.match(await ok('browser', 'snapshot'), /pay slip\.txt/, 'chosen filename not shown after upload');

  // Explicit not-supported: files cannot go to a non-file element; the error
  // names the AXI fallback for OS dialogs.
  const notSupported = await run('browser', 'upload', saveRef, uploadTarget);
  assert.equal(notSupported.code, 1, notSupported.out);
  assert.match(notSupported.out, /not-supported:.*does not accept files/, notSupported.out);
  assert.match(notSupported.out, /desklink-axi click\/type/, notSupported.out);

  // Detach stops the browser we launched (recorded PID) and forgets state.
  // A user-passed --profile is intentionally kept; only lane-created temp
  // profiles are removed on detach.
  assert.match(await ok('browser', 'detach'), new RegExp(`detached and stopped pid=${browserPid}`));
  await stopProcess(browserPid);
  const after = await run('browser', 'tabs');
  assert.equal(after.code, 1);
  assert.match(after.out, /no-browser:/);

  // A lane-created default profile is removed on detach (unlike a passed one).
  const launched2 = await ok('browser', 'launch', ...(process.env.CI ? ['--arg=--no-sandbox'] : []));
  const info2 = /browser: launched \S+ pid=(\d+) profile=(\S+)/.exec(launched2);
  assert(info2, launched2);
  owned.set(Number(info2[1]), proc(Number(info2[1]))?.started);
  assert.match(await ok('browser', 'detach'), /detached and stopped/);
  await stopProcess(Number(info2[1]));
  assert(!existsSync(info2[2]), 'lane-created profile dir was not removed');

  const strays = sessionStrays();
  assert.equal(strays.length, 0, `stray session members: ${JSON.stringify(strays)}`);
  console.log(`browser-flow: open/form/two-tab fixture passed with semantic refs on private Xvfb :${number}; selected vs front distinguished; no screenshots`);
} finally {
  for (const pid of [...owned.keys()]) { try { await stopProcess(pid); } catch { /* surfaced above */ } }
  if (xvfb) await stopOwnedXvfb(xvfb);
  assert.equal(sessionStrays().length, 0, 'unrecorded session processes survived');
  rmSync(dir, { recursive: true, force: true });
}
