import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startTcpRelay } from './tcp-relay.mjs';
import { startWsRelay } from './ws-relay.mjs';

// The far ends live in their own process, as the engine and the phone do: an
// echo server for the engine port and a WebSocket client that sends a probe
// every 50 ms and reports the longest wait between echoes.
const FAR_ENDS = `
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
const echo = createServer(socket => socket.pipe(socket));
echo.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ echoPort: echo.address().port })));
createInterface({ input: process.stdin }).once('line', line => {
    const ws = new WebSocket(line);
    let last = 0, longest = 0, echoes = 0;
    ws.on('message', () => {
        const now = Date.now();
        if (echoes > 0) longest = Math.max(longest, now - last);
        if (echoes === 0) console.log(JSON.stringify({ flowing: true }));
        last = now;
        echoes += 1;
    });
    ws.on('open', () => {
        const probes = setInterval(() => ws.send(Buffer.from('probe')), 50);
        setTimeout(() => {
            clearInterval(probes);
            console.log(JSON.stringify({ longest, echoes }));
            process.exit(0);
        }, 6000);
    });
});
`;

async function echoThrough(relay) {
    const echo = createServer(socket => socket.pipe(socket));
    await new Promise(ok => echo.listen(0, '127.0.0.1', ok));
    const port = echo.address().port;
    relay.allowPort(port);
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/tcp?port=${port}`);
    await new Promise((ok, failed) => { ws.once('open', ok); ws.once('error', failed); });
    const echoed = new Promise(ok => ws.once('message', ok));
    ws.send('probe');
    await echoed;
    return { ws, echo };
}

it('keeps relaying while the thread that started it is blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-relay-'));
    const relay = await startTcpRelay({ log: join(dir, 'relay.log') });
    const farEnds = spawn(process.execPath, ['--input-type=module', '-e', FAR_ENDS],
        { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['pipe', 'pipe', 'inherit'] });
    try {
        const lines = createInterface({ input: farEnds.stdout })[Symbol.asyncIterator]();
        const next = async () => JSON.parse((await lines.next()).value);
        const { echoPort } = await next();
        relay.allowPort(echoPort);
        farEnds.stdin.write(`ws://127.0.0.1:${relay.port}/tcp?port=${echoPort}\n`);
        expect(await next()).toEqual({ flowing: true });
        // A thread blocked on synchronous work: it stops reading without spending CPU.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
        const { longest, echoes } = await next();
        expect(echoes).toBeGreaterThan(10);
        expect(longest).toBeLessThan(1000);
        expect(relay.bytes()).toMatchObject({ streams: 1 });
        expect(relay.bytes().wsToTcp).toBeGreaterThan(0);
        expect(relay.bytes().tcpToWs).toBeGreaterThan(0);
    } finally {
        farEnds.kill();
        await relay.close();
        expect(readFileSync(join(dir, 'relay.log'), 'utf8')).toMatch(/stream #1 dial ok/);
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);

it('keeps the WebSocket proxy flowing while the flow thread blocks', async () => {
    let proxy;
    const farEnds = spawn(process.execPath, ['--input-type=module', '-e', `
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import WebSocket, { WebSocketServer } from 'ws';
const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
upstream.on('connection', ws => ws.on('message', data => ws.send(data)));
upstream.on('listening', () => console.log(JSON.stringify({ port: upstream.address().port })));
createInterface({ input: process.stdin }).once('line', line => {
 const ws = new WebSocket(line); let echoes = 0;
 ws.on('message', () => { if (++echoes === 1) console.log(JSON.stringify({ flowing: true })); });
 ws.on('open', () => { const timer = setInterval(() => ws.send('probe'), 25); setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ echoes })); process.exit(0); }, 4500); });
});`], { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['pipe', 'pipe', 'inherit'] });
    try {
        const lines = createInterface({ input: farEnds.stdout })[Symbol.asyncIterator]();
        const next = async () => JSON.parse((await lines.next()).value);
        const { port } = await next();
        proxy = await startWsRelay({ upstream: `ws://127.0.0.1:${port}` });
        farEnds.stdin.write(`ws://127.0.0.1:${proxy.port}\n`);
        expect(await next()).toEqual({ flowing: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
        const { echoes } = await next();
        expect(echoes).toBeGreaterThan(40);
        expect(proxy.bytes().clientToUpstream).toBeGreaterThan(0);
        expect(proxy.bytes().upstreamToClient).toBeGreaterThan(0);
        await proxy.close();
    } finally {
        farEnds.kill();
        if (proxy) await proxy.close();
    }
}, 30000);

it('keeps relaying when its log cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-relay-'));
    const relay = await startTcpRelay({ log: dir });
    let session;
    try {
        session = await echoThrough(relay);
        expect(relay.bytes()).toMatchObject({ streams: 1 });
    } finally {
        session?.ws.terminate();
        session?.echo.close();
        await relay.close();
        expect(relay.failure()).toMatch(/the relay log stopped/);
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);

it('delivers bytes sent before the engine port is allowed, in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-relay-'));
    const relay = await startTcpRelay({ log: join(dir, 'relay.log') });
    const echo = createServer(socket => socket.pipe(socket));
    let ws;
    try {
        await new Promise(ok => echo.listen(0, '127.0.0.1', ok));
        const port = echo.address().port;
        ws = new WebSocket(`ws://127.0.0.1:${relay.port}/tcp?port=${port}`);
        await new Promise((ok, failed) => { ws.once('open', ok); ws.once('error', failed); });
        let echoed = '';
        ws.on('message', data => { echoed += data; });
        const sent = [];
        relay.allowPort(port);
        const sending = setInterval(() => {
            const chunk = `${sent.length},`;
            sent.push(chunk);
            ws.send(chunk);
        }, 1);
        await new Promise(ok => setTimeout(ok, 300));
        clearInterval(sending);
        const want = sent.join('');
        await vi.waitFor(() => expect(echoed).toBe(want), { timeout: 5000 });
    } finally {
        ws?.terminate();
        echo.close();
        await relay.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);

it('closes a stream whose pre-dial bytes pass the 1 MiB cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-relay-'));
    const relay = await startTcpRelay({ log: join(dir, 'relay.log') });
    const echo = createServer(socket => socket.pipe(socket));
    let ws;
    try {
        await new Promise(ok => echo.listen(0, '127.0.0.1', ok));
        const port = echo.address().port;
        ws = new WebSocket(`ws://127.0.0.1:${relay.port}/tcp?port=${port}`);
        await new Promise((ok, failed) => { ws.once('open', ok); ws.once('error', failed); });
        const closed = new Promise(ok => ws.once('close', ok));
        const chunk = Buffer.alloc(256 * 1024, 'x');
        for (let i = 0; i < 5; i++) ws.send(chunk);
        await closed;
    } finally {
        ws?.terminate();
        echo.close();
        await relay.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);

it('writes each open stream close before the log ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-relay-'));
    const relay = await startTcpRelay({ log: join(dir, 'relay.log') });
    let session;
    try {
        session = await echoThrough(relay);
        await relay.close();
        expect(readFileSync(join(dir, 'relay.log'), 'utf8')).toMatch(/stream #1 close/);
    } finally {
        session?.ws.terminate();
        session?.echo.close();
        await relay.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);
