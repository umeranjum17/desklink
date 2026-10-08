import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { EngineClient } from './engineProcess.js';
import { EngineRefused } from './protocol.js';

it('keeps real control-pipe failures catchable, settles every request and reaps its child', async () => {
    // Real OS pipes: destroying a mock stream cannot prove EPIPE handling.
    for (const mode of ['write-after-end', 'remote-close']) {
        const child = spawn(process.execPath, ['-e', `
            const readline = require('node:readline');
            const fs = require('node:fs');
            readline.createInterface({input: process.stdin}).on('line', line => {
                const request = JSON.parse(line);
                if (request.method === 'hold') {
                    fs.closeSync(0);
                    process.stderr.write('control closed\\n');
                } else {
                    process.stdout.write(JSON.stringify({id: request.id, result: {ok: true}}) + '\\n');
                }
            });
            setInterval(() => {}, 1000);
        `], { stdio: ['pipe', 'pipe', 'pipe'] });
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
