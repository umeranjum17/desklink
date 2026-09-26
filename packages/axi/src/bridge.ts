import { createServer, connect, type Server } from 'node:net';
import { mkdirSync, existsSync, unlinkSync, mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EngineClient, resolveEngine, type EngineEvent } from '@desklink/host';
import { PeerConnection, type DataChannel } from 'node-datachannel';

export const socketPath = join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `desklink-axi-${process.getuid?.() ?? 'user'}`), 'desklink-axi', `${process.env.DESKLINK_AXI_SESSION ?? 'default'}.sock`);

export async function call(command: string, args: string[] = []): Promise<string> {
  if (command === 'stop' && !existsSync(socketPath)) return 'session: stopped (already closed)';
  if (command === 'start' && existsSync(socketPath)) {
    const stale = await new Promise<boolean>(resolve => { const probe=connect(socketPath); probe.on('connect',()=>{probe.end();resolve(false);}); probe.on('error',()=>resolve(true)); });
    if (stale) unlinkSync(socketPath);
  }
  if (command === 'start' && !existsSync(socketPath)) {
    mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 });
    const errorPath = `${socketPath}.error`;
    if (existsSync(errorPath)) unlinkSync(errorPath);
    const child = spawn(process.execPath, [process.argv[1]!, '--bridge', ...args], { detached: true, stdio: 'ignore', env: process.env });
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

export async function serve(args: string[]): Promise<void> {
  if (existsSync(socketPath)) throw new Error('session already running');
  const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'auto';
  const display = args.includes('--display') ? args[args.indexOf('--display') + 1] : undefined;
  const control = args.includes('--control');
  const timeout = args.includes('--timeout') ? Number(args[args.indexOf('--timeout')+1]) : 120000;
  if (process.platform !== 'linux') throw new Error('Linux only');
  const executable = resolveEngine(process.env.DESKLINK_AXI_ENGINE);
  if (!executable) throw new Error('desktop engine unavailable; set DESKLINK_AXI_ENGINE');
  const events: EngineEvent[] = [];
  const engine = await EngineClient.start(executable.command, executable.args, { onEvent: event => events.push(event) });
  const opened = await engine.openSession({
    source: source === 'x11' || (source === 'auto' && display) ? { kind: 'x11', display } : { kind: 'portal' },
    permissions: control ? ['view', 'control', 'clipboard'] : ['view'], loopbackTcp: true,
  }, timeout);
  const peer = control ? new PeerConnection('desklink-axi', { iceServers: [], bindAddress: '127.0.0.1', enableIceTcp: true }) : undefined;
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
  }
  const dir = mkdtempSync(join(tmpdir(), 'desklink-axi-'));
  let baseline = 0;
  type Item = { ref: string; text: string; x: number; y: number; words: {text:string;x:number;y:number;w:number;h:number}[] };
  let text: Item[] = []; 
  let regions: string[] = [];
  let motionRegion = '';
  let motionCount = 0;
  const capture = async (advance = true) => {
    const path = join(dir, 'frame.raw');
    const frame = await engine.request<{seq:number;still_ms:number;width:number;height:number;damage:number[][]}>('session.frame', { session_id: opened.sessionId, since: baseline, path });
    const changed = frame.seq !== baseline;
    const damage = frame.damage.map(box => box.join(','));
    if (damage.length) regions = damage;
    if (advance) baseline = frame.seq;
    return { ...frame, changed, damage, path };
  };
  const image = async (frame: Awaited<ReturnType<typeof capture>>, box: number[], path: string) => {
    const { PNG } = await import('pngjs');
    const raw = (await import('node:fs')).readFileSync(frame.path);
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
      if (!lines.has(key)) lines.set(key,{ref:`@${frame.seq}.${lines.size+1}`,text:'',x:Number(cols[6]),y:Number(cols[7]),words:[]});
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
    if (value.startsWith('@') && !value.startsWith(`@${baseline}.`)) throw new Error(`stale-ref: ${value}; run screen --query`);
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
    if (command === 'start') return `session: open source=${source} ${display ?? ''} size=${opened.geometry.encoded.width}x${opened.geometry.encoded.height} permissions=view${control ? ',control' : ''}`;
    if (command === 'stop') { await engine.closeSession(opened.sessionId); peer?.close(); await engine.stop(); server.close(); if (existsSync(socketPath)) unlinkSync(socketPath); rmSync(dir, { recursive: true, force: true }); return 'session: stopped'; }
    if (command === 'clipboard') {
      if (args[0] === 'read') { const result = await engine.readClipboard(opened.sessionId); return `clipboard: ${args.includes('--full') ? result.text : result.text.slice(0,1000)} (${result.text.length} chars)`; }
      if (args[0] === 'write') { await engine.writeClipboard(opened.sessionId, args[1] ?? ''); return 'clipboard: written'; }
    }
    if (command === 'click' || command === 'drag') {
      const [x,y] = target(args[0]!);
      await act({ kind: 'pointer', phase: 'move', x, y });
      await act({ kind: 'pointer', phase: 'down', x, y, button: args.includes('right') ? 3 : 1 });
      let endX=x,endY=y;
      if (command === 'drag') { [endX,endY] = target(args[1]!); await act({kind:'pointer',phase:'move',x:endX,y:endY}); }
      await act({ kind: 'pointer', phase: 'up', x:endX, y:endY, button: args.includes('right') ? 3 : 1 });
      if (command === 'click' && args.includes('--double')) { await act({kind:'pointer',phase:'down',x,y}); await act({kind:'pointer',phase:'up',x,y}); }
    } else if (command === 'type') {
      if (args.includes('--into')) { const [x,y]=target(args[args.indexOf('--into')+1]!); await act({kind:'pointer',phase:'move',x,y}); await act({kind:'pointer',phase:'down',x,y}); await act({kind:'pointer',phase:'up',x,y}); }
      await act({ kind: 'text', text: args[0] ?? '' });
      if (args.includes('--submit')) { await act({kind:'key',name:'Enter',down:true}); await act({kind:'key',name:'Enter',down:false}); }
    } else if (command === 'press') {
      const parts = (args[0] ?? '').split('+'); const name = parts.pop()!;
      const modifiers = parts.map(p=>({ctrl:'Ctrl',control:'Control',alt:'Alt',shift:'Shift',meta:'Meta'}[p.toLowerCase()] ?? p));
      const key = name.length === 1 ? {character:name} : {name};
      await act({kind:'key',...key,down:true,modifiers}); await act({kind:'key',...key,down:false,modifiers});
    } else if (command === 'scroll') await act({kind:'wheel',dy:args[0] === 'up' ? -Number(args.includes('--amount') ? args[args.indexOf('--amount')+1] : 3) : Number(args.includes('--amount') ? args[args.indexOf('--amount')+1] : 3)});
    else if (command === 'wait') {
      const condition = args[0] ?? 'change';
      const before = baseline;
      const deadline = Date.now() + Number(args.includes('--timeout') ? args[args.indexOf('--timeout')+1] : 5000);
      let matched = false;
      if (/^\d+$/.test(condition)) { await new Promise(r=>setTimeout(r,Number(condition))); matched=true; }
      while (!matched && Date.now() < deadline) {
        const f = await engine.request<{seq:number;still_ms:number}>('session.frame', { session_id: opened.sessionId, since: before });
        if (condition === 'settle') matched = f.still_ms >= 150;
        else if (condition === 'change') matched = f.seq !== before;
        else if (f.seq !== before) { const snapshot = await capture(false); matched = (await ocr(snapshot)).some(t=>t.text.toLowerCase().includes(condition.toLowerCase())); }
        if (!matched) await new Promise(r => setTimeout(r, 80));
      }
      if (!matched) throw new Error('settle-timeout: condition not met before deadline');
    }
    if (['click','drag','type','press','scroll'].includes(command)) await new Promise(r => setTimeout(r, 230));
    const frame = await capture(command !== 'look');
    if (command === 'look') {
      const requested = args.includes('--region') ? args[args.indexOf('--region')+1] : args[0]?.startsWith('@r') ? regions[Number(args[0].slice(2))-1] : undefined;
      const box = requested ? requested.split(',').map(Number) : [0,0,frame.width,frame.height];
      if (box.length !== 4 || box.some(n=>!Number.isInteger(n)) || box[0]!<0 || box[1]!<0 || box[2]!<=0 || box[3]!<=0 || box[0]!+box[2]!>frame.width || box[1]!+box[3]!>frame.height) throw new Error('coordinates: crop exceeds frame');
      const path = args.includes('--out') ? args[args.indexOf('--out')+1]! : join(dir, `look-${frame.seq}.png`);
      await image(frame,box,path);
      return `image: ${path}\nregion: ${box.join(',')} cost: ~${Math.round(box[2]!*box[3]!/750)} tokens to view`;
    }
    if (command === 'screen' || command === 'home') text = await ocr(frame);
    if (command === 'home') return `session: open source=${source} ${display ?? ''} size=${frame.width}x${frame.height} permissions=view${control?',control':''}\nframe: ${frame.seq} settled=${frame.still_ms>=150} unseen=${frame.changed ? frame.damage.length : 0} region\nwindows: unavailable on this compositor\ntext[${Math.min(text.length,12)} of ${text.length}]{ref,text,x,y}:\n${text.slice(0,12).map(t=>`  ${t.ref},${JSON.stringify(t.text)},${t.x},${t.y}`).join('\n')}\nhelp[2]:\n  desklink-axi diff\n  desklink-axi screen --query "<words>"`;
    if (command === 'screen') {
      const query = args.includes('--query') ? args[args.indexOf('--query')+1] : undefined;
      const items = query ? text.filter(t => t.text.toLowerCase().includes(query.toLowerCase())) : text;
      const fields = args.includes('--fields') ? args[args.indexOf('--fields')+1]!.split(',') : ['ref','text','x','y'];
      if (fields.some(field=>!['ref','text','x','y','w','h'].includes(field))) throw new Error('fields: valid fields are ref,text,x,y,w,h');
      const limit = args.includes('--full') ? items.length : 40;
      const rows = items.slice(0,limit).map(t => `  ${fields.map(field=>JSON.stringify(field === 'w' ? t.words.at(-1)!.x+t.words.at(-1)!.w-t.x : field === 'h' ? Math.max(...t.words.map(w=>w.y+w.h))-t.y : t[field as keyof Item])).join(',')}`).join('\n');
      return `screen: ${frame.width}x${frame.height} frame=${frame.seq} settled=${frame.still_ms>=150}\n${items.length ? `text[${Math.min(items.length,limit)} of ${items.length}]{${fields.join(',')}}:\n${rows}` : `text: 0 items match ${JSON.stringify(query ?? 'screen')} on frame ${frame.seq} (${text.length} items searched)`}${items.length>limit ? `\ntruncated: ${items.length-limit} more — use --full or --query` : ''}\nhelp[1]:\n  desklink-axi click @${frame.seq}.<n>`;
    }
    if (frame.changed) {
      const prev = text;
      const bounds = (frame.damage.length ? frame.damage : [`0,0,${frame.width},${frame.height}`]).map(d=>d.split(',').map(Number));
      const x = Math.max(0,Math.min(...bounds.map(b=>b[0]!))-32), y = Math.max(0,Math.min(...bounds.map(b=>b[1]!))-32);
      const right = Math.min(frame.width,Math.max(...bounds.map(b=>b[0]!+b[2]!))+32), bottom = Math.min(frame.height,Math.max(...bounds.map(b=>b[1]!+b[3]!))+32);
      const kept = prev.filter(t=>t.x<x || t.x>=right || t.y<y || t.y>=bottom);
      const dirty = await ocr(frame,[x,y,right-x,bottom-y]);
      text = [...kept,...dirty].map((t,i)=>({...t,ref:`@${frame.seq}.${i+1}`}));
      const appeared = text.filter(t => !prev.some(p => p.text === t.text));
      const gone = prev.filter(p=>!text.some(t=>t.text===p.text)).length;
      const currentRegion = frame.damage[0] ?? '';
      motionCount = appeared.length || gone || currentRegion !== motionRegion ? 0 : motionCount + 1;
      motionRegion = currentRegion;
      if (motionCount >= 3 && !args.includes('--include-animating')) return `changed: none (animating region ${currentRegion} masked; use diff --include-animating)\nhelp[1]:\n  desklink-axi look @r1`;
      return `changed: ${frame.damage.length} region since frame ${baseline-1}\nregions[${frame.damage.length}]{ref,box}:\n${frame.damage.map((d,i)=>`  @r${i+1},"${d}"`).join('\n')}\nappeared[${appeared.length}]{ref,text,x,y}:\n${appeared.slice(0,20).map(t=>`  ${t.ref},${JSON.stringify(t.text)},${t.x},${t.y}`).join('\n')}\ngone: ${gone} text items\nhelp[2]:\n  desklink-axi look @r1\n  desklink-axi screen --query "<words>"`; }
    return `changed: none since frame ${frame.seq} (still ${frame.still_ms}ms)\nhelp[1]:\n  desklink-axi screen --query "<words>"`;
  };
  const server: Server = createServer(socket => { let request = ''; socket.on('data', chunk => { request += chunk; if (!request.includes('\n')) return; const { command, args } = JSON.parse(request.split('\n')[0]!) as {command:string;args:string[]}; void output(command,args).then(result => socket.end(result+'\n'), error => socket.end(`error: ${error.message}\nsuggestion: desklink-axi ${error.message.includes('ocr') ? 'look' : 'screen'} --help\n`)); }); });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  process.on('SIGTERM', () => { void engine.stop().finally(() => { server.close(); if (existsSync(socketPath)) unlinkSync(socketPath); rmSync(dir, {recursive:true,force:true}); }); });
}
