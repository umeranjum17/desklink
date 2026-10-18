/**
 * The lab TCP relay, on its own thread: each WebSocket connection is one
 * relayed TCP connection to the engine loopback port its URL names (`port`,
 * from the kit).
 *
 * A relay that shares a thread with blocking work stops reading while that work
 * blocks, and a client sees about 2 s without frames as a frozen picture. So the
 * relay runs in a worker with its own event loop, writes its log through a
 * stream, and shares its byte counters through memory: nothing the flow does
 * can stall reads or writes on a live stream.
 *
 * The relay dials only a port the flow has allowed (one some app report has
 * carried), and waits (bounded) for the report that carries a new session's
 * port to arrive, so a new stream's dial waits on the flow.
 */
import { createWriteStream } from 'node:fs';
import { connect } from 'node:net';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { WebSocketServer } from 'ws';

const STREAMS = 0, WS_TO_TCP = 1, TCP_TO_WS = 2;

/**
 * Start the relay on 127.0.0.1. `bytes()` reads its live counters; `allowPort`
 * lets it dial an engine port; `close` stops it.
 */
export async function startTcpRelay({ log }) {
    const counters = new Float64Array(new SharedArrayBuffer(3 * Float64Array.BYTES_PER_ELEMENT));
    const worker = new Worker(new URL(import.meta.url), { workerData: { log, counters } });
    let exited = false, failure = null;
    worker.on('exit', code => {
        exited = true;
        if (code !== 0) failure ??= `the relay exited with code ${code}`;
    });
    worker.on('error', error => {
        const stack = error.stack ?? String(error);
        failure ??= stack;
        console.error(`tcp relay worker failed: ${stack}`);
    });
    worker.on('message', message => {
        if (message?.logError) failure ??= `the relay log stopped: ${message.logError}`;
    });
    const port = await new Promise((ok, failed) => {
        worker.on('message', message => { if (typeof message === 'number') ok(message); });
        worker.once('error', failed);
        worker.once('exit', code => failed(new Error(`the relay exited (${code}) before listening`)));
    });
    return {
        port,
        bytes: () => ({ wsToTcp: counters[WS_TO_TCP], tcpToWs: counters[TCP_TO_WS], streams: counters[STREAMS] }),
        failure: () => failure,
        allowPort: enginePort => worker.postMessage(enginePort),
        // The log ends before the thread does, so the last stream notes land.
        close: () => new Promise(done => {
            if (exited) { done(); return; }
            const timer = setTimeout(() => {
                failure ??= 'the relay close timed out';
                worker.terminate();
            }, 5000);
            worker.once('exit', () => { clearTimeout(timer); done(); });
            worker.postMessage('close');
        }),
    };
}

if (!isMainThread) {
    const { counters } = workerData;
    const logStream = createWriteStream(workerData.log, { flags: 'a' });
    let logging = true;
    logStream.on('error', error => {
        logging = false;
        parentPort.postMessage({ logError: error.message });
        console.error(`tcp relay log stopped: ${error.message}`);
    });
    const note = line => { if (logging) logStream.write(`${Date.now()} ${line}\n`); };
    const enginePorts = new Set();
    const streams = new Set();
    note('relay up');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    parentPort.on('message', (message) => {
        if (message !== 'close') { enginePorts.add(message); return; }
        for (const finish of streams) finish();
        for (const client of server.clients) client.terminate();
        server.close();
        logging = false;
        logStream.end(() => process.exit(0));
    });
    server.on('listening', () => parentPort.postMessage(server.address().port));
    server.on('connection', (ws, request) => {
        const target = Number(new URL(request.url, 'ws://relay').searchParams.get('port'));
        const stream = ++counters[STREAMS];
        note(`stream #${stream} open`);
        let socket = null, connected = false, closed = false;
        const queued = [];
        const finish = () => {
            if (closed) return;
            closed = true;
            streams.delete(finish);
            note(`stream #${stream} close (wsToTcp=${counters[WS_TO_TCP]} tcpToWs=${counters[TCP_TO_WS]})`);
            try { ws.close(); } catch { /* already gone */ }
            try { socket?.destroy(); } catch { /* already gone */ }
        };
        streams.add(finish);
        const pump = () => {
            note(`stream #${stream} dialing 127.0.0.1:${target}`);
            socket = connect(target, '127.0.0.1', () => {
                note(`stream #${stream} dial ok`);
                connected = true;
                for (const chunk of queued.splice(0)) socket.write(chunk);
            });
            socket.on('data', (chunk) => {
                counters[TCP_TO_WS] += chunk.length;
                if (ws.readyState === ws.OPEN) ws.send(chunk);
            });
            socket.on('error', finish);
            socket.on('close', finish);
        };
        const deadline = Date.now() + 60000;
        const dialWhenAllowed = () => {
            if (closed) return;
            if (enginePorts.has(target)) { pump(); return; }
            if (Date.now() > deadline) { note(`stream #${stream} names an unreported port: ${target}`); finish(); return; }
            setTimeout(dialWhenAllowed, 100);
        };
        dialWhenAllowed();
        ws.on('message', (data) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            counters[WS_TO_TCP] += chunk.length;
            if (connected) { socket.write(chunk); return; }
            if (queued.reduce((n, c) => n + c.length, 0) + chunk.length > 1048576) {
                note(`stream #${stream} queued bytes over 1 MiB before dial: closing`);
                finish();
                return;
            }
            queued.push(chunk);
        });
        ws.on('error', finish);
        ws.on('close', finish);
    });
}
