// Smoke tests for the AXI contract. Requires a build first (`pretest`
// runs it automatically via `npm test`).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/desklink-axi.js", import.meta.url));
const runtime = mkdtempSync(join(tmpdir(), 'desklink-cli-unit-'));
afterAll(() => rmSync(runtime, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 5000,
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', XDG_RUNTIME_DIR: runtime,
      DESKLINK_AXI_ENGINE: join(runtime, 'no-engine'), DESKLINK_AXI_SESSION: `cli-test-${process.pid}` } });
}

describe("desklink-axi AXI contract", () => {
  it("--version reports the installed package version", () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const r = run('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`desklink-axi: ${manifest.version}`);
    expect(r.stderr).toBe('');
  });

  it("no-args shows content and exits 0 (principle 8)", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^\s*usage[:\s]/i);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it("--help exits 0 and lists flags (principle 10)", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--");
  });

  it('accepts the macOS display source and numeric display id', () => {
    const help = run('start', '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('display');
    const result = run('start', '--source', 'display', '--display', '1');
    expect(result.status).toBe(1); // Syntax accepted; no usable engine in this smoke test.
    expect(result.stdout).not.toContain('invalid value');
  });

  it("unknown flag exits 2 naming valid flags (principle 6)", () => {
    const r = run("--not-a-real-flag");
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("error:");
    expect(r.stdout).toContain("--");
  });

  it('rejects mistyped desktop actions before connecting', () => {
    for (const args of [['start','--source','bogus'], ['click','1,1','--button','middle'], ['click','1,1','--wait','forever'], ['scroll','sideways'], ['scroll','down','--amount','NaN']]) {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('error:');
    }
  });

  it('accepts leading-dash text for both text commands', () => {
    for (const args of [['type','-hello'], ['clipboard','write','-secret'], ['type','--','--hello']]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('no-session:');
      expect(result.stdout).not.toContain('unknown flag');
    }
  });

  it("stderr is silent on success (principle 6)", () => {
    const r = run();
    expect(r.stderr.trim()).toBe("");
  });

  it("parses and refuses non-loopback browser endpoints (explicit opt-in only)", async () => {
    const { parseEndpoint } = await import("../dist/browser-lane.js");
    expect(parseEndpoint("127.0.0.1:9222")).toBe("127.0.0.1:9222");
    expect(parseEndpoint("http://localhost:9333/")).toBe("localhost:9333");
    expect(parseEndpoint("[::1]:9222")).toBe("[::1]:9222");
    expect(() => parseEndpoint("10.1.2.3:9222")).toThrow(/loopback/);
    expect(() => parseEndpoint("example.com:9222")).toThrow(/loopback/);
    expect(() => parseEndpoint("127.0.0.1")).toThrow(/invalid CDP endpoint/);
  });

  it("browser attach refuses non-loopback endpoints with exit 2", () => {
    const r = run("browser", "attach", "--cdp", "10.1.2.3:9222");
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("loopback");
  });

  it("browser commands require an explicit attach or launch first", () => {
    for (const args of [["browser", "tabs"], ["browser", "snapshot"], ["browser", "click", "@e1"], ["browser", "upload", "@e1", "/tmp/x"]]) {
      const r = run(...args);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("no-browser:");
    }
  });

  it("browser click rejects malformed refs", () => {
    const r = run("browser", "click", "12,34");
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("invalid ref");
  });
});
