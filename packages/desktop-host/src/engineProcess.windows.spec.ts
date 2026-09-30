import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from './engineProcess.js';

vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    spawn: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let child: ChildProcessWithoutNullStreams;
beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(), exitCode: null, signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    vi.mocked(spawn).mockReturnValue(child);
});
afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.clearAllMocks();
});

describe('Windows engine startup', () => {
    it('spawns hidden without a shell and completes hello before returning', async () => {
        const starting = EngineClient.start('host.exe', ['serve']);
        expect(spawn).toHaveBeenCalledWith('host.exe', ['serve'], {
            env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        const request = JSON.parse(child.stdin.read().toString());
        expect(request).toEqual({ id: 1, method: 'hello', params: { protocol: 3 } });
        child.stdout.write(JSON.stringify({ id: request.id, result: { protocol: 3 } }) + '\n');
        const client = await starting;
        child.emit('exit', 0, null);
        await client.stop();
    });

    it.each([0xc0000135, -1073741515])('maps missing-DLL exit %s', async (code) => {
        const starting = EngineClient.start('host.exe', ['serve']);
        const rejected = expect(starting).rejects.toMatchObject({ code: 'missing-system-library', message: expect.stringContaining('0xC0000135') });
        child.emit('exit', code, null);
        await rejected;
    });

    it('reports a spawn error immediately rather than waiting for hello timeout', async () => {
        const starting = EngineClient.start('absent.exe', ['serve']);
        const rejected = expect(starting).rejects.toMatchObject({ code: 'engine-spawn-failed', message: expect.stringContaining('ENOENT') });
        child.emit('error', new Error('spawn absent.exe ENOENT'));
        await rejected;
    });
});
