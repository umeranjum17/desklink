import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('rejects missing compiled AXI output before producing tarballs', () => {
    const root = mkdtempSync(join(process.cwd(), '.pack-guard-test-'));
    try {
        const host = join(root, 'packages', 'desktop-host');
        mkdirSync(join(host, 'release'), { recursive: true });
        mkdirSync(join(host, 'dist'));
        copyFileSync(fileURLToPath(new URL('./pack.mjs', import.meta.url)), join(host, 'release', 'pack.mjs'));
        copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(host, 'package.json'));
        // Only satisfy the host compilation prerequisite; this module must never load.
        writeFileSync(join(host, 'dist', 'resolveEngine.js'), 'throw new Error("AXI guard must run before loading the resolver");\n');
        execFileSync('git', ['init', '--quiet', root]);

        // Synthetic bundle for guard coverage only; this does not qualify a native engine.
        const engine = join(root, 'synthetic-engine');
        mkdirSync(engine);
        const payload = 'Synthetic guard-test payload; not a native engine.\n';
        writeFileSync(join(engine, 'desklink-host'), payload);
        for (const file of ['THIRD_PARTY_LICENSES.txt', 'COPYRIGHT-rust-library.html']) {
            writeFileSync(join(engine, file), 'Synthetic fixture\n');
        }
        const manifest = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
        writeFileSync(join(engine, 'provenance.json'), JSON.stringify({
            target: 'x86_64-unknown-linux-gnu',
            engine: manifest.version,
            sha256: createHash('sha256').update(payload).digest('hex'),
        }));

        const result = spawnSync(process.execPath, [join(host, 'release', 'pack.mjs'), '--engine', engine], {
            cwd: root,
            encoding: 'utf8',
            timeout: 5_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('@desklink/axi is not compiled: run npm run build first');
        expect(result.stdout).toBe('');
        expect(existsSync(join(root, 'dist-desklink'))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
