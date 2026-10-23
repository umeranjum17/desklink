// Runs only inside flow.mjs's verified, task-owned X server (DESKLINK_CARET_FLOW=1).
// A native GTK entry: the text caret must not be read as a pipe right after typing.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

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
    // The picture a user sees: the browser client showing this live desktop.
    const bridge = spawn(process.execPath, [resolve('packages/desktop-host/bin/desklink-host.mjs'), 'bridge', '--source', 'x11', '--display', env.DISPLAY, '--listen', '127.0.0.1:0'], { env: { ...env, DESKLINK_ENGINE: env.DESKLINK_AXI_ENGINE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let bridgeOut = '';
    bridge.stdout.on('data', c => { bridgeOut += c; });
    remember(bridge.pid, 'bridge');
    let context;
    const profile = mkdtempSync(join(tmpdir(), 'desklink-caret-client-'));
    try {
      for (let i = 0; i < 300 && !/^open\s+http/m.test(bridgeOut); i++) await new Promise(r => setTimeout(r, 50));
      const url = /^open\s+(http\S+)/m.exec(bridgeOut)?.[1];
      assert(url, 'bridge did not print its URL');
      context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium', headless: true, viewport: { width: 1340, height: 860 }, env: { ...process.env, DISPLAY: '' } });
      const page = context.pages()[0];
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => { const v = document.querySelector('#video'); return v?.videoWidth === 1280 && v.readyState >= 2; }, null, { timeout: 45000 });
      await new Promise(r => setTimeout(r, 1500));
      await page.screenshot({ path: join(evidence, 'native-entry.png') });
    } finally { await context?.close().catch(() => {}); bridge.kill('SIGTERM'); rmSync(profile, { recursive: true, force: true }); }
    assert(rows(out).some(row => row[1] === 'Notes on remote desktops'), `caret read as text: ${out}`);
    const version = JSON.parse(readFileSync(resolve('packages/axi/package.json'), 'utf8')).version;
    writeFileSync(join(evidence, '..', 'steps.json'), JSON.stringify({
      target: { version: `desklink-axi ${version}` },
      start: 'A native text entry in an empty private display',
      steps: ['click the text entry', 'type "Notes on remote desktops" and wait for the screen to settle', 'read the whole screen'],
      result: 'The screen read returns "Notes on remote desktops" with no caret read as a pipe',
    }, null, 2) + '\n');
    await run('stop');
  } finally { app.kill('SIGTERM'); }
}
