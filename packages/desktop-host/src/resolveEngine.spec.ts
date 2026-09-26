import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { macosEngineEnabled, platformTag, resolveEngine, explainMissingEngine } from './resolveEngine.js';

afterEach(() => {
    vi.restoreAllMocks();
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
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        try {
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            expect(platformTag()).toBe(`darwin-${process.arch}`);
            vi.stubEnv('DESKLINK_MACOS', '0');
            expect(resolveEngine('/some/configured/engine')).toBeNull();
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The macOS desktop engine is experimental and off; set DESKLINK_MACOS=1 to try it.',
            );

            vi.stubEnv('DESKLINK_MACOS', '1');
            expect(resolveEngine('')).toBeNull();
            expect(explainMissingEngine('')).toBe(
                'No macOS desktop engine is available yet; DESKLINK_MACOS=1 only enables candidate resolution, not Mac capture or input.',
            );
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The desktop engine is not at the configured path (/some/configured/engine).',
            );
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
    });
});
