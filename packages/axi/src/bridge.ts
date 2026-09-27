import { createServer, connect, type Server } from 'node:net';
import { mkdirSync, existsSync, unlinkSync, mkdtempSync, rmSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EngineClient, resolveEngine, type EngineEvent } from '@desklink/host';
import { PeerConnection, type DataChannel } from 'node-datachannel';
import { saveToken, takeToken, tokenPath } from './token.js';

export const socketPath = join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `desklink-axi-${process.getuid?.() ?? 'user'}`), 'desklink-axi', `${process.env.DESKLINK_AXI_SESSION ?? 'default'}.sock`);

export async function call(command: string, args: string[] = []): Promise<string> {
  if (command === 'stop' && !existsSync(socketPath)) return 'session: stopped (already closed)';
  if (command === 'start' && existsSync(socketPath)) {
    const stale = await new Promise<boolean>(resolve => { const probe=connect(socketPath); probe.on('connect',()=>{probe.end();resolve(false);}); probe.on('error',()=>resolve(true)); });
    if (stale) unlinkSync(socketPath);
  }
  if (command === 'start' && !existsSync(socketPath)) {
    if (process.platform === 'darwin') throw new Error('On macOS launch the signed DesklinkHost.app with --args axi-bridge <absolute desklink-axi.js> [start flags]; do not start the Node helper from Terminal or SSH.');
    mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 });
    const errorPath = `${socketPath}.error`;
    if (existsSync(errorPath)) unlinkSync(errorPath);
    const child = spawn(process.execPath, [process.argv[1]!, '--bridge', ...args], { detached: true, stdio: 'ignore', env: process.env });
    if (process.env.DESKLINK_AXI_PID_FILE && child.pid) {
      try { appendFileSync(process.env.DESKLINK_AXI_PID_FILE, `${child.pid}\n`); }
      catch (error) { child.kill('SIGKILL'); throw error; }
    }
    child.unref();
    const deadline = Date.now() + Number(args.includes('--timeout') ? args[args.indexOf('--timeout')+1] : 120000) + 5000;
    while (Date.now() < deadline && !existsSync(socketPath) && !existsSync(errorPath)) await new Promise(r => setTimeout(r, 50));
    if (existsSync(errorPath)) { const message = readFileSync(errorPath,'utf8'); unlinkSync(errorPath); throw new Error(message); }
  }
  if (!existsSync(socketPath)) throw new Error('no-session: run desklink-axi start first');
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = '';
    socket.on('connect', () => socket.write(JSON.stringify({ command, args }) + '\n'));
    socket.on('data', chunk => data += chunk);
    socket.on('end', () => resolve(data.trim()));
    socket.on('error', reject);
  });
}

function tileDamage(before: Buffer, after: Buffer, width: number, height: number): number[][] {
  const columns = Math.ceil(width / 32), rows = Math.ceil(height / 32);
  const dirty = new Set<number>();
  for (let row=0;row<rows;row++) for (let col=0;col<columns;col++) {
    const x=col*32, y=row*32, bytes=Math.min(32,width-x)*4;
    for (let line=y;line<Math.min(y+32,height);line++) {
      const offset=(line*width+x)*4;
      if (!before.subarray(offset,offset+bytes).equals(after.subarray(offset,offset+bytes))) { dirty.add(row*columns+col); break; }
    }
  }
  const boxes: number[][] = [];
  while (dirty.size) {
    const first=dirty.values().next().value!;
    dirty.delete(first);
    const stack=[first];
    let left=first%columns,right=left,top=Math.floor(first/columns),bottom=top;
    while (stack.length) {
      const tile=stack.pop()!, col=tile%columns,row=Math.floor(tile/columns);
      left=Math.min(left,col);right=Math.max(right,col);top=Math.min(top,row);bottom=Math.max(bottom,row);
      for (const neighbor of [row>0?tile-columns:-1,row+1<rows?tile+columns:-1,col>0?tile-1:-1,col+1<columns?tile+1:-1]) {
        if (dirty.delete(neighbor)) stack.push(neighbor);
      }
    }
    boxes.push([left*32,top*32,Math.min(width,(right+1)*32)-left*32,Math.min(height,(bottom+1)*32)-top*32]);
  }
  return boxes;
}

function boundedDelay(value: string): number {
  const ms = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(ms) || ms > 120000) throw new Error('wait-duration: milliseconds must be an integer from 0 to 120000');
  return ms;
}

function overlaps(a: string, b: string): boolean {
  const [ax,ay,aw,ah] = a.split(',').map(Number);
  const [bx,by,bw,bh] = b.split(',').map(Number);
  return ax! < bx!+bw! && bx! < ax!+aw! && ay! < by!+bh! && by! < ay!+ah!;
}

export async function serve(args: string[]): Promise<void> {
  if (existsSync(socketPath)) throw new Error('session already running');
  const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'auto';
  const display = args.includes('--display') ? args[args.indexOf('--display') + 1] : undefined;
  const control = args.includes('--control');
  const timeout = args.includes('--timeout') ? Number(args[args.indexOf('--timeout')+1]) : 120000;
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Linux or macOS only');
  if (process.platform === 'darwin' ? !['auto','display'].includes(source ?? '') || (display !== undefined && !/^\d+$/.test(display)) : source === 'display') throw new Error('source: use display and a numeric --display on macOS, portal/x11 on Linux');
  const executable = resolveEngine(process.env.DESKLINK_AXI_ENGINE);
  if (!executable) throw new Error(process.platform === 'darwin' && process.env.DESKLINK_MACOS !== '1'
    ? 'macOS engine disabled; set DESKLINK_MACOS=1 (and DESKLINK_AXI_ENGINE for a source build)'
    : 'desktop engine unavailable; set DESKLINK_AXI_ENGINE');
  mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 });
  const events: EngineEvent[] = [];
  const tokenFailure: { current?: Error } = {};
  const checkToken = () => { if (tokenFailure.current) throw new Error(`cannot persist portal restore token: ${tokenFailure.current.message}`); };
  const portal = process.platform === 'linux' && source !== 'x11' && !(source === 'auto' && display);
  const tokenFile = portal ? tokenPath() : undefined;
  const motion = new Map<string, {seq:number;at:number;count:number;reported:boolean}>();
  let peer: PeerConnection | undefined;
  let offerReady = false;
  const engine = await EngineClient.start(executable.command, executable.args, { requestTimeoutMs: 125000, onEvent: event => {
    if (event.event !== 'session.frame.changed') events.push(event);
    if (event.event === 'session.restoreToken' && tokenFile) {
      try { saveToken(tokenFile, event.params.token); }
      catch (error) { tokenFailure.current = error as Error; }
    }
    if (event.event === 'session.frame.changed') {
      const now = Date.now();
      const previous = [...motion];
      motion.clear();
      for (const box of event.params.damage) {
        const region = box.join(',');
        const prior = previous.find(([key,state]) => state.seq === event.params.seq-1 && now-state.at<600 && overlaps(key,region))?.[1];
        motion.set(region, {seq:event.params.seq,at:now,count:prior ? prior.count+1 : 1,reported:prior?.reported ?? false});
      }
    }
    if (offerReady && peer && event.event === 'session.candidate') peer.addRemoteCandidate(event.params.candidate, event.params.sdpMid || '0');
  } });
  const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-'));
  try {
  const opened = await engine.openSession({
    source: process.platform === 'darwin'
      ? { kind: 'display', ...(display === undefined ? {} : { display_id: Number(display) }) }
      : source === 'x11' || (source === 'auto' && display) ? { kind: 'x11', display } : { kind: 'portal' },
    permissions: control ? ['view', 'control', 'clipboard'] : ['view'], loopbackTcp: true,
    agentIndicator: control,
    ...(tokenFile ? { restoreToken: takeToken(tokenFile) } : {}),
  }, timeout);
  checkToken();
  peer = control ? new PeerConnection('desklink-axi', { iceServers: [], bindAddress: '127.0.0.1', enableIceTcp: true }) : undefined;
  let channel: DataChannel | undefined;
  let open = false;
  let nextSeq = 1;
  const pending = new Map<number, {resolve:()=>void;reject:(error:Error)=>void}>();
  if (peer) {
    peer.onDataChannel(ch => { if (ch.getLabel() === 'control') {
      channel = ch; ch.onOpen(() => { open = true; });
      ch.onMessage(raw => { try { const reply = JSON.parse(String(raw)) as {kind:string;seq?:number;code?:string;message?:string}; const waiting = pending.get(reply.seq ?? -1); if (!waiting) return; pending.delete(reply.seq!); if (reply.kind === 'rejected') waiting.reject(new Error(`${reply.code}: ${reply.message}`)); else waiting.resolve(); } catch { /* ignore unrelated notifications */ } });
    } });
    peer.onLocalCandidate((candidate, mid) => { void engine.addCandidate(opened.sessionId, opened.generation, candidate, mid, Number(mid) || 0); });
    peer.onLocalDescription((sdp) => { void engine.acceptAnswer(opened.sessionId, opened.generation, sdp); });
    const deadline = Date.now() + 10000;
    while (!events.some(event => event.event === 'session.description') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    const offer = events.find(event => event.event === 'session.description');
    if (!offer || offer.event !== 'session.description') throw new Error('transport offer unavailable');
    peer.setRemoteDescription(offer.params.description.sdp, 'offer');
    for (const event of events) if (event.event === 'session.candidate') {
      peer.addRemoteCandidate(event.params.candidate, event.params.sdpMid || '0');
    }
    offerReady = true;
  }
  let baseline = 0;
  type Item = { ref: string; text: string; x: number; y: number; conf: number; line: string; words: {text:string;x:number;y:number;w:number;h:number}[] };
  let text: Item[] = []; 
  let regions: string[] = [];
  let lastFrame: {seq:number;width:number;height:number;raw:Buffer} | undefined;
  let observed: {seq:number;damage:string[]} | undefined;
  const capture = async (since = baseline, wait: {after_seq?:number;still_ms?:number;timeout_ms?:number} = {}) => {
    const path = join(dir, 'frame.raw');
    const frame = await engine.request<{seq:number;still_ms:number;width:number;height:number;damage:number[][]}>('session.frame', { session_id: opened.sessionId, since, path, ...wait });
    const raw = readFileSync(path);
    const damage = lastFrame?.seq === since && lastFrame.width === frame.width && lastFrame.height === frame.height
      ? tileDamage(lastFrame.raw, raw, frame.width, frame.height).map(box => box.join(','))
      : frame.damage.map(box => box.join(','));
    lastFrame = {seq:frame.seq,width:frame.width,height:frame.height,raw};
    observed = {seq:frame.seq,damage};
    return { ...frame, changed: frame.seq !== baseline, damage, raw, previous: baseline };
  };
  const image = async (frame: Awaited<ReturnType<typeof capture>>, box: number[], path: string) => {
    const { PNG } = await import('pngjs');
    const raw = frame.raw;
    const [x,y,w,h] = box;
    const png = new PNG({ width: w!, height: h! });
    for (let row=0;row<h!;row++) for (let col=0;col<w!;col++) {
      const from = ((y!+row)*frame.width+x!+col)*4, to=(row*w!+col)*4;
      png.data[to]=raw[from+2]!; png.data[to+1]=raw[from+1]!; png.data[to+2]=raw[from]!; png.data[to+3]=255;
    }
    (await import('node:fs')).writeFileSync(path, PNG.sync.write(png));
  };
  const ocr = async (frame: Awaited<ReturnType<typeof capture>>, box = [0,0,frame.width,frame.height]) => {
    const imagePath = join(dir, 'ocr.png');
    await image(frame,box,imagePath);
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('tesseract', [imagePath, 'stdout', 'tsv'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('ocr-unavailable: install tesseract (sudo pacman -S tesseract or sudo apt install tesseract-ocr)');
    const lines = new Map<string, Item>();
    for (const cols of result.stdout.split('\n').slice(1).map(line => line.split('\t'))) {
      if (cols.length < 12 || Number(cols[10]) < 0 || !cols[11]?.trim()) continue;
      const key = cols.slice(1,5).join(':');
      if (!lines.has(key)) lines.set(key,{ref:`@${frame.seq}.${lines.size+1}`,text:'',x:Number(cols[6]),y:Number(cols[7]),conf:Number(cols[10]),line:key,words:[]});
      const item = lines.get(key)!;
      const word = { text:cols[11]!.trim(),x:box[0]!+Number(cols[6]),y:box[1]!+Number(cols[7]),w:Number(cols[8]),h:Number(cols[9]) };
      if (!item.text) { item.x=word.x; item.y=word.y; }
      item.words.push(word); item.text += (item.text ? ' ' : '') + word.text;
    }
    return [...lines.values()];
  };
  const act = async (message: Record<string, unknown>) => {
    if (!control) throw new Error('input-unavailable: start --control');
    for (let i = 0; i < 100 && !open; i++) await new Promise(r => setTimeout(r, 50));
    if (!open || !channel) throw new Error('transport: control channel not connected');
    const seq = nextSeq++;
    await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(seq); reject(new Error('transport: input acknowledgement timed out')); }, 3000);
      pending.set(seq,{resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});
      if (!channel!.sendMessage(JSON.stringify({ ...message, seq }))) { pending.delete(seq); clearTimeout(timer); reject(new Error('transport: input send failed')); }
    });
  };
  const target = (value: string): [number, number] => {
    if (/^\d+,\d+$/.test(value)) return value.split(',').map(Number) as [number, number];
    if (value.startsWith('@') && !text.some(t=>t.ref === value)) throw new Error(`stale-ref: ${value}; run screen --query`);
    const matches = text.filter(t => t.ref === value || t.text.toLowerCase().includes(value.toLowerCase()));
    if (matches.length !== 1) throw new Error(`${matches.length ? 'ambiguous' : 'not-found'}: ${value}; run screen --query`);
    const item = matches[0]!;
    const index = value === item.ref ? 0 : item.words.findIndex((_,i,all) => all.slice(i).map(w=>w.text).join(' ').toLowerCase().startsWith(value.toLowerCase()));
    const start = item.words[Math.max(index,0)]!;
    const count = value === item.ref ? item.words.length : value.split(/\s+/).length;
    const end = item.words[Math.max(index,0)+count-1] ?? start;
    return [Math.floor((start.x + end.x + end.w)/2), Math.floor((start.y + end.y + end.h)/2)];
  };
  const output = async (command: string, args: string[]) => {
    let pendingDamage: string[] | undefined;
    let waitSeen = baseline;
    if (command === 'start') return `session: open source=${source} ${display ?? ''} size=${opened.geometry.encoded.width}x${opened.geometry.encoded.height} permissions=view${control ? ',control' : ''}`;
    if (command === 'health') {
      const state = events.filter(event=>event.event === 'session.state' || event.event === 'session.capture.stopped').at(-1);
      if (state?.event === 'session.capture.stopped') return `capture: stopped; reason: ${state.params.reason}`;
      const frame = await engine.request<{seq:number}>('session.frame',{session_id:opened.sessionId,path:''}).catch(() => undefined);
      return state?.event === 'session.state' ? `capture: ${state.params.capture}; transport: ${state.params.transport}; frame: ${frame?.seq ?? 'unavailable'}` : 'capture: starting';
    }
    if (command === 'batch') {
      let steps: unknown;
      try { steps = JSON.parse(args[0] ?? ''); } catch { throw new Error('batch: expected JSON array of [verb, ...args] steps'); }
      if (!Array.isArray(steps) || !steps.length || steps.length > 30 || steps.some(step => !Array.isArray(step) || !['click','type','press','scroll','wait'].includes(step[0]) || step.slice(1).some((arg:unknown) => typeof arg !== 'string'))) throw new Error('batch: expected 1–30 [click|type|press|scroll|wait, ...args] steps');
      const results: string[] = [];
      for (const [index, step] of steps.entries()) {
        try { results.push(`${index+1}: ${await output(step[0], step.slice(1))}`); }
        catch (error) { results.push(`${index+1}: error: ${(error as Error).message}`); break; }
      }
      return `${results.at(-1)?.includes(': error:') ? 'error: ' : ''}batch: ${results.length}/${steps.length} steps\n${results.join('\n')}`;
    }
    if (command === 'stop') {
      try { await engine.closeSession(opened.sessionId); }
      finally {
        peer?.close(); await engine.stop(); server.close();
        if (existsSync(socketPath)) unlinkSync(socketPath);
        rmSync(dir, { recursive: true, force: true });
      }
      return 'session: stopped';
    }
    if (command === 'clipboard') {
      if (!control) throw new Error('input-unavailable: clipboard requires start --control');
      if (args[0] === 'read') { const result = await engine.readClipboard(opened.sessionId); return `clipboard: ${args.includes('--full') ? result.text : result.text.slice(0,1000)} (${result.text.length} chars)`; }
      if (args[0] === 'write') { await engine.writeClipboard(opened.sessionId, args[1] ?? ''); return 'clipboard: written'; }
    }
    const action = ['click','drag','type','press','scroll'].includes(command);
    const actionWait = action && args.includes('--wait') ? args[args.indexOf('--wait')+1] : 'none';
    const actionDelay = action && /^\d+$/.test(actionWait!) ? boundedDelay(actionWait!) : undefined;
    if (action && args.some(arg => /^@\d+\.\d+$/.test(arg))) {
      const current = await capture(baseline);
      observed = undefined; // Validation must not consume the diff baseline.
      if (current.seq !== baseline) {
        for (const ref of args.filter(arg => /^@\d+\.\d+$/.test(arg))) {
          const item = text.find(t => t.ref === ref);
          if (!item) throw new Error(`stale-ref: ${ref}; run screen --query`);
          const x = Math.max(0,item.x-32), y = Math.max(0,item.y-32);
          const right = Math.min(current.width,item.words.at(-1)!.x+item.words.at(-1)!.w+32);
          const bottom = Math.min(current.height,Math.max(...item.words.map(w=>w.y+w.h))+32);
          if (!(await ocr(current,[x,y,right-x,bottom-y])).some(t => t.text === item.text && Math.abs(t.x-item.x)<12 && Math.abs(t.y-item.y)<12)) throw new Error(`stale-ref: ${ref} moved or changed; run screen --query`);
        }
      }
    }
    const preActionSeq = action && actionWait !== 'none' ? (await engine.request<{seq:number}>('session.frame',{session_id:opened.sessionId,path:''})).seq : baseline;
    if (command === 'click' || command === 'drag') {
      const [x,y] = target(args[0]!);
      const [endX,endY] = command === 'drag' ? target(args[1]!) : [x,y];
      const button = args.includes('right') ? 3 : 1;
      await act({ kind: 'pointer', phase: 'move', x, y });
      await act({ kind: 'pointer', phase: 'down', x, y, button });
      try {
        if (command === 'drag') await act({kind:'pointer',phase:'move',x:endX,y:endY});
        await act({ kind: 'pointer', phase: 'up', x:endX, y:endY, button });
        if (command === 'click' && args.includes('--double')) { await act({kind:'pointer',phase:'down',x,y,button}); await act({kind:'pointer',phase:'up',x,y,button}); }
      } catch (error) { await act({kind:'release_all'}).catch(() => undefined); throw error; }
    } else if (command === 'type') {
      try {
        if (args.includes('--into')) { const [x,y]=target(args[args.indexOf('--into')+1]!); await act({kind:'pointer',phase:'move',x,y}); await act({kind:'pointer',phase:'down',x,y}); await act({kind:'pointer',phase:'up',x,y}); }
        await act({ kind: 'text', text: args[0] ?? '' });
        if (args.includes('--submit')) { await act({kind:'key',name:'Enter',down:true}); await act({kind:'key',name:'Enter',down:false}); }
      } catch (error) { await act({kind:'release_all'}).catch(() => undefined); throw error; }
    } else if (command === 'press') {
      const parts = (args[0] ?? '').split('+'); const name = parts.pop()!;
      const modifiers = parts.map(p=>({ctrl:'Ctrl',control:'Control',alt:'Alt',shift:'Shift',meta:'Meta'}[p.toLowerCase()] ?? p));
      const key = name.length === 1 ? {character:name} : {name};
      try { await act({kind:'key',...key,down:true,modifiers}); await act({kind:'key',...key,down:false,modifiers}); }
      catch (error) { await act({kind:'release_all'}).catch(() => undefined); throw error; }
    } else if (command === 'scroll') {
      if (args.includes('--at')) { const [x,y]=target(args[args.indexOf('--at')+1]!); await act({kind:'pointer',phase:'move',x,y}); }
      await act({kind:'wheel',dy:args[0] === 'up' ? -Number(args.includes('--amount') ? args[args.indexOf('--amount')+1] : 3) : Number(args.includes('--amount') ? args[args.indexOf('--amount')+1] : 3)});
    }
    else if (command === 'wait') {
      const condition = args[0] ?? 'change';
      const deadline = Date.now() + Number(args.includes('--timeout') ? args[args.indexOf('--timeout')+1] : 5000);
      if (/^\d+$/.test(condition)) {
        const ms = boundedDelay(condition);
        if (ms > deadline - Date.now()) throw new Error('settle-timeout: condition not met before deadline');
        await new Promise(r=>setTimeout(r,ms));
      } else if (condition === 'change' || condition === 'settle') {
        await engine.request('session.frame', {session_id:opened.sessionId, since:baseline, ...(condition === 'change' ? {after_seq:baseline} : {still_ms:150}), timeout_ms:Math.max(0,deadline-Date.now())});
      } else {
        let seen = baseline, found = false;
        while (Date.now() < deadline) {
          const snapshot = await capture(seen, {after_seq:seen,timeout_ms:Math.max(0,deadline-Date.now())}).catch(error => {
            if ((error as {code?:string}).code === 'frame-timeout') throw new Error('settle-timeout: condition not met before deadline');
            throw error;
          });
          pendingDamage ??= [];
          pendingDamage.push(...snapshot.damage);
          waitSeen = snapshot.seq;
          for (const box of snapshot.damage) {
            const [x,y,w,h] = box.split(',').map(Number);
            const left=Math.max(0,x!-32),top=Math.max(0,y!-32);
            if ((await ocr(snapshot,[left,top,Math.min(snapshot.width-left,w!+64),Math.min(snapshot.height-top,h!+64)])).some(t=>t.text.toLowerCase().includes(condition.toLowerCase()))) { found = true; break; }
          }
          if (found) break;
          seen = snapshot.seq;
        }
        if (!found) throw new Error('settle-timeout: condition not met before deadline');
      }
      return `wait: ${condition} met`;
    }
    if (action) {
      if (actionWait === 'none') return 'input: applied';
      try {
        if (actionDelay !== undefined) await new Promise(r=>setTimeout(r,actionDelay));
        else await engine.request('session.frame',{session_id:opened.sessionId,since:baseline,after_seq:preActionSeq,...(actionWait === 'settle' ? {still_ms:150} : {}),timeout_ms:5000});
      } catch (error) {
        if ((error as {code?:string}).code === 'frame-timeout') return 'input: applied; frame: timed out';
        throw error;
      }
      return 'input: applied; frame: ready';
    }
    const fields = args.includes('--fields') ? args[args.indexOf('--fields')+1]!.split(',') : ['ref','text','x','y'];
    if (fields.some(field=>!['ref','text','x','y','w','h','conf','line'].includes(field))) throw new Error('fields: valid fields are ref,text,x,y,w,h,conf,line');
    const frame = await capture(pendingDamage ? waitSeen : baseline);
    if (pendingDamage) frame.damage = [...new Set([...pendingDamage,...frame.damage])];
    if (command === 'look') {
      const item = text.find(t=>t.ref === args[0]);
      if (item && !item.ref.startsWith(`@${frame.seq}.`)) throw new Error(`stale-ref: ${args[0]}; run screen --query`);
      if (args[0]?.startsWith('@') && !args[0].startsWith('@r') && !item) throw new Error(`stale-ref: ${args[0]}; run screen --query`);
      const requested = args.includes('--region') ? args[args.indexOf('--region')+1] : args[0]?.startsWith('@r') ? regions[Number(args[0].slice(2))-1] : undefined;
      if (args[0]?.startsWith('@r') && !requested) throw new Error(`stale-ref: ${args[0]}; run diff`);
      const box = requested ? requested.split(',').map(Number) : item ? [item.x,item.y,item.words.at(-1)!.x+item.words.at(-1)!.w-item.x,Math.max(...item.words.map(w=>w.y+w.h))-item.y] : [0,0,frame.width,frame.height];
      if (box.length !== 4 || box.some(n=>!Number.isInteger(n)) || box[0]!<0 || box[1]!<0 || box[2]!<=0 || box[3]!<=0 || box[0]!+box[2]!>frame.width || box[1]!+box[3]!>frame.height) throw new Error('coordinates: crop exceeds frame');
      const path = args.includes('--out') ? args[args.indexOf('--out')+1]! : join(dir, `look-${frame.seq}.png`);
      await image(frame,box,path);
      return `image: ${path}\nregion: ${box.join(',')} cost: ~${Math.round(box[2]!*box[3]!/750)} tokens to view`;
    }
    if (command === 'screen' || command === 'home') {
      const region = args.includes('--region') ? args[args.indexOf('--region')+1]!.split(',').map(Number) : undefined;
      if (region && (region.length!==4 || region.some(n=>!Number.isInteger(n)) || region[0]!<0 || region[1]!<0 || region[2]!<=0 || region[3]!<=0 || region[0]!+region[2]!>frame.width || region[1]!+region[3]!>frame.height)) throw new Error('coordinates: region exceeds frame');
      const query = args.includes('--query') ? args[args.indexOf('--query')+1] : undefined;
      const prior = query && !region && !args.includes('--full') ? text.filter(t=>t.text.toLowerCase().includes(query.toLowerCase())) : [];
      if (prior.length === 1) {
        const item = prior[0]!;
        const x=Math.max(0,item.x-64), y=Math.max(0,item.y-64);
        const right=Math.min(frame.width,item.words.at(-1)!.x+item.words.at(-1)!.w+64);
        const bottom=Math.min(frame.height,Math.max(...item.words.map(w=>w.y+w.h))+64);
        const found = await ocr(frame,[x,y,right-x,bottom-y]);
        text = found.some(t=>t.text.toLowerCase().includes(query!.toLowerCase())) ? found : await ocr(frame,region);
      } else text = await ocr(frame,region);
    }
    if (command === 'home') return `session: open source=${source} ${display ?? ''} size=${frame.width}x${frame.height} permissions=view${control?',control':''}\nframe: ${frame.seq} settled=${frame.still_ms>=150} unseen=${frame.changed ? frame.damage.length : 0} region\nwindows: unavailable on this compositor\ntext[${Math.min(text.length,12)} of ${text.length}]{ref,text,x,y}:\n${text.slice(0,12).map(t=>`  ${t.ref},${JSON.stringify(t.text)},${t.x},${t.y}`).join('\n')}\nhelp[2]:\n  desklink-axi diff\n  desklink-axi screen --query "<words>"`;
    if (command === 'screen') {
      const query = args.includes('--query') ? args[args.indexOf('--query')+1] : undefined;
      const items = query ? text.filter(t => t.text.toLowerCase().includes(query.toLowerCase())) : text;
      const limit = args.includes('--full') ? items.length : 40;
      const rows = items.slice(0,limit).map(t => `  ${fields.map(field=>JSON.stringify(field === 'w' ? t.words.at(-1)!.x+t.words.at(-1)!.w-t.x : field === 'h' ? Math.max(...t.words.map(w=>w.y+w.h))-t.y : t[field as keyof Item])).join(',')}`).join('\n');
      return `screen: ${frame.width}x${frame.height} frame=${frame.seq} settled=${frame.still_ms>=150} estimated_tokens=~${Math.ceil(items.slice(0,limit).reduce((n,t)=>n+t.text.length+35,0)/4)}\n${items.length ? `text[${Math.min(items.length,limit)} of ${items.length}]{${fields.join(',')}}:\n${rows}` : `text: 0 items match ${JSON.stringify(query ?? 'screen')} on frame ${frame.seq} (${text.length} items searched)`}${items.length>limit ? `\ntruncated: ${items.length-limit} more — use --full or --query` : ''}\nhelp[1]:\n  desklink-axi click @${frame.seq}.<n>`;
    }
    if (frame.changed) {
      const prev = text;
      let kept = [...prev];
      const dirty: Item[] = [];
      for (const region of frame.damage) {
        const [rx,ry,rw,rh] = region.split(',').map(Number);
        const x=Math.max(0,rx!-32),y=Math.max(0,ry!-32);
        const right=Math.min(frame.width,rx!+rw!+32),bottom=Math.min(frame.height,ry!+rh!+32);
        kept = kept.filter(t=>!t.words.some(w=>w.x<right && w.x+w.w>x && w.y<bottom && w.y+w.h>y));
        dirty.push(...await ocr(frame,[x,y,right-x,bottom-y]));
      }
      text = [...kept,...dirty.filter((t,i)=>!dirty.slice(0,i).some(p=>p.text===t.text && Math.abs(p.x-t.x)<12 && Math.abs(p.y-t.y)<12))]
        .map((t,i)=>({...t,ref:`@${frame.seq}.${i+1}`}));
      const unmatched = [...prev];
      const appeared = text.filter(t => {
        const index=unmatched.findIndex(p=>p.text===t.text && Math.abs(p.x-t.x)<12 && Math.abs(p.y-t.y)<12);
        if (index<0) return true;
        unmatched.splice(index,1);
        return false;
      });
      const gone=unmatched.length;
      if (frame.still_ms>=150) motion.clear();
      const animating: string[] = [];
      const visible: string[] = [];
      const moving = [...motion].filter(([,state]) => state.count>=3 && Date.now()-state.at<600);
      for (const region of [...frame.damage, ...moving.map(([key])=>key).filter(key=>!frame.damage.some(region=>overlaps(key,region)))]) {
        const state=moving.find(([key])=>overlaps(key,region))?.[1];
        const [x,y,w,h] = region.split(',').map(Number);
        const textChanged = [...appeared,...unmatched].some(t => t.words.some(word => word.x<x!+w! && word.x+word.w>x! && word.y<y!+h! && word.y+word.h>y!));
        if (state && state.count>=3 && !textChanged && !args.includes('--include-animating')) {
          if (!state.reported) { animating.push(region); state.reported=true; }
        } else visible.push(region);
      }
      if (observed) observed.damage=visible;
      const changed = visible.length ? `${visible.length} region since frame ${frame.previous}` : `none since frame ${frame.previous}`;
      return `changed: ${changed}\nregions[${visible.length}]{ref,box}:\n${visible.map((d,i)=>`  @r${i+1},"${d}"`).join('\n')}\nappeared[${Math.min(appeared.length,20)} of ${appeared.length}]{${fields.join(',')}}:\n${appeared.slice(0,20).map(t=>`  ${fields.map(field=>JSON.stringify(field === 'w' ? t.words.at(-1)!.x+t.words.at(-1)!.w-t.x : field === 'h' ? Math.max(...t.words.map(w=>w.y+w.h))-t.y : t[field as keyof Item])).join(',')}`).join('\n')}\ngone: ${gone} text items${animating.length ? `\nanimating[${animating.length}]{box}:\n${animating.map(box=>`  "${box}"`).join('\n')}\nanimating: ${animating.join('; ')}` : ''}\nhelp[2]:\n  desklink-axi look @r1\n  desklink-axi screen --query "<words>"`; }
    if (frame.still_ms>=150) motion.clear();
    return `changed: none since frame ${frame.seq} (still ${frame.still_ms}ms)\nhelp[1]:\n  desklink-axi screen --query "<words>"`;
  };
  let commands = Promise.resolve();
  const server: Server = createServer(socket => { let request = ''; socket.on('data', chunk => { request += chunk; if (!request.includes('\n')) return;
    const { command, args } = JSON.parse(request.split('\n')[0]!) as {command:string;args:string[]};
    commands = commands.then(async () => {
      observed = undefined;
      try {
        const result = await output(command,args);
        const completed = observed as {seq:number;damage:string[]} | undefined;
        if (completed && command !== 'look') { baseline = completed.seq; regions = completed.damage; }
        socket.end(result+'\n', () => { if (command === 'stop') process.exit(0); });
      } catch (error) {
        const message = (error as Error).message;
        const code = (error as {code?:string}).code;
        socket.end(`error: ${code ? `${code}: ` : ''}${message}\nsuggestion: desklink-axi ${message.includes('ocr') ? 'look' : 'screen'} --help\n`, () => { if (command === 'stop') process.exit(1); });
      }
    });
  }); });
  await engine.request('session.frame', {session_id:opened.sessionId,after_seq:0,timeout_ms:timeout});
  checkToken();
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  process.on('SIGTERM', () => { void engine.stop().finally(() => { server.close(); if (existsSync(socketPath)) unlinkSync(socketPath); rmSync(dir, {recursive:true,force:true}); process.exit(0); }); });
  } catch (error) {
    peer?.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
