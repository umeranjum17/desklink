// Smoke tests for the AXI contract. Requires a build first (`pretest`
// runs it automatically via `npm test`).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/desklink-axi.js", import.meta.url));

function run(...args: string[]) {
  return spawnSync("node", [bin, ...args], { encoding: "utf8" });
}

describe("desklink-axi AXI contract", () => {
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

  it("stderr is silent on success (principle 6)", () => {
    const r = run();
    expect(r.stderr.trim()).toBe("");
  });
});
