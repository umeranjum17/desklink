import { afterEach, describe, expect, it, vi } from 'vitest';
import { macosEngineEnabled, platformTag, resolveEngine, explainMissingEngine } from './resolveEngine.js';

afterEach(() => vi.unstubAllEnvs());

describe('macOS engine flag', () => {
    it('keeps macOS disabled unless explicitly enabled', () => {
        expect(macosEngineEnabled('darwin', undefined)).toBe(false);
        expect(macosEngineEnabled('darwin', '0')).toBe(false);
        expect(macosEngineEnabled('darwin', 'true')).toBe(false);
        expect(macosEngineEnabled('darwin', '1')).toBe(true);
        expect(macosEngineEnabled('linux', undefined)).toBe(true);
    });

    it('explains the disabled macOS engine before resolving any origin', () => {
        vi.stubEnv('DESKLINK_MACOS', '0');
        expect(platformTag('darwin', 'arm64')).toBe('darwin-arm64');
        if (process.platform === 'darwin') {
            expect(resolveEngine('/some/configured/engine')).toBeNull();
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The macOS desktop engine is experimental and off; set DESKLINK_MACOS=1 to try it.',
            );
        }
    });
});
