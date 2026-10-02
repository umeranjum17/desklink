// Shared ownership checks extracted from AXI's private-Xvfb flow. No desktop
// connection is made here; /proc proves the listener before any client starts.
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function assertNoAmbientDesktop(env = process.env) {
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    assert(!env[name], `private lab refuses ambient ${name}; unset it before running this test`);
  }
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
