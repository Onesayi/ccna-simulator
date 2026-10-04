import { parse as parseYaml } from 'yaml';

/**
 * A small Ansible: INI inventories, YAML playbooks, and the `cisco.ios` network modules
 * (`ios_command`, `ios_config`, `ios_facts`) plus `debug`, run over SSH like `network_cli`.
 * Output follows `ansible-playbook` closely: PLAY and TASK banners, ok/changed/fatal per host,
 * and the PLAY RECAP.
 */

export interface Inventory {
  /** Host name to its variables (host vars over group vars). */
  hosts: Map<string, Record<string, unknown>>;
  /** Group name to host names. `all` holds every host. */
  groups: Map<string, string[]>;
}

/** A session on one device, opened by the control node. */
export interface NetworkConnection {
  /** Runs one EXEC command and returns its output. */
  run(command: string): string;
  /** The running configuration, to tell whether `ios_config` changed anything. */
  runningConfig(): string;
  /** Facts for `ios_facts`. */
  facts(): Record<string, unknown>;
}

/** Opens an SSH session to `address` as `user`, or explains why it could not. */
export type Connector = (address: string, user: string | undefined, password: string | undefined) => { conn: NetworkConnection } | { error: string };

function scalar(v: string): unknown {
  if (/^(true|yes)$/i.test(v)) return true;
  if (/^(false|no)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.replace(/^(['"])(.*)\1$/, '$2');
}

/** Parses an INI inventory: `[group]` sections of `host key=value ...`, and `[group:vars]` sections. */
export function parseInventory(text: string): Inventory {
  const hosts = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, string[]>([['all', []], ['ungrouped', []]]);
  const groupVars = new Map<string, Record<string, unknown>>();
  let section = 'ungrouped';
  let vars = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s[#;].*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[([^\]:]+)(:vars)?\]$/.exec(line);
    if (head) {
      section = head[1]!;
      vars = Boolean(head[2]);
      if (!vars && !groups.has(section)) groups.set(section, []);
      continue;
    }
    if (vars) {
      const m = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
      if (m) groupVars.set(section, { ...groupVars.get(section), [m[1]!]: scalar(m[2]!.trim()) });
      continue;
    }
    const [name, ...pairs] = line.split(/\s+/);
    const hv: Record<string, unknown> = hosts.get(name!) ?? {};
    for (const p of pairs) {
      const at = p.indexOf('=');
      if (at > 0) hv[p.slice(0, at)] = scalar(p.slice(at + 1));
    }
    hosts.set(name!, hv);
    const members = groups.get(section)!;
    if (!members.includes(name!)) members.push(name!);
    if (!groups.get('all')!.includes(name!)) groups.get('all')!.push(name!);
  }
  // Host variables win over group variables; `all:vars` is the weakest.
  for (const [name, hv] of hosts) {
    const inherited: Record<string, unknown> = { ...groupVars.get('all') };
    for (const [g, members] of groups) if (g !== 'all' && members.includes(name)) Object.assign(inherited, groupVars.get(g));
    hosts.set(name, { ...inherited, ...hv });
  }
  return { hosts, groups };
}

/** Hosts matched by a play's `hosts:` pattern: a group, a host, `all`, or a colon/comma list. */
function matchHosts(inv: Inventory, pattern: string): string[] {
  const out: string[] = [];
  for (const p of pattern.split(/[:,]/).map((x) => x.trim()).filter(Boolean)) {
    const members = inv.groups.get(p) ?? (inv.hosts.has(p) ? [p] : []);
    for (const h of members) if (!out.includes(h)) out.push(h);
  }
  return out;
}

function banner(text: string): string {
  return `${text} ${'*'.repeat(Math.max(3, 79 - text.length))}`;
}

/** Looks up `a.b[0].c` in the variables. */
function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.trim().split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replaces `{{ var }}` with its value, like Jinja2 without filters. */
function template(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (whole) return lookup(vars, whole[1]!);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p: string) => String(lookup(vars, p) ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars)]));
  return value;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

function json(v: unknown, indent = 4): string {
  return JSON.stringify(v, null, indent);
}

const IOS_ERROR = /^% (Invalid input|Incomplete command|Ambiguous command|Unknown command|Bad secrets)/m;

type TaskResult = { status: 'ok' | 'changed'; result: Record<string, unknown> } | { status: 'failed'; msg: string };

const MODULES = ['ios_command', 'ios_config', 'ios_facts', 'debug'];

function moduleOf(task: Record<string, unknown>): { module: string; args: unknown } | undefined {
  for (const [k, v] of Object.entries(task)) {
    const short = k.replace(/^(cisco\.ios\.|ansible\.builtin\.)/, '');
    if (MODULES.includes(short)) return { module: short, args: v };
  }
  return undefined;
}

function runModule(module: string, args: Record<string, unknown>, conn: NetworkConnection, vars: Record<string, unknown>): TaskResult {
  if (module === 'ios_command') {
    const commands = asList(args.commands);
    if (!commands.length) return { status: 'failed', msg: 'missing required arguments: commands' };
    const stdout: string[] = [];
    for (const c of commands) {
      const out = conn.run(c);
      if (IOS_ERROR.test(out)) return { status: 'failed', msg: `${c}\r\n${out}` };
      stdout.push(out);
    }
    return { status: 'ok', result: { changed: false, stdout, stdout_lines: stdout.map((s) => s.split('\n')) } };
  }
  if (module === 'ios_config') {
    const parents = asList(args.parents);
    const lines = asList(args.lines ?? args.commands);
    if (!lines.length) return { status: 'failed', msg: 'one of lines, src, backup or running_config is required' };
    const before = conn.runningConfig();
    const sent = [...parents, ...lines];
    const conf = conn.run('configure terminal');
    if (IOS_ERROR.test(conf)) return { status: 'failed', msg: `configure terminal\r\n${conf}` };
    for (const l of sent) {
      const out = conn.run(l);
      if (IOS_ERROR.test(out)) {
        conn.run('end');
        return { status: 'failed', msg: `${l}\r\n${out}` };
      }
    }
    conn.run('end');
    if (args.save_when === 'always' || args.save_when === 'modified') conn.run('write memory');
    const changed = conn.runningConfig() !== before;
    return { status: changed ? 'changed' : 'ok', result: { changed, commands: changed ? sent : [], updates: changed ? sent : [] } };
  }
  if (module === 'ios_facts') {
    const facts = conn.facts();
    Object.assign(vars, facts);
    return { status: 'ok', result: { changed: false, ansible_facts: facts } };
  }
  return { status: 'failed', msg: `couldn't resolve module/action '${module}'` };
}

/**
 * Runs a playbook against an inventory and returns what `ansible-playbook` would print. `connect`
 * opens an SSH session to a device, so routing, ACLs, SSH settings and credentials all matter.
 */
export function runPlaybook(playbookText: string, inventoryText: string, connect: Connector): string {
  let plays: unknown;
  try {
    plays = parseYaml(playbookText);
  } catch (err) {
    return `ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nSyntax Error while loading YAML.\n  ${(err as Error).message.split('\n')[0]}`;
  }
  if (!Array.isArray(plays)) return 'ERROR! A playbook must be a list of plays, got a dict instead';
  const inv = parseInventory(inventoryText);
  const out: string[] = [];
  const recap = new Map<string, { ok: number; changed: number; unreachable: number; failed: number; skipped: number }>();
  const tally = (h: string) => {
    let t = recap.get(h);
    if (!t) recap.set(h, (t = { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0 }));
    return t;
  };

  for (const play of plays as Record<string, unknown>[]) {
    if (!play || typeof play !== 'object' || typeof play.hosts !== 'string') return `${out.join('\n')}\nERROR! the field 'hosts' is required but was not set`.trim();
    const tasks = (Array.isArray(play.tasks) ? play.tasks : []) as Record<string, unknown>[];
    for (const t of tasks) {
      const m = t && typeof t === 'object' ? moduleOf(t) : undefined;
      if (!m) {
        const name = t && typeof t === 'object' ? Object.keys(t).find((k) => !['name', 'register', 'when', 'tags', 'vars'].includes(k)) : undefined;
        return `${out.join('\n')}\nERROR! ${name ? `couldn't resolve module/action '${name}'. This often indicates a misspelling, missing collection, or incorrect module path.` : 'no module/action detected in task.'}`.trim();
      }
    }
    const hosts = matchHosts(inv, play.hosts);
    if (!hosts.length) out.push(`[WARNING]: Could not match supplied host pattern, ignoring: ${play.hosts}`);
    out.push('', banner(`PLAY [${typeof play.name === 'string' ? play.name : play.hosts}]`));
    if (!hosts.length) {
      out.push('skipping: no hosts matched');
      continue;
    }

    const playVars = (play.vars && typeof play.vars === 'object' ? play.vars : {}) as Record<string, unknown>;
    const live = new Map<string, { vars: Record<string, unknown>; conn?: NetworkConnection }>();
    for (const h of hosts) live.set(h, { vars: { inventory_hostname: h, ...inv.hosts.get(h), ...playVars } });

    // network_cli connects on the first task that needs the device.
    const connection = (h: string): NetworkConnection | string => {
      const state = live.get(h)!;
      if (state.conn) return state.conn;
      const v = state.vars;
      const kind = String(v.ansible_connection ?? play.connection ?? 'ssh').replace(/^ansible\.netcommon\./, '');
      if (kind !== 'network_cli') return `Connection type ${kind} is not valid for this module. Use ansible_connection=ansible.netcommon.network_cli for IOS devices.`;
      const os = v.ansible_network_os;
      if (!os) return 'Unable to automatically determine host network os. Please manually configure ansible_network_os value for this host';
      if (!/^(cisco\.ios\.)?ios$/.test(String(os))) return `network os ${String(os)} is not supported`;
      const address = String(v.ansible_host ?? h);
      const r = connect(address, v.ansible_user === undefined ? undefined : String(v.ansible_user), v.ansible_password === undefined ? (v.ansible_ssh_pass === undefined ? undefined : String(v.ansible_ssh_pass)) : String(v.ansible_password));
      if ('error' in r) return r.error;
      if (v.ansible_become) {
        const p = r.conn.run('enable');
        if (/Password/.test(p)) r.conn.run(String(v.ansible_become_password ?? v.ansible_become_pass ?? ''));
      }
      state.conn = r.conn;
      return r.conn;
    };

    const gather = play.gather_facts === undefined ? true : Boolean(play.gather_facts);
    const steps: Record<string, unknown>[] = [...(gather ? [{ name: 'Gathering Facts', ios_facts: {} }] : []), ...tasks];
    for (const task of steps) {
      const active = hosts.filter((h) => live.has(h));
      if (!active.length) break;
      const { module, args } = moduleOf(task)!;
      out.push('', banner(`TASK [${typeof task.name === 'string' ? task.name : module}]`));
      for (const h of active) {
        const state = live.get(h)!;
        const a = (template(args ?? {}, state.vars) ?? {}) as Record<string, unknown>;
        if (module === 'debug') {
          tally(h).ok++;
          const raw = (args ?? {}) as Record<string, unknown>;
          if (typeof raw.var === 'string') {
            const name = raw.var;
            const value = lookup(state.vars, name);
            out.push(`ok: [${h}] => {\n    ${JSON.stringify(name)}: ${value === undefined ? '"VARIABLE IS NOT DEFINED!"' : json(value).replace(/\n/g, '\n    ')}\n}`);
          } else out.push(`ok: [${h}] => {\n    "msg": ${json(a.msg ?? 'Hello world!').replace(/\n/g, '\n    ')}\n}`);
          continue;
        }
        const conn = connection(h);
        if (typeof conn === 'string') {
          out.push(`fatal: [${h}]: UNREACHABLE! => ${JSON.stringify({ changed: false, msg: conn, unreachable: true })}`);
          tally(h).unreachable++;
          live.delete(h);
          continue;
        }
        const r = runModule(module, a, conn, state.vars);
        if (r.status === 'failed') {
          out.push(`fatal: [${h}]: FAILED! => ${JSON.stringify({ changed: false, msg: r.msg })}`);
          tally(h).failed++;
          live.delete(h);
          continue;
        }
        if (typeof task.register === 'string') state.vars[task.register] = r.result;
        tally(h).ok++;
        if (r.status === 'changed') tally(h).changed++;
        out.push(`${r.status}: [${h}]`);
      }
    }
  }
  out.push('', banner('PLAY RECAP'));
  for (const [h, t] of recap) {
    out.push(`${h.padEnd(27)}: ok=${String(t.ok).padEnd(4)} changed=${String(t.changed).padEnd(4)} unreachable=${String(t.unreachable).padEnd(4)} failed=${String(t.failed).padEnd(4)} skipped=${String(t.skipped).padEnd(4)} rescued=0    ignored=0   `);
  }
  out.push('');
  return out.join('\n');
}
