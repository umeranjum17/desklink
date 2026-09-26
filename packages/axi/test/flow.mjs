// Linux integration proof: all capture/input is confined to a private Xvfb.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineClient } from '@desklink/host';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-flow-'));
const display = `:${180 + process.pid % 60}`;
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to this task’s built engine');
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
const env = { ...process.env, DISPLAY: display, DESKLINK_AXI_SESSION: `flow-${process.pid}`, DESKLINK_AXI_ENGINE: enginePath };
const cli = resolve('packages/axi/bin/desklink-axi.js');
let client;
let target;
let events = '';
const observations = [];
async function run(...args) {
  const child = spawn(process.execPath, [cli, ...args], { env });
  let out = ''; for await (const part of child.stdout) out += part;
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, `${args.join(' ')}: ${out}`);
  observations.push({ command: args.join(' '), output: out }); return out;
}
try {
  await new Promise(r => setTimeout(r, 500));
  client = await EngineClient.start(enginePath, ['serve'], {}, env);
  const session = await client.openSession({ source: {kind:'x11',display}, permissions:['view'] });
  const path = join(dir, 'frame.raw');
  let first;
  for (let i=0;i<40;i++) { try { first = await client.request('session.frame',{session_id:session.sessionId,path}); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  assert(first?.seq > 0);
  const original = readFileSync(path);
  const build = spawn('cargo', ['build','-q','--manifest-path','packages/desktop-host/engine/Cargo.toml','--example','x11_target'], { env, stdio:'ignore' });
  assert.equal(await new Promise(r=>build.on('exit',r)),0,'X client builds');
  const example = join(process.env.CARGO_TARGET_DIR ?? 'packages/desktop-host/engine/target','debug','examples','x11_target');
  target = spawn(example, [], { env, stdio:['ignore','pipe','pipe'] });
  target.stdout.on('data', chunk => events += chunk);
  for (let i=0;i<60;i++) { if (target.exitCode !== null) throw Error('X test client exited'); await new Promise(r=>setTimeout(r,100)); const f = await client.request('session.frame',{session_id:session.sessionId,since:first.seq,path}); if (f.seq > first.seq) { assert(f.damage.length > 0); assert.notDeepEqual(readFileSync(path),original); break; } if (i===59) throw Error('frame never changed'); }
  await client.stop(); client = undefined;
  const started = await run('start','--control','--source','x11','--display',display);
  assert.match(started,/permissions=view,control/);
  const before = await run('diff'); assert.match(before,/changed:/);
  const clicked = await run('click','100,100'); assert.match(clicked,/changed: [1-9]/);
  const looked = await run('look','@r1'); assert.match(looked,/image: .*\.png/);
  const imagePath = /image: (.*\.png)/.exec(looked)?.[1];
  assert(imagePath && readFileSync(imagePath).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const typed = await run('type','abc'); assert.match(typed,/changed:/);
  assert.match(events, /"kind":"button".*"phase":"up"/);
  assert.match(events, /"kind":"key".*"phase":"down"/);
  await run('stop');
  assert.match(await run('start','--source','x11','--display',display),/permissions=view\n/);
  assert.match(await run('screen','--query','zebra'),/0 items match "zebra"/);
  await run('stop');
  if (process.env.DESKLINK_AXI_MEASURE_PATH) writeFileSync(process.env.DESKLINK_AXI_MEASURE_PATH,JSON.stringify(observations));
  console.log('engine: frame bytes and damage followed X client; CLI: click changed pixels and type reached X client');
} finally {
  if (client) await client.stop().catch(()=>{});
  if (target) target.kill('SIGTERM');
  xvfb.kill('SIGTERM');
  rmSync(dir,{recursive:true,force:true});
}
