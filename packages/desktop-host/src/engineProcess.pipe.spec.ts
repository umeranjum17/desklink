import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { EngineClient } from './engineProcess.js';
import { EngineRefused } from './protocol.js';

it('keeps real control-pipe failures catchable, settles every request and reaps its child', async () => {
    // Real OS pipes: destroying a mock stream cannot prove EPIPE handling.
    for (const mode of ['write-after-end', 'remote-close']) {
        const child = spawn(process.execPath, ['-e', `
            const readline = require('node:readline');
            const { Socket } = require('node:net');
            // libuv never closes Windows stdio fds 0-2, even via fs.closeSync.
            // An extra pipe has a single owned handle that destroy really closes.
            const input = new Socket({fd: 3, readable: true, writable: false});
            readline.createInterface({input}).on('line', line => {
                const request = JSON.parse(line);
                if (request.method === 'hold') {
                    input.once('close', () => process.stderr.write('control closed\\n'));
                    input.destroy();
                } else {
                    process.stdout.write(JSON.stringify({id: request.id, result: {ok: true}}) + '\\n');
                }
            });
            setInterval(() => {}, 1000);
        `], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        // Extra pipes are duplex; keep this end write-only like ordinary stdin,
        // so read-side EOF cannot auto-end it before we exercise the failed write.
        const control = child.stdio[3] as Socket;
        control.pause();
        child.stdin = control;
        const exited = once(child, 'exit');
        let closed!: () => void;
        const pipeClosed = new Promise<void>(resolve => { closed = resolve; });
        // The report's public-JS reproduction constructs a client around its
        // own child; Reflect exercises that same runtime entry point.
        const client = Reflect.construct(EngineClient, [child, {
            requestTimeoutMs: 2000,
            onDiagnostic: (line: string) => { if (line === 'control closed') closed(); },
        }]) as EngineClient;
        try {
            expect(await client.request('hello')).toEqual({ ok: true });
            let results: PromiseSettledResult<unknown>[];
            if (mode === 'write-after-end') {
                child.stdin.end();
                results = await Promise.allSettled([client.request('hello')]);
            } else {
                const outstanding = client.request('hold');
                // Attach rejection handlers before the real descriptor closes.
                const settled = Promise.allSettled([outstanding]);
                await pipeClosed;
                results = await Promise.allSettled([client.request('capabilities')]);
                results.push(...await settled);
            }
            for (const result of results) {
                expect(result.status).toBe('rejected');
                if (result.status !== 'rejected') throw new Error('broken pipe resolved');
                expect(result.reason).toBeInstanceOf(EngineRefused);
                expect(result.reason.code).toBe(mode === 'write-after-end' ? 'ERR_STREAM_WRITE_AFTER_END' : 'EPIPE');
                expect(result.reason.cause.code).toBe(result.reason.code);
            }
            await client.stop();
            expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
        }
    }
}, 10000);
