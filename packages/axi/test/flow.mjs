// Linux integration proof: all capture/input is confined to a private Xvfb.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineClient } from '@desklink/host';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-flow-'));
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to this task’s built engine');
const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: ['ignore','pipe','pipe'] });
let display;
let env;
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
  const number = await Promise.race([
    new Promise((resolve,reject) => { let text=''; xvfb.stdout.on('data', chunk => { text+=chunk; if (text.includes('\n')) resolve(text.trim().split('\n')[0]); }); xvfb.on('exit', code => reject(new Error(`Xvfb exited ${code} before display readiness`))); xvfb.on('error',reject); }),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('Xvfb display readiness timed out')),5000)),
  ]);
  assert(/^\d+$/.test(number) && xvfb.exitCode===null, 'private Xvfb owns its assigned display');
  display = `:${number}`;
  env = { ...process.env, DISPLAY: display, DESKLINK_AXI_SESSION: `flow-${process.pid}`, DESKLINK_AXI_ENGINE: enginePath };
  client = await EngineClient.start(enginePath, ['serve'], {}, env);
  const session = await client.openSession({ source: {kind:'x11',display}, permissions:['view'] });
  const path = join(dir, 'frame.raw');
  const first = await client.request('session.frame',{session_id:session.sessionId,path,after_seq:0,timeout_ms:3000});
  assert(first.seq > 0);
  const original = readFileSync(path);
  await new Promise(r=>setTimeout(r,180));
  await assert.rejects(client.request('session.frame',{session_id:session.sessionId,after_seq:first.seq,still_ms:150,timeout_ms:50}),{code:'frame-timeout'});
  const build = spawn('cargo', ['build','-q','--manifest-path','packages/desktop-host/engine/Cargo.toml','--example','x11_target'], { env, stdio:'ignore' });
  assert.equal(await new Promise(r=>build.on('exit',r)),0,'X client builds');
  const example = join(process.env.CARGO_TARGET_DIR ?? 'packages/desktop-host/engine/target','debug','examples','x11_target');
  target = spawn(example, [], { env, stdio:['ignore','pipe','pipe'] });
  target.stdout.on('data', chunk => events += chunk);
  const changed = await client.request('session.frame',{session_id:session.sessionId,since:first.seq,path,after_seq:first.seq,still_ms:150,timeout_ms:6000});
  assert(changed.still_ms>=150 && changed.damage.length > 0);
  assert.notDeepEqual(readFileSync(path),original);
  await client.stop(); client = undefined;
  const started = await run('start','--control','--source','x11','--display',display);
  assert.match(started,/permissions=view,control/);
  for (const args of [['wait','120001','--timeout','200000'], ['click','100,100','--wait','120001']]) {
    const invalid = spawn(process.execPath,[cli,...args],{env});
    let output = ''; for await (const part of invalid.stdout) output += part;
    assert.equal(await new Promise(r=>invalid.on('exit',r)),1,output);
    assert.match(output,/error: wait-duration: milliseconds must be an integer from 0 to 120000/);
  }
  assert.doesNotMatch(events, /"kind":"button"/, 'rejected delay must not send input');
  const before = await run('diff'); assert.match(before,/changed:/);
  const clicked = await run('click','100,100'); assert.match(clicked,/changed: [1-9]/);
  const looked = await run('look','@r1'); assert.match(looked,/image: .*\.png/);
  const imagePath = /image: (.*\.png)/.exec(looked)?.[1];
  assert(imagePath && readFileSync(imagePath).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const unchanged = spawn(process.execPath,[cli,'click','100,100'],{env});
  let noChange = ''; for await (const part of unchanged.stdout) noChange += part;
  assert.equal(await new Promise(r=>unchanged.on('exit',r)),1,noChange);
  assert.match(noChange,/error: frame-timeout: frame condition not met before deadline/);
  const typing = spawn(process.execPath,[cli,'type','abc'],{env});
  let typed = ''; for await (const part of typing.stdout) typed += part;
  assert.equal(await new Promise(r=>typing.on('exit',r)),1,typed);
  assert.match(typed,/error: frame-timeout:/);
  assert.match(events, /"kind":"button".*"phase":"up"/);
  assert.match(events, /"kind":"key".*"phase":"down"/);
  await run('stop');
  assert.match(await run('start','--control','--source','x11','--display',display),/permissions=view,control/);
  await run('diff'); // Establish the snapshot before the corner starts looping.
  target.kill('SIGTERM');
  await new Promise(r=>target.once('exit',r));
  target = spawn(example, ['--animate','--move'], { env, stdio:['ignore','pipe','pipe'] });
  target.stdout.on('data',chunk=>events+=chunk);
  await new Promise((resolve,reject)=>{target.stdout.once('data',resolve);target.once('error',reject);});
  await new Promise(r=>setTimeout(r,3000)); // The CLI is absent; captured frames must still build the mask.
  const animated = await run('diff');
  const corner = /animating: (\d+),(\d+),(\d+),(\d+)/.exec(animated);
  assert(corner && Number(corner[1]) >= 1152 && Number(corner[2]) < 96, animated);
  const once = await run('click','100,100','--wait','1000');
  assert.match(once,/regions\[[1-9]/, events);
  assert.match(once,/@r\d+,"(?:64|96|128),/);
  await run('stop');
  target.kill('SIGTERM');
  await new Promise(r=>target.once('exit',r));
  target = undefined;
  assert.match(await run('start','--source','x11','--display',display),/permissions=view\n/);
  for (const operation of [['read'],['write','private text']]) {
    const child = spawn(process.execPath,[cli,'clipboard',...operation],{env});
    let output=''; for await (const part of child.stdout) output+=part;
    assert.equal(await new Promise(r=>child.on('exit',r)),1);
    assert.match(output,/clipboard requires start --control/);
  }
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
