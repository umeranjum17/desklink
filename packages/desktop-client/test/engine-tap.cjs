// Test-only tap for the iOS recovery flow. That flow runs the real bridge CLI
// as a separate process, so the harness cannot reach the engine child it owns.
// This module is loaded into that bridge with `NODE_OPTIONS=--require=this` and
// records every bridge -> engine `session.close` / `session.restart_ice` to
// DESKLINK_IOS_TAP_LOG. It changes no behaviour: each write is forwarded
// untouched, so the engine sees exactly the bytes the bridge sent.
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const log = process.env.DESKLINK_IOS_TAP_LOG;
if (log) {
    const origSpawn = spawn;
    require('node:child_process').spawn = function tappedSpawn(command, args, options) {
        const child = origSpawn.call(this, command, args, options);
        if (Array.isArray(args) && args[0] === 'serve' && child.stdin) {
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = (chunk, ...rest) => {
                for (const line of String(chunk).split('\n')) {
                    if (line === '') continue;
                    try {
                        const message = JSON.parse(line);
                        if (message.method === 'session.close' || message.method === 'session.restart_ice') {
                            appendFileSync(log, `${Date.now()} bridge->engine ${JSON.stringify(message)}\n`);
                        }
                    } catch { /* a split line; the next write carries the rest */ }
                }
                return write(chunk, ...rest);
            };
        }
        return child;
    };
}
