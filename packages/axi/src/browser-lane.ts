// Browser lane (build-plan item 2): a thin semantic browser adapter over
// playwright-core for tab listing, compact accessibility snapshots with
// element refs, and ref click/fill/upload/press. Anything that needs an OS
// dialog or a non-browser surface returns a structured not-supported error
// naming the AXI lane, so the desktop substrate stays in desklink-axi.
//
// Consent boundary: nothing is discovered or attached implicitly. The lane
// only acts after an explicit `browser attach --cdp <loopback endpoint>` (the
// endpoint you started Chromium with) or `browser launch`, which starts an
// isolated task-owned Chromium profile with its debugging port bound to
// loopback only. Non-loopback endpoints are refused.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { socketPath } from './bridge.js';
import type { CommandModule } from './cli/router.js';
import { AxiError, UsageError } from './output/errors.js';
import { emitList, print } from './output/toon.js';

const statePath = () => socketPath.replace(/\.sock$/, '.browser.json');

interface BrowserState {
  endpoint: string;
  launched: boolean;
  pid?: number;
  profile?: string;
  profileCreated?: boolean;
  selectedTargetId?: string;
  browserSession?: string;
}

/** Parse `host:port` or `http://host:port` and refuse non-loopback hosts. */
export function parseEndpoint(value: string): string {
  const stripped = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(stripped);
  if (!match) throw new UsageError(`invalid CDP endpoint '${value}'`, 'usage: --cdp 127.0.0.1:<port> as started with --remote-debugging-port');
  const host = match[1]!.replace(/^\[|\]$/g, '');
  const port = Number(match[2]);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new UsageError(`refusing non-loopback endpoint '${value}'`, 'start Chromium with --remote-debugging-port bound to loopback and pass 127.0.0.1:<port>');
  }
  if (port < 1 || port > 65535) throw new UsageError(`invalid port in '${value}'`, 'usage: --cdp 127.0.0.1:<port>');
  return `${host === '::1' ? '[::1]' : host}:${port}`;
}

function readState(): BrowserState {
  const path = statePath();
  if (!existsSync(path)) {
    throw new AxiError('no-browser: run desklink-axi browser attach --cdp 127.0.0.1:<port> or desklink-axi browser launch first',
      'desklink-axi browser attach --help');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BrowserState;
}

function writeState(state: BrowserState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // Browser-only use may run before `start` created the runtime dir.
  writeFileSync(path, JSON.stringify(state, undefined, 1), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function forgetState(): void {
  rmSync(statePath(), { force: true });
}

type Connected = { browser: import('playwright-core').Browser; context: import('playwright-core').BrowserContext; state: BrowserState; selected: import('playwright-core').Page; order: import('playwright-core').Page[] };

/** Playwright reorders pages by activation between connections, so identity
 * is the CDP target id and positions come from the DevTools target list
 * (most recently activated first — its first entry is the front tab). */
async function targetIdOf(context: import('playwright-core').BrowserContext, page: import('playwright-core').Page): Promise<string> {
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  return targetInfo.targetId;
}

async function targetOrder(state: BrowserState): Promise<string[]> {
  const list = await fetch(`http://${state.endpoint}/json/list`).then(r => r.json() as unknown as { type: string; id: string }[]).catch(() => [] as { type: string; id: string }[]);
  return list.filter(target => target.type === 'page').map(target => target.id);
}

async function orderedPages(state: BrowserState, context: import('playwright-core').BrowserContext): Promise<import('playwright-core').Page[]> {
  const pages = context.pages();
  const ids = await Promise.all(pages.map(page => targetIdOf(context, page)));
  const byId = new Map(ids.map((id, i) => [id, pages[i]!] as const));
  const order = (await targetOrder(state)).map(id => byId.get(id)).filter((page): page is import('playwright-core').Page => page !== undefined);
  return [...order, ...pages.filter((_, i) => !order.includes(pages[i]!))];
}

async function connect(): Promise<Connected> {
  const state = readState();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`http://${state.endpoint}`).catch((error: Error) => {
    throw new AxiError(`browser: cannot reach ${state.endpoint}: ${error.message.split('\n')[0]}`, 'check that the browser is still running; re-attach with browser attach --cdp');
  });
  const context = browser.contexts()[0];
  const order = context ? await orderedPages(state, context) : [];
  if (!context || !order.length) {
    await browser.close();
    throw new AxiError('browser: no open pages at the endpoint', 'open a page with browser open <url>');
  }
  context.setDefaultTimeout(10000);
  const byId = await Promise.all(order.map(async page => [await targetIdOf(context, page), page] as const));
  const selected = state.selectedTargetId
    ? byId.find(([id]) => id === state.selectedTargetId)?.[1]
    : order[0];
  if (!selected) {
    await browser.close();
    throw new AxiError('stale-tab: the selected tab is gone', 'desklink-axi browser tabs, then browser select <tab>');
  }
  return { browser, context, state, selected, order };
}

async function withPage<T>(fn: (page: import('playwright-core').Page, lanes: { context: import('playwright-core').BrowserContext; order: import('playwright-core').Page[]; state: BrowserState; selectedId: string }) => Promise<T>): Promise<T> {
  const lanes = await connect();
  try {
    const selectedId = await targetIdOf(lanes.context, lanes.selected);
    return await fn(lanes.selected, { context: lanes.context, order: lanes.order, state: lanes.state, selectedId });
  } finally {
    await lanes.browser.close(); // For a CDP connection this only disconnects.
  }
}

function refLocator(page: import('playwright-core').Page, ref: string): import('playwright-core').Locator {
  if (!/^@e\d+$/.test(ref)) {
    throw new UsageError(`invalid ref '${ref}'`, 'refs come from browser snapshot output, e.g. @e12');
  }
  return page.locator(`aria-ref=${ref.slice(1)}`);
}

// Snapshot refs are injected into the page per connection, so every ref
// command re-snapshots first: unchanged pages re-derive identical refs, and
// a ref that no longer exists is rejected as stale.
async function resolveRef(page: import('playwright-core').Page, ref: string): Promise<import('playwright-core').Locator> {
  const locator = refLocator(page, ref);
  const id = ref.slice(1);
  const yaml = await snapshotText(page);
  if (!yaml.includes(`[ref=${id}]`) || (await locator.count()) === 0) {
    throw new AxiError(`stale-ref: ${ref}; the page changed since the snapshot`, 'desklink-axi browser snapshot');
  }
  return locator;
}

async function snapshotText(page: import('playwright-core').Page): Promise<string> {
  return page.locator('body').ariaSnapshot({ mode: 'ai' });
}

function truncated(yaml: string, full: boolean): string {
  const lines = yaml.split('\n');
  if (full || lines.length <= 60) return yaml;
  return [...lines.slice(0, 60), `truncated: ${lines.length - 60} more — use --full`].join('\n');
}

const attach: CommandModule = {
  spec: {
    name: 'browser attach',
    summary: 'attach to a Chromium you started with a loopback debugging port (explicit opt-in)',
    flags: [{ name: 'cdp', type: 'string', description: 'loopback CDP endpoint, e.g. 127.0.0.1:9222' }],
    examples: ['desklink-axi browser attach --cdp 127.0.0.1:9222'],
  },
  async run(parsed) {
    const value = parsed.flags.cdp;
    if (typeof value !== 'string' || !value) throw new UsageError('browser attach requires --cdp 127.0.0.1:<port>', 'the endpoint is the opt-in: desklink-axi never discovers browsers');
    const endpoint = parseEndpoint(value);
    const previous = existsSync(statePath()) ? readState() : undefined;
    if (previous?.launched && previous.pid) await stopLaunched(previous);
    const version = await fetch(`http://${endpoint}/json/version`).then(r => r.json() as Promise<{ Browser?: string }>).catch(() => undefined);
    if (!version) throw new AxiError(`browser: no devtools endpoint at ${endpoint}`, 'start chromium with --remote-debugging-port=<port> (loopback) and pass the same port');
    writeState({ endpoint, launched: false });
    const list = await fetch(`http://${endpoint}/json/list`).then(r => r.json() as Promise<{ type: string }[]>).catch(() => [] as { type: string }[]);
    print(`browser: attached ${endpoint} browser=${version.Browser ?? 'unknown'} pages=${list.filter(t => t.type === 'page').length}`);
    return 0;
  },
};

function childrenOf(pid: number): number[] {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}

// Chromium helpers (crashpad handlers double-fork, xdg-settings spawns during
// shutdown) can reparent out of the recorded child tree, so every launch
// carries a unique marker in the spawned environment and the sweep below
// reaps any same-uid process still carrying it.
function markerStrays(marker: string): number[] {
  const needle = `DESKLINK_AXI_BROWSER_SESSION=${marker}`;
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return []; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const found: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue;
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(needle)) found.push(pid);
    } catch { /* vanished or unreadable */ }
  }
  return found;
}

async function stopLaunched(state: BrowserState): Promise<void> {
  const stop = async (pid: number) => {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 20; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(r => setTimeout(r, 50));
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  };
  if (state.pid) {
    // Record the child tree before any signal; kill only these exact PIDs.
    const kids = [...new Set([...childrenOf(state.pid), ...childrenOf(state.pid).flatMap(childrenOf)])];
    await stop(state.pid);
    for (const kid of kids) await stop(kid);
  }
  // Helpers that reparented out of the recorded tree (crashpad handlers,
  // xdg-settings spawned during shutdown) still carry the launch marker:
  // SIGTERM them, then SIGKILL survivors, until none remain (~3 s bound).
  if (state.browserSession) {
    const deadline = Date.now() + 3000;
    let termed = false;
    for (;;) {
      const strays = markerStrays(state.browserSession);
      if (!strays.length) break;
      if (Date.now() >= deadline) {
        for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        break;
      }
      for (const pid of strays) { try { process.kill(pid, termed ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
      termed = true;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  // Remove the profile only once the browser is truly dead; a dying Chromium
  // still writes into it.
  if (state.profileCreated && state.profile) {
    for (let i = 0; i < 10; i++) {
      rmSync(state.profile, { recursive: true, force: true });
      if (!existsSync(state.profile)) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

const launch: CommandModule = {
  spec: {
    name: 'browser launch',
    summary: 'start an isolated task-owned Chromium (loopback debugging port only) and attach',
    flags: [
      { name: 'profile', type: 'string', description: 'user-data-dir; default is a private temp profile owned by this task' },
      { name: 'executable', type: 'string', description: 'Chromium path; default: $DESKLINK_AXI_BROWSER, then the playwright-core browser' },
      { name: 'headless', type: 'boolean', description: 'run without a window' },
      { name: 'arg', type: 'string', description: 'extra Chromium flag value; repeat once per flag (e.g. --arg --window-size=1280,640)' },
    ],
    examples: ['desklink-axi browser launch --profile /tmp/task-profile'],
  },
  async run(parsed) {
    const previous = existsSync(statePath()) ? readState() : undefined;
    if (previous?.launched && previous.pid) await stopLaunched(previous);
    const profile = typeof parsed.flags.profile === 'string' && parsed.flags.profile
      ? resolve(parsed.flags.profile)
      : mkdtempSync(join(tmpdir(), 'desklink-axi-browser-'));
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    let executable = typeof parsed.flags.executable === 'string' ? parsed.flags.executable : process.env.DESKLINK_AXI_BROWSER;
    if (!executable) {
      try { executable = (await import('playwright-core')).chromium.executablePath(); }
      catch { /* fall through to the structured error */ }
    }
    if (!executable || !existsSync(executable)) {
      throw new AxiError('browser: no Chromium executable found', 'pass --executable, set DESKLINK_AXI_BROWSER, or run: npx playwright-core install chromium');
    }
    const args = [
      '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--disable-dev-shm-usage', '--password-store=basic',
      // With DISPLAY set, render there — never follow WAYLAND_DISPLAY to a
      // display the session did not ask for.
      ...(process.env.DISPLAY ? ['--ozone-platform=x11'] : []),
      ...(parsed.flags.headless ? ['--headless=new'] : []),
      ...(Array.isArray(parsed.flags.arg) ? parsed.flags.arg.map(String) : typeof parsed.flags.arg === 'string' ? [parsed.flags.arg] : []),
    ];
    const browserSession = randomBytes(8).toString('hex');
    const log = openSync(join(profile, 'chromium.log'), 'a');
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', log], env: { ...process.env, DESKLINK_AXI_BROWSER_SESSION: browserSession } });
    closeSync(log);
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 300 && (!existsSync(portFile) || !readFileSync(portFile, 'utf8').trim()) && child.pid; i++) await new Promise(r => setTimeout(r, 100));
    if (!existsSync(portFile) || !readFileSync(portFile, 'utf8').trim()) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      for (const pid of markerStrays(browserSession)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      const tail = existsSync(join(profile, 'chromium.log')) ? readFileSync(join(profile, 'chromium.log'), 'utf8').split('\n').filter(Boolean).at(-1) ?? '' : '';
      throw new AxiError(`browser: Chromium did not open its debugging port${tail ? `: ${tail.slice(0, 200)}` : ''}`, 'check the executable; see chromium.log in the profile; try --headless on displays without a compositor');
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0]!.trim();
    writeState({ endpoint: `127.0.0.1:${port}`, launched: true, pid: child.pid, profile, profileCreated: typeof parsed.flags.profile !== 'string', browserSession });
    child.unref();
    print(`browser: launched 127.0.0.1:${port} pid=${child.pid} profile=${profile}`);
    return 0;
  },
};

const tabs: CommandModule = {
  spec: {
    name: 'browser tabs',
    summary: 'list tabs; selected is this lane\'s page, front is the tab the browser actually activated',
    flags: [],
    examples: ['desklink-axi browser tabs'],
  },
  async run() {
    await withPage(async (page, { order, state, selectedId }) => {
      const selectedIndex = order.indexOf(page);
      const rows = await Promise.all(order.map(async (candidate, i) => ({
        tab: i,
        title: await candidate.title().catch(() => ''),
        url: candidate.url(),
        selected: i === selectedIndex ? 'yes' : 'no',
        front: i === 0 ? 'yes' : 'no', // DevTools target list: most recently activated first.
      })));
      print(`browser: ${state.endpoint} selected=${selectedIndex} front=0`);
      print(emitList('tabs', rows, ['tab', 'title', 'url', 'selected', 'front']));
      print('help[1]:\n  desklink-axi browser select <tab>');
      writeState({ ...state, selectedTargetId: selectedId });
    });
    return 0;
  },
};

const select: CommandModule = {
  spec: {
    name: 'browser select',
    summary: 'select a tab and bring it to the front',
    args: [{ name: 'tab', required: true, description: 'tab index from browser tabs' }],
    flags: [],
    examples: ['desklink-axi browser select 1'],
  },
  async run(parsed) {
    const index = Number(parsed.positionals[0]);
    if (!Number.isInteger(index) || index < 0) throw new UsageError('browser select takes a tab index', 'desklink-axi browser tabs');
    await withPage(async (page, { context, order, state }) => {
      const target = order[index];
      if (!target) throw new AxiError(`no tab ${index}`, `valid: 0..${order.length - 1}`);
      await target.bringToFront();
      writeState({ ...state, selectedTargetId: await targetIdOf(context, target) });
      print(`browser: selected ${index} url=${target.url()}`);
    });
    return 0;
  },
};

const open: CommandModule = {
  spec: {
    name: 'browser open',
    summary: 'open a URL in a new tab, select it, and bring it to the front',
    args: [{ name: 'url', required: true, description: 'URL to open' }],
    flags: [],
    examples: ['desklink-axi browser open file:///tmp/fixture/index.html'],
  },
  async run(parsed) {
    const url = parsed.positionals[0]!;
    await withPage(async (page, { context, order, state }) => {
      const created = await context.newPage();
      await created.goto(url, { waitUntil: 'load' }).catch((error: Error) => {
        throw new AxiError(`browser: could not open ${url}: ${error.message.split('\n')[0]}`);
      });
      await created.bringToFront();
      writeState({ ...state, selectedTargetId: await targetIdOf(context, created) });
      print(`browser: opened ${url} tab=${order.length}`);
    });
    return 0;
  },
};

const navigate: CommandModule = {
  spec: {
    name: 'browser navigate',
    summary: 'navigate the selected tab to a URL',
    args: [{ name: 'url', required: true, description: 'URL to load in the selected tab' }],
    flags: [],
    examples: ['desklink-axi browser navigate file:///tmp/fixture/index.html'],
  },
  async run(parsed) {
    await withPage(async (page, { state, selectedId }) => {
      await page.goto(parsed.positionals[0]!, { waitUntil: 'load' }).catch((error: Error) => {
        throw new AxiError(`browser: could not load ${parsed.positionals[0]}: ${error.message.split('\n')[0]}`);
      });
      writeState({ ...state, selectedTargetId: selectedId });
      print(`browser: navigated ${page.url()}`);
    });
    return 0;
  },
};

const close: CommandModule = {
  spec: {
    name: 'browser close',
    summary: 'close a tab by index',
    args: [{ name: 'tab', required: true, description: 'tab index from browser tabs' }],
    flags: [],
    examples: ['desklink-axi browser close 1'],
  },
  async run(parsed) {
    const index = Number(parsed.positionals[0]);
    if (!Number.isInteger(index) || index < 0) throw new UsageError('browser close takes a tab index', 'desklink-axi browser tabs');
    await withPage(async (page, { context, order, state, selectedId }) => {
      const target = order[index];
      if (!target) throw new AxiError(`no tab ${index}`, `valid: 0..${order.length - 1}`);
      const closedId = await targetIdOf(context, target);
      await target.close();
      const wasSelected = closedId === selectedId;
      writeState(wasSelected ? { ...state, selectedTargetId: undefined } : state);
      print(`browser: closed ${index}${wasSelected ? '; selection cleared' : ''}`);
    });
    return 0;
  },
};

const snapshot: CommandModule = {
  spec: {
    name: 'browser snapshot',
    summary: 'compact accessibility snapshot of the selected tab with element refs; no screenshots',
    flags: [
      { name: 'tab', type: 'string', description: 'snapshot this tab index instead of the selected one' },
      { name: 'full', type: 'boolean', description: 'disable the 60-line bound' },
    ],
    examples: ['desklink-axi browser snapshot'],
  },
  async run(parsed) {
    await withPage(async (page, { order, state, selectedId }) => {
      const tabFlag = parsed.flags.tab;
      let target = page;
      if (typeof tabFlag === 'string') {
        const index = Number(tabFlag);
        if (!order[index]) throw new AxiError(`no tab ${tabFlag}`, `valid: 0..${order.length - 1}`);
        target = order[index]!;
      }
      const yaml = await snapshotText(target);
      const index = order.indexOf(target);
      print(`browser: ${state.endpoint} page=${index} url=${target.url()}`);
      print(`snapshot:\n${truncated(yaml, parsed.flags.full === true)}`);
      print('help[2]:\n  desklink-axi browser click @e<N>\n  desklink-axi browser fill @e<N> "text"');
      writeState({ ...state, selectedTargetId: selectedId });
    });
    return 0;
  },
};

async function refAction(parsed: { positionals: string[] }, verb: 'click' | 'fill', value?: string): Promise<number> {
  const ref = parsed.positionals[0]!;
  if (!/^@e\d+$/.test(ref)) {
    throw new UsageError(`invalid ref '${ref}'`, 'refs come from browser snapshot output, e.g. @e12');
  }
  await withPage(async page => {
    const locator = await resolveRef(page, ref);
    try {
      if (verb === 'click') await locator.click();
      else await locator.fill(value ?? '');
    } catch (error) {
      throw new AxiError(`${verb}: ${ref} did not complete: ${(error as Error).message.split('\n')[0]}`, 're-snapshot; the element may be covered or the page busy');
    }
    print(`${verb}: applied ${ref}${verb === 'fill' ? ` value=${JSON.stringify(value ?? '')}` : ''}`);
  });
  return 0;
}

const click: CommandModule = {
  spec: {
    name: 'browser click',
    summary: 'click an element by snapshot ref',
    args: [{ name: 'ref', required: true, description: 'element ref from browser snapshot, e.g. @e12' }],
    flags: [],
    examples: ['desklink-axi browser click @e12'],
  },
  async run(parsed) { return refAction(parsed, 'click'); },
};

const fill: CommandModule = {
  spec: {
    name: 'browser fill',
    summary: 'fill an input by snapshot ref',
    args: [
      { name: 'ref', required: true, description: 'element ref from browser snapshot, e.g. @e5' },
      { name: 'text', required: true, description: 'text to fill' },
    ],
    flags: [],
    examples: ['desklink-axi browser fill @e5 "Ada Lovelace"'],
  },
  async run(parsed) { return refAction(parsed, 'fill', parsed.positionals[1]); },
};

const press: CommandModule = {
  spec: {
    name: 'browser press',
    summary: 'press a key in the selected tab',
    args: [{ name: 'key', required: true, description: 'key name, e.g. Enter or Control+a' }],
    flags: [],
    examples: ['desklink-axi browser press Enter'],
  },
  async run(parsed) {
    const key = parsed.positionals[0]!;
    await withPage(async page => {
      await page.keyboard.press(key);
      print(`press: applied ${key}`);
    });
    return 0;
  },
};

const upload: CommandModule = {
  spec: {
    name: 'browser upload',
    summary: 'set a file on an <input type=file> by ref; OS dialogs are not-supported (use the AXI lane)',
    args: [
      { name: 'ref', required: true, description: 'element ref from browser snapshot, e.g. @e9' },
      { name: 'path', required: true, description: 'file to upload' },
    ],
    flags: [],
    examples: ['desklink-axi browser upload @e9 /tmp/report.pdf'],
  },
  async run(parsed) {
    const ref = parsed.positionals[0]!;
    const path = resolve(parsed.positionals[1]!);
    // Consent gate before filesystem access: no-browser fires first.
    await withPage(async page => {
      const locator = await resolveRef(page, ref);
      if (!existsSync(path)) throw new AxiError(`upload: no such file ${path}`);
      const isFileInput = await locator.evaluate(el => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
      if (!isFileInput) {
        throw new AxiError(`not-supported: ${ref} does not accept files (needs <input type=file>)`,
          'OS file dialogs are outside the browser lane; fall back to desklink-axi click/type on the dialog');
      }
      await locator.setInputFiles(path);
      print(`upload: applied ${ref} file=${path}`);
    });
    return 0;
  },
};

const detach: CommandModule = {
  spec: {
    name: 'browser detach',
    summary: 'forget the attached browser; stops it only if this lane launched it',
    flags: [],
    examples: ['desklink-axi browser detach'],
  },
  async run() {
    if (!existsSync(statePath())) {
      print('browser: not attached');
      return 0;
    }
    const state = readState();
    if (state.launched && state.pid) {
      await stopLaunched(state);
      print(`browser: detached and stopped pid=${state.pid}`);
    } else {
      print(`browser: detached ${state.endpoint} (browser left running)`);
    }
    forgetState();
    return 0;
  },
};

export function browserCommands(): Record<string, CommandModule> {
  const modules = { attach, launch, tabs, select, open, navigate, close, snapshot, click, fill, press, upload, detach };
  return Object.fromEntries(Object.entries(modules).map(([name, mod]) => [`browser ${name}`, mod]));
}
