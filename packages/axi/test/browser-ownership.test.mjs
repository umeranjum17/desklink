// Persisted browser state is the public CLI contract under test. These are
// owned Node process fixtures, not browser/platform qualification.
import { expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/desklink-axi.js', import.meta.url));
it.skipIf(process.platform !== 'linux')('refuses stale/unowned browser state before contact or cleanup, and stops the matching owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desklink-browser-owner-'));
  const profile = join(dir, 'profile');
  mkdirSync(profile);
  writeFileSync(join(profile, 'keep'), 'owned fixture');
  const marker = 'unit-owned-browser-' + dir;
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    env: { ...process.env, DESKLINK_AXI_BROWSER_SESSION: marker }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    const started = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
    const statePath = join(dir, 'desklink-axi', 'ownership-test.browser.json');
    mkdirSync(join(dir, 'desklink-axi'));
    const state = { endpoint: `127.0.0.1:${server.address().port}`, launched: true, pid: child.pid,
      pidStarted: started, browserSession: marker, profile, profileCreated: true };
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], {
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', TMPDIR: dir, XDG_RUNTIME_DIR: dir, DESKLINK_AXI_SESSION: 'ownership-test' },
      encoding: 'utf8', timeout: 4000,
    });
    for (const invalid of [{ ...state, pidStarted: 'wrong-start' }, { ...state, pidStarted: undefined }]) {
      writeFileSync(statePath, JSON.stringify(invalid));
      for (const command of ['tabs', 'detach', 'launch']) {
        const result = run('browser', command, ...(command === 'launch' ? ['--executable', process.execPath] : []));
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('refusing stale or unowned process identity');
        expect(() => process.kill(child.pid, 0)).not.toThrow();
        expect(readFileSync(join(profile, 'keep'), 'utf8')).toBe('owned fixture');
        expect(existsSync(statePath)).toBe(true);
      }
    }
    expect(requests).toBe(0);
    writeFileSync(statePath, JSON.stringify(state));
    const result = run('browser', 'detach');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    await exited; // spawnSync held this parent until the child was a zombie.
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
