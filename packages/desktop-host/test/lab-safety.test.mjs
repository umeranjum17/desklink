import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoAmbientDesktop } from './lab-safety.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  'packages/axi/test/flow.mjs', 'packages/axi/test/smoke.mjs',
  'packages/axi/test/browser-flow.mjs', 'packages/axi/test/a11y-flow.mjs',
  'packages/axi/test/bench.mjs', 'packages/desktop-host/test/lab-safety-flow.mjs', 'packages/desktop-host/test/g2g-flow.mjs',
  'packages/desktop-host/test/portal-g2g-flow.mjs', 'packages/desktop-host/test/encoded-flow.mjs',
  'packages/desktop-host/engine/test/keeper-flow.mjs',
  'packages/desktop-client/test/reconnect-flow.mjs', 'packages/desktop-client/test/ios-flow.mjs',
];

it('allows unit checks with no desktop and refuses either ambient desktop variable', () => {
  expect(() => assertNoAmbientDesktop({})).not.toThrow();
  expect(() => assertNoAmbientDesktop({ DISPLAY: '', WAYLAND_DISPLAY: '' })).not.toThrow();
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    expect(() => assertNoAmbientDesktop({ [key]: 'not-a-real-display' })).toThrow(`refuses ambient ${key}`);
  }
});

it.each(entries)('%s refuses before commands, builds, skips or desktop contact', (entry) => {
  const dir = mkdtempSync(join(tmpdir(), 'desklink-refusal-'));
  try {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY']) {
      // No live endpoint is supplied, even if a regression bypasses the guard.
      const env = { ...process.env, PATH: '', HOME: dir, XDG_RUNTIME_DIR: dir,
        DISPLAY: '', WAYLAND_DISPLAY: '', DESKLINK_IOS_MAC: '',
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/no-bus`, AT_SPI_BUS_ADDRESS: `unix:path=${dir}/no-a11y`,
        [key]: key === 'DISPLAY' ? ':1048575' : `${dir}/no-wayland` };
      const result = spawnSync(process.execPath, [join(root, entry)], { cwd: root, env, encoding: 'utf8', timeout: 4000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`private lab refuses ambient ${key}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 4000 }).stdout?.trim();
it.skipIf(!python)('Wayland point flow refuses before dependencies, files or compositor contact', () => {
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    const result = spawnSync(python, [join(root, 'packages/desktop-host/engine/test/point-wayland-flow.py')], {
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', [key]: 'not-a-real-display' }, encoding: 'utf8', timeout: 4000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`private lab refuses ambient ${key}`);
  }
});

it('refuses direct execution of the portal cage outside its owned PID namespace', () => {
  const result = spawnSync(process.execPath, [join(root, 'packages/desktop-host/test/portal-g2g-flow.mjs'), '--cage', '/nonexistent'], {
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }, encoding: 'utf8', timeout: 4000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('portal cage must be the init of its private PID namespace');
});
