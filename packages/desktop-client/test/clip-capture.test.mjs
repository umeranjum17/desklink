import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { captureClip } from './clip-capture.mjs';

// A fake phone behind `adb -s <serial> ...`. FAKE_MODE=denied makes screenrecord
// fail the way the Android 16 test phone does; otherwise it "records" into
// FAKE_DEVICE and pull reads that back. Every call lands in FAKE_LOG, so the
// check can see which path ran.
const FAKE_ADB = `#!/bin/sh
shift 2
echo "$*" >> "$FAKE_LOG"
for last; do :; done
case "$1" in
    shell)
        case "$2" in
            rm) exit 0 ;;
            screenrecord)
                if [ "$FAKE_MODE" = denied ]; then echo "Permission denied" >&2; exit 1; fi
                printf recorded > "$FAKE_DEVICE/$(basename "$last")"; exit 0 ;;
        esac ;;
    exec-out) cat "$FAKE_FRAME" ;;
    pull) cp "$FAKE_DEVICE/$(basename "$2")" "$3" ;;
esac
`;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// Runs captureClip against the fake phone and returns what it made and did.
const clipWithPhone = (mode, seconds) => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-clip-'));
    try {
        const adb = join(dir, 'adb');
        writeFileSync(adb, FAKE_ADB);
        chmodSync(adb, 0o755);
        const device = join(dir, 'device');
        mkdirSync(device);
        const frame = join(dir, 'frame.png');
        const png = new PNG({ width: 64, height: 128 });
        png.data.fill(200);
        writeFileSync(frame, PNG.sync.write(png));
        const log = join(dir, 'calls.log');
        writeFileSync(log, '');
        const fake = { FAKE_MODE: mode, FAKE_DEVICE: device, FAKE_FRAME: frame, FAKE_LOG: log };
        Object.assign(process.env, fake);
        const outPath = join(dir, 'clip.mp4');
        try {
            const result = captureClip({
                adb, serial: 'fake-serial', seconds, devicePath: '/sdcard/clip.mp4', outPath, scratch: dir,
            });
            const calls = readFileSync(log, 'utf8');
            const codec = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath], { encoding: 'utf8' }).stdout.trim();
            return { result, calls, codec };
        } finally {
            for (const key of Object.keys(fake)) delete process.env[key];
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

it('keeps screenrecord as the first choice when the phone allows it', () => {
    const { result, calls } = clipWithPhone('allowed', 1);
    expect(result.mode).toBe('screenrecord');
    expect(calls).toContain('shell screenrecord --time-limit 1 /sdcard/clip.mp4');
    expect(calls).not.toContain('exec-out screencap');
});

it.skipIf(!hasFfmpeg)('falls back to a screencap timelapse when screenrecord is denied', { timeout: 60000 }, () => {
    const { result, calls, codec } = clipWithPhone('denied', 1);
    expect(result.mode).toBe('timelapse');
    expect(result.frames).toBeGreaterThan(0);
    expect(calls).toContain('shell screenrecord --time-limit 1 /sdcard/clip.mp4');
    expect(calls).toContain('exec-out screencap -p');
    expect(codec).toBe('h264');
});
