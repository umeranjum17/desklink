import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { WebSocket, WebSocketServer } from 'ws';

// Lab WebSocket proxy on its own event loop; controls and counters are shared
// so flows can change outage conditions without owning the relay's sockets.
export async function startWsRelay({ host = '127.0.0.1', port = 0, path, upstream, evidence, onEvent, controlCount = 3 }) {
    const state = new Int32Array(new SharedArrayBuffer((controlCount + 3) * Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(new URL(import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')), workerData: { host, port, path, upstream, evidence, state } });
    let failure, exited = false;
    worker.on('exit', () => { exited = true; });
    worker.on('error', error => { failure = error.message; });
    worker.on('message', message => { if (message.event) onEvent?.(message.event); });
    const listenPort = await new Promise((resolve, reject) => {
        worker.on('message', message => { if (message.port !== undefined) resolve(message.port); });
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`WebSocket relay exited (${code}) before listening`)));
    });
    return {
        port: listenPort,
        clients: { terminate: () => worker.postMessage('terminate') },
        get refused() { return Atomics.load(state, controlCount); },
        mode: (index, value) => {
            if (!Number.isInteger(index) || index < 0 || index >= controlCount) throw new RangeError('unknown WebSocket relay mode');
            Atomics.store(state, index, value ? 1 : 0);
        },
        bytes: () => ({ clientToUpstream: Atomics.load(state, controlCount + 1), upstreamToClient: Atomics.load(state, controlCount + 2) }),
        close: () => exited ? Promise.resolve() : new Promise(resolve => { worker.once('exit', resolve); worker.postMessage('close'); }),
        failure: () => failure,
    };
}

if (!isMainThread) {
    const { host, port, path, upstream, evidence, state } = workerData;
    const { writeFileSync } = await import('node:fs');
    let offer = null, answer = null;
    const controlCount = state.length - 3;
    const server = new WebSocketServer({ host, port, ...(path ? { path } : {}), verifyClient: (_info, done) => {
        const reject = Atomics.load(state, 0) !== 0;
        if (reject) Atomics.add(state, controlCount, 1);
        done(!reject);
    } });
    const clients = new Set();
    parentPort.on('message', message => {
        if (message === 'terminate') for (const client of clients) client.terminate();
        if (message === 'close') {
            for (const client of clients) client.terminate();
            server.close(() => process.exit(0));
        }
    });
    server.on('listening', () => parentPort.postMessage({ port: server.address().port }));
    server.on('connection', (client, request) => {
        clients.add(client);
        const host = new WebSocket(`${upstream}${request.url}`);
        const queued = [];
        const held = new Set();
        const methods = new Map();
        const cleanup = () => { clients.delete(client); if (host.readyState < WebSocket.CLOSING) host.close(); };
        const sendUp = raw => {
            if (Atomics.load(state, 1)) return;
            if (host.readyState !== WebSocket.OPEN) { queued.push(raw); return; }
            if (Atomics.load(state, 2)) {
                try { if (JSON.parse(String(raw)).method === 'session.metrics') held.add(JSON.parse(String(raw)).id); } catch {}
            }
            host.send(raw);
            if (controlCount > 3 && Atomics.load(state, 3)) {
                try { if (JSON.parse(String(raw)).method === 'session.restart_ice') { parentPort.postMessage({ event: { _restartCut: true } }); client.terminate(); } } catch {}
            }
        };
        host.on('open', () => { for (const raw of queued.splice(0)) sendUp(raw); });
        client.on('message', raw => {
            Atomics.add(state, controlCount + 1, Buffer.byteLength(raw));
            try {
                const m = JSON.parse(String(raw));
                if (m.method) methods.set(m.id, m.method);
                if (m.method === 'session.description' && m.params?.description?.type === 'answer' && answer === null) {
                    answer = m.params.description.sdp;
                    if (evidence) writeFileSync(`${evidence}/answer.sdp`, answer);
                    parentPort.postMessage({ event: { _answer: answer } });
                }
            } catch {}
            sendUp(raw);
        });
        host.on('message', raw => {
            Atomics.add(state, controlCount + 2, Buffer.byteLength(raw));
            if (Atomics.load(state, 1)) return;
            try {
                const m = JSON.parse(String(raw));
                if (m.event === 'session.description' && offer === null) {
                    offer = m.params.description.sdp;
                    if (evidence) writeFileSync(`${evidence}/offer.sdp`, offer);
                }
                if (m.event === 'session.description' || m.event === 'session.state') parentPort.postMessage({ event: m });
                if (held.delete(m.id)) return;
                if (methods.get(m.id) === 'session.open' && m.result) parentPort.postMessage({ event: { _opened: m.result } });
                methods.delete(m.id);
            } catch {}
            if (client.readyState === WebSocket.OPEN) client.send(String(raw));
        });
        client.on('close', cleanup); host.on('close', () => client.close()); host.on('error', () => client.close());
    });
}
