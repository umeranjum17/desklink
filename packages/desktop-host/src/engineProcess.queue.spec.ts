import { expect, it } from 'vitest';
import { EngineClient, type EngineClientOptions } from './engineProcess.js';
import { PROTOCOL_VERSION, type EngineEvent } from './protocol.js';

// A real child speaking the real control protocol over real pipes: the queue is
// only observable through the public `drainEvents`, so a mock that reached into
// private state would not prove what a consumer sees.
const SCRIPT = `
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'hello') {
            process.stdout.write(JSON.stringify({id: request.id, result: {protocol: ${PROTOCOL_VERSION}}}) + '\\n');
            const events = ${JSON.stringify([
                { event: 'session.description', params: { sessionId: 's', generation: 1, description: { type: 'offer', sdp: 'v=0' } } },
                { event: 'session.candidate', params: { sessionId: 's', generation: 1, candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
                { event: 'session.frame.changed', params: { sessionId: 's', seq: 1, damage: [[0, 0, 1, 1]] } },
                { event: 'session.cursor', params: { sessionId: 's', x: 10, y: 20, visible: true, timestamp_us: 1 } },
                { event: 'session.state', params: { sessionId: 's', capture: 'streaming', transport: 'connected', firstFrame: true } }
            ])};
            for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
        } else {
            process.stdout.write(JSON.stringify({id: request.id, result: {ok: true}}) + '\\n');
        }
    });
    setInterval(() => {}, 1000);
`;

const ORDER = [
    'session.description', 'session.candidate', 'session.frame.changed', 'session.cursor', 'session.state',
];

async function start(options: EngineClientOptions): Promise<EngineClient> {
    return EngineClient.start(process.execPath, ['-e', SCRIPT], options);
}

it('does not retain events for a consumer that reads them through onEvent', async () => {
    const seen: EngineEvent[] = [];
    const client = await start({ onEvent: (event) => { seen.push(event); } });
    try {
        // A trailing request round-trip orders every streamed event ahead of its
        // reply, so the queue is settled by the time it resolves.
        await client.request('sync');
        expect(seen.map((event) => event.event)).toEqual(ORDER);
        expect(client.drainEvents()).toEqual([]);
    } finally {
        await client.stop();
    }
});

it('retains events for a consumer that reads them through drainEvents', async () => {
    const client = await start({});
    try {
        await client.request('sync');
        expect(client.drainEvents().map((event) => event.event)).toEqual(ORDER);
        expect(client.drainEvents()).toEqual([]);
    } finally {
        await client.stop();
    }
});
