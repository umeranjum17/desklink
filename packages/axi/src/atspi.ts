// Linux AT-SPI accessibility client over `busctl` (systemd's D-Bus client,
// present wherever systemd is). Zero new npm dependencies; every call is one
// bounded process spawn against the user's accessibility bus.
//
// Bus resolution order (matching libatspi itself):
//   1. AT_SPI_BUS_ADDRESS environment variable (headless/test cages)
//   2. org.a11y.Bus.GetAddress on the session bus (normal desktops)
// The X11 _AT_SPI_BUS root-window property fallback is not implemented; on
// desktops without a session bus there is no AXI session anyway.
//
// macOS: the AX API route is NOT implemented. Capability probing reports it
// as explicitly unavailable so callers can degrade to OCR/coordinates.

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function a11yDebug(line: string): void {
  const path = process.env.DESKLINK_AXI_A11Y_DEBUG;
  if (path) { try { appendFileSync(path, line + '\n'); } catch { /* debug sink only */ } }
}

export interface A11yNode {
  ref: string;
  bus: string;
  path: string;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  states: string[];
  interfaces: string[];
  value?: string;
  action?: string;
}

export interface A11ySnapshot {
  gen: number;
  nodes: A11yNode[];
  apps: string[];
}

export class A11yError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const MACOS_A11Y_NOTICE = 'a11y-unavailable: macOS AX route is not implemented (planned; Linux AT-SPI first)';

const REGISTRY = 'org.a11y.atspi.Registry';
const ROOT = '/org/a11y/atspi/accessible/root';
const MAX_NODES = 400;
const MAX_DEPTH = 12;

// ATSPI state enum bits (at-spi-constants.h), only the ones we surface.
const STATE_BITS: Array<[number, string]> = [
  [1, 'active'], [4, 'checked'], [6, 'defunct'], [7, 'editable'], [8, 'enabled'],
  [11, 'focusable'], [12, 'focused'], [24, 'sensitive'], [25, 'showing'],
  [26, 'single-line'], [30, 'visible'], [33, 'required'], [41, 'checkable'],
];

export function decodeStates(words: number[]): string[] {
  const set: string[] = [];
  for (const [bit, name] of STATE_BITS) {
    const word = bit < 32 ? words[0] ?? 0 : words[1] ?? 0;
    if (word & (1 << bit % 32)) set.push(name);
  }
  return set;
}

export function isActionable(node: A11yNode): boolean {
  return node.interfaces.includes('Action') && node.states.includes('enabled') && node.states.includes('showing');
}

export const axRefPattern = /^@a(\d+)\.(\d+)$/;

// busctl --json wraps each out parameter as {type,data}; the whole reply is a
// one-element array of the tuple. decode() unwraps variants and nesting.
export function decodeReply(json: { type?: string; data?: unknown }): unknown {
  if (!json || typeof json.type !== 'string') return json;
  if (json.type === 'v') {
    const inner = Array.isArray(json.data) ? (json.data as unknown[])[0] : json.data;
    return decodeReply(inner as { type?: string; data?: unknown });
  }
  if (Array.isArray(json.data)) return json.data.map(decodeReply);
  return json.data;
}

export function replyPayload(json: { type?: string; data?: unknown }): unknown {
  const decoded = decodeReply(json);
  return Array.isArray(decoded) ? decoded[0] : decoded;
}

export function parseActions(reply: unknown): string[] {
  // Modern a(sss) name/description/keybinding; tolerate legacy (uss).
  const rows = Array.isArray(reply) ? reply : [];
  return rows.map(row => {
    const tuple = Array.isArray(row) ? row : [];
    return typeof tuple[0] === 'number' ? String(tuple[1]) : String(tuple[0] ?? '');
  });
}

export class A11yClient {
  private address?: string;
  private nextGen = 1;

  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  private busctl(args: string[], address: string, timeoutMs = 5000): Promise<{ type: string; data: unknown }> {
    return new Promise((resolve, reject) => {
      execFile('busctl', ['--address', address, '--json=short', ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim().split('\n').at(-1) ?? 'busctl failed';
          reject(new A11yError(classifyBusctlError(detail), detail));
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new A11yError('a11y-error', `unparsable busctl output: ${stdout.slice(0, 120)}`)); }
      });
    });
  }

  private call(dest: string, path: string, iface: string, method: string, signature = '', ...args: string[]): Promise<unknown> {
    return this.ready().then(address => this.busctl(['call', dest, path, iface, method, ...(signature ? [signature, ...args] : [])], address).then(replyPayload));
  }

  private async ready(): Promise<string> {
    if (this.address) return this.address;
    if (process.platform === 'darwin') throw new A11yError('a11y-unavailable', MACOS_A11Y_NOTICE.replace('a11y-unavailable: ', ''));
    const direct = this.env.AT_SPI_BUS_ADDRESS;
    if (direct) { this.address = direct; return direct; }
    const session = this.env.DBUS_SESSION_BUS_ADDRESS ?? (this.env.XDG_RUNTIME_DIR ? `unix:path=${this.env.XDG_RUNTIME_DIR}/bus` : '');
    if (!session) throw new A11yError('a11y-unavailable', 'no D-Bus session bus; accessibility tree unavailable');
    try {
      const reply = await this.busctl(['call', 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress'], session);
      const payload = replyPayload(reply);
      if (typeof payload !== 'string' || !payload) throw new Error('empty address');
      this.address = payload;
      return payload;
    } catch (error) {
      throw new A11yError('a11y-unavailable', `accessibility bus unreachable: ${(error as Error).message}; install at-spi2-core (running desktop sessions usually provide it)`);
    }
  }

  reset(): void { this.address = undefined; }

  private async nodeFacts(bus: string, path: string) {
    const logged = (error: unknown) => {
      a11yDebug(`${bus} ${path}: ${(error as Error).message}`);
      throw error;
    };
    const [role, states, extents, interfaces] = await Promise.all([
      this.call(bus, path, 'org.a11y.atspi.Accessible', 'GetRoleName').catch(logged).catch(() => 'unknown'),
      this.call(bus, path, 'org.a11y.atspi.Accessible', 'GetState').catch(logged).catch(() => []),
      this.call(bus, path, 'org.a11y.atspi.Component', 'GetExtents', 'u', '0').catch(logged).catch(() => []),
      this.call(bus, path, 'org.a11y.atspi.Accessible', 'GetInterfaces').catch(logged).catch(() => []),
    ]);
    const name = await this.call(bus, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.a11y.atspi.Accessible', 'Name').catch(() => '');
    return {
      name: typeof name === 'string' ? name : '',
      role: typeof role === 'string' ? role : 'unknown',
      states: decodeStates(Array.isArray(states) ? states.filter(n => typeof n === 'number') as number[] : []),
      box: Array.isArray(extents) && extents.every(n => typeof n === 'number') && extents.length === 4 ? extents as number[] : [0, 0, 0, 0],
      interfaces: Array.isArray(interfaces) ? interfaces.map(name => String(name).replace('org.a11y.atspi.', '')) : [],
    };
  }

  private async readValue(node: { bus: string; path: string; interfaces: string[] }): Promise<string | undefined> {
    try {
      if (node.interfaces.includes('Text')) {
        const count = await this.call(node.bus, node.path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.a11y.atspi.Text', 'CharacterCount');
        const n = typeof count === 'number' ? count : 0;
        if (n <= 0) return '';
        const text = await this.call(node.bus, node.path, 'org.a11y.atspi.Text', 'GetText', 'ii', '0', String(Math.min(n, 400)));
        return typeof text === 'string' ? text : undefined;
      }
      if (node.interfaces.includes('Value')) {
        const value = await this.call(node.bus, node.path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.a11y.atspi.Value', 'Value');
        return typeof value === 'number' ? String(value) : undefined;
      }
    } catch (error) {
      a11yDebug(`value ${node.path}: ${(error as Error).message}`);
      return undefined;
    }
    return undefined;
  }

  async snapshot(): Promise<A11ySnapshot> {
    const gen = this.nextGen++;
    const roots = await this.call(REGISTRY, ROOT, 'org.a11y.atspi.Accessible', 'GetChildren') as Array<[string, string]>;
    const nodes: A11yNode[] = [];
    const apps: string[] = [];
    for (const [bus, path] of Array.isArray(roots) ? roots : []) {
      apps.push(String(bus));
      let frontier: Array<[string, string, number]> = [[String(bus), String(path), 0]];
      while (frontier.length && nodes.length < MAX_NODES) {
        const facts = await Promise.all(frontier.map(([b, p]) => this.nodeFacts(b, p).catch(() => undefined)));
        const next: Array<[string, string, number]> = [];
        for (let i = 0; i < frontier.length && nodes.length < MAX_NODES; i++) {
          const [busName, nodePath, depth] = frontier[i]!;
          const fact = facts[i];
          if (!fact || fact.states.includes('defunct')) continue;
          const node: A11yNode = {
            ref: `@a${gen}.${nodes.length + 1}`, bus: busName, path: nodePath,
            role: fact.role, name: fact.name,
            x: fact.box[0]!, y: fact.box[1]!, w: fact.box[2]!, h: fact.box[3]!,
            states: fact.states, interfaces: fact.interfaces,
          };
          if (fact.interfaces.includes('Action')) {
            try {
              const actions = parseActions(await this.call(busName, nodePath, 'org.a11y.atspi.Action', 'GetActions'));
              if (actions.length) node.action = actions[0]!;
            } catch { /* action probe optional */ }
          }
          nodes.push(node);
          if (depth < MAX_DEPTH) {
            try {
              const children = await this.call(busName, nodePath, 'org.a11y.atspi.Accessible', 'GetChildren') as Array<[string, string]>;
              for (const [childBus, childPath] of Array.isArray(children) ? children : []) {
                next.push([String(childBus), String(childPath), depth + 1]);
              }
            } catch { /* leaf */ }
          }
        }
        frontier = next;
      }
    }
    for (const node of nodes.slice(0, 100)) {
      if (node.interfaces.includes('Text') || node.interfaces.includes('Value')) {
        node.value = await this.readValue(node);
      }
    }
    return { gen, nodes, apps };
  }

  query(nodes: A11yNode[], words: string): A11yNode[] {
    const needle = words.toLowerCase();
    return nodes.filter(node => node.name.toLowerCase().includes(needle) || node.role.toLowerCase().includes(needle) || node.value?.toLowerCase().includes(needle));
  }

  // Re-check a snapshot node against the live tree: identity (role, name,
  // geometry) must still match, else the ref is stale.
  async revalidate(node: A11yNode): Promise<A11yNode> {
    let fact: Awaited<ReturnType<A11yClient['nodeFacts']>>;
    try { fact = await this.nodeFacts(node.bus, node.path); }
    catch { throw new A11yError('stale-ref', `${node.ref} is gone; run desklink-axi tree`); }
    const moved = fact.box.some((n, i) => n !== [node.x, node.y, node.w, node.h][i]);
    if (fact.states.includes('defunct') || fact.name !== node.name || fact.role !== node.role || moved) {
      throw new A11yError('stale-ref', `${node.ref} (${node.role} ${JSON.stringify(node.name)}) moved or changed; run desklink-axi tree`);
    }
    return { ...node, states: fact.states, interfaces: fact.interfaces };
  }

  async doAction(node: A11yNode): Promise<string> {
    const actions = parseActions(await this.call(node.bus, node.path, 'org.a11y.atspi.Action', 'GetActions'));
    if (!actions.length) throw new A11yError('not-actionable', `${node.ref} exposes no AT-SPI action`);
    const done = await this.call(node.bus, node.path, 'org.a11y.atspi.Action', 'DoAction', 'i', '0');
    if (done !== true) throw new A11yError('action-failed', `${node.ref} action ${JSON.stringify(actions[0])} was rejected`);
    return actions[0]!;
  }

  async grabFocus(node: A11yNode): Promise<boolean> {
    const done = await this.call(node.bus, node.path, 'org.a11y.atspi.Component', 'GrabFocus');
    return done === true;
  }
}

function classifyBusctlError(detail: string): string {
  if (/ServiceUnknown|not provided by any .service|Could not activate|Failed to activate/.test(detail)) return 'a11y-unavailable';
  if (/No such file or directory|Failed to connect/.test(detail)) return 'a11y-unavailable';
  if (/doesn't exist|Unknown interface|UnknownMethod/.test(detail)) return 'a11y-unsupported';
  return 'a11y-error';
}
