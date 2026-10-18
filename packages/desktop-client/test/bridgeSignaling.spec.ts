import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SessionEvent } from '@desklink/react-native';

import { bridgeSignaling } from '../example/bridgeSignaling';

/**
 * The relay-only lab drops every inbound candidate but the relayed TCP one.
 * A real bridge socket carries a direct UDP candidate and then the loopback
 * TCP one; the second arriving proves the first was already handled.
 */
const UDP = 'candidate:1 1 udp 2122260223 100.64.0.2 54321 typ host';
const TCP = 'candidate:2 1 tcp 1518280447 127.0.0.1 40123 typ host tcptype passive';

let server: WebSocketServer | undefined;
afterEach(() => server?.close());

async function heard(filter?: (event: SessionEvent) => SessionEvent | null): Promise<string[]> {
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => {
        for (const candidate of [UDP, TCP]) socket.send(JSON.stringify({ event: 'session.candidate', params: { sessionId: 's', candidate } }));
    });
    const { port } = server.address() as { port: number };
    const lines: string[] = [];
    let signaling: ReturnType<typeof bridgeSignaling> | undefined;
    await new Promise<void>((done) => {
        signaling = bridgeSignaling(`ws://127.0.0.1:${port}/desktop`, (event) => {
            if (event.kind !== 'candidate') return;
            lines.push(event.candidate.candidate);
            if (event.candidate.candidate === TCP) done();
        }, filter);
    });
    signaling?.close();
    return lines;
}

async function heardOfferGeometry(): Promise<SessionEvent | undefined> {
    const geometry = { source: { width: 1200, height: 600 }, encoded: { width: 1200, height: 600 }, origin: { x: 0, y: 0 } };
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => socket.send(JSON.stringify({
        event: 'session.description',
        params: { sessionId: 's', description: { type: 'offer', sdp: 'v=0' }, geometry },
    })));
    const { port } = server.address() as { port: number };
    return await new Promise<SessionEvent | undefined>((done) => {
        let signaling: ReturnType<typeof bridgeSignaling> | undefined;
        signaling = bridgeSignaling(`ws://127.0.0.1:${port}/desktop`, (event) => {
            if (event.kind !== 'description') return;
            signaling?.close();
            done(event);
        });
    });
}

describe('bridgeSignaling inbound filter', () => {
    it('drops what the filter rejects', async () => {
        expect(await heard((event) => (event.kind === 'candidate' && event.candidate.candidate === UDP ? null : event))).toEqual([TCP]);
    });

    it('passes every event without a filter', async () => {
        expect(await heard()).toEqual([UDP, TCP]);
    });

    it('keeps renegotiation geometry when parsing an offer', async () => {
        expect(await heardOfferGeometry()).toMatchObject({
            kind: 'description',
            geometry: { source: { width: 1200, height: 600 }, encoded: { width: 1200, height: 600 } },
        });
    });
});
