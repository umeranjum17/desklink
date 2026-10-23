// Runs only inside flow.mjs's verified, task-owned X server (DESKLINK_CARET_FLOW=1).
// A native GTK entry: the text caret must not be read as a pipe right after typing.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

export async function caretFlow({ run, env, verifyXvfb, remember }) {
  const evidence = process.env.DESKLINK_OCR_EVIDENCE;
  assert(evidence, 'set DESKLINK_OCR_EVIDENCE');
  mkdirSync(evidence, { recursive: true });
  const script = resolve('packages/axi/test/fixtures/caret-entry.py');
  await verifyXvfb();
  const app = spawn('python3', ['-I', script], { env: { ...env, GDK_BACKEND: 'x11', GDK_SCALE: '1', GDK_DPI_SCALE: '1', NO_AT_BRIDGE: '1' }, stdio: 'ignore' });
  await new Promise((resolve, reject) => { app.once('spawn', resolve); app.once('error', reject); });
  remember(app.pid, 'caret-entry.py');
  const rows = out => out.split('\n').filter(l => /^  "@/.test(l)).map(l => JSON.parse(`[${l.trim()}]`));
  try {
    await new Promise(r => setTimeout(r, 2000));
    await run('start', '--control', '--source', 'x11', '--display', env.DISPLAY);
    // Click right of where the text will go: the pointer cue freezes the pixels under it.
    await run('click', '400,77');
    await run('type', 'Notes on remote desktops', '--wait', 'settle');
    const out = await run('screen', '--full');
    writeFileSync(join(evidence, 'native-entry-screen.txt'), out);
    await run('look', '--out', join(evidence, 'native-entry.png'));
    assert(rows(out).some(row => row[1] === 'Notes on remote desktops'), `caret read as text: ${out}`);
    await run('stop');
  } finally { app.kill('SIGTERM'); }
}
