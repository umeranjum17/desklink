import { homedir } from 'node:os';
import { emitList } from '../output/toon.js';
export const DESCRIPTION = "See and drive a live Linux or macOS desktop through desklink; text and changes by default, pixels on request";
export const SPEC_VERSION = 'axi/1.0-2026-07';
const commands = ['start','stop','screen','diff','look','click','type','press','scroll','drag','wait','clipboard read','clipboard write','setup hooks'];
export function renderHome(binPath: string): string { return `desklink-axi: ${binPath.replace(homedir(),'~')} — ${DESCRIPTION}\nhelp[3]:\n  desklink-axi start --control --source x11 --display :97\n  desklink-axi screen --query "<words>"\n  desklink-axi look @r1`; }
export function rootHelpText(): string { return [`desklink-axi: ${DESCRIPTION}`,emitList('commands',commands.map(command=>({command,summary:`${command} on the live desktop`})),['command','summary']),'flags[1]{flag,description}:\n  --help,show help for any command','examples[2]:\n  desklink-axi start --control --source x11 --display :97\n  desklink-axi screen --query "<words>"'].join('\n'); }
export function renderSkill(): string { return `---\nname: desklink-axi\ndescription: "${DESCRIPTION}"\n---\n\n# desklink-axi\n\n${DESCRIPTION} (${SPEC_VERSION}).\n\n\`\`\`\n${renderHome('desklink-axi')}\n\`\`\`\n\nEvery command supports --help. Exit 0 success, 1 operational error, 2 usage error. No screen text at startup unless requested.\n`; }
