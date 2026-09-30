import type { CommandModule } from "../cli/router.js";
import { print } from "../output/toon.js";
import { renderHome, rootHelpText } from "../skill/content.js";
import { call } from '../bridge.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export const homeCommand: CommandModule = {
  spec: {
    name: "",
    summary: "Home view: live content first (AXI principle 8)",
    flags: [
      { name: "version", type: "boolean", description: "print the tool version" },
    ],
    examples: ["desklink-axi", "desklink-axi --version"],
  },
  async run(parsed) {
    if (parsed.flags["version"]) {
      print(`desklink-axi: ${version}`);
      return 0;
    }
    try { print(`${renderHome(process.argv[1] ?? 'desklink-axi')}\n${await call('home')}`); }
    catch { print(`${renderHome(process.argv[1] ?? 'desklink-axi')}\nsession: closed — run desklink-axi start`); }
    return 0;
  },
};

export function rootHelp(): string {
  return rootHelpText();
}
