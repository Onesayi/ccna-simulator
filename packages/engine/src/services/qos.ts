import type { IpPacket } from '../core/frames';
import type { Interface } from '../devices/device';
import { dscpName } from './dscp';

/** One `match` line in a class map. */
export type ClassMatch =
  | { kind: 'any' }
  | { kind: 'dscp'; values: number[] }
  | { kind: 'precedence'; values: number[] }
  | { kind: 'access-group'; acl: string }
  | { kind: 'protocol'; protocol: string };

export interface ClassMap {
  name: string;
  /** `match-all` (every line must match) or `match-any`. IOS defaults to match-all. */
  matchAll: boolean;
  matches: ClassMatch[];
}

export interface Rate {
  kbps?: number;
  percent?: number;
}

/** What a policy map does to one class of traffic. */
export interface PolicyClass {
  name: string;
  setDscp?: number;
  priority?: Rate;
  bandwidth?: Rate & { remaining?: boolean };
  /** Single-rate policer in bits per second; exceeding traffic is dropped or re-marked. */
  police?: { cir: number; exceed: 'drop' | 'transmit' | { dscp: number } };
  /** `shape average <bps>`: stored and shown; the simulator has no queues to delay traffic. */
  shape?: number;
  fairQueue?: boolean;
}

export interface PolicyMap {
  name: string;
  /** In order; `class-default` is always evaluated last whether listed or not. */
  classes: PolicyClass[];
}

interface ClassCounters {
  packets: number;
  bytes: number;
  conformed: number;
  exceeded: number;
  /** Policer token bucket, in bytes, and when it was last refilled. */
  tokens?: number;
  refilledAt?: number;
}

export interface QosHooks {
  aclPermits(acl: string, p: IpPacket): boolean | undefined;
  now(): number;
}

export const CLASS_DEFAULT = 'class-default';

/** Approximate sizes, used for byte counters and policing: IOS pings are 100 bytes. */
export function packetBytes(p: IpPacket): number {
  if (p.kind === 'icmp') return 100;
  if (p.kind === 'tcp') return 40 + (p.transfer?.data?.length ?? 0);
  if (p.kind === 'udp') return 28 + (p.tftp?.data?.length ?? 0) + 64;
  return 64;
}

/** Protocols `match protocol` recognises (a small slice of NBAR). */
const PROTOCOLS: Record<string, (p: IpPacket) => boolean> = {
  icmp: (p) => p.kind === 'icmp',
  ospf: (p) => p.kind === 'ospf',
  http: (p) => p.kind === 'tcp' && (p.dstPort === 80 || p.srcPort === 80),
  'secure-http': (p) => p.kind === 'tcp' && (p.dstPort === 443 || p.srcPort === 443),
  ssh: (p) => p.kind === 'tcp' && (p.dstPort === 22 || p.srcPort === 22),
  telnet: (p) => p.kind === 'tcp' && (p.dstPort === 23 || p.srcPort === 23),
  ftp: (p) => p.kind === 'tcp' && (p.dstPort === 21 || p.srcPort === 21),
  tftp: (p) => p.kind === 'udp' && (p.dstPort === 69 || p.srcPort === 69),
  dns: (p) => p.kind === 'udp' && (p.dstPort === 53 || p.srcPort === 53),
  ntp: (p) => p.kind === 'udp' && (p.dstPort === 123 || p.srcPort === 123),
  snmp: (p) => p.kind === 'udp' && [161, 162].includes(p.dstPort),
  rtp: (p) => p.kind === 'udp' && p.dstPort >= 16384 && p.dstPort <= 32767,
};
export const QOS_PROTOCOLS = Object.keys(PROTOCOLS);

/**
 * Modular QoS CLI on a router: class maps classify packets (by DSCP, IP precedence, an ACL or a
 * protocol), policy maps mark them (`set dscp`), police them, and describe how the output queue
 * should share the link (`priority`, `bandwidth`, `fair-queue`, `shape`). A service policy runs on
 * packets entering or leaving an interface. Links in the simulator never congest, so the queuing
 * settings are validated and shown but do not change delivery.
 */
export class Qos {
  readonly classMaps = new Map<string, ClassMap>();
  readonly policyMaps = new Map<string, PolicyMap>();
  private readonly counters = new Map<string, ClassCounters>();

  constructor(private readonly hooks: QosHooks) {}

  private matches(m: ClassMatch, p: IpPacket): boolean {
    switch (m.kind) {
      case 'any':
        return true;
      case 'dscp':
        return m.values.includes(p.dscp ?? 0);
      case 'precedence':
        return m.values.includes((p.dscp ?? 0) >> 3);
      case 'access-group':
        return this.hooks.aclPermits(m.acl, p) ?? false;
      case 'protocol':
        return PROTOCOLS[m.protocol]?.(p) ?? false;
    }
  }

  /** The class a packet falls into under a policy: the first that matches, else class-default. */
  classify(policy: PolicyMap, p: IpPacket): PolicyClass {
    for (const c of policy.classes) {
      if (c.name === CLASS_DEFAULT) continue;
      const cm = this.classMaps.get(c.name);
      if (!cm || !cm.matches.length) continue;
      const hit = cm.matchAll ? cm.matches.every((m) => this.matches(m, p)) : cm.matches.some((m) => this.matches(m, p));
      if (hit) return c;
    }
    return policy.classes.find((c) => c.name === CLASS_DEFAULT) ?? { name: CLASS_DEFAULT };
  }

  counter(iface: Interface, dir: 'input' | 'output', cls: string): ClassCounters {
    const key = `${iface.name}|${dir}|${cls}`;
    let c = this.counters.get(key);
    if (!c) {
      c = { packets: 0, bytes: 0, conformed: 0, exceeded: 0 };
      this.counters.set(key, c);
    }
    return c;
  }

  /**
   * Runs the interface's service policy for one direction on a packet. Returns the packet, possibly
   * re-marked, or `undefined` when a policer drops it.
   */
  apply(iface: Interface, dir: 'input' | 'output', p: IpPacket): IpPacket | undefined {
    const name = iface.servicePolicy?.[dir];
    const policy = name ? this.policyMaps.get(name) : undefined;
    if (!policy) return p;
    const cls = this.classify(policy, p);
    const c = this.counter(iface, dir, cls.name);
    const bytes = packetBytes(p);
    c.packets++;
    c.bytes += bytes;
    let out = cls.setDscp !== undefined ? { ...p, dscp: cls.setDscp } : p;
    if (cls.police) {
      // Single token bucket: refills at CIR, holding at most Bc = CIR/32 bytes (at least 1500), as IOS sizes it.
      const bc = Math.max(1500, cls.police.cir / 8 / 32);
      const now = this.hooks.now();
      c.tokens = Math.min(bc, (c.tokens ?? bc) + ((now - (c.refilledAt ?? now)) / 1000) * (cls.police.cir / 8));
      c.refilledAt = now;
      if (c.tokens >= bytes) {
        c.tokens -= bytes;
        c.conformed++;
      } else {
        c.exceeded++;
        const exceed = cls.police.exceed;
        if (exceed === 'drop') return undefined;
        if (exceed !== 'transmit') out = { ...out, dscp: exceed.dscp };
      }
    }
    return out;
  }

  /** Kbps a class reserves on a link of `linkKbps`, for the admission check. */
  static reserved(c: PolicyClass, linkKbps: number): number {
    const r = c.priority ?? (c.bandwidth?.remaining ? undefined : c.bandwidth);
    if (!r) return 0;
    return r.kbps ?? ((r.percent ?? 0) * linkKbps) / 100;
  }

  /**
   * IOS refuses an output policy whose priority and bandwidth reservations add up to more than
   * the interface bandwidth, and queuing actions on input. Returns the error, or undefined.
   */
  admission(policy: PolicyMap, iface: Interface, dir: 'input' | 'output', linkKbps: number): string | undefined {
    if (dir === 'input') {
      const queued = policy.classes.find((c) => c.priority || c.bandwidth || c.fairQueue || c.shape);
      return queued ? `Queueing (priority, bandwidth, fair-queue, shape) is not supported in the input direction (class ${queued.name})` : undefined;
    }
    let used = 0;
    for (const c of policy.classes) {
      const want = Qos.reserved(c, linkKbps);
      if (used + want > linkKbps) return `I/f ${iface.name} class ${c.name} requested bandwidth ${want} (kbps), available only ${linkKbps - used} (kbps)`;
      used += want;
    }
    return undefined;
  }

  /** The policy maps that use a class map. */
  usedBy(className: string): string[] {
    return [...this.policyMaps.values()].filter((p) => p.classes.some((c) => c.name === className)).map((p) => p.name);
  }

  clearCounters(): void {
    this.counters.clear();
  }

  config(): string[] {
    const out: string[] = [];
    for (const cm of this.classMaps.values()) {
      out.push(`class-map match-${cm.matchAll ? 'all' : 'any'} ${cm.name}`, ...cm.matches.map((m) => ` match ${formatMatch(m)}`), '!');
    }
    for (const pm of this.policyMaps.values()) {
      out.push(`policy-map ${pm.name}`);
      for (const c of pm.classes) out.push(` class ${c.name}`, ...actionLines(c).map((l) => `  ${l}`));
      out.push('!');
    }
    return out;
  }
}

export function formatMatch(m: ClassMatch): string {
  switch (m.kind) {
    case 'any':
      return 'any';
    case 'dscp':
      return `dscp ${m.values.map(dscpName).join(' ')}`;
    case 'precedence':
      return `ip precedence ${m.values.join(' ')}`;
    case 'access-group':
      return /^\d+$/.test(m.acl) ? `access-group ${m.acl}` : `access-group name ${m.acl}`;
    case 'protocol':
      return `protocol ${m.protocol}`;
  }
}

function rate(r: Rate & { remaining?: boolean }): string {
  return r.percent !== undefined ? `${r.remaining ? 'remaining ' : ''}percent ${r.percent}` : String(r.kbps);
}

/** The commands under `class <name>` in a policy map, as the running config shows them. */
export function actionLines(c: PolicyClass): string[] {
  const out: string[] = [];
  if (c.priority) out.push(`priority ${rate(c.priority)}`);
  if (c.bandwidth) out.push(`bandwidth ${rate(c.bandwidth)}`);
  if (c.shape !== undefined) out.push(`shape average ${c.shape}`);
  if (c.police) {
    const ex = c.police.exceed;
    out.push(`police ${c.police.cir} conform-action transmit exceed-action ${ex === 'drop' ? 'drop' : ex === 'transmit' ? 'transmit' : `set-dscp-transmit ${dscpName(ex.dscp)}`}`);
  }
  if (c.setDscp !== undefined) out.push(`set dscp ${dscpName(c.setDscp)}`);
  if (c.fairQueue) out.push('fair-queue');
  return out;
}

// ---------------------------------------------------------------- show commands

function matchLine(m: ClassMatch): string {
  if (m.kind === 'dscp') return `dscp ${m.values.map((v) => `${dscpName(v)} (${v})`).join(' ')}`;
  return formatMatch(m);
}

export function showClassMap(q: Qos): string {
  const out: string[] = [];
  let id = 1;
  for (const cm of q.classMaps.values()) {
    out.push(` Class Map match-${cm.matchAll ? 'all' : 'any'} ${cm.name} (id ${id++})`, ...(cm.matches.length ? cm.matches.map((m) => `   Match ${matchLine(m)}`) : ['   Match none']), '');
  }
  out.push(` Class Map match-any ${CLASS_DEFAULT} (id 0)`, '   Match any', '');
  return out.join('\n');
}

export function showPolicyMap(q: Qos, name?: string): string {
  const maps = name ? [q.policyMaps.get(name)].filter((p) => p !== undefined) : [...q.policyMaps.values()];
  if (name && !maps.length) throw new Error(`Policy map ${name} not configured`);
  const out: string[] = [];
  for (const pm of maps) {
    out.push(`  Policy Map ${pm.name}`);
    for (const c of pm.classes) out.push(`    Class ${c.name}`, ...actionLines(c).map((l) => `      ${l}`));
    out.push('');
  }
  return out.join('\n');
}

export function showPolicyMapInterface(q: Qos, ifaces: Interface[], linkKbps: (i: Interface) => number): string {
  const out: string[] = [];
  for (const i of ifaces) {
    const dirs = (['input', 'output'] as const).filter((d) => i.servicePolicy?.[d]);
    if (!dirs.length) continue;
    out.push(` ${i.name}`, '');
    for (const dir of dirs) {
      const pm = q.policyMaps.get(i.servicePolicy![dir]!);
      out.push(`  Service-policy ${dir}: ${i.servicePolicy![dir]}`, '');
      if (!pm) continue;
      const classes = pm.classes.some((c) => c.name === CLASS_DEFAULT) ? pm.classes : [...pm.classes, { name: CLASS_DEFAULT }];
      for (const c of classes) {
        const cm = q.classMaps.get(c.name);
        const k = q.counter(i, dir, c.name);
        out.push(
          `    Class-map: ${c.name} (match-${cm?.matchAll ? 'all' : 'any'})`,
          `      ${k.packets} packets, ${k.bytes} bytes`,
          '      5 minute offered rate 0000 bps, drop rate 0000 bps',
          ...(c.name === CLASS_DEFAULT ? ['      Match: any'] : (cm?.matches ?? []).map((m) => `      Match: ${matchLine(m)}`)),
        );
        if (c.priority) {
          const kbps = Qos.reserved(c, linkKbps(i));
          out.push('      Priority: Strict, b/w exceed drops: 0', '', `      Priority Level: 1`, `      Priority: ${c.priority.percent !== undefined ? `${c.priority.percent}% (${kbps} kbps)` : `${kbps} (kbps)`}, burst bytes ${Math.round(kbps * 25)}`);
        }
        if (c.bandwidth) out.push('      Queueing', `      bandwidth ${rate(c.bandwidth)}${c.bandwidth.remaining ? '' : ` (${Qos.reserved(c, linkKbps(i))} kbps)`}`);
        if (c.fairQueue) out.push('      Queueing', '      Flow Based Fair Queueing');
        if (c.shape !== undefined) out.push(`      Shape average ${c.shape} bps`);
        if (c.police) {
          const ex = c.police.exceed;
          out.push(
            `      police:`,
            `          cir ${c.police.cir} bps, bc ${Math.max(1500, Math.round(c.police.cir / 8 / 32))} bytes`,
            `        conformed ${k.conformed} packets; actions:`,
            '          transmit',
            `        exceeded ${k.exceeded} packets; actions:`,
            `          ${ex === 'drop' ? 'drop' : ex === 'transmit' ? 'transmit' : `set-dscp-transmit ${dscpName(ex.dscp)}`}`,
          );
        }
        if (c.setDscp !== undefined) out.push('      QoS Set', `        dscp ${dscpName(c.setDscp)}`, `          Packets marked ${k.packets}`);
        out.push('');
      }
    }
  }
  return out.join('\n');
}

/** For `show policy-map interface` on interfaces that have no policy. */
export function interfacesWithPolicy(ifaces: Interface[]): Interface[] {
  return ifaces.filter((i) => i.servicePolicy?.input || i.servicePolicy?.output);
}
