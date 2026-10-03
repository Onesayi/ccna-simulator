import { ipToInt, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { HsrpMessage } from '../core/frames';
import { shortName, type HsrpGroupConfig, type Interface } from '../devices/device';

export type HsrpState = 'Init' | 'Listen' | 'Standby' | 'Active';

interface Peer {
  ip: Ipv4Address;
  priority: number;
  state: HsrpMessage['state'];
  vip?: Ipv4Address;
}

/** One HSRP group on one interface, as this router sees it. */
export interface HsrpGroupStatus {
  iface: Interface;
  config: HsrpGroupConfig;
  state: HsrpState;
  /** `local`, or the address of the active (or standby) router heard on the segment. */
  active?: string;
  standby?: string;
  standbyPriority?: number;
  /** Learned from the active router's hellos when no virtual IP is configured here. */
  learnedVip?: Ipv4Address;
  changes: number;
  lastChange: number;
  heard: Map<Ipv4Address, Peer>;
  /** Virtual IPs we already complained about, so the log is not flooded every round. */
  warned?: Ipv4Address;
}

export interface HsrpHooks {
  interfaces: Interface[];
  log: string[];
  now(): number;
  findIface(name: string): Interface | undefined;
  send(iface: Interface, msg: HsrpMessage, srcMac: MacAddress): void;
}

export const HSRP_DEFAULT_PRIORITY = 100;

/** Version 1 uses 0000.0c07.acXX (groups 0-255); version 2 uses 0000.0c9f.fXXX (groups 0-4095). */
export function hsrpVirtualMac(version: 1 | 2, group: number): MacAddress {
  if (version === 1) return `0000.0c07.ac${group.toString(16).padStart(2, '0')}`;
  return `0000.0c9f.f${group.toString(16).padStart(3, '0')}`;
}

const WIRE_STATE: Record<HsrpState, HsrpMessage['state']> = { Init: 'speak', Listen: 'speak', Standby: 'standby', Active: 'active' };

/**
 * HSRP for one router. Each round every group sends a hello; `settle` then elects from what was
 * heard: an active router stays active until one with a better priority (then higher address)
 * preempts it or it stops being heard, and the best of the rest is standby. The active router
 * owns the virtual IP and MAC, so it answers ARP for the gateway and sources its hellos from the
 * virtual MAC, which keeps switch MAC tables pointing at it.
 */
export class Hsrp {
  private readonly status = new Map<string, HsrpGroupStatus>();

  constructor(private readonly hooks: HsrpHooks) {}

  /** Every configured group, in interface order. Groups removed from the config are forgotten. */
  groups(): HsrpGroupStatus[] {
    const live = new Set<string>();
    const out: HsrpGroupStatus[] = [];
    for (const iface of this.hooks.interfaces) {
      for (const config of iface.hsrp?.groups ?? []) {
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

  /** Priority after interface tracking: each tracked interface that is down takes its decrement off. */
  priority(st: HsrpGroupStatus): number {
    const down = st.config.tracks.filter((t) => !this.trackUp(t.iface));
    return Math.max(0, st.config.priority - down.reduce((n, t) => n + t.decrement, 0));
  }

  /** Whether a tracked interface is up right now. */
  trackUp(name: string): boolean {
    return this.hooks.findIface(name)?.isUp ?? false;
  }

  vip(st: HsrpGroupStatus): Ipv4Address | undefined {
    return st.config.vip ?? st.learnedVip;
  }

  virtualMac(st: HsrpGroupStatus): MacAddress {
    return hsrpVirtualMac(st.iface.hsrp?.version ?? 1, st.config.group);
  }

  tick(): void {
    for (const st of this.groups()) {
      st.heard.clear();
      if (!st.iface.isUp || !st.iface.ip) continue;
      const msg: HsrpMessage = { version: st.iface.hsrp!.version, group: st.config.group, state: WIRE_STATE[st.state], priority: this.priority(st), vip: this.vip(st) };
      this.hooks.send(st.iface, msg, st.state === 'Active' ? this.virtualMac(st) : st.iface.mac);
    }
  }

  receive(iface: Interface, msg: HsrpMessage, src: Ipv4Address): void {
    if ((iface.hsrp?.version ?? 1) !== msg.version) return;
    const st = this.groups().find((g) => g.iface === iface && g.config.group === msg.group);
    st?.heard.set(src, { ip: src, priority: msg.priority, state: msg.state, vip: msg.vip });
  }

  settle(): boolean {
    let changed = false;
    for (const st of this.groups()) {
      const next = this.elect(st);
      if (next !== st.state) {
        this.logChange(st, st.state, next);
        st.state = next;
        st.changes++;
        st.lastChange = this.hooks.now();
        changed = true;
      }
    }
    return changed;
  }

  private elect(st: HsrpGroupStatus): HsrpState {
    const ip = st.iface.ip;
    if (!st.iface.isUp || !ip) {
      st.active = st.standby = undefined;
      return 'Init';
    }
    const me: Peer = { ip: ip.address, priority: this.priority(st), state: WIRE_STATE[st.state] };
    const outranks = (a: Peer, b: Peer) => a.priority > b.priority || (a.priority === b.priority && ipToInt(a.ip) > ipToInt(b.ip));
    const peers = [...st.heard.values()];
    const actives = peers.filter((p) => p.state === 'active').sort((a, b) => (outranks(a, b) ? -1 : 1));
    const bestActive = actives[0];
    const others = peers.filter((p) => p.state !== 'active');
    if (bestActive?.vip) {
      if (!st.config.vip) st.learnedVip = bestActive.vip;
      else if (bestActive.vip !== st.config.vip && st.warned !== bestActive.vip) {
        st.warned = bestActive.vip;
        this.hooks.log.push(
          `%HSRP-4-DIFFVIP1: ${st.iface.name} Grp ${st.config.group} active routers virtual IP address ${bestActive.vip} is different to the locally configured address ${st.config.vip}`,
        );
      }
    }
    // A group that just came up listens for a round before it may claim a role, as a real router
    // waits out the hold time. That also lets spanning tree open the switch port first.
    if (!this.vip(st) || st.state === 'Init') {
      st.active = bestActive?.ip;
      return 'Listen';
    }
    const backup = (): HsrpState => (others.every((p) => outranks(me, p)) ? 'Standby' : 'Listen');
    let next: HsrpState;
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

  private logChange(st: HsrpGroupStatus, from: HsrpState, to: HsrpState): void {
    const line = (a: string, b: string) => `%HSRP-5-STATECHANGE: ${st.iface.name} Grp ${st.config.group} state ${a} -> ${b}`;
    // A router that comes up alone passes through Speak and Standby on its way to Active, as IOS logs it.
    if (to === 'Listen' || to === 'Init' && from === 'Listen') return;
    if ((from === 'Init' || from === 'Listen') && to === 'Active') this.hooks.log.push(line('Speak', 'Standby'), line('Standby', 'Active'));
    else if ((from === 'Init' || from === 'Listen') && to === 'Standby') this.hooks.log.push(line('Speak', 'Standby'));
    else this.hooks.log.push(line(from, to));
  }

  /** The virtual MAC to answer ARP with, when we are active for `vip` on this interface. */
  activeMacFor(iface: Interface, vip: Ipv4Address): MacAddress | undefined {
    const st = this.groups().find((g) => g.iface === iface && g.state === 'Active' && this.vip(g) === vip);
    return st && this.virtualMac(st);
  }

  /** Virtual MACs this interface receives frames for: those of the groups it is active for. */
  ownsMac(iface: Interface, mac: MacAddress): boolean {
    return this.groups().some((g) => g.iface === iface && g.state === 'Active' && this.virtualMac(g) === mac);
  }

  ownsVip(ip: Ipv4Address): boolean {
    return this.groups().some((g) => g.state === 'Active' && g.iface.isUp && this.vip(g) === ip);
  }
}

// ---------------------------------------------------------------- show standby

function who(addr: string | undefined): string {
  return addr ?? 'unknown';
}

export function showStandbyBrief(h: Hsrp): string {
  const rows = h.groups().map((st) => {
    const p = st.config.preempt ? 'P' : ' ';
    return `${shortName(st.iface.name).padEnd(12)}${String(st.config.group).padEnd(5)}${String(h.priority(st)).padEnd(4)}${p} ${st.state.padEnd(8)}${who(st.active).padEnd(16)}${who(st.standby).padEnd(16)}${h.vip(st) ?? 'unknown'}`;
  });
  return [
    '                     P indicates configured to preempt.',
    '                     |',
    'Interface   Grp  Pri P State   Active          Standby         Virtual IP',
    ...rows,
  ].join('\n');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export function showStandby(h: Hsrp, now: number): string {
  const out: string[] = [];
  for (const st of h.groups()) {
    const version = st.iface.hsrp?.version ?? 1;
    const mac = h.virtualMac(st);
    const prio = h.priority(st);
    out.push(
      `${st.iface.name} - Group ${st.config.group}${version === 2 ? ' (version 2)' : ''}`,
      `  State is ${st.state}`,
      `    ${st.changes} state change${st.changes === 1 ? '' : 's'}, last state change ${ago(now - st.lastChange)}`,
      `  Virtual IP address is ${h.vip(st) ?? 'unknown'}`,
      `  Active virtual MAC address is ${st.active ? mac : 'unknown'}${st.state === 'Active' ? ' (MAC In Use)' : ''}`,
      `    Local virtual MAC address is ${mac} (v${version} default)`,
      '  Hello time 3 sec, hold time 10 sec',
      `  Preemption ${st.config.preempt ? 'enabled' : 'disabled'}`,
      `  Active router is ${st.active === 'local' ? 'local' : st.active ?? 'unknown'}`,
      `  Standby router is ${st.standby === 'local' ? 'local' : st.standby ? `${st.standby}, priority ${st.standbyPriority}` : 'unknown'}`,
      `  Priority ${prio} (configured ${st.config.priority})`,
      ...st.config.tracks.map((t) => `    Track interface ${t.iface} state ${h.trackUp(t.iface) ? 'Up' : 'Down'} decrement ${t.decrement}`),
      `  Group name is "hsrp-${shortName(st.iface.name)}-${st.config.group}" (default)`,
    );
  }
  return out.join('\n');
}
