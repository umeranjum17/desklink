// Ownership/refusal/cleanup proof only: no capture or input, no live endpoint.
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from './lab-safety.mjs';

assertNoAmbientDesktop();
assert.equal(process.platform, 'linux', 'owned-Xvfb proof requires Linux');
const dir = mkdtempSync(join(tmpdir(), 'desklink-lab-safety-'));
const number = Array.from({ length: 30 }, (_, i) => 170 + i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`, socket = `/tmp/.X11-unix/X${number}`, lock = `/tmp/.X${number}-lock`;
const authority = join(dir, 'Xauthority'), children = [];

async function start() {
  assert(!existsSync(socket) && !existsSync(lock), 'refusing an occupied display');
  const auth = spawnSync('xauth', ['-f', authority, 'add', display, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' });
  assert.equal(auth.status, 0, auth.stderr);
  const child = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  trackOwnedXvfb(child, display);
  children.push(child);
  console.log('owned-Xvfb', JSON.stringify({ pid: child.pid, display, dir }));
  await verifyOwnedXvfb(child);
  return child;
}
function gone(child) {
  assert(!existsSync(`/proc/${child.pid}`), `owned PID ${child.pid} survived`);
  assert(!existsSync(socket) && !existsSync(lock), 'owned socket/lock survived');
}

try {
  const failed = await start();
  await assert.rejects(async () => {
    try { throw new Error('injected workload failure'); }
    finally { await stopOwnedXvfb(failed); }
  }, /injected workload failure/);
  gone(failed);

  const stopped = await start();
  stopped.kill('SIGSTOP'); // Forces bounded SIGKILL fallback, with stale files.
  await stopOwnedXvfb(stopped);
  gone(stopped);

  const replacement = await start();
  const originalLock = readFileSync(lock, 'utf8');
  await stopOwnedXvfb(stopped); // Old ownership must not affect a new server.
  assert.equal(readFileSync(lock, 'utf8'), originalLock);
  await verifyOwnedXvfb(replacement);
  const unrecorded = new ChildProcess();
  unrecorded.pid = replacement.pid;
  await assert.rejects(stopOwnedXvfb(unrecorded), /unrecorded Xvfb/);
  await assert.rejects(verifyOwnedXvfb(unrecorded), /not recorded at spawn/);
  await verifyOwnedXvfb(replacement);

  // A wrong lock refuses verification without contacting that named PID.
  // This test created the lock and restores its own bytes for final cleanup.
  const lockMode = statSync(lock).mode & 0o777;
  chmodSync(lock, 0o600); // Xvfb creates its own lock read-only.
  writeFileSync(lock, String(process.pid));
  await assert.rejects(verifyOwnedXvfb(replacement), /X lock belongs to another server/);
  assert.equal(Number(readFileSync(lock, 'utf8')), process.pid, 'unknown lock was changed');
  writeFileSync(lock, originalLock);
  chmodSync(lock, lockMode);
  await stopOwnedXvfb(replacement);
  gone(replacement);
  console.log(JSON.stringify({ safety: 'passed', display, owned_pids: children.map(child => child.pid),
    cases: ['failure cleanup', 'SIGKILL fallback', 'replacement preserved', 'unrecorded PID refused', 'wrong lock refused'] }));
} finally {
  for (const child of children) await stopOwnedXvfb(child);
  rmSync(dir, { recursive: true, force: true });
}
