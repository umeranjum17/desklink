import { afterEach, describe, expect, it, vi } from 'vitest';
import { macosEngineEnabled, platformTag, resolveEngine, explainMissingEngine } from './resolveEngine.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('macOS engine flag', () => {
    it('keeps macOS disabled unless explicitly enabled', () => {
        expect(macosEngineEnabled('darwin', undefined)).toBe(false);
        expect(macosEngineEnabled('darwin', '0')).toBe(false);
        expect(macosEngineEnabled('darwin', 'true')).toBe(false);
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
                'The macOS desktop engine is experimental and off; set DESKLINK_MACOS=1 to try it.',
            );

            vi.stubEnv('DESKLINK_MACOS', '1');
            expect(resolveEngine('')).toBeNull();
            expect(explainMissingEngine('')).toBe(
                `The prebuilt desktop engine for darwin-${process.arch} is missing. It arrives as the optional dependency @desklink/host-darwin-${process.arch}: reinstall without omitting optional dependencies, or point MUXR_DESKLINK_ENGINE at an engine built from source.`,
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
