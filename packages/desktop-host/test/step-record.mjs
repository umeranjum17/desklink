// The done-done step record (steps.json): what a user did in a passing journey
// and what they saw at the end, written beside the captures done-done judges.
// It goes to $DONE_DONE_EVIDENCE_ROOT when done-done runs the journey, else
// into the helper's own evidence directory. A journey that chains two helpers
// (`verify`) gets one record: the second helper appends its steps and result.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function recordSteps(evidenceDir, { start, steps, result }) {
  const file = join(process.env.DONE_DONE_EVIDENCE_ROOT ?? evidenceDir, 'steps.json');
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const { version } = JSON.parse(readFileSync(join(repo, 'packages/desktop-host/package.json'), 'utf8'));
  const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const record = prior
    ? { ...prior, steps: [...prior.steps, `Then, from ${start}:`, ...steps], result: `${prior.result} ${result}` }
    : { target: { version: `desklink ${version} at ${head}` }, start, steps, result };
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}
