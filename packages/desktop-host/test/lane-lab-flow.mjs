#!/usr/bin/env node
// Two lanes, one host, the same moment: proof that lane isolation holds.
//
// No desktop is contacted and no X server is started. The helpers are the same
// ones every flow uses; this proves the naming, that a lane never lands on a
// path another run holds, and that concurrent lanes get one display each.
//
// Usage: node packages/desktop-host/test/lane-lab-flow.mjs [evidence-dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimPrivateDisplay, laneArtefactDir } from './lab-safety.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const worker = (name) => join(repo, 'packages/desktop-host/test', name);
const out = resolve(process.argv[2] ?? join(mkdtempSync(join(tmpdir(), 'desklink-lane-lab-out-')), 'evidence'));
mkdirSync(out, { recursive: true });
// A throwaway HOME: this proof writes lab roots, never the real ~/lab-tmp.
const home = mkdtempSync(join(tmpdir(), 'desklink-lane-lab-home-'));

const result = { out, home, lanes: {}, displays: {}, outcome: 'FAIL' };
const start = (script, env) => new Promise((done, fail) => {
  const child = spawn(process.execPath, [script], { cwd: repo, env: { ...process.env, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', fail);
  child.on('close', code => done({ code, stdout, stderr }));
});

try {
  // 1. Two lanes started in the same tick, each staging its whole receipt.
  const stage = (taskId) => start(worker('lane-worker.mjs'), { DESKLINK_LANE: taskId })
    .then(run => { assert.equal(run.code, 0, `lane ${taskId} failed: ${run.stderr}`); return { ...JSON.parse(run.stdout), receipt: run.stdout }; });
  const [a, b] = await Promise.all([stage('dl-lane-a'), stage('dl-lane-b')]);
  result.lanes = { a, b };
  assert.equal(a.root, join(home, 'lab-tmp', 'dl-lane-a'));
  assert.equal(b.root, join(home, 'lab-tmp', 'dl-lane-b'));
  assert.notEqual(a.artefact, b.artefact, 'two lanes share an artefact directory');
  assert.equal(readFileSync(join(a.artefact, 'receipt.json'), 'utf8'), a.receipt, "lane A's artefact was overwritten");
  assert.equal(readFileSync(join(b.artefact, 'receipt.json'), 'utf8'), b.receipt, "lane B's artefact was overwritten");
  // Neither lane's own output names the other's path: nothing addressed it.
  assert(!a.receipt.includes('dl-lane-b') && !b.receipt.includes('dl-lane-a'), 'a lane addressed the other lane');

  // 2. A lane's artefact path is never reused, and never leaves its own root.
  const fresh = Array.from({ length: 5 }, () => laneArtefactDir('reuse-probe', { HOME: home, DESKLINK_LANE: 'dl-lane-a' }));
  assert.equal(new Set(fresh).size, 5, `two runs shared an artefact directory: ${fresh.join(',')}`);
  assert(fresh.every(dir => dir.startsWith(join(home, 'lab-tmp', 'dl-lane-a'))), 'an artefact escaped the lane root');
  assert.throws(() => laneArtefactDir('../escape', { HOME: home, DESKLINK_LANE: 'dl-lane-a' }), /plain name/);
  assert.throws(() => laneArtefactDir('ok', { HOME: home, DESKLINK_LANE: 'no spaces or /' }), /DESKLINK_LANE/);

  // 3. Eight lanes claim a display in the same tick: one number each.
  const claims = await Promise.all(Array.from({ length: 8 }, () => start(worker('lane-claim.mjs'))));
  assert.deepEqual(claims.map(claim => claim.code), Array(8).fill(0), claims.map(c => c.stderr).join('\n'));
  const held = claims.map(claim => JSON.parse(claim.stdout));
  const numbers = held.map(claim => claim.number);
  // Every claim was held while every other one was taken: the eight spans overlap.
  result.displays = { numbers, distinct: new Set(numbers).size, firstFrom: Math.min(...held.map(c => c.from)),
    lastFrom: Math.max(...held.map(c => c.from)) };
  assert.equal(new Set(numbers).size, 8, `two lanes claimed the same display: ${numbers.join(',')}`);
  assert(result.displays.lastFrom - result.displays.firstFrom < 1500, 'the eight claims did not overlap in time');
  assert(!existsSync(join(tmpdir(), 'desklink-display-claims', String(numbers[0]))), 'a released claim stayed held');
  // A claim whose owner is gone (a killed lane) is reclaimed, not lost forever.
  mkdirSync(join(tmpdir(), 'desklink-display-claims', '901'), { recursive: true });
  writeFileSync(join(tmpdir(), 'desklink-display-claims', '901', 'pid'), String(2 ** 22 - 1));
  const reclaimed = claimPrivateDisplay({ from: 901, count: 1 });
  assert.equal(reclaimed.display, ':901');
  reclaimed.release();
  assert.throws(() => claimPrivateDisplay({ from: 901, count: 0 }), /no unclaimed private X display/);

  // 4. One ordinary lane, alone, is unchanged.
  const solo = await stage('dl-lane-solo');
  result.solo = solo;
  assert.equal(solo.root, join(home, 'lab-tmp', 'dl-lane-solo'));
  assert.equal(readFileSync(join(solo.artefact, 'evidence.txt'), 'utf8'), 'dl-lane-solo evidence\n');
  assert.match(solo.display, /^:(1[7-9]\d|[2-9]\d\d)$/, `the solo lane lost its private display: ${solo.display}`);

  result.outcome = 'PASS';
} catch (error) {
  result.error = String(error.stack ?? error);
  console.error(result.error);
} finally {
  writeFileSync(join(out, 'lane-lab.json'), `${JSON.stringify(result, null, 2)}\n`);
  rmSync(home, { recursive: true, force: true });
}
assert.equal(result.outcome, 'PASS', `lane isolation failed; inspect ${join(out, 'lane-lab.json')}`);
console.log(`PASS: two lanes at one moment, no shared path; evidence ${out}`);