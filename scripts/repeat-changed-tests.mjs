#!/usr/bin/env node
/**
 * Repeat the tests a branch adds or changes, half of them under CPU contention.
 *
 * Run before opening a PR. The selected tests are:
 *   - Rust `#[test]`/`#[tokio::test]` functions whose body changed in
 *     packages/desktop-host/engine/*.rs, and
 *   - changed vitest spec/test files anywhere the root config collects.
 *
 * Each test runs N times (default 1000 for engine tests, 20 for vitest files):
 * half normally, half pinned to one core with busy loops on it. Every run
 * starts with DISPLAY/WAYLAND_DISPLAY unset so nothing can reach a live
 * desktop; tests marked #[ignore] (including the ones that need a task-owned
 * lab compositor) are listed as skipped, not run.
 *
 * Usage: scripts/repeat-changed-tests.sh [--runs N] [--concurrency K] [--base REF]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const ENGINE = 'packages/desktop-host/engine';
const ENGINE_MANIFEST = join(ENGINE, 'Cargo.toml');
// The engine's own timing flakes are rare (~0.2% of runs measured on the
// cue_feed drain), so its repeats default high; a direct test binary is ~20ms
// per run, keeping 1000 runs under half a minute. Vitest costs ~0.5s+ per run,
// so its default stays at the low end.
const RUST_DEFAULT_RUNS = 1000;
const VITEST_DEFAULT_RUNS = 20;

function usage() {
    console.log(`usage: scripts/repeat-changed-tests.sh [--runs N] [--concurrency K] [--base REF]

  --runs N         runs per selected test (default ${RUST_DEFAULT_RUNS} for engine
                   tests, ${VITEST_DEFAULT_RUNS} for vitest test files: half under CPU contention)
  --concurrency K  concurrent copies in the contended half (default 8)
  --base REF       ref to compare against (default origin/main)
  --help           show this message`);
}

function parseNumber(value, flag) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) fail(`${flag} needs a positive integer, got ${value}`);
    return number;
}

function parseArgs(argv) {
    const options = {
        runs: null,
        concurrency: Number(process.env.REPEAT_CONCURRENCY || 8),
        base: process.env.BASE_REF || 'origin/main',
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else if (arg === '--runs' || arg === '-n') {
            options.runs = parseNumber(argv[++i], '--runs');
        } else if (arg.startsWith('--runs=')) {
            options.runs = parseNumber(arg.slice('--runs='.length), '--runs');
        } else if (arg === '--concurrency' || arg === '-c') {
            options.concurrency = parseNumber(argv[++i], '--concurrency');
        } else if (arg.startsWith('--concurrency=')) {
            options.concurrency = parseNumber(arg.slice('--concurrency='.length), '--concurrency');
        } else if (arg === '--base') {
            options.base = argv[++i];
            if (!options.base) fail('--base needs a ref');
        } else if (arg.startsWith('--base=')) {
            options.base = arg.slice('--base='.length);
        } else {
            fail(`unknown argument: ${arg}`);
        }
    }
    return options;
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(2);
}

function git(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
    if (result.status !== 0) {
        if (options.allowFailure) return null;
        const detail = (result.stderr || '').trim();
        fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

function lines(text) {
    return (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function splitNames(text) {
    return lines(text);
}

/** Return the test functions in one Rust source file, with their body text. */
function extractRustTests(source) {
    const sourceLines = source.split('\n');
    const found = [];
    let pending = null;

    const startPending = () => ({ attributes: [], start: 0, test: false, ignored: false, reason: '' });

    for (let i = 0; i < sourceLines.length; i++) {
        const line = sourceLines[i];
        const trimmed = line.trim();

        if (/^#!?\[/.test(trimmed)) {
            if (!pending) pending = startPending();
            if (!pending.attributes.length) pending.start = i;
            pending.attributes.push(trimmed);
            if (/^#\[(?:tokio::)?test(?:\s*\([^\]]*\))?\]$/.test(trimmed)) pending.test = true;
            const ignore = /^#\[ignore(?:\s*=\s*"([^"]*)")?\]$/.exec(trimmed);
            if (ignore) {
                pending.ignored = true;
                pending.reason = ignore[1] || '';
            }
            continue;
        }

        if (pending && (trimmed === '' || /^\/\//.test(trimmed))) {
            pending.attributes.push(trimmed);
            continue;
        }

        const fn = /^(\s*)(?:(?:pub(?:\([^)]*\))?)\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (pending && fn) {
            if (pending.test) {
                const indent = fn[1].length;
                let end = sourceLines.length - 1;
                for (let j = i + 1; j < sourceLines.length; j++) {
                    if (/^\s*\}\s*$/.test(sourceLines[j]) && /^ */.exec(sourceLines[j])[0].length === indent) {
                        end = j;
                        break;
                    }
                }
                found.push({
                    name: fn[2],
                    text: sourceLines.slice(i, end + 1).join('\n'),
                    ignored: pending.ignored,
                    reason: pending.reason,
                });
            }
            pending = null;
            continue;
        }

        pending = null;
    }

    return found;
}

/** Names of tests whose text differs between the base and current source. */
function changedRustTests(baseSource, currentSource) {
    const base = new Map(extractRustTests(baseSource).map((test) => [test.name, test]));
    const changed = new Map();
    for (const test of extractRustTests(currentSource)) {
        const before = base.get(test.name);
        if (!before || before.text !== test.text) changed.set(test.name, test);
    }
    return changed;
}

function isRustEngineFile(file) {
    return file.startsWith(`${ENGINE}/`) && file.endsWith('.rs') && !file.startsWith(`${ENGINE}/vendor/`);
}

function isVitestFile(file) {
    if (/(^|\/)node_modules\//.test(file)) return false;
    if (/(^|\/)dist\//.test(file) || /(^|\/)engine\/target\//.test(file)) return false;
    return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file);
}

function discoverTests(baseRef) {
    const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
    const committed = splitNames(git(['diff', '--name-only', '--diff-filter=AMR', mergeBase, 'HEAD']));
    const worktree = splitNames(git(['diff', '--name-only', '--diff-filter=AMR', 'HEAD']));
    const untracked = splitNames(git(['ls-files', '--others', '--exclude-standard']));

    const rustTests = new Map();
    const vitestFiles = new Set();

    const readHead = (file) => {
        const text = git(['show', `HEAD:${file}`], { allowFailure: true });
        return text === null ? '' : text;
    };

    for (const file of committed) {
        if (isRustEngineFile(file)) {
            const headSource = readHead(file);
            if (!headSource) continue;
            const baseSource = git(['show', `${mergeBase}:${file}`], { allowFailure: true }) || '';
            for (const test of changedRustTests(baseSource, headSource).values()) {
                rustTests.set(test.name, { ...test, file });
            }
        } else if (isVitestFile(file) && existsSync(join(ROOT, file))) {
            vitestFiles.add(file);
        }
    }

    for (const file of new Set([...worktree, ...untracked])) {
        if (isRustEngineFile(file)) {
            const path = join(ROOT, file);
            if (!existsSync(path)) continue;
            const currentSource = readFileSync(path, 'utf8');
            const baseSource = readHead(file);
            for (const test of changedRustTests(baseSource, currentSource).values()) {
                rustTests.set(test.name, { ...test, file });
            }
        } else if (isVitestFile(file) && existsSync(join(ROOT, file))) {
            vitestFiles.add(file);
        }
    }

    return { mergeBase, rustTests: [...rustTests.values()], vitestFiles: [...vitestFiles].sort() };
}

/** Build the engine test binaries and map every test name to its binary. */
function engineTestIndex(env) {
    const build = spawnSync(
        'cargo',
        ['test', '--manifest-path', ENGINE_MANIFEST, '--no-run', '--message-format=json'],
        { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (build.error) fail(`could not run cargo: ${build.error.message}`);
    if (build.status !== 0) {
        console.error(build.stdout);
        console.error(build.stderr);
        fail('cargo test --no-run failed; fix the build before repeating tests');
    }
    const binaries = new Set();
    for (const line of lines(build.stdout)) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        if (message.profile?.test && message.executable) binaries.add(message.executable);
    }
    if (!binaries.size) fail('cargo reported no engine test binary to run');

    const index = new Map();
    for (const binary of binaries) {
        const listed = spawnSync(binary, ['--list'], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (listed.error || listed.status !== 0) continue;
        for (const line of lines(listed.stdout)) {
            const match = /^(.+): test$/.exec(line);
            if (match && !index.has(match[1])) index.set(match[1], binary);
        }
    }
    return index;
}

function allowedCpu() {
    const result = spawnSync('taskset', ['-pc', String(process.pid)], { encoding: 'utf8' });
    const text = `${result.stdout || ''}${result.stderr || ''}`;
    const match = /affinity list:\s*(\S+)/.exec(text);
    if (!match) return null;
    const first = match[1].split(',')[0];
    const range = /^(\d+)-(\d+)$/.exec(first);
    const cpu = range ? Number(range[1]) : Number(first);
    return Number.isInteger(cpu) ? cpu : null;
}

function startBurners(cpu) {
    const burners = [];
    const count = Number(process.env.REPEAT_CONTENTION_BURNERS || 2);
    for (let i = 0; i < count; i++) {
        const child = spawn(
            'taskset',
            ['-c', String(cpu), 'sh', '-c', 'while :; do :; done'],
            { stdio: 'ignore' },
        );
        child.on('error', () => {});
        burners.push(child);
    }
    return burners;
}

function stopBurners(burners) {
    for (const child of burners) {
        try {
            child.kill('SIGKILL');
        } catch {
            // Already gone.
        }
    }
}

function testEnvironment() {
    const env = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    return env;
}

function testTimeout() {
    return Number(process.env.REPEAT_TEST_TIMEOUT_MS || 180_000);
}

function spawnOnce(command, args, options) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: ROOT,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ ok: false, timedOut: true, output: `${stdout}${stderr}\n(timed out after ${options.timeout}ms)` });
        }, options.timeout);
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', (error) => finish({ ok: false, timedOut: false, output: `${stdout}${stderr}\n${error.message}` }));
        child.on('close', (code) => finish({ ok: code === 0, timedOut: false, output: `${stdout}${stderr}` }));
    });
}

/** Run `count` concurrent copies of one test, all pinned to one busy core. */
async function runContendedWave(command, args, count, options) {
    const runs = [];
    for (let i = 0; i < count; i++) {
        runs.push(
            spawnOnce('taskset', ['-c', String(options.cpu), command, ...args], {
                env: options.env,
                timeout: options.timeout,
            }),
        );
    }
    return await Promise.all(runs);
}

async function repeat(label, command, args, options, logDir) {
    const plain = Math.ceil(options.runs / 2);
    const contended = options.runs - plain;
    const waveSize = Math.max(1, Math.min(options.concurrency, contended || 1));
    let plainPass = 0;
    let contendedPass = 0;
    let firstFailure = null;

    const recordFailure = (where, result) => {
        if (!firstFailure) {
            firstFailure = { where, output: result.output, timedOut: result.timedOut };
        }
    };

    for (let i = 0; i < plain; i++) {
        const result = await spawnOnce(command, args, { env: options.env, timeout: options.timeout });
        if (result.ok) plainPass++;
        else recordFailure(`run ${i + 1} (normal)`, result);
    }

    const burners = contended > 0 ? startBurners(options.cpu) : [];
    try {
        for (let i = 0; i < contended; i += waveSize) {
            const size = Math.min(waveSize, contended - i);
            const results = await runContendedWave(command, args, size, options);
            results.forEach((result, j) => {
                if (result.ok) contendedPass++;
                else recordFailure(`run ${plain + i + j + 1} (contended)`, result);
            });
        }
    } finally {
        stopBurners(burners);
    }

    const passed = plainPass + contendedPass;
    const parts = [`${plainPass}/${plain} normal`];
    if (contended > 0) parts.push(`${contendedPass}/${contended} contended`);
    if (passed === options.runs) {
        console.log(`PASS  ${passed}/${options.runs}  ${label}  (${parts.join(', ')})`);
        return true;
    }

    console.log(`FAIL  ${passed}/${options.runs}  ${label}  (${parts.join(', ')})`);
    if (firstFailure) {
        mkdirSync(logDir, { recursive: true });
        const safe = label.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 160);
        const logPath = join(logDir, `${safe}-${firstFailure.where.replace(/[^A-Za-z0-9]+/g, '_')}.log`);
        writeFileSync(
            logPath,
            `# ${label}\n# first failure: ${firstFailure.where}${firstFailure.timedOut ? ' (timed out)' : ''}\n\n${firstFailure.output}\n`,
        );
        console.log(`      first failure: ${firstFailure.where}: ${logPath}`);
    }
    return false;
}

async function main() {
    if (process.platform !== 'linux') {
        fail('this pre-PR check is Linux-only (it uses taskset for CPU contention)');
    }
    const options = parseArgs(process.argv.slice(2));
    if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT }).status !== 0) {
        fail(`${ROOT} is not a git work tree`);
    }
    git(['rev-parse', '--verify', options.base]);

    const { mergeBase, rustTests, vitestFiles } = discoverTests(options.base);
    const env = testEnvironment();
    const logDir = process.env.REPEAT_LOG_DIR || join(tmpdir(), 'desklink-repeat-tests');

    if (!rustTests.length && !vitestFiles.length) {
        console.log(`nothing changed: no Rust engine tests or vitest test files changed versus ${options.base}.`);
        return;
    }

    const rustRuns = options.runs ?? RUST_DEFAULT_RUNS;
    const vitestRuns = options.runs ?? VITEST_DEFAULT_RUNS;

    console.log(`base: ${options.base} (merge-base ${mergeBase.slice(0, 12)})`);
    const summary = [];
    if (rustTests.length) summary.push(`${rustTests.length} engine test${rustTests.length === 1 ? '' : 's'} in ${rustRuns} runs each`);
    if (vitestFiles.length) summary.push(`${vitestFiles.length} vitest file${vitestFiles.length === 1 ? '' : 's'} in ${vitestRuns} runs each`);
    console.log(`repeating: ${summary.join(', ')} (half under CPU contention)`);
    console.log('');

    const cpu = allowedCpu();
    if (cpu === null) fail('could not read this process CPU affinity; taskset is required');
    const baseOptions = { concurrency: options.concurrency, cpu, env, timeout: testTimeout() };
    const rustOptions = { ...baseOptions, runs: rustRuns };
    const vitestOptions = { ...baseOptions, runs: vitestRuns };

    let ok = true;
    let ran = 0;

    if (rustTests.length) {
        for (const test of rustTests.filter((test) => test.ignored)) {
            const reason = test.reason || 'ignored by the Rust test harness';
            console.log(`SKIP  0/0   ${test.name}  (${reason}; not run)`);
        }
        const runnable = rustTests.filter((test) => !test.ignored);
        const testIndex = runnable.length ? engineTestIndex(env) : new Map();
        const allNames = [...testIndex.keys()];
        for (const test of runnable) {
            const fullNames = allNames.filter((name) => name === test.name || name.endsWith(`::${test.name}`));
            if (!fullNames.length) {
                console.log(`SKIP  0/0   ${test.name}  (not in this build: cfg-gated out on this platform)`);
                continue;
            }
            for (const fullName of fullNames) {
                ran++;
                const passed = await repeat(
                    fullName,
                    testIndex.get(fullName),
                    ['--exact', fullName],
                    rustOptions,
                    logDir,
                );
                ok = passed && ok;
            }
        }
    }

    const vitest = join(ROOT, 'node_modules', '.bin', 'vitest');
    const vitestCommand = existsSync(vitest) ? vitest : 'npx';
    const vitestPrefix = existsSync(vitest) ? [] : ['--no-install', 'vitest'];
    for (const file of vitestFiles) {
        ran++;
        const passed = await repeat(
            file,
            vitestCommand,
            [...vitestPrefix, 'run', '--reporter=dot', file],
            vitestOptions,
            logDir,
        );
        ok = passed && ok;
    }

    if (ok) {
        console.log(`\nall ${ran} changed test${ran === 1 ? '' : 's'} passed.`);
    } else {
        console.log(`\nsome changed tests failed; logs: ${logDir}`);
        process.exitCode = 1;
    }
}

main();
