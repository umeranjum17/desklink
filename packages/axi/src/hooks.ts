import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installHooks(): string {
  const directory = join(process.cwd(), '.claude');
  mkdirSync(directory,{recursive:true});
  const path = join(directory,'settings.local.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {};
  const hooks = settings.hooks ?? {};
  const session = hooks.SessionStart ?? [];
  const command = 'desklink-axi --session-hook';
  if (!session.some((entry: {hooks?: {command?:string}[]}) => entry.hooks?.some(h=>h.command===command))) {
    session.push({hooks:[{type:'command',command}]});
    hooks.SessionStart = session;
    settings.hooks = hooks;
    writeFileSync(path,JSON.stringify(settings,null,2)+'\n');
  }
  return `hooks: installed ${path}\nhelp[1]:\n  desklink-axi start --help`;
}
