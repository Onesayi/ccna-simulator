import type { Ipv4Address } from '../core/addressing';
import type { RadiusMessage, TacacsMessage } from '../core/frames';
import type { ScheduledEvent } from '../core/scheduler';
import type { LocalUser } from './management';

/**
 * AAA on an IOS device (`aaa new-model`): method lists for login authentication, EXEC
 * authorization and EXEC accounting, and the RADIUS and TACACS+ servers they point at.
 */

export type AaaProtocol = 'radius' | 'tacacs+';

export interface AaaServerStats {
  requests: number;
  accepts: number;
  rejects: number;
  timeouts: number;
}

export interface AaaServer {
  /** The name from `radius server <name>`, or the address for the legacy `radius-server host` form. */
  name: string;
  protocol: AaaProtocol;
  address?: Ipv4Address;
  key?: string;
  /** RADIUS ports. IOS still defaults to the old 1645/1646 pair. */
  authPort: number;
  acctPort: number;
  /** Configured with `radius-server host` or `tacacs-server host`. */
  legacy?: boolean;
  stats: AaaServerStats;
}

/** `aaa group server radius|tacacs+ <name>`: a named, ordered list of servers. */
export interface AaaGroup {
  name: string;
  protocol: AaaProtocol;
  servers: string[];
}

/** One step of a method list, tried in order until one gives an answer. */
export type AaaMethod = { kind: 'group'; group: string } | { kind: 'local' } | { kind: 'line' } | { kind: 'enable' } | { kind: 'none' };

export interface AccountingList {
  mode: 'start-stop' | 'stop-only';
  methods: AaaMethod[];
}

/**
 * - `pass` / `fail`: a method answered (a server accepted or rejected, the local password matched or not).
 * - `error`: no method could answer (servers unreachable, no such user anywhere).
 */
export type AaaOutcome = { status: 'pass'; method: string; privilege?: number } | { status: 'fail'; method: string } | { status: 'error' };

/** How long to wait for a server before trying the next one. */
export const AAA_TIMEOUT_MS = 5_000;

export function parseMethods(words: string[]): AaaMethod[] {
  const out: AaaMethod[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!.toLowerCase();
    if (w === 'group') {
      const g = words[++k];
      if (!g) throw new Error('Invalid input detected at \'^\' marker.');
      out.push({ kind: 'group', group: g.toLowerCase() === 'tacacs+' || g.toLowerCase() === 'radius' ? g.toLowerCase() : g });
    } else if ('local'.startsWith(w) && w.length >= 3) out.push({ kind: 'local' });
    else if (w === 'line') out.push({ kind: 'line' });
    else if (w === 'enable') out.push({ kind: 'enable' });
    else if (w === 'none') out.push({ kind: 'none' });
    else throw new Error('Invalid input detected at \'^\' marker.');
  }
  if (!out.length) throw new Error('% Incomplete command.');
  return out;
}

export function formatMethods(methods: AaaMethod[]): string {
  return methods.map((m) => (m.kind === 'group' ? `group ${m.group}` : m.kind)).join(' ');
}

export interface AaaHooks {
  users: Map<string, LocalUser>;
  enablePassword(): string | undefined;
  sendRadius(server: AaaServer, port: number, msg: RadiusMessage): boolean;
  sendTacacs(server: AaaServer, msg: TacacsMessage): boolean;
  schedule(delayMs: number, label: string, run: () => void): ScheduledEvent | undefined;
  cancel(event: ScheduledEvent | undefined): void;
}

/** The credentials being checked, and what was learned on the way (RADIUS sends the privilege with the accept). */
export interface AaaContext {
  username?: string;
  password?: string;
  /** The line password, for the `line` method. */
  linePassword?: string;
  /** Set when a RADIUS server accepted: its `priv-lvl`, reused by `aaa authorization exec ... group radius`. */
  radiusPrivilege?: number;
  /** NAS-Port-Type for RADIUS: a VTY login or a wireless 802.1X client. */
  portType?: 'Virtual' | 'Wireless-802.11';
}

let requestCounter = 0;

export class Aaa {
  newModel = false;
  /** `aaa authorization console`: apply EXEC authorization to console logins too. */
  authorizeConsole = false;
  readonly login = new Map<string, AaaMethod[]>();
  readonly authorization = new Map<string, AaaMethod[]>();
  readonly accounting = new Map<string, AccountingList>();
  readonly servers = new Map<string, AaaServer>();
  readonly groups = new Map<string, AaaGroup>();
  /** `radius-server key` / `tacacs-server key`: used by servers with no key of their own. */
  readonly globalKeys: Partial<Record<AaaProtocol, string>> = {};
  private readonly pending = new Map<string, { done: (reply: RadiusMessage | TacacsMessage | undefined) => void; timer?: ScheduledEvent }>();

  constructor(private readonly hooks: AaaHooks) {}

  server(name: string, protocol: AaaProtocol): AaaServer {
    let s = this.servers.get(name);
    if (!s) {
      s = { name, protocol, authPort: 1645, acctPort: 1646, stats: { requests: 0, accepts: 0, rejects: 0, timeouts: 0 } };
      this.servers.set(name, s);
    }
    return s;
  }

  keyOf(s: AaaServer): string | undefined {
    return s.key ?? this.globalKeys[s.protocol];
  }

  /** The servers a `group <name>` method reaches, in order. */
  serversOf(group: string): AaaServer[] {
    const all = [...this.servers.values()];
    if (group === 'radius' || group === 'tacacs+') return all.filter((s) => s.protocol === group && s.address);
    const g = this.groups.get(group);
    return (g?.servers ?? []).map((n) => this.servers.get(n)).filter((s): s is AaaServer => s !== undefined && s.protocol === g?.protocol && s.address !== undefined);
  }

  /** The login methods for a line: its own list, the default list, or IOS's fallback when none is defined. */
  loginMethods(list: string | undefined, line: 'console' | 'vty'): AaaMethod[] | undefined {
    if (list) return this.login.get(list);
    return this.login.get('default') ?? (line === 'vty' ? [{ kind: 'local' }] : [{ kind: 'none' }]);
  }

  /** Authenticates a login against a method list. `done` runs once a method answers or all fail. */
  authenticate(methods: AaaMethod[], ctx: AaaContext, done: (outcome: AaaOutcome) => void): void {
    const next = (k: number): void => {
      if (k >= methods.length) return done({ status: 'error' });
      const m = methods[k]!;
      const label = m.kind === 'group' ? `group ${m.group}` : m.kind;
      switch (m.kind) {
        case 'none':
          return done({ status: 'pass', method: label });
        case 'local': {
          const u = ctx.username !== undefined ? this.hooks.users.get(ctx.username) : undefined;
          // An unknown user is an error, so the next method gets a turn; a wrong password is a failure.
          if (!u) return next(k + 1);
          return done(u.password === ctx.password ? { status: 'pass', method: label, privilege: u.privilege } : { status: 'fail', method: label });
        }
        case 'line':
          if (ctx.linePassword === undefined) return next(k + 1);
          return done(ctx.password === ctx.linePassword ? { status: 'pass', method: label } : { status: 'fail', method: label });
        case 'enable': {
          const pw = this.hooks.enablePassword();
          if (pw === undefined) return next(k + 1);
          return done(ctx.password === pw ? { status: 'pass', method: label } : { status: 'fail', method: label });
        }
        case 'group':
          return this.askServers(this.serversOf(m.group), 'authen', ctx, (o) => (o.status === 'error' ? next(k + 1) : done({ ...o, method: label })));
      }
    };
    next(0);
  }

  /**
   * EXEC authorization: which privilege level the session starts at. With no list, IOS starts every
   * AAA login at level 1, whatever the user's configured privilege (a classic surprise).
   */
  authorize(methods: AaaMethod[] | undefined, ctx: AaaContext, done: (privilege: number | undefined) => void): void {
    if (!methods) return done(1);
    const next = (k: number): void => {
      if (k >= methods.length) return done(undefined);
      const m = methods[k]!;
      switch (m.kind) {
        case 'none':
          return done(1);
        case 'local': {
          const u = ctx.username !== undefined ? this.hooks.users.get(ctx.username) : undefined;
          return u ? done(u.privilege) : next(k + 1);
        }
        case 'group': {
          const servers = this.serversOf(m.group);
          // RADIUS combines authentication and authorization: the accept already carried the level.
          if (servers[0]?.protocol === 'radius') return ctx.radiusPrivilege !== undefined ? done(ctx.radiusPrivilege) : next(k + 1);
          return this.askServers(servers, 'author', ctx, (o) => (o.status === 'pass' ? done(o.privilege ?? 1) : o.status === 'fail' ? done(undefined) : next(k + 1)));
        }
        default:
          return next(k + 1);
      }
    };
    next(0);
  }

  /** Sends an EXEC accounting record to the first group in the default list, if one is set. */
  account(record: 'start' | 'stop', username: string | undefined): void {
    const list = this.accounting.get('default');
    if (!list || (record === 'start' && list.mode === 'stop-only')) return;
    const group = list.methods.find((m): m is Extract<AaaMethod, { kind: 'group' }> => m.kind === 'group');
    if (!group) return;
    for (const s of this.serversOf(group.group)) {
      const key = this.keyOf(s) ?? '';
      if (s.protocol === 'radius') this.hooks.sendRadius(s, s.acctPort, { code: 'accounting-request', id: ++requestCounter & 0xff, username, record, portType: 'Virtual', key });
      else this.hooks.sendTacacs(s, { type: 'acct', session: ++requestCounter, username, record, key });
    }
  }

  /** Tries each server in turn: an answer ends the search, a timeout moves on to the next. */
  private askServers(servers: AaaServer[], kind: 'authen' | 'author', ctx: AaaContext, done: (o: AaaOutcome) => void): void {
    const next = (k: number): void => {
      const s = servers[k];
      if (!s) return done({ status: 'error' });
      const key = this.keyOf(s);
      s.stats.requests++;
      const id = ++requestCounter;
      const pendingKey = `${s.protocol}:${id}`;
      const finish = (reply: RadiusMessage | TacacsMessage | undefined) => {
        if (!reply) {
          s.stats.timeouts++;
          return next(k + 1);
        }
        const pass = 'code' in reply ? reply.code === 'access-accept' : reply.status === 'pass' || reply.status === 'success';
        if (pass) s.stats.accepts++;
        else s.stats.rejects++;
        if ('code' in reply && pass) ctx.radiusPrivilege = reply.privilege;
        done(pass ? { status: 'pass', method: s.protocol, privilege: reply.privilege } : { status: 'fail', method: s.protocol });
      };
      // A server with no key cannot be used at all.
      const sent =
        key !== undefined &&
        (s.protocol === 'radius'
          ? this.hooks.sendRadius(s, s.authPort, { code: 'access-request', id: id & 0xff, username: ctx.username, password: ctx.password, portType: ctx.portType ?? 'Virtual', key })
          : this.hooks.sendTacacs(s, { type: kind, session: id, username: ctx.username, password: kind === 'authen' ? ctx.password : undefined, key }));
      if (!sent) {
        s.stats.timeouts++;
        return next(k + 1);
      }
      const entry: { done: typeof finish; timer?: ScheduledEvent } = { done: finish };
      entry.timer = this.hooks.schedule(AAA_TIMEOUT_MS, `aaa timeout ${s.name}`, () => {
        this.pending.delete(pendingKey);
        finish(undefined);
      });
      this.pending.set(pendingKey, entry);
    };
    next(0);
  }

  /** A RADIUS reply from `src`. Replies with the wrong key fail the authenticator check and are dropped. */
  receiveRadius(src: Ipv4Address, msg: RadiusMessage): void {
    const match = [...this.pending.keys()].find((k) => k.startsWith('radius:') && (Number(k.slice(7)) & 0xff) === msg.id);
    if (!match) return;
    const server = [...this.servers.values()].find((s) => s.protocol === 'radius' && s.address === src);
    if (!server || this.keyOf(server) !== msg.key) return;
    this.resolve(match, msg);
  }

  receiveTacacs(src: Ipv4Address, msg: TacacsMessage): void {
    const key = `tacacs+:${msg.session}`;
    const server = [...this.servers.values()].find((s) => s.protocol === 'tacacs+' && s.address === src);
    if (!this.pending.has(key) || !server || this.keyOf(server) !== msg.key) return;
    this.resolve(key, msg);
  }

  private resolve(key: string, reply: RadiusMessage | TacacsMessage): void {
    const entry = this.pending.get(key)!;
    this.pending.delete(key);
    this.hooks.cancel(entry.timer);
    entry.done(reply);
  }

  /** Running-config lines for the global AAA settings. */
  config(): string[] {
    if (!this.newModel && !this.servers.size) return [];
    const out: string[] = [];
    if (this.newModel) out.push('aaa new-model');
    for (const g of this.groups.values()) out.push(`aaa group server ${g.protocol} ${g.name}`, ...g.servers.map((s) => ` server name ${s}`), '!');
    for (const [name, m] of this.login) out.push(`aaa authentication login ${name} ${formatMethods(m)}`);
    for (const [name, m] of this.authorization) out.push(`aaa authorization exec ${name} ${formatMethods(m)}`);
    for (const [name, a] of this.accounting) out.push(`aaa accounting exec ${name} ${a.mode} ${formatMethods(a.methods)}`);
    if (this.newModel) out.push('!', 'aaa session-id common');
    for (const p of ['radius', 'tacacs+'] as const) {
      const key = this.globalKeys[p];
      if (key) out.push(`${p === 'radius' ? 'radius' : 'tacacs'}-server key ${key}`);
    }
    for (const s of this.servers.values()) {
      if (s.legacy) {
        const ports = s.protocol === 'radius' ? ` auth-port ${s.authPort} acct-port ${s.acctPort}` : '';
        out.push(`${s.protocol === 'radius' ? 'radius' : 'tacacs'}-server host ${s.address}${ports}${s.key ? ` key ${s.key}` : ''}`);
        continue;
      }
      out.push(s.protocol === 'radius' ? `radius server ${s.name}` : `tacacs server ${s.name}`);
      if (s.address) out.push(s.protocol === 'radius' ? ` address ipv4 ${s.address} auth-port ${s.authPort} acct-port ${s.acctPort}` : ` address ipv4 ${s.address}`);
      if (s.key) out.push(` key ${s.key}`);
      out.push('!');
    }
    return out;
  }
}
