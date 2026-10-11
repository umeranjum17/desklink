// The userspace-shaped relay, run ON THE MAC so the simulator app can reach it
// over a path that is always present (its own LAN address, not an intermittent
// Tailscale candidate). The engine and the fixture stay on the private Linux
// Xvfb; only this relay and its signalling socket move.
//
// The flow copies this file and `shaped-link.mjs` into the example app's own
// directory on the Mac (so `import 'ws'` resolves against the app's installed
// dependency), starts an SSH reverse-forward for the Linux bridge, and spawns
// this process. It prints newline-delimited JSON on stdout and reads `report`
// and `quit` on stdin. Nothing here changes a product path: it is the same
// ShapedLink the browser journeys run, with an app-facing and an engine-facing
// address on two different Mac interfaces.
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

const link = new ShapedLink((line) => emit({ type: 'log', line }), {
    appAddress, engineAddress, remoteBrowser: true, remoteEngine: true,
});
const relay = await startSignalling(link, bridgePort, token, { relayOnly: true })
    .catch((error) => {
        emit({ type: 'error', message: `relay start: ${error instanceof Error ? error.message : error}` });
        process.exit(1);
    });
emit({ type: 'ready', relayPort: relay.port, appAddress, engineAddress, pid: process.pid });

createInterface({ input: process.stdin }).on('line', (line) => {
    const command = line.trim();
    if (command === 'report' || command === 'quit') emit({ type: 'report', link: link.snapshot() });
    if (command === 'quit') { relay.close(); link.close(); process.exit(0); }
});
