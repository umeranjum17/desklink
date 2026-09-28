import { describe, expect, it } from 'vitest';
import { startDisplayKeeper, parseKeeperLine, type KeeperWindow } from './keeper.js';

/**
 * The keeper is how a consumer sees what is really on its private screen. The
 * parse has to be exact (presence decisions hang off class and pid) and the
 * spawn wiring has to carry reports, refusals and stops to the right callback.
 */
const STUB = `
const line = process.argv[1];
process.stdout.write(line + '\\n');
if (process.argv[2] === 'linger') setTimeout(() => {}, 60000);
`;

function stubEngine(line: string, linger = false): { command: string; args: string[] } {
    return { command: process.execPath, args: ['-e', STUB, line, ...(linger ? ['linger'] : [])] };
}

/** A spawn is asynchronous; the callback decides when the evidence is in. */
async function until<T>(read: () => T | undefined, ms = 2000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error('the keeper never reported');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const report =
    '{"windows":[{"id":4194305,"title":"PPF probe - Google Chrome","class":"Google-chrome","pid":1003571,"width":1280,"height":800}]}';

describe('parseKeeperLine', () => {
    it('reads a window report exactly', () => {
        expect(parseKeeperLine(report)).toEqual({
            windows: [
                { id: 4194305, title: 'PPF probe - Google Chrome', class: 'Google-chrome', pid: 1003571, width: 1280, height: 800 },
            ],
        });
    });

    it('keeps missing title, class and pid as null, not undefined', () => {
        const parsed = parseKeeperLine('{"windows":[{"id":7,"title":null,"class":null,"pid":null,"width":100,"height":100}]}');
        expect(parsed?.windows).toEqual([{ id: 7, title: null, class: null, pid: null, width: 100, height: 100 }]);
        expect(Object.keys(parsed?.windows?.[0] ?? {})).toHaveLength(6);
    });

    it('drops malformed window entries instead of inventing fields', () => {
        expect(parseKeeperLine('{"windows":[{"id":"x","width":10,"height":10},{"width":10,"height":10},null]}')?.windows).toEqual([]);
    });

    it('reads a refusal and nothing else', () => {
        expect(parseKeeperLine('{"error":"another window manager"}')).toEqual({ error: 'another window manager' });
    });

    it('returns null for an empty line, noise, and a line that is not an object', () => {
        expect(parseKeeperLine('')).toBeNull();
        expect(parseKeeperLine('   ')).toBeNull();
        expect(parseKeeperLine('not json at all')).toBeNull();
        expect(parseKeeperLine('"a string"')).toBeNull();
        expect(parseKeeperLine('{"something":"else"}')).toBeNull();
    });
});

describe('startDisplayKeeper', () => {
    it('delivers a window report to onWindows', async () => {
        let windows: KeeperWindow[] | undefined;
        const keeper = startDisplayKeeper({
            display: ':42',
            engine: stubEngine(report),
            onWindows: (received) => (windows = received),
        });
        try {
            expect((await until(() => windows))?.[0]?.class).toBe('Google-chrome');
        } finally {
            await keeper.stop();
        }
    });

    it('carries a refusal on the exit detail', async () => {
        let exit: { code: number | null; error?: string } | undefined;
        const keeper = startDisplayKeeper({
            display: ':42',
            engine: stubEngine('{"error":"another window manager"}'),
            onExit: (detail) => (exit = detail),
        });
        try {
            expect((await until(() => exit))?.error).toBe('another window manager');
        } finally {
            await keeper.stop();
        }
    });

    it('reports a keeper that could not spawn as dead on the exit detail', async () => {
        let exit: { code: number | null; signal: NodeJS.Signals | null; error?: string } | undefined;
        const keeper = startDisplayKeeper({
            display: ':42',
            engine: { command: '/nonexistent/desklink-engine', args: [] },
            onExit: (detail) => (exit = detail),
        });
        try {
            const detail = await until(() => exit);
            expect(detail?.code).toBeNull();
            expect(detail?.signal).toBeNull();
            expect(detail?.error).toBeTruthy();
        } finally {
            await keeper.stop();
        }
    });

    it('stop() ends even a keeper that would linger', async () => {
        let exited = false;
        const keeper = startDisplayKeeper({
            display: ':42',
            engine: stubEngine(report, true),
            onExit: () => (exited = true),
        });
        const started = Date.now();
        await keeper.stop();
        expect(exited).toBe(true);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});
