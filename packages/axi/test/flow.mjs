// Linux integration proof: all capture/input is confined to a private Xvfb.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { assertNoAmbientDesktop, trackOwnedXvfb, verifyOwnedXvfb, stopOwnedXvfb } from '../../desktop-host/test/lab-safety.mjs';

assertNoAmbientDesktop();
const { EngineClient } = await import('@desklink/host');
const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-flow-'));
const enginePath = process.env.DESKLINK_AXI_ENGINE;
assert(enginePath && existsSync(enginePath), 'set DESKLINK_AXI_ENGINE to this task’s built engine');
const build = spawnSync('cargo', ['build','-q','--manifest-path','packages/desktop-host/engine/Cargo.toml','--example','x11_target','--example','x11_clip'], { stdio:'inherit' });
assert.equal(build.status,0,'X client builds');
const example = join(process.env.CARGO_TARGET_DIR ?? 'packages/desktop-host/engine/target','debug','examples','x11_target');
const clipboardExample = join(process.env.CARGO_TARGET_DIR ?? 'packages/desktop-host/engine/target','debug','examples','x11_clip');
const number = Array.from({length:30},(_,i)=>170+i).find(n =>
  !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
assert(number !== undefined, 'no unclaimed high X display');
const display = `:${number}`;
const noXtest = process.env.DESKLINK_AXI_NO_XTEST === '1';
const socket = `/tmp/.X11-unix/X${number}`;
const authority = join(dir,'Xauthority');
const auth = spawnSync('xauth',['-f',authority,'add',display,'.',randomBytes(16).toString('hex')],{encoding:'utf8'});
assert.equal(auth.status,0,`could not prepare private X authority: ${auth.stderr}`);
// The socket and lock appear before Xvfb can serve clients. -sigstop stops the
// server only once initialization is complete; resume that owned PID before
// probing. Unlike -displayfd, this preserves the X lock ownership assertion and
// explicit high display. -noreset avoids reinitialization between probe clients.
const xvfb = spawn('Xvfb', [display, '-sigstop', '-noreset', '-auth', authority, '-screen', '0', '1280x720x24', '-nolisten', 'tcp', ...(noXtest ? ['-extension', 'XTEST'] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
let xvfbReady = false;
let xvfbError = '';
xvfb.stderr.on('data', chunk => xvfbError = (xvfbError + chunk).slice(-2000));
xvfb.on('error', error => xvfbError = String(error));
trackOwnedXvfb(xvfb, display);
const pidFile = join(dir, 'bridges.pid');
const enginePidFile = join(dir, 'engines.pid');
const owned = new Map(); // PID -> /proc start time; never signal a reused PID.
const sessionName = `flow-${process.pid}-${randomBytes(16).toString('hex')}`;
const env = { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', XAUTHORITY: authority, DESKLINK_AXI_SESSION: sessionName, DESKLINK_AXI_ENGINE: enginePath, DESKLINK_AXI_PID_FILE: pidFile, DESKLINK_AXI_ENGINE_PID_FILE: enginePidFile };
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
      if (cmd.includes(enginePath) && (cmd.includes('serve') || cmd.includes('agent-overlay') || cmd.includes('point-overlay'))) remember(child,enginePath);
    } catch { /* Child already exited. */ }
  }
}
// Detect unrecorded session members, but never adopt them for cleanup.
const sessionMarker = `DESKLINK_AXI_SESSION=${sessionName}`;
function sessionStrays() {
  const strays = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || owned.has(pid) || pid === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(sessionMarker)) continue;
      strays.push({ pid, cmdline: readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ') });
    } catch { /* Vanished or not readable. */ }
  }
  return strays;
}
async function goneOwned(pid) {
  const started = owned.get(pid);
  for (let i=0; i<200 && proc(pid)?.started===started && proc(pid)?.state!=='Z'; i++) await new Promise(r=>setTimeout(r,50));
  assert(!started || proc(pid)?.started!==started || proc(pid)?.state==='Z', `task process ${pid} survived stop`);
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
async function stopXvfbGracefully() { await stopOwnedXvfb(xvfb); }
async function verifyXvfb() {
  if (!xvfbReady) {
    for (let i=0;i<200 && proc(xvfb.pid)?.state!=='T' && xvfb.pid && xvfb.exitCode===null && xvfb.signalCode===null;i++) await new Promise(r=>setTimeout(r,50));
    assert(xvfb.pid && xvfb.exitCode===null && proc(xvfb.pid)?.state==='T', `private Xvfb did not become ready: ${xvfbError}`);
  }
  await verifyOwnedXvfb(xvfb);
  if (!xvfbReady) {
    xvfb.kill('SIGCONT');
    xvfbReady = true;
  }
  const info = spawnSync(example,['--probe'],{env,encoding:'utf8',timeout:3000});
  assert.equal(info.status,0,`X client could not verify ${display}: ${info.error ?? info.signal ?? ''} ${info.stderr}`);
  assert.match(info.stdout,/vendor=The X.Org Foundation size=1280x720 xwayland=false/, 'unexpected server vendor or geometry');
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
    // Session tags detect leaks; they do not grant permission to kill a PID.
    if (sessionStrays().length) failures.push(new Error('unrecorded session processes survived'));
    for (const pid of owned.keys()) if (pid !== xvfb.pid) {
      try { await stopProcess(pid); } catch (error) { failures.push(error); }
    }
    // Keep the private server up until every input-capable child is gone —
    // but stop it even when child reaping failed, so an injected assertion
    // failure leaves no Xvfb behind either. Failures surface afterwards.
    try { await stopXvfbGracefully(); } catch (error) { failures.push(error); }
    assert([...owned].every(([pid,started])=>!started || proc(pid)?.started!==started || proc(pid)?.state==='Z'), 'a task-owned child survived');
    if (failures.length) throw new AggregateError(failures,'could not prove child cleanup');
    rmSync(dir,{recursive:true,force:true});
  })();
}
for (const [signal,code] of [['SIGTERM',143],['SIGINT',130]]) process.once(signal,()=> {
  void cleanup().then(()=>process.exit(code),error=>{ console.error(error); process.exit(1); });
});
async function run(...args) {
  await verifyXvfb();
  const started = performance.now();
  // AXI's engine has no ambient display: named-source capture/input/clipboard
  // must still reach the private display, never a process-global fallback.
  const child = spawn(process.execPath, [cli, ...args], { env: {...env, DISPLAY:''} });
  let out = ''; for await (const part of child.stdout) out += part;
  const code = child.exitCode ?? await new Promise(r => child.once('exit', r));
  assert.equal(code, 0, `${args.join(' ')}: ${out}`);
  recordProcesses();
  observations.push({ command: args.join(' '), ms: Math.round(performance.now()-started), output: out }); return out;
}
try {
  remember(xvfb.pid,'Xvfb');
  await verifyXvfb(); // Never open a session or send input before ownership is proven.
  if (process.env.DESKLINK_AXI_CAPABILITY_PROOF === '1' || noXtest) {
    const { PeerConnection, cleanup: cleanupPeers } = await import('node-datachannel');
    const notices = [];
    client = await EngineClient.start(enginePath, ['serve'], {onEvent:event=>notices.push(event)}, {...env, DISPLAY:''});
    recordProcesses();
    const opened = await client.openSession({source:{kind:'x11',display}, agentIndicator:true, loopbackTcp:true});
    recordProcesses();
    assert.equal(opened.agentIndicator, true, 'supported indicator still starts');
    const path = join(dir,'frame.raw');
    const frame = await client.request('session.frame',{session_id:opened.sessionId,path,after_seq:0,timeout_ms:3000});
    assert(frame.seq > 0 && readFileSync(path).length > 0, 'capture remains available');
    await verifyXvfb();
    await client.writeClipboard(opened.sessionId, 'no-XTEST clipboard ✓');
    const selection = spawnSync(clipboardExample,['get'],{env,encoding:'utf8',timeout:3000});
    assert.equal(selection.status,0,selection.stderr);
    assert.equal(selection.stdout,'no-XTEST clipboard ✓');
    assert.equal((await client.readClipboard(opened.sessionId)).text, selection.stdout);
    const peer = new PeerConnection('capability-proof',{iceServers:[],bindAddress:'127.0.0.1',enableIceTcp:true});
    try {
      let channel;
      const replies = [];
      peer.onDataChannel(ch => { if (ch.getLabel() === 'control') {
        channel = ch;
        ch.onMessage(raw => replies.push(JSON.parse(String(raw))));
      } });
      peer.onLocalCandidate((candidate,mid)=>void client.addCandidate(opened.sessionId,opened.generation,candidate,mid,Number(mid)||0));
      peer.onLocalDescription(sdp=>void client.acceptAnswer(opened.sessionId,opened.generation,sdp));
      const offer = notices.find(event=>event.event==='session.description');
      assert(offer,'session offers transport');
      peer.setRemoteDescription(offer.params.description.sdp,'offer');
      for (const event of notices.filter(event=>event.event==='session.candidate')) peer.addRemoteCandidate(event.params.candidate,event.params.sdpMid ?? '0');
      const deadline = Date.now()+10000;
      while (!replies.some(reply=>reply.kind==='hello') && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
      assert(replies.some(reply=>reply.kind==='hello'),'control channel opens');
      const actions = [
        ...['move','down','up','cancel'].map(phase=>({kind:'pointer',phase,x:100,y:100,button:1})),
        ...[{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}].map(delta=>({kind:'wheel',...delta})),
        {kind:'key',name:'Enter',down:true,modifiers:['Shift']},
        {kind:'key',name:'Enter',down:false,modifiers:[]},
        {kind:'key',character:'b',down:true},
        {kind:'key',character:'b',down:false},
        {kind:'key',name:'Shift',down:true},
        {kind:'key',name:'Shift',down:false},
        {kind:'text',text:'hello'},
        {kind:'release_all'},
      ];
      for (const [index,action] of actions.entries()) {
        await verifyXvfb();
        const seq=index+1;
        channel.sendMessage(JSON.stringify({...action,seq}));
        const limit=Date.now()+3000;
        while (!replies.some(reply=>reply.seq===seq) && Date.now()<limit) await new Promise(r=>setTimeout(r,10));
        const reply=replies.find(reply=>reply.seq===seq);
        assert(reply,`action ${seq} answered`);
        if (noXtest) assert.deepEqual({kind:reply.kind,code:reply.code},{kind:'rejected',code:'input-unavailable'});
        else assert.equal(reply.kind,'ack');
      }
    } finally { peer.close(); cleanupPeers(); }
    await client.stop(); client=undefined;
    assert.match(await run('start','--source','x11','--display',display),/session: open source=x11/);
    await run('stop');
    console.log(`private XTEST=${!noXtest}: capture, indicator, independent clipboard and all input paths passed`);
  } else {
  const cursorEvents = [];
  client = await EngineClient.start(enginePath, ['serve'], { onEvent: event => cursorEvents.push(event) }, env);
  recordProcesses();
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.capture.cursor_modes, ['embedded', 'hidden']);
  assert.equal(capabilities.capture.cursor_positions.x11, true);
  let cursorTarget;
  const cursorEvidence = process.env.DESKLINK_CURSOR_EVIDENCE_DIR;
  if (cursorEvidence) {
    cursorTarget = spawn(example, [], {env,stdio:['ignore','pipe','pipe']});
    remember(cursorTarget.pid,example);
    await new Promise(r=>setTimeout(r,300));
  }
  const hidden = await client.openSession({ source: {kind:'x11',display}, cursor:'hidden' });
  assert.deepEqual(hidden.cursor, {mode:'hidden',positions:true});
  const hiddenPath = join(dir, 'hidden.raw');
  const hiddenFrame = await client.request('session.frame',{session_id:hidden.sessionId,path:hiddenPath,after_seq:0,still_ms:100,timeout_ms:3000});
  const hiddenPixels = readFileSync(hiddenPath);
  for (const [x,y] of [[50,60],[420,310],[1000,600]]) {
    await verifyXvfb();
    const moved = spawnSync(example, ['--warp-pointer', String(x), String(y)], { env, encoding:'utf8', timeout:3000 });
    assert.equal(moved.status,0,moved.stderr);
    for(let i=0;i<100 && !cursorEvents.some(e=>e.event==='session.cursor' && e.params.sessionId===hidden.sessionId && e.params.x===x && e.params.y===y);i++) await new Promise(r=>setTimeout(r,10));
    const event = cursorEvents.find(e=>e.event==='session.cursor' && e.params.sessionId===hidden.sessionId && e.params.x===x && e.params.y===y);
    assert(event, `pointer ${x},${y} was not reported on a still screen`);
    assert(event.params.visible);
    assert(event.params.timestamp_us >= hiddenFrame.timestamp_us);
    const frame = await client.request('session.frame',{session_id:hidden.sessionId,path:hiddenPath});
    assert.equal(frame.seq, hiddenFrame.seq, 'cursor motion must not damage cursor-free video');
    assert.deepEqual(readFileSync(hiddenPath),hiddenPixels, 'cursor motion changed pixels');
  }
  if (cursorEvidence) {
    const { PNG } = await import('pngjs');
    const samples = [];
    const polygon = [[0,0],[0,24],[6,18],[11,29],[16,27],[11,16],[21,16]];
    const inside = (x,y) => {
      let yes=false;
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
        const a=polygon[i],b=polygon[j];
        if((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) yes=!yes;
      }
      return yes;
    };
    for(let i=0;i<75;i++) {
      const started = performance.now();
      const x=Math.round(100+i*12), y=Math.round(270+120*Math.sin(i/14));
      await verifyXvfb();
      const moved=spawnSync(example,['--warp-pointer',String(x),String(y)],{env,encoding:'utf8',timeout:3000});
      assert.equal(moved.status,0,moved.stderr);
      const latest=()=>cursorEvents.findLast(e=>e.event==='session.cursor' && e.params.sessionId===hidden.sessionId);
      for(let n=0;n<100 && (latest()?.params.x!==x || latest()?.params.y!==y);n++) await new Promise(r=>setTimeout(r,5));
      const cursor=latest()?.params;
      assert(cursor && cursor.x===x && cursor.y===y && cursor.visible,'delivered cursor must match the real pointer');
      const frame=await client.request('session.frame',{session_id:hidden.sessionId,path:hiddenPath});
      assert.equal(frame.seq,hiddenFrame.seq,'recording must contain no cursor damage');
      const raw=readFileSync(hiddenPath);
      assert.deepEqual(raw,hiddenPixels);
      const png=new PNG({width:frame.width,height:frame.height});
      for(let p=0;p<frame.width*frame.height;p++) {
        png.data[p*4]=raw[p*4+2];png.data[p*4+1]=raw[p*4+1];png.data[p*4+2]=raw[p*4];png.data[p*4+3]=255;
      }
      const leaf=String(i).padStart(3,'0');
      writeFileSync(join(cursorEvidence,`hidden-${leaf}.png`),PNG.sync.write(png));
      // This consumer draws a vector arrow solely from the delivered sample.
      for(let dy=0;dy<30;dy++) for(let dx=0;dx<22;dx++) if(inside(dx+.5,dy+.5)) {
        const edge=!inside(dx-1,dy)||!inside(dx+1,dy)||!inside(dx,dy-1)||!inside(dx,dy+1);
        const at=((cursor.y+dy)*frame.width+cursor.x+dx)*4;
        png.data[at]=png.data[at+1]=png.data[at+2]=edge?0:255;
      }
      writeFileSync(join(cursorEvidence,`redrawn-${leaf}.png`),PNG.sync.write(png));
      samples.push({frame:i,frame_timestamp_us:frame.timestamp_us,cursor,verified_pointer:{x,y}});
      const delay=40-(performance.now()-started);if(delay>0) await new Promise(r=>setTimeout(r,delay));
    }
    writeFileSync(join(cursorEvidence,'cursor-recording.json'),JSON.stringify({source:'task-owned Xvfb',display,engine:enginePath,cursor:hidden.cursor,samples,events:cursorEvents.filter(e=>e.event==='session.cursor' && e.params.sessionId===hidden.sessionId)},null,2));
  }
  await client.closeSession(hidden.sessionId,hidden.generation);
  if(cursorTarget) {
    const comparison = await client.openSession({source:{kind:'x11',display},cursor:'embedded'});
    const frame = await client.request('session.frame',{session_id:comparison.sessionId,path:hiddenPath,after_seq:0,timeout_ms:3000});
    const raw=readFileSync(hiddenPath);
    assert.deepEqual(raw,hiddenPixels,'existing X11 root capture never composites the cursor');
    const {PNG}=await import('pngjs');
    const png=new PNG({width:frame.width,height:frame.height});
    for(let i=0;i<frame.width*frame.height;i++) {png.data[i*4]=raw[i*4+2];png.data[i*4+1]=raw[i*4+1];png.data[i*4+2]=raw[i*4];png.data[i*4+3]=255;}
    writeFileSync(join(cursorEvidence,'x11-embedded.png'),PNG.sync.write(png));
    writeFileSync(join(cursorEvidence,'x11-embedded.json'),JSON.stringify({requested_cursor:'embedded',granted_cursor:comparison.cursor,frame,pointer:cursorEvents.findLast(e=>e.event==='session.cursor' && e.params.sessionId===hidden.sessionId)?.params},null,2));
    await client.closeSession(comparison.sessionId,comparison.generation);
  }
  if(cursorTarget) { cursorTarget.kill('SIGTERM'); await goneOwned(cursorTarget.pid); }

  const session = await client.openSession({ source: {kind:'x11',display},  });
  const path = join(dir, 'frame.raw');
  const first = await client.request('session.frame',{session_id:session.sessionId,path,after_seq:0,timeout_ms:3000});
  assert(first.seq > 0);
  const original = readFileSync(path);
  await new Promise(r=>setTimeout(r,180));
  await assert.rejects(client.request('session.frame',{session_id:session.sessionId,after_seq:first.seq,still_ms:150,timeout_ms:50}),{code:'frame-timeout'});
  await verifyXvfb();
  const typedPath = join(dir, 'typed.txt');
  target = spawn(example, ['--record-text', typedPath], { env, stdio:['ignore','pipe','pipe'] });
  remember(target.pid,example);
  target.stdout.on('data', chunk => events += chunk);
  const changed = await client.request('session.frame',{session_id:session.sessionId,since:first.seq,path,after_seq:first.seq,still_ms:150,timeout_ms:6000});
  assert(changed.still_ms>=150 && changed.damage.length > 0);
  assert.notDeepEqual(readFileSync(path),original);
  const cleanFrame = readFileSync(path);
  // The cue is visible in the root screenshot, independent of pointer/focus,
  // and included in the session frame. Only this verified private display is read.
  const desktop = async () => {
    await verifyXvfb();
    const rootPath = join(dir, 'root.raw');
    const result = spawnSync(example, ['--desktop-state','--desktop-frame',rootPath], { env, encoding:'utf8', timeout:3000 });
    assert.equal(result.status,0,result.stderr);
    return { state:JSON.parse(result.stdout), raw:readFileSync(rootPath) };
  };
  // Capture is asynchronous: a newer sequence can still describe an intermediate
  // cue. Establish the expected pixels before using its sequence as a baseline.
  const capturedPixels = async (expected, afterSeq) => {
    const deadline = performance.now() + 6000;
    let frame;
    do {
      frame = await client.request('session.frame', {
        session_id:session.sessionId, path, after_seq:afterSeq, still_ms:100,
        timeout_ms:Math.max(0, Math.ceil(deadline-performance.now())),
      });
      if (readFileSync(path).equals(expected)) return frame;
      afterSeq = frame.seq;
    } while (performance.now() < deadline);
    assert.deepEqual(readFileSync(path),expected,'capture must reach the expected desktop pixels');
    return frame;
  };
  const savePointShot = async (raw, name) => {
    if (!process.env.DESKLINK_POINT_EVIDENCE_DIR) return;
    const { PNG } = await import('pngjs');
    const png = new PNG({width:1280,height:720});
    for (let i=0;i<1280*720;i++) {
      png.data[i*4]=raw[i*4+2]; png.data[i*4+1]=raw[i*4+1]; png.data[i*4+2]=raw[i*4]; png.data[i*4+3]=255;
    }
    writeFileSync(join(process.env.DESKLINK_POINT_EVIDENCE_DIR, `desklink-point-overlay-${name}.png`),PNG.sync.write(png));
  };
  const beforePoint = await desktop();
  await savePointShot(beforePoint.raw, 'before');
  assert.deepEqual(await client.point(session.sessionId,{x:400,y:300,label:'Here',timeoutMs:3000}),{shown:true});
  recordProcesses();
  await new Promise(r=>setTimeout(r,100));
  const pointed = await desktop();
  assert.deepEqual(pointed.state,beforePoint.state,'point must not move the pointer or change focus');
  assert.deepEqual([...pointed.raw.subarray((300*1280+400)*4,(300*1280+400)*4+3)],[0xd0,0x9e,0x4c],'ring center is at requested desktop coordinates');
  assert.deepEqual([...pointed.raw.subarray((300*1280+418)*4,(300*1280+418)*4+3)],[0xd0,0x9e,0x4c],'ring edge is 18 pixels from center');
  assert.notDeepEqual(pointed.raw,beforePoint.raw);
  await savePointShot(pointed.raw,'after');
  const withPoint = await client.request('session.frame',{session_id:session.sessionId,path,after_seq:changed.seq,still_ms:100,timeout_ms:2000});
  assert.deepEqual(readFileSync(path),pointed.raw,'the cue is intentionally included in captured frames');
  await assert.rejects(client.point(session.sessionId,{x:1280,y:300}),{code:'coordinates'});
  await assert.rejects(client.point(session.sessionId,{x:400,y:300,label:'invalid\nlabel'}),{code:'malformed'});
  await assert.rejects(client.point(session.sessionId,{x:400,y:300,timeoutMs:120001}),{code:'malformed'});
  await assert.rejects(client.request('session.point',{session_id:session.sessionId,clear:true,x:4}),{code:'malformed'});
  assert.deepEqual((await desktop()).raw,pointed.raw,'invalid calls preserve the existing marker');
  await client.point(session.sessionId,{x:700,y:500,timeoutMs:150});
  await new Promise(r=>setTimeout(r,50));
  const replaced = await desktop();
  assert.notDeepEqual(replaced.raw,pointed.raw,'new points replace old points');
  assert.deepEqual(replaced.state,beforePoint.state);
  await new Promise(r=>setTimeout(r,250));
  assert.deepEqual((await desktop()).raw,beforePoint.raw,'timeout removes the cue');
  await client.point(session.sessionId,{x:400,y:300,timeoutMs:10000});
  await new Promise(r=>setTimeout(r,50));
  const finalPoint = await desktop();
  assert.notDeepEqual(finalPoint.raw,beforePoint.raw);
  const finalPointFrame = await capturedPixels(finalPoint.raw,withPoint.seq);
  await client.point(session.sessionId,{clear:true});
  await client.point(session.sessionId,{clear:true});
  assert.deepEqual((await desktop()).raw,beforePoint.raw,'clear removes the cue and is idempotent');
  assert.deepEqual((await desktop()).state,beforePoint.state);
  await capturedPixels(cleanFrame,finalPointFrame.seq);
  // Xcursor sprites live outside GetImage(root): motion and ripple must not
  // create a different frame or damage region from an indicator-off session.
  await verifyXvfb();
  overlay = spawn(enginePath, ['agent-overlay', display], { env, stdio: ['pipe','pipe','pipe'] });
  remember(overlay.pid,enginePath);
  await new Promise((resolve,reject) => {overlay.stdout.once('data',resolve);overlay.once('error',reject);});
  // Install the Xcursor override before taking the baseline. Its first
  // definition can wake the capture loop independently of later cursor motion.
  overlay.stdin.write('M 100 100\n');
  await new Promise(r=>setTimeout(r,100));
  const cleanSeq = (await capturedPixels(cleanFrame,0)).seq;
  overlay.stdin.write('M 300 300\nC 300 300\n');
  await new Promise(r=>setTimeout(r,600));
  const cursorOnly = await client.request('session.frame',{session_id:session.sessionId,path,since:cleanSeq});
  assert.equal(cursorOnly.seq,cleanSeq, 'cursor motion and ripple add no frame damage');
  assert.deepEqual(readFileSync(path),cleanFrame, 'indicator-on and indicator-off captures match');
  overlay.stdin.end();
  await new Promise(r=>overlay.once('exit',r)); overlay = undefined;
  await client.stop(); client = undefined;
  const started = await run('start','--source','x11','--display',display);
  assert.match(started,/session: open source=x11/);
  assert.doesNotMatch(started,/permissions=/);
  for (const args of [['wait','120001','--timeout','200000'], ['click','100,100','--wait','120001']]) {
    await verifyXvfb();
    const invalid = spawn(process.execPath,[cli,...args],{env});
    let output = ''; for await (const part of invalid.stdout) output += part;
    assert.equal(invalid.exitCode ?? await new Promise(r=>invalid.once('exit',r)),1,output);
    assert.match(output,/error: wait-duration: milliseconds must be an integer from 0 to 120000/);
  }
  assert.doesNotMatch(events, /"kind":"button"/, 'rejected delay must not send input');
  const before = await run('diff'); assert.match(before,/changed:/);
  assert.match(await run('point','100,100','--label','Here','--timeout','10000'),/point: shown/);
  const clicked = await run('click','100,100');
  assert.match(clicked,/input: applied/, events);
  assert.match(await run('wait','change','--timeout','5000'),/wait: change met/);
  assert.match(await run('diff'),/changed: [1-9]/, events);
  assert.match(events, /"kind":"button".*"phase":"up"/, 'the click reached the app beneath the indicator');
  const looked = await run('look','@r1'); assert.match(looked,/image: .*\.png/);
  const imagePath = /image: (.*\.png)/.exec(looked)?.[1];
  assert(imagePath && readFileSync(imagePath).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.match(await run('point','--clear'),/point: cleared/);
  await new Promise(r=>setTimeout(r,200));
  await verifyXvfb();
  const unchanged = spawn(process.execPath,[cli,'click','100,100'],{env});
  let noChange = ''; for await (const part of unchanged.stdout) noChange += part;
  assert.equal(unchanged.exitCode ?? await new Promise(r=>unchanged.once('exit',r)),0,noChange);
  assert.match(noChange,/input: applied/);
  const waited = await run('click','100,100','--wait','change');
  assert.match(waited,/input: applied; frame: timed out/);
  await verifyXvfb();
  const expectedText = 'AXI_SYNTHETIC_726';
  const typing = spawn(process.execPath,[cli,'type',expectedText],{env});
  let typed = ''; for await (const part of typing.stdout) typed += part;
  assert.equal(typing.exitCode ?? await new Promise(r=>typing.once('exit',r)),0,typed);
  assert.match(typed,/input: applied/);
  // The X client saves asynchronously; on slow runners the file can lag the
  // applied input by a moment. Bounded settle — the text must still land.
  for (let i = 0; i < 20 && readFileSync(typedPath,'utf8') !== expectedText; i++) await new Promise(r=>setTimeout(r,100));
  assert.equal(readFileSync(typedPath,'utf8'),expectedText,'saved X-client buffer must equal typed text');
  const beforeChords = events.length;
  await run('press','Alt+Tab');
  await run('press','Meta+2');
  await run('press','F12');
  await run('wait','100');
  const chordEvents = [...events.slice(beforeChords).matchAll(/\{"kind":"key","keycode":(\d+),"phase":"(down|up)"\}/g)]
    .map((match) => [match[2], Number(match[1])]);
  assert.deepEqual(chordEvents, [
    ['down',64], ['down',23], ['up',23], ['up',64], // Alt+Tab
    ['down',133], ['down',11], ['up',11], ['up',133], // Super+2
    ['down',96], ['up',96], // F12
  ], `desktop must receive and release each chord: ${events.slice(beforeChords)}`);
  await run('press','a'); await run('type','single'); await run('wait','10');
  const batched = await run('batch',JSON.stringify([['press','a'],['type','batch'],['wait','10']]));
  assert.match(batched,/batch: 3\/3 steps/);
  assert.match(batched,/1: input: applied/);
  assert.match(events, /"kind":"button".*"phase":"up"/);
  assert.match(events, /"kind":"key".*"phase":"down"/);
  // Outcome semantics: acknowledged input alone must never read as success.
  await verifyXvfb();
  const failedBatch = spawn(process.execPath,[cli,'batch',JSON.stringify([['press','a'],['assert','XYZZY_NEVER_ON_SCREEN']])],{env});
  let failOut=''; for await (const part of failedBatch.stdout) failOut += part;
  assert.equal(failedBatch.exitCode ?? await new Promise(r=>failedBatch.once('exit',r)),1,failOut);
  assert.match(failOut,/assert-failed: "XYZZY_NEVER_ON_SCREEN" not on screen/);
  assert.match(failOut,/effects: unverified/, 'a failed assert must not read as task success');
  assert.doesNotMatch(failOut, /^batch: 2\/2 steps/m, 'a failed assert must not produce a success summary');
  const absentOk = await run('batch', JSON.stringify([['assert','--absent','XYZZY_NEVER_ON_SCREEN']]));
  assert.match(absentOk,/assert: "XYZZY_NEVER_ON_SCREEN" absent/);
  assert.match(absentOk,/effects: asserted\[1\]/);
  const named = await run('batch', JSON.stringify([{verb:'snapshot',name:'ui'},{verb:'press',args:['a'],name:'key'},{verb:'wait',args:['50']}]));
  assert.match(named,/batch: 3\/3 steps; effects: unverified/);
  assert.match(named,/2 key: input: applied/);
  recordProcesses();
  const bridgePid = Number(readFileSync(pidFile,'utf8').trim().split(/\s+/).at(-1));
  const enginePid = Number(readFileSync(enginePidFile,'utf8').trim().split(/\s+/).at(-1));
  await run('stop');
  await goneOwned(bridgePid); await goneOwned(enginePid);
  assert.match(await run('start','--source','x11','--display',display),/session: open source=x11/);
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
  assert.match(once,/input: applied; frame: ready/, events);
  assert.match(await run('diff'),/regions\[[1-9]/, events);
  await run('stop');
  target.kill('SIGTERM');
  await new Promise(r=>target.once('exit',r));
  target = undefined;
  const paired = await run('start','--source','x11','--display',display);
  assert.match(paired,/session: open source=x11/);
  assert.doesNotMatch(paired,/permissions=/);
  async function ownSelection(mode, text = '') {
    await verifyXvfb();
    const owner = spawn(clipboardExample, [mode], {env, stdio:['pipe','pipe','pipe']});
    remember(owner.pid, clipboardExample);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('selection owner did not start')), 3000);
      owner.stdout.once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
      owner.once('exit', code => { clearTimeout(timer); reject(new Error(`owner exited ${code}`)); });
      owner.once('error', error => { clearTimeout(timer); reject(error); });
    });
    owner.stdin.end(text);
    const ownership = await ready;
    assert.match(ownership, /^owner=\d+ display=:\d+$/);
    console.log(`independent selection: ${ownership}`);
    return owner;
  }
  async function readSelection(target) {
    await verifyXvfb();
    const result = spawnSync(clipboardExample, ['get', ...(target ? [target] : [])], {env, encoding:'utf8', timeout:4000});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  async function refused(...args) {
    await verifyXvfb();
    const result = spawnSync(process.execPath, [cli, ...args], {env, encoding:'utf8', timeout:5000});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    observations.push({command:args.join(' '), output:result.stdout});
    return result.stdout;
  }
  const labOwner = await ownSelection('set', 'lab-owned ✓ 1');
  assert.equal((await run('clipboard','read','--full')).trim(), 'clipboard: lab-owned ✓ 1 (13 chars)');
  assert.match(await run('clipboard','write','client-sent ✓ 2'), /clipboard: written/);
  await goneOwned(labOwner.pid); // SelectionClear must end the independent owner.
  assert.equal(await readSelection(), 'client-sent ✓ 2');
  assert.equal(await readSelection('TEXT'), 'client-sent ✓ 2');
  assert.deepEqual((await readSelection('TARGETS')).trim().split('\n'), ['TARGETS','UTF8_STRING','TEXT']);
  await verifyXvfb();
  // Linux argv is smaller than 300000 bytes: send this payload over AXI's real socket.
  const axiSocket = join(env.XDG_RUNTIME_DIR ?? join(tmpdir(), `desklink-axi-${process.getuid()}`), 'desklink-axi', `${sessionName}.sock`);
  const oversized = await new Promise((resolve, reject) => {
    const socket = connect(axiSocket); let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('oversized write timed out')));
    socket.on('connect', () => socket.write(JSON.stringify({command:'clipboard',args:['write','x'.repeat(300000)]})+'\n'));
    socket.on('data', chunk => output += chunk);
    socket.on('end', () => resolve(output)); socket.on('error', reject);
  });
  assert.match(oversized, /refusing to place 300000 bytes/);
  assert.equal(await readSelection(), 'client-sent ✓ 2', 'refused write preserves the real selection');
  console.log(`oversized clipboard: ${oversized.trim()}`);
  const longOwner = await ownSelection('set', 'a'.repeat(256*1024-1)+'✓suffix');
  client = await EngineClient.start(enginePath, ['serve'], {}, {...env, DISPLAY:''});
  recordProcesses();
  const boundedSession = await client.openSession({source:{kind:'x11',display}});
  const bounded = await client.readClipboard(boundedSession.sessionId);
  assert.equal(bounded.text, 'a'.repeat(256*1024-1));
  assert.equal(bounded.truncated, true, 'UTF-8 boundary truncation remains visible');
  await client.closeSession(boundedSession.sessionId);
  await assert.rejects(client.readClipboard(boundedSession.sessionId), /session/);
  await client.stop(); client = undefined;
  console.log('clipboard: bounded UTF-8 read and revoked session refusal passed without ambient DISPLAY');
  const incrOwner = await ownSelection('incr');
  await goneOwned(longOwner.pid);
  assert.match(await refused('clipboard','read','--full'), /INCR is unsupported/);
  console.log('INCR clipboard: explicitly refused');
  const silentOwner = await ownSelection('silent');
  await goneOwned(incrOwner.pid);
  const timeoutStart = Date.now();
  assert.match(await refused('clipboard','read','--full'), /clipboard owner did not answer/);
  assert(Date.now()-timeoutStart < 4000, 'unresponsive owner is bounded');
  await stopProcess(silentOwner.pid);
  assert.match(await refused('clipboard','read','--full'), /desktop clipboard has no text/);
  // Hidden compatibility no-op remains accepted, never displayed as a scope.
  await run('stop');
  const legacyStart = await run('start','--control','--source','x11','--display',display);
  assert.doesNotMatch(legacyStart,/permissions=/);
  assert.match(await run('clipboard','write','Umer'), /clipboard: written/);
  assert.equal(await readSelection(), 'Umer');
  assert.match(await run('screen','--query','zebra'),/0 items match "zebra"/);
  await run('stop');
  const badDisplay = `:${number+1000}`;
  assert(!existsSync(`/tmp/.X11-unix/X${number+1000}`) && !existsSync(`/tmp/.X${number+1000}-lock`));
  const failed = spawn(process.execPath,[cli,'start','--source','x11','--display',badDisplay,'--timeout','3000'],{env:{...env,DESKLINK_AXI_SESSION:`${sessionName}-failed`}});
  let failure=''; for await (const part of failed.stdout) failure += part;
  assert.equal(failed.exitCode ?? await new Promise(r=>failed.once('exit',r)),1,failure);
  recordProcesses();
  await goneOwned(Number(readFileSync(pidFile,'utf8').trim().split(/\s+/).at(-1)));
  await goneOwned(Number(readFileSync(enginePidFile,'utf8').trim().split(/\s+/).at(-1)));
  if (process.env.DESKLINK_AXI_MEASURE_PATH) writeFileSync(process.env.DESKLINK_AXI_MEASURE_PATH,JSON.stringify(observations));
  console.log('engine: private Xvfb frame/damage; CLI: paired click, independent X11 clipboard owner/readback, bounds and cleanup passed');
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await cleanup();
}
