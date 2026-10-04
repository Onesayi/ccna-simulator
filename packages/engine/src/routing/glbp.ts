import { ipToInt, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { GlbpForwarder, GlbpMessage } from '../core/frames';
import { shortName, type GlbpGroupConfig, type Interface } from '../devices/device';

export type GlbpState = 'Init' | 'Listen' | 'Standby' | 'Active';

export const GLBP_DEFAULT_PRIORITY = 100;
export const GLBP_DEFAULT_WEIGHTING = 100;
/** A group has at most four virtual forwarders (four virtual MACs). */
export const GLBP_MAX_FORWARDERS = 4;

interface Peer {
  ip: Ipv4Address;
  priority: number;
  state: GlbpMessage['state'];
  weighting: number;
  vip?: Ipv4Address;
  forwarders?: GlbpForwarder[];
}

/** One GLBP group on one interface, as this router sees it. */
export interface GlbpGroupStatus {
  iface: Interface;
  config: GlbpGroupConfig;
  /** This router's role in the active virtual gateway (AVG) election. */
  state: GlbpState;
  active?: string;
  standby?: string;
  standbyPriority?: number;
  learnedVip?: Ipv4Address;
  /** The forwarder table: the AVG's own, or the last one it advertised. */
  forwarders: GlbpForwarder[];
  /** Forwarder states last round, to log changes. */
  fwdStates: Map<number, 'Active' | 'Listen'>;
  changes: number;
  lastChange: number;
  heard: Map<Ipv4Address, Peer>;
  /** Next forwarder to hand out (round robin), and how many ARP replies each got (weighted). */
  cursor: number;
  handedOut: Map<number, number>;
}

export interface GlbpHooks {
  interfaces: Interface[];
  log: string[];
  now(): number;
  send(iface: Interface, msg: GlbpMessage, srcMac: MacAddress): void;
}

/** GLBP virtual MACs are 0007.b400.XXYY: XX is the group, YY the forwarder number. */
export function glbpVirtualMac(group: number, forwarder: number): MacAddress {
  const g = group.toString(16).padStart(4, '0');
  return `0007.b4${g.slice(0, 2)}.${g.slice(2)}${forwarder.toString(16).padStart(2, '0')}`;
}

const WIRE_STATE: Record<GlbpState, GlbpMessage['state']> = { Init: 'speak', Listen: 'speak', Standby: 'standby', Active: 'active' };

/**
 * GLBP for one router. Members elect an active virtual gateway (AVG) the way HSRP elects its
 * active router: highest priority, then highest address, with preemption off by default. The AVG
 * gives each member (up to four) a virtual MAC to forward for, which makes it an active virtual
 * forwarder (AVF), and answers every ARP request for the virtual IP with one of those MACs in
 * turn, so hosts spread across all the gateways. When a member goes quiet the AVG takes its
 * forwarder over; the member gets it back when it returns.
 */
export class Glbp {
  private readonly status = new Map<string, GlbpGroupStatus>();

  constructor(private readonly hooks: GlbpHooks) {}

  groups(): GlbpGroupStatus[] {
    const live = new Set<string>();
    const out: GlbpGroupStatus[] = [];
    for (const iface of this.hooks.interfaces) {
      for (const config of iface.glbp ?? []) {
        const key = `${iface.name}|${config.group}`;
        live.add(key);
        let st = this.status.get(key);
        if (!st || st.iface !== iface) {
          st = { iface, config, state: 'Init', forwarders: [], fwdStates: new Map(), changes: 0, lastChange: this.hooks.now(), heard: new Map(), cursor: 0, handedOut: new Map() };
          this.status.set(key, st);
        }
        st.config = config;
        out.push(st);
      }
    }
    for (const key of [...this.status.keys()]) if (!live.has(key)) this.status.delete(key);
    return out;
  }

  vip(st: GlbpGroupStatus): Ipv4Address | undefined {
    return st.config.vip ?? st.learnedVip;
  }

  /** Forwarders this router answers for right now. */
  owned(st: GlbpGroupStatus): GlbpForwarder[] {
    const me = st.iface.ip?.address;
    return st.iface.isUp && me ? st.forwarders.filter((f) => f.owner === me) : [];
  }

  tick(): void {
    for (const st of this.groups()) {
      st.heard.clear();
      if (!st.iface.isUp || !st.iface.ip) continue;
      const msg: GlbpMessage = {
        group: st.config.group,
        priority: st.config.priority,
        state: WIRE_STATE[st.state],
        weighting: st.config.weighting,
        vip: this.vip(st),
        forwarders: st.state === 'Active' ? st.forwarders.map((f) => ({ ...f })) : undefined,
      };
      // Each forwarder's hello leaves from its virtual MAC, which keeps switch MAC tables pointing at its owner.
      const owned = this.owned(st);
      if (!owned.length) this.hooks.send(st.iface, msg, st.iface.mac);
      for (const f of owned) this.hooks.send(st.iface, msg, glbpVirtualMac(st.config.group, f.number));
    }
  }

  receive(iface: Interface, msg: GlbpMessage, src: Ipv4Address): void {
    const st = this.groups().find((g) => g.iface === iface && g.config.group === msg.group);
    st?.heard.set(src, { ip: src, priority: msg.priority, state: msg.state, weighting: msg.weighting, vip: msg.vip, forwarders: msg.forwarders });
  }

  settle(): boolean {
    let changed = false;
    for (const st of this.groups()) {
      const next = this.elect(st);
      if (next !== st.state) {
        if (next !== 'Listen' && !(next === 'Init' && st.state === 'Listen')) {
          const from = st.state === 'Init' || st.state === 'Listen' ? 'Speak' : st.state;
          this.hooks.log.push(`%GLBP-6-STATECHANGE: ${st.iface.name} Grp ${st.config.group} state ${from} -> ${next}`);
        }
        st.state = next;
        st.changes++;
        st.lastChange = this.hooks.now();
        changed = true;
      }
      changed = this.assign(st) || changed;
      changed = this.logForwarders(st) || changed;
    }
    return changed;
  }

  private elect(st: GlbpGroupStatus): GlbpState {
    const ip = st.iface.ip;
    if (!st.iface.isUp || !ip) {
      st.active = st.standby = undefined;
      return 'Init';
    }
    const me: Peer = { ip: ip.address, priority: st.config.priority, state: WIRE_STATE[st.state], weighting: st.config.weighting };
    const outranks = (a: Peer, b: Peer) => a.priority > b.priority || (a.priority === b.priority && ipToInt(a.ip) > ipToInt(b.ip));
    const peers = [...st.heard.values()];
    const bestActive = peers.filter((p) => p.state === 'active').sort((a, b) => (outranks(a, b) ? -1 : 1))[0];
    const others = peers.filter((p) => p.state !== 'active');
    if (bestActive?.vip && !st.config.vip) st.learnedVip = bestActive.vip;
    if (!this.vip(st) || st.state === 'Init') {
      st.active = bestActive?.ip;
      return 'Listen';
    }
    const backup = (): GlbpState => (others.every((p) => outranks(me, p)) ? 'Standby' : 'Listen');
    let next: GlbpState;
    if (st.state === 'Active') next = bestActive && outranks(bestActive, me) ? backup() : 'Active';
    else if (!bestActive) next = others.every((p) => outranks(me, p)) ? 'Active' : backup();
    else next = st.config.preempt && outranks(me, bestActive) ? 'Active' : backup();

    st.active = next === 'Active' ? 'local' : bestActive?.ip;
    const standbyPeer = others.filter((p) => p.state === 'standby').sort((a, b) => (outranks(a, b) ? -1 : 1))[0];
    if (next === 'Standby') {
      st.standby = 'local';
      st.standbyPriority = me.priority;
    } else {
      st.standby = standbyPeer?.ip;
      st.standbyPriority = standbyPeer?.priority;
    }
    return next;
  }

  /**
   * The AVG keeps the forwarder table: every member it hears gets one forwarder (up to four), a
   * forwarder whose owner went quiet moves to the AVG, and returns to its primary when that comes
   * back. Everyone else copies the table from the AVG's hellos. Returns true when it changed.
   */
  private assign(st: GlbpGroupStatus): boolean {
    const before = JSON.stringify(st.forwarders);
    const me = st.iface.ip?.address;
    if (st.state === 'Active' && me) {
      const alive = new Set([me, ...st.heard.keys()]);
      const table = st.forwarders.map((f) => ({ ...f, owner: alive.has(f.primary) ? f.primary : alive.has(f.owner) ? f.owner : me }));
      const members = [me, ...[...st.heard.keys()].sort((a, b) => ipToInt(a) - ipToInt(b))];
      for (const m of members) {
        if (table.length >= GLBP_MAX_FORWARDERS || table.some((f) => f.primary === m)) continue;
        const number = [1, 2, 3, 4].find((n) => !table.some((f) => f.number === n))!;
        table.push({ number, primary: m, owner: m });
      }
      st.forwarders = table.sort((a, b) => a.number - b.number);
    } else if (st.state !== 'Init') {
      const avg = [...st.heard.values()].find((p) => p.state === 'active' && p.forwarders);
      if (avg) st.forwarders = avg.forwarders!.map((f) => ({ ...f }));
    } else {
      st.forwarders = [];
    }
    return JSON.stringify(st.forwarders) !== before;
  }

  private logForwarders(st: GlbpGroupStatus): boolean {
    let changed = false;
    const owned = new Set(this.owned(st).map((f) => f.number));
    const seen = new Set<number>();
    for (const f of st.forwarders) {
      seen.add(f.number);
      const now = owned.has(f.number) ? 'Active' : 'Listen';
      const was = st.fwdStates.get(f.number) ?? 'Listen';
      if (now !== was) {
        this.hooks.log.push(`%GLBP-6-FWDSTATECHANGE: ${st.iface.name} Grp ${st.config.group} Fwd ${f.number} state ${was} -> ${now}`);
        changed = true;
      }
      st.fwdStates.set(f.number, now);
    }
    for (const n of [...st.fwdStates.keys()]) if (!seen.has(n)) st.fwdStates.delete(n);
    return changed;
  }

  /**
   * The AVG's answer to an ARP request for the virtual IP: one of the forwarders' MACs, chosen by
   * the load-balancing method. `requester` is the asking host's MAC; without it (an ARP reply,
   * not a request) any forwarder MAC will do and the rotation does not move.
   */
  activeMacFor(iface: Interface, vip: Ipv4Address, requester?: MacAddress): MacAddress | undefined {
    const st = this.groups().find((g) => g.iface === iface && g.state === 'Active' && this.vip(g) === vip);
    if (!st || !st.forwarders.length) return undefined;
    const fwd = requester ? this.pick(st, requester) : st.forwarders[0]!;
    return glbpVirtualMac(st.config.group, fwd.number);
  }

  private pick(st: GlbpGroupStatus, requester: MacAddress): GlbpForwarder {
    const list = st.forwarders;
    let chosen: GlbpForwarder;
    if (st.config.loadBalancing === 'host-dependent') {
      chosen = list[parseInt(requester.replace(/\./g, '').slice(-4), 16) % list.length]!;
    } else if (st.config.loadBalancing === 'weighted') {
      const weight = (f: GlbpForwarder) => (f.owner === st.iface.ip?.address ? st.config.weighting : (st.heard.get(f.owner)?.weighting ?? GLBP_DEFAULT_WEIGHTING)) || 1;
      chosen = [...list].sort((a, b) => (st.handedOut.get(a.number) ?? 0) / weight(a) - (st.handedOut.get(b.number) ?? 0) / weight(b))[0]!;
    } else {
      chosen = list[st.cursor++ % list.length]!;
    }
    st.handedOut.set(chosen.number, (st.handedOut.get(chosen.number) ?? 0) + 1);
    return chosen;
  }

  ownsMac(iface: Interface, mac: MacAddress): boolean {
    return this.groups().some((g) => g.iface === iface && this.owned(g).some((f) => glbpVirtualMac(g.config.group, f.number) === mac));
  }

  ownsVip(ip: Ipv4Address): boolean {
    return this.groups().some((g) => g.iface.isUp && this.vip(g) === ip && (g.state === 'Active' || this.owned(g).length > 0));
  }
}

// ---------------------------------------------------------------- show glbp

function who(addr: string | undefined): string {
  return addr ?? 'unknown';
}

export function showGlbpBrief(g: Glbp): string {
  const rows: string[] = [];
  for (const st of g.groups()) {
    const name = shortName(st.iface.name).padEnd(12);
    const grp = String(st.config.group).padEnd(5);
    rows.push(`${name}${grp}${'-'.padEnd(4)}${String(st.config.priority).padEnd(4)}${st.state.padEnd(9)}${(g.vip(st) ?? 'unknown').padEnd(16)}${who(st.active).padEnd(16)}${who(st.standby)}`);
    const me = st.iface.ip?.address;
    for (const f of st.forwarders) {
      const owner = f.owner === me ? 'local' : f.owner;
      const state = f.owner === me && st.iface.isUp ? 'Active' : 'Listen';
      rows.push(`${name}${grp}${String(f.number).padEnd(4)}${'-'.padEnd(4)}${state.padEnd(9)}${glbpVirtualMac(st.config.group, f.number).padEnd(16)}${owner.padEnd(16)}-`);
    }
  }
  return ['Interface   Grp  Fwd Pri State    Address         Active router   Standby router', ...rows].join('\n');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export function showGlbp(g: Glbp, now: number): string {
  const out: string[] = [];
  for (const st of g.groups()) {
    const me = st.iface.ip?.address;
    const members = [...new Set([...(me ? [me] : []), ...st.heard.keys()])].sort((a, b) => ipToInt(a) - ipToInt(b));
    const active = st.forwarders.filter((f) => f.owner === me && st.iface.isUp).length;
    out.push(
      `${st.iface.name} - Group ${st.config.group}`,
      `  State is ${st.state}`,
      `    ${st.changes} state change${st.changes === 1 ? '' : 's'}, last state change ${ago(now - st.lastChange)}`,
      `  Virtual IP address is ${g.vip(st) ?? 'unknown'}`,
      '  Hello time 3 sec, hold time 10 sec',
      '  Redirect time 600 sec, forwarder time-out 14400 sec',
      `  Preemption ${st.config.preempt ? 'enabled, min delay 0 sec' : 'disabled'}`,
      `  Active is ${who(st.active)}`,
      `  Standby is ${st.standby === 'local' ? 'local' : st.standby ? `${st.standby}, priority ${st.standbyPriority}` : 'unknown'}`,
      `  Priority ${st.config.priority} (${st.config.priority === GLBP_DEFAULT_PRIORITY ? 'default' : 'configured'})`,
      `  Weighting ${st.config.weighting} (${st.config.weighting === GLBP_DEFAULT_WEIGHTING ? 'default 100' : 'configured'}), thresholds: lower 1, upper ${st.config.weighting}`,
      `  Load balancing: ${st.config.loadBalancing}`,
      '  Group members:',
      ...members.map((m) => `    ${m}${m === me ? ' (local)' : ''}`),
      `  There ${st.forwarders.length === 1 ? 'is 1 forwarder' : `are ${st.forwarders.length} forwarders`} (${active} active)`,
    );
    for (const f of st.forwarders) {
      const mine = f.owner === me && st.iface.isUp;
      out.push(
        `  Forwarder ${f.number}`,
        `    State is ${mine ? 'Active' : 'Listen'}`,
        `    MAC address is ${glbpVirtualMac(st.config.group, f.number)} (${f.primary === me ? 'default' : 'learnt'})`,
        `    Owner ID is ${f.primary}`,
        '    Preemption enabled, min delay 30 sec',
        `    Active is ${mine ? 'local' : f.owner}${f.owner === f.primary ? '' : ' (secondary)'}`,
      );
    }
  }
  return out.join('\n');
}
