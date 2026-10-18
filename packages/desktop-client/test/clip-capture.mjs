/**
 * The clip of the device screen a lab run keeps: `screenrecord` first.
 *
 * Some phones deny `screenrecord` (the Android 16 test phone refuses every path
 * adb can read). When it fails, the same window is captured as
 * `adb exec-out screencap -p` frames and encoded here as an H.264 timelapse at
 * the rate the device actually gave, so the run still has a clip. The caller
 * labels a timelapse as one in its run output.
 *
 * Every command is awaited, never spawnSync: a relay on the caller's event loop
 * stalls for the whole clip while a blocking command runs.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Resolves with a status and Buffers, like spawnSync, and never rejects. Like
// spawnSync, `input` is written to stdin and stdin is then closed.
export const spawnAsync = (file, args, { input, ...options } = {}) => {
    const pending = execFileAsync(file, args, { encoding: 'buffer', ...options });
    pending.child.stdin.end(input);
    return pending.then(({ stdout, stderr }) => ({ status: 0, signal: null, stdout, stderr }),
        error => ({ status: typeof error.code === 'number' ? error.code : null, signal: error.signal ?? null, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) }));
};

export async function captureClip({ adb = 'adb', serial, seconds, devicePath, outPath, scratch }) {
    const run = (...args) => spawnAsync(adb, ['-s', serial, ...args], { timeout: 120000 });
    await run('shell', 'rm', '-f', devicePath);
    const recorded = await run('shell', 'screenrecord', '--time-limit', String(seconds), devicePath);
    if (recorded.status === 0 && (await run('pull', devicePath, outPath)).status === 0 && statSync(outPath).size > 0) {
        return { mode: 'screenrecord' };
    }

    const dir = mkdtempSync(join(scratch, 'timelapse-'));
    const started = Date.now();
    let frames = 0;
    while (Date.now() - started < seconds * 1000) {
        const shot = await spawnAsync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'],
            { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
        if (shot.status !== 0 || shot.stdout.length === 0) break;
        writeFileSync(join(dir, `f_${frames}.png`), shot.stdout);
        frames++;
    }
    const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
    if (frames === 0) {
        rmSync(dir, { recursive: true, force: true });
        const reason = String(recorded.stderr ?? '').trim() || `exit ${recorded.status}`;
        throw new Error(`screenrecord failed (${reason}) and no screencap frame came back`);
    }
    const fps = frames / elapsed;
    const encoded = await spawnAsync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps.toFixed(3),
        '-i', join(dir, 'f_%d.png'), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '30', outPath],
    { timeout: 600000 });
    rmSync(dir, { recursive: true, force: true });
    if (encoded.status !== 0) throw new Error(`ffmpeg could not encode the timelapse: ${encoded.stderr}`);
    return { mode: 'timelapse', frames, fps: Math.round(fps * 100) / 100 };
}
