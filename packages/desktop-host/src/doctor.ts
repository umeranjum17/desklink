/**
 * `desklink-host doctor`: one PASS/FAIL line per requirement a Linux session
 * needs, and the free package command that fixes a failure.
 *
 * The engine answers the machine questions (`diagnose`); this file adds the
 * package facts and the words a person can act on. It starts no session and
 * opens no portal, so it is safe to run before choosing a capture source.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { missingSystemLibrary } from './engineProcess.js';
import { enginePackageRoot, explainMissingEngine, resolveEngine, type ResolvedEngine } from './resolveEngine.js';

type Status = 'PASS' | 'FAIL' | 'N/A';

interface Check {
    status: Status;
    name: string;
    detail: string;
    fix?: string;
}

interface X11Report {
    connected: boolean;
    error?: string;
    display?: string;
    width?: number;
    height?: number;
    shm?: boolean;
    damage?: boolean;
    xtest?: boolean;
}

interface WaylandReport {
    screencast: boolean;
    screencast_error?: string;
    remote_desktop: boolean;
    remote_desktop_error?: string;
    pipewire: boolean;
}

interface EncoderReport {
    name: string;
    hardware: boolean;
}

interface DiagnoseReport {
    version?: string;
    session?: 'x11' | 'wayland' | 'none';
    x11?: X11Report;
    wayland?: WaylandReport;
    encoder?: EncoderReport | null;
    uinput?: boolean;
}

interface PackageFacts {
    version?: string;
    engines?: { node?: string };
}

const ENGINE_FIX = 'Debian/Ubuntu: `npm install @desklink/host-linux-x64-gnu` (keep optional dependencies); Fedora: the same command.';
const NODE_FIX = 'Debian/Ubuntu: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`; Fedora: `sudo dnf install nodejs`.';
const X11_FIX = 'Debian/Ubuntu: `sudo apt install xserver-xorg-core`; Fedora: `sudo dnf install xorg-x11-server-Xorg` (run inside the logged-in desktop session).';
const WAYLAND_FIX = 'Debian/Ubuntu: `sudo apt install pipewire xdg-desktop-portal xdg-desktop-portal-gnome` (KDE: xdg-desktop-portal-kde); Fedora: `sudo dnf install pipewire xdg-desktop-portal xdg-desktop-portal-gnome`.';
const INPUT_FIX = 'Wayland Debian/Ubuntu: `sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome`; Fedora: `sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome`; then run `desklink-host setup-input` once for /dev/uinput.';
const ENCODER_FIX = 'Debian/Ubuntu: `sudo apt install mesa-va-drivers intel-media-va-driver`; Fedora: `sudo dnf install mesa-va-drivers intel-media-driver` (the engine also fetches Cisco openh264 once on first use when online).';
const LIBRARY_FIX = 'Debian/Ubuntu: `sudo apt install libpipewire-0.3-0 libxkbcommon0 libevdev2 libstdc++6 libxcursor1 libx11-6 libxext6 libwayland-client0 libfontconfig1 libfreetype6`; Fedora: `sudo dnf install pipewire-libs libxkbcommon libevdev libstdc++ libXcursor libX11 libXext libwayland-client fontconfig freetype`. A complete desktop install usually has these already.';
const UPDATE_FIX = 'Debian/Ubuntu: `npm install @desklink/host@latest`; Fedora: the same command.';
const PROBE_FIX = `install the engine first — ${ENGINE_FIX}`;

function pass(name: string, detail: string): Check {
    return { status: 'PASS', name, detail };
}

function na(name: string, detail: string): Check {
    return { status: 'N/A', name, detail };
}

function fail(name: string, detail: string, fix: string): Check {
    return { status: 'FAIL', name, detail, fix };
}

function firstLine(text: string): string {
    return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function runEngine(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((done) => {
        execFile(command, args, { timeout: 40_000, maxBuffer: 8 << 20, windowsHide: true }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
            done({ code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

function readPackage(): PackageFacts | null {
    try {
        return JSON.parse(readFileSync(join(enginePackageRoot(), 'package.json'), 'utf8')) as PackageFacts;
    } catch {
        return null;
    }
}

/** The package asks for a minimum Node version; only `>=` needs to be read. */
function nodeMeets(current: string, requirement: string): boolean {
    const have = current.split('.').map(Number);
    for (const clause of requirement.trim().split(/\s+/)) {
        const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
        if (match === null) return false;
        const want = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
        for (let index = 0; index < 3; index++) {
            const left = have[index] ?? 0;
            const right = want[index] ?? 0;
            if (left !== right) {
                if (left < right) return false;
                break;
            }
        }
    }
    return true;
}

function librariesCheck(resolved: ResolvedEngine | null, version: { code: number | null; stderr: string }): Check {
    if (resolved === null) return na('libraries', 'needs an engine binary; see the engine line');
    const missing = missingSystemLibrary(version.stderr);
    if (missing !== null) return fail('libraries', `cannot load ${missing}`, LIBRARY_FIX);
    if (version.code === 0) return pass('libraries', "the engine starts with this machine's system libraries");
    return fail('libraries', `the engine did not run: ${firstLine(version.stderr) || `exit ${version.code ?? 'unexpectedly'}`}`, UPDATE_FIX);
}

function x11Check(x11: X11Report | undefined, session: 'x11' | 'wayland' | 'none', probeError: string | null, probeFix: string): Check {
    if (session === 'wayland') return na('x11', 'Wayland session; the portal is the capture path');
    if (session === 'none') return fail('x11', 'no X11 or Wayland session (DISPLAY and WAYLAND_DISPLAY are unset)', X11_FIX);
    if (x11 === undefined) return fail('x11', `not checked: ${probeError ?? 'the engine reported no X11 result'}`, probeFix);
    if (!x11.connected) return fail('x11', `cannot open ${x11.display ?? process.env.DISPLAY ?? 'the display'}: ${x11.error ?? 'unknown error'}`, X11_FIX);
    const missing = [!x11.shm && 'XShm', !x11.damage && 'XDamage'].filter((value) => value !== false);
    const size = `${x11.width ?? '?'}x${x11.height ?? '?'}`;
    if (missing.length > 0) {
        return fail('x11', `${x11.display ?? 'the display'} ${size} cannot use ${missing.join(' or ')}`, X11_FIX);
    }
    return pass('x11', `${x11.display ?? 'the display'} ${size}, XShm + XDamage`);
}

function waylandCheck(wayland: WaylandReport | undefined, session: 'x11' | 'wayland' | 'none', probeError: string | null, probeFix: string): Check {
    if (session !== 'wayland') return na('wayland', session === 'x11' ? 'X11 session; no portal is needed' : 'no Wayland session');
    if (wayland === undefined) return fail('wayland', `not checked: ${probeError ?? 'the engine reported no Wayland result'}`, probeFix);
    const missing: string[] = [];
    if (!wayland.screencast) missing.push(`xdg-desktop-portal ScreenCast (${wayland.screencast_error ?? 'not reachable'})`);
    if (!wayland.pipewire) missing.push('PipeWire socket');
    if (missing.length > 0) return fail('wayland', `missing ${missing.join(', ')}`, WAYLAND_FIX);
    return pass('wayland', 'xdg-desktop-portal ScreenCast + PipeWire');
}

function inputCheck(report: DiagnoseReport | null, session: 'x11' | 'wayland' | 'none', probeError: string | null, probeFix: string): Check {
    if (report === null) return fail('input', `not checked: ${probeError ?? 'the engine did not answer'}`, probeFix);
    if (session === 'x11') {
        const x11 = report.x11;
        if (x11?.connected !== true) return fail('input', 'XTest cannot be checked without an X display', X11_FIX);
        if (x11.xtest !== true) return fail('input', `XTest is missing from ${x11.display ?? 'the display'}`, X11_FIX);
        return pass('input', `XTest on ${x11.display ?? 'the display'}`);
    }
    if (session === 'wayland') {
        const wayland = report.wayland;
        const missing: string[] = [];
        if (wayland?.remote_desktop !== true) missing.push(`portal RemoteDesktop (${wayland?.remote_desktop_error ?? 'not reachable'})`);
        if (report.uinput !== true) missing.push('/dev/uinput is not writable');
        if (missing.length > 0) return fail('input', `missing ${missing.join(', ')}`, INPUT_FIX);
        return pass('input', 'portal RemoteDesktop + /dev/uinput');
    }
    return fail('input', 'no X11 or Wayland session to inject into', X11_FIX);
}

function encoderCheck(report: DiagnoseReport | null, probeError: string | null, probeFix: string): Check {
    if (report === null) return fail('encoder', `not checked: ${probeError ?? 'the engine did not answer'}`, probeFix);
    if (report.encoder === null || report.encoder === undefined) return fail('encoder', 'no working H.264 encoder', ENCODER_FIX);
    return pass('encoder', `${report.encoder.name}${report.encoder.hardware ? ' (hardware)' : ''}; VP9 software is always available`);
}

function versionCheck(packageVersion: string | null, engineVersion: string | null, reason: string | null, fix: string): Check {
    if (packageVersion === null) return fail('versions', 'cannot read @desklink/host package.json', UPDATE_FIX);
    if (engineVersion === null) return fail('versions', `@desklink/host ${packageVersion}; engine version unavailable (${reason ?? 'no answer'})`, fix);
    return pass('versions', `@desklink/host ${packageVersion} · engine ${engineVersion}`);
}

export async function runDoctor(): Promise<number> {
    // Linux first: the engine has no `diagnose` on other platforms yet, and a
    // report built from failed probes there would describe the wrong machine.
    if (process.platform !== 'linux') {
        console.log(`FAIL  platform  desklink-host doctor checks Linux only; ${process.platform} was not checked`);
        return 1;
    }
    const checks: Check[] = [];
    const packageFacts = readPackage();
    const packageVersion = typeof packageFacts?.version === 'string' ? packageFacts.version : null;
    const resolved: ResolvedEngine | null = resolveEngine();

    checks.push(resolved === null
        ? fail('engine', explainMissingEngine() ?? 'the engine binary is not resolvable', ENGINE_FIX)
        : pass('engine', `${resolved.command} (${resolved.origin})`));

    const nodeVersion = process.versions.node;
    const requirement = typeof packageFacts?.engines?.node === 'string' ? packageFacts.engines.node : null;
    checks.push(requirement !== null && !nodeMeets(nodeVersion, requirement)
        ? fail('node', `v${nodeVersion} does not meet the package requirement ${requirement}`, NODE_FIX)
        : pass('node', `v${nodeVersion}${requirement === null ? '' : ` (package needs ${requirement})`}`));

    let diagnose: DiagnoseReport | null = null;
    let engineVersion: string | null = null;
    let probeError: string | null = null;
    let versionResult: { code: number | null; stdout: string; stderr: string } = { code: null, stdout: '', stderr: '' };

    if (resolved !== null) {
        const [version, diagnoseResult] = await Promise.all([
            runEngine(resolved.command, ['version']),
            runEngine(resolved.command, ['diagnose']),
        ]);
        versionResult = version;
        if (versionResult.code === 0) engineVersion = versionResult.stdout.trim() || null;
        if (diagnoseResult.code === 0) {
            try {
                diagnose = JSON.parse(diagnoseResult.stdout) as DiagnoseReport;
            } catch {
                probeError = 'the engine returned unreadable diagnose output';
            }
        } else {
            probeError = firstLine(diagnoseResult.stderr) || `engine diagnose exited ${diagnoseResult.code ?? 'unexpectedly'}`;
        }
        if (engineVersion === null && typeof diagnose?.version === 'string') engineVersion = diagnose.version;
    }

    checks.push(librariesCheck(resolved, versionResult));

    const session: 'x11' | 'wayland' | 'none' = diagnose?.session
        ?? (process.env.WAYLAND_DISPLAY !== undefined && process.env.WAYLAND_DISPLAY !== ''
            ? 'wayland'
            : process.env.DISPLAY !== undefined && process.env.DISPLAY !== ''
                ? 'x11'
                : 'none');

    const missingLibrary = missingSystemLibrary(versionResult.stderr);
    const probeFix = resolved === null ? PROBE_FIX : missingLibrary !== null ? LIBRARY_FIX : UPDATE_FIX;
    checks.push(x11Check(diagnose?.x11 ?? undefined, session, probeError, probeFix));
    checks.push(waylandCheck(diagnose?.wayland ?? undefined, session, probeError, probeFix));
    checks.push(inputCheck(diagnose, session, probeError, probeFix));
    checks.push(encoderCheck(diagnose, probeError, probeFix));
    checks.push(versionCheck(packageVersion, engineVersion, resolved === null ? 'no engine binary' : probeError, probeFix));

    for (const check of checks) {
        console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(8)}  ${check.detail}`);
        if (check.fix !== undefined) console.log(`      fix       ${check.fix}`);
    }
    const failed = checks.filter((check) => check.status === 'FAIL').length;
    const passed = checks.filter((check) => check.status === 'PASS').length;
    const skipped = checks.length - failed - passed;
    console.log('');
    console.log(`${checks.length} checks: ${passed} passed, ${failed} failed, ${skipped} not applicable`);
    return failed === 0 ? 0 : 1;
}
