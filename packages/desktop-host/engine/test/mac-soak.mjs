// Run against a consented macOS engine session's PID, without opening another capture prompt.
// Example: node packages/desktop-host/engine/test/mac-soak.mjs <engine-pid>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

assert.equal(process.platform, 'darwin', 'run this on the macOS host');
const pid = Number(process.argv[2]);
assert(Number.isSafeInteger(pid) && pid > 0, 'pass the live engine PID');
const samples = [];
for (let n = 0; n <= 30; n++) {
  const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  assert(Number.isFinite(rss) && rss > 0, `engine ${pid} exited at sample ${n}`);
  samples.push(rss);
  console.log(`${new Date().toISOString()} ${rss} KB`);
  if (n < 30) await setTimeout(10_000);
}
const min = Math.min(...samples), max = Math.max(...samples);
assert(max <= 2 * 1024 * 1024 && max - min <= 512 * 1024,
  `engine RSS grew beyond bound: ${min}..${max} KB`);
console.log(`5-minute capture soak passed: RSS ${min}..${max} KB`);
