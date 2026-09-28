// Linux live proof for the display keeper: every scenario runs on a
// task-owned Xvfb with its own cookie, against the real engine binary and the
// real TS wrapper. No capture or input ever touches a real desktop — the same
// confinement rules as packages/axi/test/flow.mjs.
//
//   KEEPER_FLOW_EVIDENCE=<dir> node packages/desktop-host/engine/test/keeper-flow.mjs
//
// Writes a transcript to $KEEPER_FLOW_EVIDENCE/keeper-flow.log and PNG
// screenshots of the kept screen next to it. Exits non-zero when a scenario
// fails.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const engineDir = resolve(import.meta.dirname, '..');
const engineBin =
  process.env.DESKLINK_AXI_ENGINE ?? join(engineDir, 'target', 'debug', 'desklink-host');
const fixtureBin = join(engineDir, 'target', 'debug', 'examples', 'keeper_fixture');
const evidenceDir = process.env.KEEPER_FLOW_EVIDENCE ?? import.meta.dirname;
assert(existsSync(engineBin), 'engine not built: cargo build --manifest-path packages/desktop-host/engine/Cargo.toml');
assert(existsSync(fixtureBin), 'fixture not built: cargo build --example keeper_fixture');

const log = createWriteStream(join(evidenceDir, 'keeper-flow.log'), { flags: 'a' });
function note(line) {
  log.write(line + '\n');
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, pass, evidence, detail) {
  results.push({ name, result: pass ? 'pass' : 'fail', evidence, ...(detail ? { detail } : {}) });
  note(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  note(`      evidence: ${evidence}`);
}

/** A high display nobody owns; never the ambient desktop's low numbers. */
function freeDisplay() {
  const sockets = '/tmp/.X11-unix';
  const used = new Set(
    existsSync(sockets)
      ? spawnSync('ls', [sockets]).stdout.toString().trim().split('\n')
          .filter((n) => /^X\d+$/.test(n)).map((n) => Number(n.slice(1)))
      : [],
  );
  for (let n = 170; n < 250; n++) {
    if (!used.has(n) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('no free high X display');
}

/** One private Xvfb, its own cookie, its own temp dir. */
class Screen {
  constructor() {
    this.number = freeDisplay();
    this.display = `:${this.number}`;
    this.dir = mkdtempSync(join(tmpdir(), 'keeper-flow-'));
    this.authority = join(this.dir, 'Xauthority');
    const cookie = randomBytes(16).toString('hex');
    const auth = spawnSync('xauth', ['-f', this.authority, 'add', this.display, '.', cookie], { encoding: 'utf8' });
    assert.equal(auth.status, 0, `xauth failed: ${auth.stderr}`);
    this.xvfb = spawn('Xvfb', [this.display, '-auth', this.authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  }
  async ready() {
    const socket = `/tmp/.X11-unix/X${this.number}`;
    for (let i = 0; i < 100 && !existsSync(socket) && this.xvfb.exitCode === null; i++) await sleep(50);
    assert(this.xvfb.exitCode === null && existsSync(socket), `Xvfb ${this.display} did not start`);
  }
  env() {
    return { ...process.env, DISPLAY: this.display, XAUTHORITY: this.authority };
  }
  /** SIGTERM first so the socket is unlinked; SIGKILL only if it survives. */
  async stop() {
    const pid = this.xvfb.pid;
    if (pid && this.xvfb.exitCode === null) {
      try { this.xvfb.kill('SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 60 && this.xvfb.exitCode === null; i++) await sleep(50);
      if (this.xvfb.exitCode === null) { try { this.xvfb.kill('SIGKILL'); } catch {} }
      await sleep(50);
    }
    try { this.xvfb.kill('SIGKILL'); } catch { /* gone */ }
  }
}

/** The real engine running `keep` on a display; captures its stdout lines. */
function startKeeper(display, env) {
  const child = spawn(engineBin, ['keep', '--display', display], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const stderr = [];
  const waiters = new Set();
  const pump = createInterface({ input: child.stdout });
  pump.on('line', (line) => {
    lines.push(line);
    note(`      keeper stdout: ${line}`);
    for (const waiter of [...waiters]) if (waiter.test(line)) { waiters.delete(waiter); waiter.resolve(line); }
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr.push(line);
    note(`      keeper stderr: ${line}`);
  });
  const exit = new Promise((res) => child.once('close', (code, signal) => res({ code, signal })));
  async function waitForLine(test, ms = 5000, label = 'line', since = 0) {
    for (let i = since; i < lines.length; i++) if (test(lines[i])) return lines[i];
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = await Promise.race([
        new Promise((res) => waiters.add({ test, resolve: res })),
        sleep(Math.max(1, deadline - Date.now())).then(() => null),
      ]);
      if (found) return found;
    }
    throw new Error(`keeper never wrote ${label}; saw ${JSON.stringify(lines)}`);
  }
  return { child, lines, stderr, exit, waitForLine };
}

async function exitWithin(exitPromise, ms) {
  return Promise.race([exitPromise, sleep(ms).then(() => null)]);
}

/** The scriptable X client fixture; one command in, one reply out. */
class Fixture {
  constructor(screen) {
    this.proc = spawn(fixtureBin, [], { env: screen.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.replies = [];
    const pump = createInterface({ input: this.proc.stdout });
    this.pending = [];
    pump.on('line', (line) => {
      note(`      fixture: ${line}`);
      const resolve = this.pending.shift();
      if (resolve) resolve(line);
      else this.replies.push(line);
    });
    this.proc.stderr.on('data', (d) => note(`      fixture stderr: ${d}`));
  }
  async ready() {
    await this.cmd('screen', 8000); // greeting is a valid reply to any command
  }
  async cmd(line, ms = 4000) {
    this.proc.stdin.write(line + '\n');
    const reply = await Promise.race([
      new Promise((res) => this.pending.push(res)),
      sleep(ms).then(() => null),
    ]);
    if (reply === null) throw new Error(`fixture never answered "${line}"`);
    return reply;
  }
  async focus(expected, ms = 4000, label = 'focus') {
    const deadline = Date.now() + ms;
    for (;;) {
      const reply = await this.cmd('focus');
      if (reply === expected) return reply;
      if (Date.now() > deadline) throw new Error(`${label}: wanted ${expected}, last saw ${reply}`);
      await sleep(60);
    }
  }
  stop() {
    try { this.proc.stdin.end('quit\n'); } catch { /* already gone */ }
    this.proc.kill('SIGTERM');
  }
}

function parseWindows(line) {
  try {
    const parsed = JSON.parse(line);
    return Array.isArray(parsed.windows) ? parsed : null;
  } catch {
    return null;
  }
}

function screenshot(screen, path) {
  const shot = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x720', '-framerate', '2', '-i', `${screen.display}.0`, '-frames:v', '1', '-y', path],
    { env: screen.env(), timeout: 20000, encoding: 'utf8' },
  );
  assert.equal(shot.status, 0, `screenshot failed: ${shot.stderr}`);
  assert(existsSync(path), 'screenshot file missing');
  return path;
}

// ---------------------------------------------------------------------------
note(`=== keeper-flow ${new Date().toISOString()} ===`);
const scenario = process.argv[2] ?? 'all';

if (scenario === 'all') {
  // Main flow on one private screen.
  const screen = new Screen();
  await screen.ready();
  note(`private screen ${screen.display} (Xvfb pid ${screen.xvfb.pid})`);
  let keeper, fixture, idA, idB, idC;
  try {
    // S1: the keeper takes the screen and reports its empty state.
    keeper = startKeeper(screen.display, screen.env());
    const first = await keeper.waitForLine((l) => parseWindows(l) !== null, 8000, 'the first window report');
    const empty = parseWindows(first);
    const s1 = Array.isArray(empty.windows) && empty.windows.length === 0 && keeper.child.exitCode === null;
    const shotEmpty = screenshot(screen, join(evidenceDir, 'keeper-1-empty-screen.png'));
    record(
      'Keeper claims a private X screen as its window manager and reports the empty state as one {"windows":[]} line',
      s1,
      `first stdout line ${first}; screenshot ${shotEmpty}`,
    );

    // S2: a content window is filled to the screen.
    fixture = new Fixture(screen);
    await fixture.ready();
    const dims = await fixture.cmd('screen');
    assert.equal(dims, `screen ${dims.split(' ')[1]} 1280 720`, 'screen is 1280x720');
    const createdA = await fixture.cmd('create 1240x700 name Pricing class probe Google-chrome pid 4711');
    idA = Number(createdA.split(' ')[1]);
    await fixture.cmd(`map ${idA}`);
    const lineA = await keeper.waitForLine(
      (l) => parseWindows(l)?.windows.some((w) => w.id === idA), 5000, 'a report naming window A');
    const wA = parseWindows(lineA).windows.find((w) => w.id === idA);
    const geoA = await fixture.cmd(`geometry ${idA}`);
    const s2 =
      wA.width === 1280 && wA.height === 720 &&
      geoA === `geometry ${idA} 0 0 1280 720` &&
      wA.class === 'Google-chrome' && wA.pid === 4711 && wA.title === 'Pricing';
    const shotFull = screenshot(screen, join(evidenceDir, 'keeper-2-content-fullscreen.png'));
    record(
      'A normal content window (1240x700) is filled to 0,0,1280x720 and reported with its title, class and pid',
      s2,
      `report ${lineA}; fixture ${geoA}; screenshot ${shotFull}`,
    );

    // S3: a tiny helper window is parked off-screen; content stays full.
    const createdB = await fixture.cmd('create 100x80 name Toolbar class probe Emulator-tool pid 4712');
    idB = Number(createdB.split(' ')[1]);
    await fixture.cmd(`map ${idB}`);
    const lineB = await keeper.waitForLine(
      (l) => parseWindows(l)?.windows.some((w) => w.id === idB), 5000, 'a report naming window B');
    const wB = parseWindows(lineB).windows.find((w) => w.id === idB);
    const geoB = await fixture.cmd(`geometry ${idB}`);
    const geoA2 = await fixture.cmd(`geometry ${idA}`);
    const s3 =
      geoB === `geometry ${idB} -30000 -30000 100 80` &&
      wB.width === 100 && wB.height === 80 &&
      geoA2 === `geometry ${idA} 0 0 1280 720`;
    const shotParked = screenshot(screen, join(evidenceDir, 'keeper-3-helper-parked.png'));
    record(
      'A tiny helper window (100x80, the emulator toolbar case) is parked at -30000,-30000 and never reaches the visible screen',
      s3,
      `report ${lineB}; fixture ${geoB}; content still ${geoA2}; screenshot ${shotParked}`,
    );

    // S4 leg 1: the parked helper did not take focus from the newest content window.
    await fixture.focus(`focus ${idA}`, 4000, 'focus after helper parked');
    record(
      'Focus stays on the newest content window after a helper parks (helper is never focused)',
      true,
      `fixture focus command returned focus ${idA}`,
    );

    // S4 leg 2: the newest content window holds focus; report order is bottom-first.
    const createdC = await fixture.cmd('create 1100x640 name Editor class probe Code pid 4713');
    idC = Number(createdC.split(' ')[1]);
    await fixture.cmd(`map ${idC}`);
    const lineC = await keeper.waitForLine(
      (l) => parseWindows(l)?.windows.some((w) => w.id === idC), 5000, 'a report naming window C');
    const order = parseWindows(lineC).windows.map((w) => w.id);
    await fixture.focus(`focus ${idC}`, 4000, 'focus after C mapped');
    record(
      'The newest content window holds the X input focus and the report lists windows bottom-of-stack first, newest last',
      JSON.stringify(order) === JSON.stringify([idA, idB, idC]),
      `focus ${idC}; report order ${order}`,
    );

    // S5: reports track screen changes (unmap/destroy) within the debounce.
    const beforeS5 = keeper.lines.length;
    await fixture.cmd(`destroy ${idB}`);
    await keeper.waitForLine(
      (l) => { const p = parseWindows(l); return p && p.windows.length === 2 && !p.windows.some((w) => w.id === idB); },
      5000, 'a report without the destroyed helper', beforeS5);
    await fixture.cmd(`unmap ${idC}`);
    const lineGone = await keeper.waitForLine(
      (l) => { const p = parseWindows(l); return p && p.windows.length === 1 && p.windows[0].id === idA; },
      5000, 'a report with only window A', beforeS5);
    await fixture.focus(`focus ${idA}`, 4000, 'focus after C unmapped');
    record(
      'Unmapping/destroying windows updates the report within the debounce bound and focus returns to the remaining content window',
      true,
      `final report ${lineGone}; focus ${idA}`,
    );

    // S12: a client resize request is answered with the kiosk geometry.
    const beforeS12 = keeper.lines.length;
    await fixture.cmd(`askgeo ${idA} 800x600`);
    await keeper.waitForLine((l) => parseWindows(l) !== null, 5000, 'a report after the resize request', beforeS12);
    const geoA3 = await fixture.cmd(`geometry ${idA}`);
    record(
      'A client asking for a smaller geometry is answered with the kiosk size, not the requested one',
      geoA3 === `geometry ${idA} 0 0 1280 720`,
      `fixture ${geoA3}`,
    );

    // S6: a second keeper on the same screen is refused.
    const second = startKeeper(screen.display, screen.env());
    const secondExit = await exitWithin(second.exit, 8000);
    const refusal = second.lines.filter((l) => l.includes('"error"'));
    const s6 =
      secondExit?.code === 1 && refusal.length === 1 &&
      refusal[0] === '{"error":"another window manager"}' &&
      keeper.child.exitCode === null;
    record(
      'A second keeper on the same screen refuses with one {"error":"another window manager"} line, exit 1; the first keeper keeps running',
      s6,
      `refusal ${refusal[0] ?? '(none)'}, exit ${JSON.stringify(secondExit)}; first keeper still running`,
    );

    // S7: the display going away is a normal exit 0 with no error line.
    const reportsSoFar = keeper.lines.length;
    await screen.stop();
    const keeperExit = await exitWithin(keeper.exit, 10000);
    const errorLines = keeper.lines.filter((l) => l.includes('"error"'));
    const s7 =
      keeperExit?.code === 0 && keeperExit?.signal === null &&
      errorLines.length === 0 && keeper.lines.length >= reportsSoFar;
    record(
      'Killing the private Xvfb (the screen ending) makes the keeper exit 0 on its own with no error line',
      s7,
      `exit ${JSON.stringify(keeperExit)}; stdout lines ${keeper.lines.length}, none an error`,
    );

    // S8: an unopenable display is refused with one error line, exit 1.
    const refused = startKeeper(screen.display, { ...process.env });
    const refusedExit = await exitWithin(refused.exit, 8000);
    const s8 =
      refusedExit?.code === 1 &&
      refused.lines.length === 1 &&
      /^\{"error":"cannot open X display /.test(refused.lines[0]);
    record(
      'A display that cannot be opened is refused with one {"error":"cannot open X display …"} line and exit 1',
      s8,
      `line ${refused.lines[0] ?? '(none)'}, exit ${JSON.stringify(refusedExit)}`,
    );
  } finally {
    fixture?.stop();
    if (keeper?.child.exitCode === null) keeper.child.kill('SIGTERM');
    if (screen.xvfb.exitCode === null) await screen.stop();
  }

  // S9: a bare `keep` refuses; nothing to hunt for a display.
  {
    const bareProc = spawn(engineBin, ['keep'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const bareLines = [];
    createInterface({ input: bareProc.stdout }).on('line', (l) => bareLines.push(l));
    const bareExit = await new Promise((res) => {
      const t = setTimeout(() => res(null), 8000);
      bareProc.once('close', (code) => { clearTimeout(t); res({ code }); });
    });
    const s9 = bareExit?.code === 1 && bareLines[0] === '{"error":"no display given"}';
    record(
      'A bare `keep` with no --display refuses with {"error":"no display given"} and exit 1 (it never hunts for a screen)',
      s9,
      `line ${bareLines[0] ?? '(none)'}, exit ${JSON.stringify(bareExit)}`,
    );
  }
}

// S7b: the display-gone invariant across startup timing — kill the Xvfb at
// many points between spawn and the first report, plus right after it. The
// contract: the keeper either never connected (one "cannot open" refusal,
// exit 1) or had connected and exits 0 with no error line. Anything else
// (exit 1 without a line, a wrong error, a hang) breaks the contract.
if (scenario === 'all' || scenario === 'race') {
  const attempts = 8;
  const outcomes = [];
  let broken = 0;
  for (let i = 0; i < attempts; i++) {
    const screen = new Screen();
    await screen.ready();
    const keeper = startKeeper(screen.display, screen.env());
    // A few immediate kills try to land before connect; the rest spread
    // across exec/connect/claim/first-report, which this machine does in
    // well under 50 ms.
    const delay = i < 2 ? 0 : Math.floor(Math.random() * 40);
    await sleep(delay);
    screen.xvfb.kill('SIGKILL');
    const exit = await exitWithin(keeper.exit, 8000);
    const errorLines = keeper.lines.filter((l) => l.includes('"error"'));
    let outcome;
    if (exit === null) outcome = 'HANG';
    else if (exit.code === 0 && errorLines.length === 0) outcome = 'exit0';
    else if (
      exit.code === 1 && keeper.lines.length === 1 &&
      /^\{"error":"cannot open X display /.test(keeper.lines[0])
    ) outcome = 'refused-clean';
    else outcome = 'BROKEN';
    if (outcome === 'BROKEN' || outcome === 'HANG') broken++;
    outcomes.push(`${delay}ms→${outcome}(exit=${exit ? exit.code : 'none'},lines=${keeper.lines.length})`);
    await screen.stop();
  }
  // Kill right after the first report: the keeper had certainly connected.
  for (let i = 0; i < 3; i++) {
    const screen = new Screen();
    await screen.ready();
    const keeper = startKeeper(screen.display, screen.env());
    await keeper.waitForLine((l) => parseWindows(l) !== null, 8000, 'the first report');
    screen.xvfb.kill('SIGKILL');
    const exit = await exitWithin(keeper.exit, 8000);
    const errorLines = keeper.lines.filter((l) => l.includes('"error"'));
    const outcome = exit?.code === 0 && errorLines.length === 0 ? 'exit0' : 'BROKEN';
    if (outcome === 'BROKEN') broken++;
    outcomes.push(`after-report→${outcome}(exit=${exit ? exit.code : 'none'})`);
    await screen.stop();
  }
  record(
    `Display-gone contract holds across startup timing (${attempts} random pre-report kills, 3 post-report kills): every run either exits 0 silently or refuses exactly once with "cannot open"`,
    broken === 0,
    outcomes.join('; '),
  );
}

// S10/S11: the TS wrapper (startDisplayKeeper) against the real engine — the
// surface a muxr consumer actually calls.
if (scenario === 'all' || scenario === 'wrapper') {
  const { startDisplayKeeper } = await import(join(engineDir, '..', 'dist', 'keeper.js'));
  const screen = new Screen();
  await screen.ready();
  let windows;
  const exits = [];
  const diagnostics = [];
  let fixture;
  try {
    const keeper = startDisplayKeeper({
      display: screen.display,
      engine: { command: engineBin, args: [] },
      env: screen.env(),
      onWindows: (w) => {
        windows = w;
        note(`      wrapper onWindows: ${JSON.stringify(w)}`);
      },
      onExit: (d) => exits.push(d),
      onDiagnostic: (l) => diagnostics.push(l),
    });
    const until = async (test, ms = 6000, label = 'wrapper callback') => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = test();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`never saw ${label}`);
        await sleep(25);
      }
    };
    await until(() => windows !== undefined, 8000, 'the empty first report');
    const emptyOk = windows.length === 0 && exits.length === 0;

    fixture = new Fixture(screen);
    await fixture.ready();
    const created = await fixture.cmd('create 1240x700 name Probe class probe Google-chrome pid 4242');
    const id = Number(created.split(' ')[1]);
    await fixture.cmd(`map ${id}`);
    await until(
      () => windows?.some((w) => w.class === 'Google-chrome' && w.pid === 4242 && w.width === 1280),
      8000, 'a live window report through the wrapper',
    );
    const liveOk = exits.length === 0; // still running while reporting
    await keeper.stop();
    await until(() => exits.length === 1, 5000, 'the exit detail after stop()');
    const stopExit = exits[0];
    record(
      'startDisplayKeeper drives the real engine: empty report first, then live window reports (class/title/pid/size), still alive while reporting, and stop() ends it with one exit detail',
      emptyOk && liveOk && windows.length === 1,
      `reports through onWindows; stop() exit ${JSON.stringify(stopExit)}`,
    );

    // S11: a refusal surfaces on the exit detail when the display cannot open.
    assert(!existsSync('/tmp/.X11-unix/X250'), 'display :250 unexpectedly in use');
    let refusedExit;
    const refused = startDisplayKeeper({
      display: ':250',
      engine: { command: engineBin, args: [] },
      env: { ...process.env },
      onExit: (d) => (refusedExit = d),
    });
    await until(() => refusedExit !== undefined, 8000, 'the refusal exit detail');
    record(
      'A wrapper whose display cannot open delivers the refusal on the exit detail (code 1, error set)',
      refusedExit?.code === 1 && /cannot open X display/.test(refusedExit?.error ?? ''),
      `onExit ${JSON.stringify(refusedExit)}`,
    );
  } finally {
    fixture?.stop();
    if (screen.xvfb.exitCode === null) await screen.stop();
  }
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.result === 'fail');
note(`=== ${results.length - failed.length}/${results.length} scenarios passed ===`);
log.end();
console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
