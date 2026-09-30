import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { macosEngineEnabled, platformTag, resolveEngine, explainMissingEngine } from './resolveEngine.js';

vi.mock('node:module', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:module')>();
    return { ...actual, createRequire: vi.fn(actual.createRequire) };
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('macOS engine flag', () => {
    it('enables macOS by default with an explicit opt-out', () => {
        expect(macosEngineEnabled('darwin', undefined)).toBe(true);
        expect(macosEngineEnabled('darwin', '0')).toBe(false);
        expect(macosEngineEnabled('darwin', 'true')).toBe(true);
        expect(macosEngineEnabled('darwin', '1')).toBe(true);
        expect(macosEngineEnabled('linux', undefined)).toBe(true);
    });

    it('gates resolution and explains missing engines on Darwin', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });
        try {
            expect(platformTag()).toBe('darwin-arm64');
            vi.stubEnv('DESKLINK_MACOS', '0');
            expect(resolveEngine('/some/configured/engine')).toBeNull();
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The macOS desktop engine is disabled by DESKLINK_MACOS=0; unset it to enable the engine.',
            );

            vi.stubEnv('DESKLINK_MACOS', '');
            const noBuilds = mkdtempSync(join(tmpdir(), 'resolve-engine-'));
            const noPrebuilt = vi.fn(() => { throw new Error('No prebuilt package'); }) as unknown as NodeRequire;
            vi.mocked(createRequire).mockReturnValueOnce(noPrebuilt).mockReturnValueOnce(noPrebuilt);
            expect(resolveEngine('', noBuilds)).toBeNull();
            expect(explainMissingEngine('', noBuilds)).toBe(
                `The prebuilt desktop engine for darwin-${process.arch} is missing. It arrives as the optional dependency @desklink/host-darwin-${process.arch}: reinstall without omitting optional dependencies, or point DESKLINK_ENGINE at an engine built from source.`,
            );
            expect(resolveEngine(process.execPath)).toEqual({ command: process.execPath, args: ['serve'], origin: 'configured' });
            expect(explainMissingEngine(process.execPath)).toBeNull();
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The desktop engine is not at the configured path (/some/configured/engine).',
            );
        } finally {
            Object.defineProperty(process, 'platform', platform);
            Object.defineProperty(process, 'arch', arch);
        }
    });
});

describe('engine path override', () => {
    it('reads the override from DESKLINK_ENGINE', () => {
        vi.stubEnv('DESKLINK_MACOS', '');
        vi.stubEnv('DESKLINK_ENGINE', process.execPath);
        vi.stubEnv('MUXR_DESKLINK_ENGINE', '');
        const noBuilds = mkdtempSync(join(tmpdir(), 'resolve-engine-env-'));
        expect(resolveEngine(undefined, noBuilds)).toEqual({ command: process.execPath, args: ['serve'], origin: 'configured' });
    });

    it('falls back to the legacy name when DESKLINK_ENGINE is unset', () => {
        vi.stubEnv('DESKLINK_MACOS', '');
        vi.stubEnv('DESKLINK_ENGINE', '');
        vi.stubEnv('MUXR_DESKLINK_ENGINE', process.execPath);
        const noBuilds = mkdtempSync(join(tmpdir(), 'resolve-engine-env-'));
        expect(resolveEngine(undefined, noBuilds)).toEqual({ command: process.execPath, args: ['serve'], origin: 'configured' });
    });

    it('prefers DESKLINK_ENGINE when both names are set', () => {
        vi.stubEnv('DESKLINK_MACOS', '');
        vi.stubEnv('DESKLINK_ENGINE', process.execPath);
        vi.stubEnv('MUXR_DESKLINK_ENGINE', '/some/legacy/engine');
        const noBuilds = mkdtempSync(join(tmpdir(), 'resolve-engine-env-'));
        expect(resolveEngine(undefined, noBuilds)).toEqual({ command: process.execPath, args: ['serve'], origin: 'configured' });
    });
});
