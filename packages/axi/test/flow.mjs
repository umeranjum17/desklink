// Linux integration proof: all capture/input is confined to a private Xvfb.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineClient } from '@desklink/host';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-flow-'));
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to this task’s built engine');
const number = Array.from({length:50},(_,i)=>150+i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir,'Xauthority');
const auth = spawnSync('xauth',['-f',authority,'add',display,'.',randomBytes(16).toString('hex')],{encoding:'utf8'});
assert.equal(auth.status,0,`could not prepare private X authority: ${auth.stderr}`);
const xvfb = spawn('Xvfb', [display, '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
const pidFile = join(dir, 'bridges.pid');
const enginePidFile = join(dir, 'engines.pid');
const owned = new Map(); // PID -> /proc start time; never signal a reused PID.
const env = { ...process.env, DISPLAY: display, XAUTHORITY: authority, DESKLINK_AXI_SESSION: `flow-${process.pid}`, DESKLINK_AXI_ENGINE: enginePath, DESKLINK_AXI_PID_FILE: pidFile, DESKLINK_AXI_ENGINE_PID_FILE: enginePidFile };
function proc(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');
    return { state: fields[0], started: fields[19] };
  } catch { return undefined; }
}
function remember(pid, command) {
  assert(Number.isSafeInteger(pid) && pid > 1, `invalid recorded PID: ${pid}`);
  if (owned.has(pid)) return;
  const state = proc(pid);
  if (!state || state.state==='Z') { owned.set(pid,undefined); return; }
  assert(readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ').includes(command), `unexpected child ${pid}`);
  owned.set(pid,state.started);
}
function childrenOf(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}
function recordProcesses() {
  if (existsSync(pidFile)) for (const pid of readFileSync(pidFile,'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) remember(pid,'--bridge');
  if (existsSync(enginePidFile)) for (const pid of readFileSync(enginePidFile,'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) remember(pid,enginePath);
  for (const pid of [process.pid, ...owned.keys()]) for (const child of childrenOf(pid)) {
    try {
      const cmd = readFileSync(`/proc/${child}/cmdline`,'utf8').replaceAll('\0',' ');
      if (cmd.includes(enginePath) && (cmd.includes('serve') || cmd.includes('agent-overlay'))) remember(child,enginePath);
    } catch { /* Child already exited. */ }
  }
}
async function stopProcess(pid) {
  const started = owned.get(pid);
  if (!started) return;
  const alive = () => { const state=proc(pid); return state?.started===started && state.state!=='Z'; };
  if (!alive()) return;
  try { process.kill(pid,'SIGKILL'); } catch (error) { if (alive()) throw error; }
  for (let i=0;i<40 && alive();i++) await new Promise(r=>setTimeout(r,25));
  assert(!alive(), `task-owned process ${pid} survived cleanup`);
}
async function verifyXvfb() {
  for (let i=0;i<100 && !existsSync(socket) && xvfb.exitCode===null;i++) await new Promise(r=>setTimeout(r,50));
  assert(xvfb.pid && xvfb.exitCode===null && existsSync(socket), 'private Xvfb did not start');
  assert.equal(Number(readFileSync(`/tmp/.X${number}-lock`,'utf8').trim()),xvfb.pid,'X lock belongs to another server');
  const line = readFileSync('/proc/net/unix','utf8').split('\n').find(line=>line.endsWith(` ${socket}`));
  assert(line,'X socket missing from proc socket table');
  const inode = line.trim().split(/\s+/)[6];
  assert(readdirSync(`/proc/${xvfb.pid}/fd`).some(fd=> {
    try { return readlinkSync(`/proc/${xvfb.pid}/fd/${fd}`)===`socket:[${inode}]`; } catch { return false; }
  }), 'X server socket is not held by the spawned Xvfb PID');
  const info = spawnSync('xdpyinfo',['-display',display],{env,encoding:'utf8',timeout:3000});
  assert.equal(info.status,0,`xdpyinfo could not verify ${display}: ${info.stderr}`);
  assert.match(info.stdout,/vendor string:\s+The X.Org Foundation/, 'unexpected X server vendor');
  assert.doesNotMatch(info.stdout,/\bXWAYLAND\b/, 'refusing live Xwayland');
  assert.match(info.stdout,/dimensions:\s+1280x720 pixels/, 'unexpected display geometry');
}

const cli = resolve('packages/axi/bin/desklink-axi.js');
let client;
let target;
let overlay;
let events = '';
const observations = [];
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (client) await client.stop().catch(()=>{});
    if (overlay) { overlay.stdin.end(); overlay.kill('SIGTERM'); }
    if (target) target.kill('SIGTERM');
    const failures = [];
    try { recordProcesses(); } catch (error) { failures.push(error); }
    for (const pid of owned.keys()) if (pid !== xvfb.pid) {
      try { await stopProcess(pid); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures,'could not prove child cleanup; private Xvfb remains up');
    await stopProcess(xvfb.pid); // Keep the private server up until every input-capable child is gone.
    assert([...owned].every(([pid,started])=>!started || proc(pid)?.started!==started || proc(pid)?.state==='Z'), 'a task-owned child survived');
    rmSync(dir,{recursive:true,force:true});
  })();
}
for (const [signal,code] of [['SIGTERM',143],['SIGINT',130]]) process.once(signal,()=> {
  void cleanup().then(()=>process.exit(code),error=>{ console.error(error); process.exit(1); });
});
async function run(...args) {
  await verifyXvfb();
  const child = spawn(process.execPath, [cli, ...args], { env });
  let out = ''; for await (const part of child.stdout) out += part;
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, `${args.join(' ')}: ${out}`);
  recordProcesses();
  observations.push({ command: args.join(' '), output: out }); return out;
}
try {
  remember(xvfb.pid,'Xvfb');
  await verifyXvfb(); // Never open a session or send input before ownership is proven.
  client = await EngineClient.start(enginePath, ['serve'], {}, env);
  recordProcesses();
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
  await verifyXvfb();
  target = spawn(example, [], { env, stdio:['ignore','pipe','pipe'] });
  remember(target.pid,example);
  target.stdout.on('data', chunk => events += chunk);
  const changed = await client.request('session.frame',{session_id:session.sessionId,since:first.seq,path,after_seq:first.seq,still_ms:150,timeout_ms:6000});
  assert(changed.still_ms>=150 && changed.damage.length > 0);
  assert.notDeepEqual(readFileSync(path),original);
  const cleanFrame = readFileSync(path);
  // Xcursor sprites live outside GetImage(root): motion and ripple must not
  // create a different frame or damage region from an indicator-off session.
  await verifyXvfb();
  overlay = spawn(enginePath, ['agent-overlay', display], { env, stdio: ['pipe','pipe','pipe'] });
  remember(overlay.pid,enginePath);
  await new Promise((resolve,reject) => {overlay.stdout.once('data',resolve);overlay.once('error',reject);});
  overlay.stdin.write('M 100 100\nC 100 100\n');
  await new Promise(r=>setTimeout(r,600));
  const cursorOnly = await client.request('session.frame',{session_id:session.sessionId,path,since:changed.seq});
  assert.equal(cursorOnly.seq,changed.seq, 'cursor motion and ripple add no frame damage');
  assert.deepEqual(readFileSync(path),cleanFrame, 'indicator-on and indicator-off captures match');
  overlay.stdin.end();
  await new Promise(r=>overlay.once('exit',r)); overlay = undefined;
  await client.stop(); client = undefined;
  const started = await run('start','--control','--source','x11','--display',display);
  assert.match(started,/permissions=view,control/);
  for (const args of [['wait','120001','--timeout','200000'], ['click','100,100','--wait','120001']]) {
    await verifyXvfb();
    const invalid = spawn(process.execPath,[cli,...args],{env});
    let output = ''; for await (const part of invalid.stdout) output += part;
    assert.equal(await new Promise(r=>invalid.on('exit',r)),1,output);
    assert.match(output,/error: wait-duration: milliseconds must be an integer from 0 to 120000/);
  }
  assert.doesNotMatch(events, /"kind":"button"/, 'rejected delay must not send input');
  const before = await run('diff'); assert.match(before,/changed:/);
  const clicked = await run('click','100,100'); assert.match(clicked,/changed: [1-9]/, events);
  assert.match(events, /"kind":"button".*"phase":"up"/, 'the click reached the app beneath the indicator');
  const looked = await run('look','@r1'); assert.match(looked,/image: .*\.png/);
  const imagePath = /image: (.*\.png)/.exec(looked)?.[1];
  assert(imagePath && readFileSync(imagePath).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  await verifyXvfb();
  const unchanged = spawn(process.execPath,[cli,'click','100,100'],{env});
  let noChange = ''; for await (const part of unchanged.stdout) noChange += part;
  assert.equal(await new Promise(r=>unchanged.on('exit',r)),1,noChange);
  assert.match(noChange,/error: frame-timeout: frame condition not met before deadline/);
  await verifyXvfb();
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
  await verifyXvfb();
  target = spawn(example, ['--animate','--move'], { env, stdio:['ignore','pipe','pipe'] });
  remember(target.pid,example);
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
    await verifyXvfb();
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
  await cleanup();
}
