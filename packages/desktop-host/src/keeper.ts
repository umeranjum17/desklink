import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { resolveEngine } from './resolveEngine.js';

/** One top-level window on the kept screen, stacking order, newest last. */
export interface KeeperWindow {
    id: number;
    title: string | null;
    class: string | null;
    pid: number | null;
    width: number;
    height: number;
}

export interface DisplayKeeperOptions {
    /** The X display to keep, for example ':42'. Auth comes from `XAUTHORITY` in `env`. */
    display: string;
    /**
     * The engine to run. Defaults to this package's resolved engine; an
     * embedder that owns its engine names it.
     */
    engine?: { command: string; args: string[] };
    /** The keeper's environment; `XAUTHORITY` must carry the display's cookie. */
    env?: NodeJS.ProcessEnv;
    onWindows?: (windows: KeeperWindow[]) => void;
    /** The keeper died; `error` is why it refused to run, when it said. */
    onExit?: (detail: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => void;
    onDiagnostic?: (line: string) => void;
}

/**
 * Parse one keeper stdout line: a window report, a fatal refusal, or nothing
 * (not JSON and not the keeper's business, which goes to diagnostics).
 */
export function parseKeeperLine(line: string): { windows?: KeeperWindow[]; error?: string } | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (typeof parsed.error === 'string') return { error: parsed.error };
    const list = parsed.windows;
    if (!Array.isArray(list)) return null;
    const windows: KeeperWindow[] = [];
    for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue;
        const window = entry as Record<string, unknown>;
        if (typeof window.id !== 'number' || typeof window.width !== 'number' || typeof window.height !== 'number') continue;
        windows.push({
            id: window.id,
            title: typeof window.title === 'string' ? window.title : null,
            class: typeof window.class === 'string' ? window.class : null,
            pid: typeof window.pid === 'number' ? window.pid : null,
            width: window.width,
            height: window.height,
        });
    }
    return { windows };
}

/** A running keeper of one X screen. It exits by itself when the display goes. */
export interface DisplayKeeper {
    /** Stop the keeper and wait for it to be gone. */
    stop(): Promise<void>;
}

/**
 * Run the engine as the kiosk keeper of one private X screen: it fills the
 * screen with each normal window, parks tiny helper windows off-screen, keeps
 * focus on the newest window, and reports the screen's windows on every change.
 * Nothing arrives when no window is open — which is the point.
 */
export function startDisplayKeeper(options: DisplayKeeperOptions): DisplayKeeper {
    const engine = options.engine ?? resolveEngine();
    if (!engine) throw new Error('no desktop engine to keep the display with; see resolveEngine');
    const child = spawn(engine.command, [...engine.args.filter((arg) => arg !== 'serve'), 'keep', '--display', options.display], {
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let refusal: string | undefined;
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
        const parsed = parseKeeperLine(line);
        if (parsed === null) {
            options.onDiagnostic?.(line.trim());
        } else if (parsed.error !== undefined) {
            refusal = parsed.error;
            options.onDiagnostic?.(`display keeper refused: ${parsed.error}`);
        } else if (parsed.windows !== undefined) {
            options.onWindows?.(parsed.windows);
        }
    });
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => options.onDiagnostic?.(line));
    child.on('error', (error) => options.onDiagnostic?.(`display keeper process error: ${error.message}`));
    child.on('exit', (code, signal) => options.onExit?.({ code, signal, ...(refusal === undefined ? {} : { error: refusal }) }));
    return {
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) return resolve();
                // 'close', not 'exit': every report line must have been read
                // before the consumer can be sure what the last state was.
                child.once('close', () => resolve());
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 3000).unref();
            }),
    };
}
