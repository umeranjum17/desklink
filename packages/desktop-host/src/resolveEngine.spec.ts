import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { macosEngineEnabled, windowsEngineEnabled, windowsBuildSupported, windowsBuildError, platformTag, resolveEngine, explainMissingEngine } from './resolveEngine.js';

const mockedWindowsRelease = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, release: () => mockedWindowsRelease.value ?? actual.release() };
});

vi.mock('node:module', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:module')>();
    return { ...actual, createRequire: vi.fn(actual.createRequire) };
});

beforeEach(() => {
    // Existing override specs also run on the hosted Windows runner.
    vi.stubEnv('DESKLINK_WINDOWS', '1');
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
        const root = mkdtempSync(join(tmpdir(), 'resolve-engine-darwin-'));
        const executable = join(root, 'desklink-host');
        writeFileSync(executable, 'fixture', { mode: 0o755 });
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
            expect(resolveEngine(executable)).toEqual({ command: executable, args: ['serve'], origin: 'configured' });
            expect(explainMissingEngine(executable)).toBeNull();
            expect(explainMissingEngine('/some/configured/engine')).toBe(
                'The desktop engine is not at the configured path (/some/configured/engine).',
            );
        } finally {
            Object.defineProperty(process, 'platform', platform);
            Object.defineProperty(process, 'arch', arch);
            rmSync(root, { recursive: true, force: true });
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


describe('Windows preview resolution', () => {
    it('requires Windows 11 22H2 or later', () => {
        expect(windowsBuildSupported('10.0.19045')).toEqual({ supported: false, build: '19045' });
        expect(windowsBuildSupported('10.0.20348')).toEqual({ supported: false, build: '20348' });
        expect(windowsBuildSupported('10.0.22621')).toEqual({ supported: true, build: '22621' });
        expect(windowsBuildSupported('Windows 11')).toEqual({ supported: false, build: 'unknown (Windows 11)' });
        expect(windowsBuildSupported('10.0.22621.not-a-version')).toEqual({
            supported: false,
            build: 'unknown (10.0.22621.not-a-version)',
        });
        expect(windowsBuildError('Windows 11')).toBe(
            'The Windows desktop engine preview requires Windows 11 22H2+ x64; detected Windows build unknown (Windows 11).',
        );
    });

    it('requires the exact opt-in only on Windows', () => {
        vi.stubEnv('DESKLINK_WINDOWS', '');
        for (const flag of [undefined, '', '0', 'true']) expect(windowsEngineEnabled('win32', flag)).toBe(false);
        expect(windowsEngineEnabled('win32', '1')).toBe(true);
        expect(windowsEngineEnabled('linux', '0')).toBe(true);
        expect(windowsEngineEnabled('darwin', '0')).toBe(true);
        expect(platformTag('win32', 'x64')).toBe('win32-x64-msvc');
    });

    it('gates explicit paths, accepts files without Unix execute bits, and finds .exe builds', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
        const root = mkdtempSync(join(tmpdir(), 'windows-engine-'));
        const binary = join(root, 'engine', 'target', 'debug', 'desklink-host.exe');
        mkdirSync(join(root, 'engine', 'target', 'debug'), { recursive: true });
        writeFileSync(binary, 'fixture', { mode: 0o600 });
        Object.defineProperty(process, 'platform', { value: 'win32' });
        Object.defineProperty(process, 'arch', { value: 'x64' });
        mockedWindowsRelease.value = '10.0.22621';
        try {
            vi.stubEnv('DESKLINK_WINDOWS', '');
            expect(resolveEngine(binary, root)).toBeNull();
            expect(explainMissingEngine(binary, root)).toContain('DESKLINK_WINDOWS=1');
            vi.stubEnv('DESKLINK_WINDOWS', '1');
            vi.stubEnv('DESKLINK_ENGINE', binary);
            expect(resolveEngine(undefined, root)).toEqual({ command: binary, args: ['serve'], origin: 'configured' });
            expect(explainMissingEngine(binary, root)).toBeNull();
            expect(resolveEngine(root, root)).toBeNull();
            expect(resolveEngine('', root)).toEqual({ command: binary, args: ['serve'], origin: 'package' });
            rmSync(binary);
            expect(explainMissingEngine('', root)).toContain('not published yet');
            Object.defineProperty(process, 'arch', { value: 'arm64' });
            expect(resolveEngine(process.execPath, root)).toBeNull();
            expect(explainMissingEngine(process.execPath, root)).toContain('architecture is unsupported');
        } finally {
            mockedWindowsRelease.value = undefined;
            Object.defineProperty(process, 'platform', platform);
            Object.defineProperty(process, 'arch', arch);
            rmSync(root, { recursive: true, force: true });
        }
    });
});
