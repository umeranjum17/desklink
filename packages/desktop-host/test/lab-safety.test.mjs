import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  'packages/axi/test/flow.mjs', 'packages/axi/test/smoke.mjs',
  'packages/axi/test/browser-flow.mjs', 'packages/axi/test/a11y-flow.mjs',
  'packages/axi/test/bench.mjs', 'packages/desktop-host/test/lab-safety-flow.mjs', 'packages/desktop-host/test/g2g-flow.mjs',
  'packages/desktop-host/test/portal-g2g-flow.mjs', 'packages/desktop-host/test/encoded-flow.mjs',
  'packages/desktop-host/engine/test/keeper-flow.mjs',
  'packages/desktop-client/test/reconnect-flow.mjs', 'packages/desktop-client/test/ios-flow.mjs',
];

// Starting a Python interpreter is the slowest thing these checks do: a cold
// hosted runner loads the runtime and stdlib before the flow's own refusal
// guard can run, and that start has nothing to do with what the test proves.
// This bounds a hung interpreter, not a slow one, so it is far above any real
// start; the Python section below waits on the same budget for both of its spawns.
const INTERPRETER_DEADLINE_MS = 60_000;

const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: INTERPRETER_DEADLINE_MS }).stdout?.trim();

// The journey: someone starts any lab flow from a shell that has a live desktop.
// Every flow must refuse before commands, builds, skips or desktop contact.
it('every lab flow refuses an ambient desktop before touching it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desklink-refusal-'));
  try {
    for (const entry of entries) {
      for (const key of ['DISPLAY', 'WAYLAND_DISPLAY']) {
        // No live endpoint is supplied, even if a regression bypasses the guard.
        const env = { ...process.env, PATH: '', HOME: dir, XDG_RUNTIME_DIR: dir,
          DISPLAY: '', WAYLAND_DISPLAY: '', DESKLINK_IOS_MAC: '',
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/no-bus`, AT_SPI_BUS_ADDRESS: `unix:path=${dir}/no-a11y`,
          [key]: key === 'DISPLAY' ? ':1048575' : `${dir}/no-wayland` };
        const result = spawnSync(process.execPath, [join(root, entry)], { cwd: root, env, encoding: 'utf8', timeout: 4000 });
        expect(result.error, entry).toBeUndefined();
        expect(result.status, entry).toBe(1);
        expect(result.stdout, entry).toBe('');
        expect(result.stderr, entry).toContain(`private lab refuses ambient ${key}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // The Wayland point flow is a Python script; it refuses before dependencies, files or compositor contact.
  if (python) {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY']) {
      const result = spawnSync(python, [join(root, 'packages/desktop-host/engine/test/point-wayland-flow.py')], {
        env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', [key]: 'not-a-real-display' }, encoding: 'utf8', timeout: INTERPRETER_DEADLINE_MS,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`private lab refuses ambient ${key}`);
    }
  }

  // The portal cage refuses direct execution outside its owned PID namespace.
  const cage = spawnSync(process.execPath, [join(root, 'packages/desktop-host/test/portal-g2g-flow.mjs'), '--cage', '/nonexistent'], {
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }, encoding: 'utf8', timeout: 4000,
  });
  expect(cage.error).toBeUndefined();
  expect(cage.status).toBe(1);
  expect(cage.stderr).toContain('portal cage must be the init of its private PID namespace');
}, INTERPRETER_DEADLINE_MS * 3);
