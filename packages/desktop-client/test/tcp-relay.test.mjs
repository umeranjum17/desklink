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
