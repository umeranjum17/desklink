import { dispatch, type Registry, type CommandModule } from './cli/router.js';
import { homeCommand, rootHelp } from './commands/home.js';
import { call, serve, socketPath } from './bridge.js';
import { writeFileSync } from 'node:fs';
import { print } from './output/toon.js';
import { installHooks } from './hooks.js';

if (process.argv[2] === '--bridge') {
  try { await serve(process.argv.slice(3)); }
  catch (error) { writeFileSync(`${socketPath}.error`,(error as Error).message); process.exitCode=1; }
} else if (process.argv[2] === '--session-hook') {
  print('desklink-axi: desktop session available on request; run desklink-axi to check status');
} else {
  const definitions: [string, string[], string[]][] = [
    ['start', [], ['control','source','display','timeout']], ['stop', [], []],
    ['screen', [], ['query','region','full','fields']], ['diff', [], ['include-animating','fields']],
    ['look', ['target'], ['region','out']], ['click', ['target'], ['button','double','wait']],
    ['type', ['text'], ['into','submit']], ['press', ['key'], []],
    ['scroll', ['direction'], ['at','amount']], ['drag', ['from','to'], []],
    ['wait', [], ['timeout']], ['clipboard read', [], ['full']],
    ['clipboard write', ['text'], []], ['setup hooks', [], []],
  ];
  const commands: Record<string, CommandModule> = {};
  for (const [name, required, flags] of definitions) commands[name] = {
    spec: { name, summary: `${name} on the live desktop`, args: required.map(arg => ({name:arg,required:true,description:arg})), flags: flags.map(flag => ({name:flag,type: ['control','full','double','submit','include-animating'].includes(flag) ? 'boolean' : 'string', description:flag})), examples: [`desklink-axi ${name} ${required.map(arg=>`<${arg}>`).join(' ')}`] },
    async run(parsed) {
      const args = [...parsed.positionals];
      for (const [key,value] of Object.entries(parsed.flags)) if (value === true) args.push(`--${key}`); else if (typeof value === 'string') args.push(`--${key}`,value);
      if (name === 'setup hooks') { print(installHooks()); return 0; }
      try { const result = await call(name.startsWith('clipboard') ? 'clipboard' : name, name.startsWith('clipboard') ? [name.split(' ')[1]!, ...args] : args); print(result); return result.startsWith('error:') ? 1 : 0; }
      catch (error) { print(`error: ${(error as Error).message}\nsuggestion: desklink-axi start --help`); return 1; }
    },
  };
  const registry: Registry = { tool: 'desklink-axi', root: homeCommand, rootHelp, commands, aliases: {} };
  process.exit(await dispatch(registry, process.argv.slice(2)));
}
