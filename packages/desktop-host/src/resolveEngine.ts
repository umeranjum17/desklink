import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release as osRelease } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding the engine executable.
 *
 * Three sources, in order, and no fourth:
 *
 *  1. an explicit path, when a consumer or an operator names one;
 *  2. this package's platform package, which npm installs as an optional
 *     dependency on a platform that has a prebuilt engine (Linux x64 glibc and macOS arm64);
 *  3. this package's own build output, for a source build.
 *
 * Deliberately not searched: `PATH`. "A program called desklink-host" is not
 * evidence of which program is about to be given control of a desktop.
 */

export interface ResolvedEngine {
    command: string;
    args: string[];
    origin: 'configured' | 'prebuilt' | 'package';
}

/** Platforms with a published platform package. */
const PREBUILT_PLATFORMS = ['linux-x64-gnu', 'darwin-arm64'];

export function macosEngineEnabled(platform = process.platform, flag = process.env.DESKLINK_MACOS): boolean {
    return platform !== 'darwin' || flag !== '0';
}

export function windowsEngineEnabled(platform = process.platform, flag = process.env.DESKLINK_WINDOWS): boolean {
    return platform !== 'win32' || flag === '1';
}

export function windowsBuildSupported(release = osRelease()): { supported: boolean; build: string } {
    const match = /^10\.0\.(\d+)(?:\.|$)/.exec(release);
    if (!match) return { supported: false, build: `unknown (${release})` };
    const build = Number(match[1]);
    return { supported: Number.isSafeInteger(build) && build >= 22621, build: match[1] };
}

export function windowsBuildError(release = osRelease()): string | null {
    const { supported, build } = windowsBuildSupported(release);
    return supported ? null : `The Windows desktop engine preview requires Windows 11 22H2+ x64; detected Windows build ${build}.`;
}

export function enginePackageRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The platform package for this machine.
 *
 * `libc` is part of the tag because a glibc binary on a musl system fails in
 * ways that look like a broken install rather than an unsupported one, and
 * because npm's own `libc` selector is not honoured by every client.
 */
export function platformTag(
    platform: string = process.platform,
    arch: string = process.arch,
    glibc: boolean | undefined = hasGlibc(),
): string {
    if (platform === 'win32') return `win32-${arch}-msvc`;
    if (platform === 'linux') return `linux-${arch}-${glibc === false ? 'musl' : 'gnu'}`;
    return `${platform}-${arch}`;
}

/** A Linux Node without a reported glibc runtime is taken to be musl. */
function hasGlibc(): boolean | undefined {
    if (process.platform !== 'linux') return undefined;
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime !== undefined;
}

function prebuiltBinary(): string | null {
    const require = createRequire(import.meta.url);
    const name = `@desklink/host-${platformTag()}`;
    try {
        // The platform package's manifest points at the executable, so the
        // binary's name and location stay that package's business.
        const manifest = require(`${name}/package.json`) as { executable?: string; bin?: Record<string, string> };
        const relative = manifest.executable ?? manifest.bin?.['desklink-host'];
        if (typeof relative !== 'string') return null;
        const path = require.resolve(`${name}/${relative.replace(/^\.\//, '')}`);
        return path;
    } catch {
        return null;
    }
}

function buildCandidates(root: string): string[] {
    const binary = process.platform === 'win32' ? 'desklink-host.exe' : 'desklink-host';
    return [
        join(root, 'engine', 'target', 'release', binary),
        join(root, 'engine', 'target', 'debug', binary),
        join(root, 'bin', binary),
    ];
}

/**
 * Engine-binary override, read from the environment.
 *
 * `DESKLINK_ENGINE` is the documented override. `MUXR_DESKLINK_ENGINE` still
 * works as a deprecated fallback, read only when `DESKLINK_ENGINE` is unset
 * or blank, and will be removed in a later release.
 */
function configuredEnginePath(): string | undefined {
    const configured = process.env.DESKLINK_ENGINE;
    if (configured !== undefined && configured.trim() !== '') return configured;
    return process.env.MUXR_DESKLINK_ENGINE;
}

export function resolveEngine(configured = configuredEnginePath(), root = enginePackageRoot()): ResolvedEngine | null {
    if (!macosEngineEnabled() || !windowsEngineEnabled()) return null;
    if (process.platform === 'win32' && process.arch !== 'x64') return null;
    if (process.platform === 'win32' && windowsBuildError() !== null) return null;
    if (configured !== undefined && configured.trim() !== '') {
        if (!isExecutable(configured)) return null;
        return { command: configured, args: ['serve'], origin: 'configured' };
    }
    const prebuilt = prebuiltBinary();
    if (prebuilt !== null && isExecutable(prebuilt)) {
        return { command: prebuilt, args: ['serve'], origin: 'prebuilt' };
    }
    for (const candidate of buildCandidates(root)) {
        if (isExecutable(candidate)) {
            return { command: candidate, args: ['serve'], origin: 'package' };
        }
    }
    return null;
}

function isExecutable(path: string): boolean {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // A file that is not executable is an install that went wrong, and saying so
    // is more useful than an EACCES three calls later.
    return process.platform === 'win32' || (stat.mode & 0o111) !== 0;
}

/**
 * Why the engine is missing, in words fit to show a user. `null` means it is
 * there.
 */
export function explainMissingEngine(
    configured = configuredEnginePath(),
    root = enginePackageRoot(),
): string | null {
    if (!windowsEngineEnabled()) {
        return 'The Windows desktop engine preview is disabled; set DESKLINK_WINDOWS=1 to opt in (Windows 11 22H2+ x64 only).';
    }
    if (process.platform === 'win32' && process.arch !== 'x64') {
        return 'The Windows desktop engine preview requires Windows 11 22H2+ x64; this architecture is unsupported.';
    }
    if (process.platform === 'win32') {
        const buildError = windowsBuildError();
        if (buildError !== null) return buildError;
    }
    if (!macosEngineEnabled()) {
        return 'The macOS desktop engine is disabled by DESKLINK_MACOS=0; unset it to enable the engine.';
    }
    const resolved = resolveEngine(configured, root);
    if (resolved !== null) return null;
    if (configured !== undefined && configured.trim() !== '') {
        if (!existsSync(configured)) {
            return `The desktop engine is not at the configured path (${configured}).`;
        }
        return `The desktop engine at ${configured} is not an executable file.`;
    }
    if (process.platform === 'win32') {
        return 'No Windows preview engine was found. Build desklink-host.exe from source and set DESKLINK_ENGINE to its path; Windows platform packages are not published yet.';
    }
    if (process.platform === 'darwin') {
        const tag = platformTag();
        if (PREBUILT_PLATFORMS.includes(tag)) {
            return `The prebuilt desktop engine for ${tag} is missing. It arrives as the optional dependency @desklink/host-${tag}: reinstall without omitting optional dependencies, or point DESKLINK_ENGINE at an engine built from source.`;
        }
        return `There is no prebuilt desktop engine for ${tag}. Build it from source (see the @desklink/host README) and point DESKLINK_ENGINE at the binary.`;
    }
    if (process.platform !== 'linux') {
        return `The desktop engine runs on Linux and macOS; ${process.platform} is not supported yet.`;
    }
    const tag = platformTag();
    if (PREBUILT_PLATFORMS.includes(tag)) {
        return `The prebuilt desktop engine for ${tag} is missing. It arrives as the optional dependency @desklink/host-${tag}: reinstall without omitting optional dependencies, or point DESKLINK_ENGINE at an engine built from source.`;
    }
    return `There is no prebuilt desktop engine for ${tag}. Build it from source (see the @desklink/host README) and point DESKLINK_ENGINE at the binary.`;
}
