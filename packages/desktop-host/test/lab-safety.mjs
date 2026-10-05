// Shared ownership checks extracted from AXI's private-Xvfb flow. No desktop
// connection is made here; /proc proves the listener before any client starts.
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function assertNoAmbientDesktop(env = process.env) {
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    assert(!env[name], `private lab refuses ambient ${name}; unset it before running this test`);
  }
}

// ---------------------------------------------------------------- lane paths
// One family, one guard: a lane's artefacts live under its own task-scoped lab
// directory and a lane's private display is claimed atomically, so two lanes
// starting at the same moment can never read, overwrite or delete each other.

/**
 * The lane's own lab root, `~/lab-tmp/<lane>/`. `DESKLINK_LANE` is the task id
 * a lane is dispatched under; with none, the lane is named for its own pid, so
 * two lanes never share a root and never write a predictable shared name.
 */
export function laneRoot(env = process.env) {
  const lane = env.DESKLINK_LANE ?? `pid-${process.pid}`;
  assert.match(lane, /^[\w][\w.-]*$/, 'DESKLINK_LANE names this lane: letters, digits, . _ -');
  return join(env.HOME ?? homedir(), 'lab-tmp', lane);
}

/**
 * A fresh directory for one kind of artefact inside the lane's own root. It
 * refuses an existing path, so a second run never lands on the first run's
 * evidence. Returns the directory; the caller creates what goes in it.
 */
export function laneArtefactDir(purpose, env = process.env) {
  assert.match(purpose, /^[\w][\w.-]*$/, 'an artefact kind is a plain name, never a path');
  const parent = join(laneRoot(env), purpose);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Never a name another run holds: the timestamp carries this lane's pid, and
  // two calls in the same millisecond take the next free suffix rather than
  // landing on a directory that already has artefacts in it.
  const stem = `${new Date().toISOString().replace(/:/g, '')}-${process.pid}`;
  for (let attempt = 1; ; attempt++) {
    const dir = join(parent, attempt === 1 ? stem : `${stem}-${attempt}`);
    try { mkdirSync(dir, { mode: 0o700 }); return dir; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

/**
 * Claim one private X display for this lane, atomically. Reading
 * `/tmp/.X<n>-lock` and then starting Xvfb on it is a race: two lanes starting
 * at the same moment both saw the number free and only one server came up.
 * The claim is a directory, because `mkdir` is the one atomic primitive here
 * that does not collide with the X server's own lock file. Release it when the
 * lane is done; a claim whose owner is gone is reclaimed automatically.
 */
export function claimPrivateDisplay({ from = 170, count = 30 } = {}) {
  const root = join(tmpdir(), 'desklink-display-claims');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const identity = `${process.pid} ${proc(process.pid)?.started ?? ''}`;
  for (let number = from; number < from + count; number++) {
    const claim = join(root, String(number));
    let held = false;
    try { mkdirSync(claim); held = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let raw = null;
      try { raw = readFileSync(join(claim, 'pid'), 'utf8').trim().split(/\s+/); } catch { continue; }
      const owner = Number(raw[0]);
      if (!Number.isInteger(owner) || owner <= 1) continue;
      if (owner === process.pid) continue;
      const state = proc(owner);
      if (state && state.state !== 'Z' && (raw.length < 2 || raw[1] === '' || String(state.started) === raw[1])) continue;
      rmSync(claim, { recursive: true, force: true });
      try { mkdirSync(claim); held = true; } catch { continue; }
    }
    writeFileSync(join(claim, 'pid'), identity);
    // X claimed it first (a display outside this range, or a leftover server):
    // give it back and take the next number.
    if (existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`)) {
      rmSync(claim, { recursive: true, force: true });
      continue;
    }
    let released = false;
    return {
      number, display: `:${number}`,
      release() {
        if (!released && held) {
          released = true;
          try {
            const raw = readFileSync(join(claim, 'pid'), 'utf8').trim().split(/\s+/);
            if (Number(raw[0]) !== process.pid) return;
            if (raw[1] !== undefined && raw[1] !== '' && String(proc(process.pid)?.started) !== raw[1]) return;
          } catch { return; }
          rmSync(claim, { recursive: true, force: true });
        }
      },
    };
  }
  throw new Error(`no unclaimed private X display in ${from}..${from + count - 1}`);
}

function proc(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ');
    return { state: fields[0], parent: Number(fields[1]), started: fields[19] };
  } catch { return undefined; }
}

const servers = new WeakMap();
export function trackOwnedXvfb(child, display) {
  assert(child instanceof ChildProcess && child.pid > 1, 'expected a spawned Xvfb child');
  assert.equal(basename(child.spawnargs[0]), 'Xvfb', 'expected an Xvfb executable');
  assert(/^:\d+$/.test(display) && Number(display.slice(1)) >= 170, 'expected a private high display');
  assert.equal(child.spawnargs[1], display, 'Xvfb display does not match');
  const state = proc(child.pid);
  assert.equal(state?.parent, process.pid, 'Xvfb is not our child');
  assert(!servers.has(child), 'Xvfb already tracked');
  servers.set(child, {
    started: state.started, display,
    socket: `/tmp/.X11-unix/X${display.slice(1)}`,
    lock: `/tmp/.X${display.slice(1)}-lock`, files: [],
  });
}

export async function verifyOwnedXvfb(child) {
  const server = servers.get(child);
  assert(server, 'Xvfb was not recorded at spawn');
  for (let i = 0; i < 100 && !existsSync(server.socket) && child.exitCode === null; i++) await sleep(50);
    assert.equal(proc(child.pid)?.started, server.started, 'Xvfb PID changed or exited');
    assert.equal(proc(child.pid)?.parent, process.pid, 'Xvfb is not our child');
    assert.equal(basename(readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')[0]), 'Xvfb', 'not an Xvfb server');
    assert.equal(Number(readFileSync(server.lock, 'utf8').trim()), child.pid, 'X lock belongs to another server');
    const listeners = readFileSync('/proc/net/unix', 'utf8').split('\n').filter(line => {
      const fields = line.trim().split(/\s+/);
      return line.endsWith(` ${server.socket}`) && (parseInt(fields[3], 16) & 0x10000) !== 0;
    });
    const fds = readdirSync(`/proc/${child.pid}/fd`).map(fd => {
      try { return readlinkSync(`/proc/${child.pid}/fd/${fd}`); } catch { return ''; }
    });
    assert(listeners.some(line => fds.includes(`socket:[${line.trim().split(/\s+/)[6]}]`)), 'X listener is not held by our Xvfb');
    const socket = lstatSync(server.socket), lock = lstatSync(server.lock);
    assert(socket.isSocket() && lock.isFile() && socket.uid === process.getuid() && lock.uid === process.getuid(), 'unexpected X socket/lock owner or type');
    if (!server.files.length) server.files = [[server.socket, socket], [server.lock, lock]];
    for (const [path, original] of server.files) {
      const current = lstatSync(path);
      assert(current.dev === original.dev && current.ino === original.ino, 'X socket/lock identity changed');
    }
}

export async function stopOwnedXvfb(child) {
  const server = servers.get(child);
  assert(server, 'refusing to stop an unrecorded Xvfb');
  const alive = () => {
    const state = proc(child.pid);
    return state?.started === server.started && state.state !== 'Z';
  };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!alive()) break;
    child.kill(signal);
    for (let i = 0; i < 40 && alive(); i++) await sleep(50);
  }
  assert(!alive(), 'our Xvfb survived cleanup');
  // SIGKILL leaves files behind. A replacement PID/lock is never ours, even
  // if the filesystem reused an inode from our now-dead server.
  const currentProcess = proc(child.pid);
  if (currentProcess && currentProcess.started !== server.started) return;
  if (!existsSync(server.lock) || Number(readFileSync(server.lock, 'utf8').trim()) !== child.pid) return;
  const originalLock = server.files.find(([path]) => path === server.lock)?.[1];
  if (!originalLock) return;
  const currentLock = lstatSync(server.lock);
  if (currentLock.dev !== originalLock.dev || currentLock.ino !== originalLock.ino) return;
  for (const [path, original] of server.files) {
    if (!existsSync(path)) continue;
    const current = lstatSync(path);
    if (current.dev !== original.dev || current.ino !== original.ino) continue;
    if (path === server.lock && Number(readFileSync(path, 'utf8').trim()) !== child.pid) continue;
    unlinkSync(path);
  }
}
