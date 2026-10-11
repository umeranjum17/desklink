// The userspace-shaped relay, run ON THE MAC so the simulator app can reach it
// over a path that is always present (its own LAN address, not an intermittent
// Tailscale candidate). The engine and the fixture stay on the private Linux
// Xvfb; only this relay and its signalling socket move.
//
// The flow copies this file and `shaped-link.mjs` into the example app's own
// directory on the Mac (so `import 'ws'` resolves against the app's installed
// dependency), starts an SSH reverse-forward for the Linux bridge, and spawns
// this process. It prints newline-delimited JSON on stdout and reads commands on
// stdin. Nothing here changes a product path: it is the same ShapedLink the
// browser journeys run, with an app-facing and an engine-facing address on two
// different Mac interfaces.
//
// One owned cut lives here, not on shared host networking: `cut` adopts the
// discard shape (both native UDP directions) and cuts the signalling channel;
// `restore` retires the app's old browser-facing tuple, lifts the discard and
// re-opens signalling, so only a fresh ICE generation can find the replacement.
// `restore negative` restores signalling but LEAVES THE MEDIA CUT — the control
// whose picture-recovery verdict must fail. `report`/`quit` return a snapshot.
// Every protocol frame that names a session, a method or ICE credentials is
// forwarded as a `wire` record, so the run's receipt can name what crossed.
import { createInterface } from 'node:readline';
import { ShapedLink, startSignalling } from './shaped-link.mjs';

const arg = (name, fallback = '') => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
};
const bridgePort = Number(arg('bridge-port'));
const token = arg('token');
const appAddress = arg('app-address', '127.0.0.1');
const engineAddress = arg('engine-address', appAddress);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (!Number.isInteger(bridgePort) || bridgePort <= 0) {
    emit({ type: 'error', message: 'missing --bridge-port' });
    process.exit(1);
}

// Only the frames a receipt needs: the session id, the open/close/restart_ice
// method that carried it, and the ICE credentials (ufrag + DTLS fingerprint) an
// offer carried. Candidates and metrics would only flood the pipe.
const WIRE_METHODS = new Set(['session.open', 'session.close', 'session.restart_ice', 'session.description']);
const WIRE_EVENTS = new Set(['session.description', 'session.state', 'session.revoked']);
function wireRecord(dir, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return null; }
    const sessionId = message.result?.sessionId ?? message.params?.sessionId ?? null;
    if (message.method !== undefined) {
        if (!WIRE_METHODS.has(message.method)) return null;
        return { dir, method: message.method, id: message.id ?? null, sessionId };
    }
    if (!WIRE_EVENTS.has(message.event)) return null;
    const record = { dir, event: message.event, sessionId };
    if (message.event === 'session.description') {
        const sdp = message.params?.description?.sdp ?? '';
        record.descriptionType = message.params?.description?.type ?? null;
        record.ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1] ?? null;
        record.fingerprint = sdp.match(/a=fingerprint:([^\r\n]+)/)?.[1] ?? null;
    }
    if (message.event === 'session.state') record.transport = message.params?.transport ?? null;
    return record;
}

const link = new ShapedLink((line) => emit({ type: 'log', line }), {
    appAddress, engineAddress, remoteBrowser: true, remoteEngine: true,
});
const relay = await startSignalling(link, bridgePort, token, {
    relayOnly: true,
    onWire: (dir, raw) => {
        const record = wireRecord(dir, raw);
        if (record !== null) emit({ type: 'wire', wire: record });
    },
}).catch((error) => {
    emit({ type: 'error', message: `relay start: ${error instanceof Error ? error.message : error}` });
    process.exit(1);
});
emit({ type: 'ready', relayPort: relay.port, appAddress, engineAddress, pid: process.pid });

async function handle(command) {
    if (command === 'cut') {
        link.set({ discard: true }, 'owned path cut');
        relay.setCut(true);
        emit({ type: 'cut', at: Date.now(), link: link.snapshot() });
        return;
    }
    if (command === 'restore' || command === 'restore negative') {
        const negative = command.endsWith('negative');
        try {
            await link.rebindBrowserSide();
        } catch (error) {
            emit({ type: 'error', message: `rebind: ${error instanceof Error ? error.message : error}` });
            return;
        }
        const at = Date.now();
        // The negative restores the path but keeps cutting MEDIA and nothing
        // else: STUN/DTLS flow, so the transport can reach connected and the
        // status can change, yet no frame crosses — the picture verdict must
        // still fail. A full-path discard would only prove a dead transport.
        link.set(negative ? { discardMedia: true } : { discard: false }, negative
            ? 'negative control: signalling restored, media stays cut'
            : 'owned path back');
        relay.setCut(false);
        emit({ type: 'restored', at, negative, link: link.snapshot() });
        return;
    }
    if (command === 'report' || command === 'quit') emit({ type: 'report', link: link.snapshot() });
    if (command === 'quit') { relay.close(); link.close(); process.exit(0); }
}

createInterface({ input: process.stdin }).on('line', (line) => {
    void handle(line.trim());
});
