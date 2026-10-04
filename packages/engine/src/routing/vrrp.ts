import { ipToInt, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { VrrpMessage } from '../core/frames';
import { shortName, type Interface, type VrrpGroupConfig } from '../devices/device';

export type VrrpState = 'Init' | 'Backup' | 'Master';

export const VRRP_DEFAULT_PRIORITY = 100;
/** The priority of the router that owns the virtual IP as a real interface address. */
export const VRRP_OWNER_PRIORITY = 255;

/** One VRRP group on one interface, as this router sees it. */
export interface VrrpGroupStatus {
  iface: Interface;
  config: VrrpGroupConfig;
  state: VrrpState;
  /** The master's address and priority, from its last advertisement (or this router). */
  master?: { ip: Ipv4Address; priority: number };
  changes: number;
  lastChange: number;
  /** Advertisements heard this round, by sender. */
  heard: Map<Ipv4Address, VrrpMessage>;
}

export interface VrrpHooks {
  interfaces: Interface[];
  log: string[];
  now(): number;
  send(iface: Interface, msg: VrrpMessage, srcMac: MacAddress): void;
}

/** VRRP uses 0000.5e00.01XX, with the group number (1-255) in the last byte. */
export function vrrpVirtualMac(group: number): MacAddress {
  return `0000.5e00.01${group.toString(16).padStart(2, '0')}`;
}

/**
 * VRRPv2 for one router. Unlike HSRP only the master speaks: it advertises every interval from the
 * virtual MAC, and backups listen. A backup that hears no master in a round takes over; a master
 * that hears a better master steps down; a backup with preemption (the default) takes over from a
 * worse master. The router whose interface address is the virtual IP is the owner: priority 255,
 * always master while it is up.
 */
export class Vrrp {
  private readonly status = new Map<string, VrrpGroupStatus>();

  constructor(private readonly hooks: VrrpHooks) {}

  groups(): VrrpGroupStatus[] {
    const live = new Set<string>();
    const out: VrrpGroupStatus[] = [];
    for (const iface of this.hooks.interfaces) {
      for (const config of iface.vrrp ?? []) {
        const key = `${iface.name}|${config.group}`;
        live.add(key);
        let st = this.status.get(key);
        if (!st || st.iface !== iface) {
          st = { iface, config, state: 'Init', changes: 0, lastChange: this.hooks.now(), heard: new Map() };
          this.status.set(key, st);
        }
        st.config = config;
        out.push(st);
      }
    }
    for (const key of [...this.status.keys()]) if (!live.has(key)) this.status.delete(key);
    return out;
  }

  /** True when this router's interface address is the virtual IP. */
  isOwner(st: VrrpGroupStatus): boolean {
    return st.config.vip !== undefined && st.iface.ip?.address === st.config.vip;
  }

  priority(st: VrrpGroupStatus): number {
    return this.isOwner(st) ? VRRP_OWNER_PRIORITY : st.config.priority;
  }

  tick(): void {
    for (const st of this.groups()) {
      st.heard.clear();
      if (st.state !== 'Master' || !st.iface.isUp || !st.iface.ip || !st.config.vip) continue;
      this.hooks.send(st.iface, { group: st.config.group, priority: this.priority(st), vip: st.config.vip, interval: 1 }, vrrpVirtualMac(st.config.group));
    }
  }

  receive(iface: Interface, msg: VrrpMessage, src: Ipv4Address): void {
    const st = this.groups().find((g) => g.iface === iface && g.config.group === msg.group);
    st?.heard.set(src, msg);
  }

  settle(): boolean {
    let changed = false;
    for (const st of this.groups()) {
      const next = this.elect(st);
      if (next === st.state) continue;
      this.hooks.log.push(`%VRRP-6-STATECHANGE: ${shortName(st.iface.name)} Grp ${st.config.group} state ${st.state} -> ${next}`);
      st.state = next;
      st.changes++;
      st.lastChange = this.hooks.now();
      changed = true;
    }
    return changed;
  }

  private elect(st: VrrpGroupStatus): VrrpState {
    const ip = st.iface.ip;
    if (!st.iface.isUp || !ip || !st.config.vip) {
      st.master = undefined;
      return 'Init';
    }
    const mine = { ip: ip.address, priority: this.priority(st) };
    const better = (a: { ip: string; priority: number }, b: { ip: string; priority: number }) =>
      a.priority > b.priority || (a.priority === b.priority && ipToInt(a.ip) > ipToInt(b.ip));
    const masters = [...st.heard].map(([from, m]) => ({ ip: from, priority: m.priority })).sort((a, b) => (better(a, b) ? -1 : 1));
    const best = masters[0];
    // The owner goes straight to master; anyone else listens for a round first.
    if (st.state === 'Init' && !this.isOwner(st)) {
      st.master = best;
      return 'Backup';
    }
    let next: VrrpState;
    if (!best) next = 'Master';
    else if (st.state === 'Master') next = better(best, mine) ? 'Backup' : 'Master';
    else next = (st.config.preempt || this.isOwner(st)) && better(mine, best) ? 'Master' : 'Backup';
    st.master = next === 'Master' ? mine : best;
    return next;
  }

  /** The virtual MAC to answer ARP with, when we are master for `vip` on this interface. */
  activeMacFor(iface: Interface, vip: Ipv4Address): MacAddress | undefined {
    const st = this.groups().find((g) => g.iface === iface && g.state === 'Master' && g.config.vip === vip);
    return st && vrrpVirtualMac(st.config.group);
  }

  ownsMac(iface: Interface, mac: MacAddress): boolean {
    return this.groups().some((g) => g.iface === iface && g.state === 'Master' && vrrpVirtualMac(g.config.group) === mac);
  }

  ownsVip(ip: Ipv4Address): boolean {
    return this.groups().some((g) => g.state === 'Master' && g.iface.isUp && g.config.vip === ip);
  }
}

// ---------------------------------------------------------------- show vrrp

export function showVrrpBrief(v: Vrrp): string {
  const rows = v.groups().map((st) => {
    const own = v.isOwner(st) ? 'Y' : ' ';
    const pre = st.config.preempt ? 'Y' : ' ';
    const prio = v.priority(st);
    // Master down interval: 3 x advertisement + skew, in milliseconds.
    const time = 3000 + Math.round(((256 - prio) * 1000) / 256);
    return `${shortName(st.iface.name).padEnd(19)}${String(st.config.group).padEnd(4)}${String(prio).padEnd(4)}${String(time).padEnd(6)}${own.padEnd(4)}${pre}  ${st.state.padEnd(8)}${(st.master?.ip ?? 'unknown').padEnd(16)}${st.config.vip ?? 'unknown'}`;
  });
  return ['Interface          Grp Pri Time  Own Pre State   Master addr     Group addr', ...rows].join('\n');
}

export function showVrrp(v: Vrrp): string {
  const out: string[] = [];
  for (const st of v.groups()) {
    const prio = v.priority(st);
    const local = st.master?.ip === st.iface.ip?.address;
    const down = (3 + (256 - prio) / 256).toFixed(3);
    out.push(
      `${st.iface.name} - Group ${st.config.group}${st.config.description ? `\n  ${st.config.description}` : ''}`,
      `  State is ${st.state}`,
      `  Virtual IP address is ${st.config.vip ?? 'unknown'}`,
      `  Virtual MAC address is ${vrrpVirtualMac(st.config.group)}`,
      '  Advertisement interval is 1.000 sec',
      `  Preemption ${st.config.preempt ? 'enabled' : 'disabled'}`,
      `  Priority is ${prio}${v.isOwner(st) ? ' (IP address owner)' : ''}`,
      `  Master Router is ${st.master ? `${st.master.ip}${local ? ' (local)' : ''}, priority is ${st.master.priority}` : 'unknown'}`,
      '  Master Advertisement interval is 1.000 sec',
      `  Master Down interval is ${down} sec`,
    );
  }
  return out.join('\n');
}
