import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// The journey this covers: two lanes staging their artefacts at the same moment
// on one host, neither able to read, overwrite or delete the other's, and one
// ordinary lane alone still working exactly as before.
it('keeps two lanes apart while they stage at the same moment', () => {
  const out = mkdtempSync(join(tmpdir(), 'desklink-lane-lab-run-'));
  try {
    const run = spawnSync(process.execPath, [join(root, 'packages/desktop-host/test/lane-lab-flow.mjs'), out], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
    });
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('PASS: two lanes at one moment');
    expect(run.status).toBe(0);
  } finally { rmSync(out, { recursive: true, force: true }); }
}, 150000);