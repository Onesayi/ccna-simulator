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
  /** `shape average <bps>`: holds the class to this rate, queuing (delaying) the excess instead of dropping it. */
  shape?: number;
  fairQueue?: boolean;
  /** `queue-limit <n> packets`: how deep the class queue may grow before tail drop (IOS default 64). */
  queueLimit?: number;
  /** `random-detect [dscp-based]`: WRED drops early, more for higher drop precedence. */
  randomDetect?: RandomDetect;
  /** `service-policy <child>` inside a class: a hierarchical policy, usually under a parent shaper. */
  child?: string;
}

export interface RandomDetect {
  dscpBased: boolean;
  /** `random-detect dscp|precedence <value> <min> <max> [<denominator>]` overrides, by DSCP or precedence. */
  thresholds: Record<number, WredThreshold>;
}

export interface WredCounters {
  tx: number;
  txBytes: number;
  random: number;
  randomBytes: number;
  tail: number;
  tailBytes: number;
}

export interface WredThreshold {
  min: number;
  max: number;
  /** Mark probability denominator: at the max threshold, one packet in `denom` is dropped. */
  denom: number;
}

/** IOS default class queue depth, in packets. */
export const DEFAULT_QUEUE_LIMIT = 64;

/**
 * WRED thresholds for a DSCP, as IOS sets them by default for a 64-packet queue: higher drop
 * precedence (AFx3) starts dropping earlier than AFx1, EF last of all.
 */
export function wredThreshold(rd: RandomDetect, dscp: number): WredThreshold {
  const key = rd.dscpBased ? dscp : dscp >> 3;
  const custom = rd.thresholds[key];
  if (custom) return custom;
  let min = 20;
  if (!rd.dscpBased) min = 20 + 2 * key;
  else if (dscp === 46) min = 36;
  else if (dscp >= 10 && dscp <= 38 && dscp % 8 !== 0 && dscp % 2 === 0) min = [32, 28, 24][((dscp % 8) >> 1) - 1]!;
  else if (dscp % 8 === 0 && dscp > 0) min = 20 + 2 * (dscp >> 3);
  return { min, max: 40, denom: 10 };
}

export interface PolicyMap {
  name: string;
  /** In order; `class-default` is always evaluated last whether listed or not. */
  classes: PolicyClass[];
}

export interface ClassCounters {
  packets: number;
  bytes: number;
  conformed: number;
  exceeded: number;
  /** Queuing results from traffic generator runs: packets sent and dropped (tail, WRED, LLQ over-rate), queue depth. */
  output?: { packets: number; bytes: number; drops: number; wredDrops: number; priorityDrops: number; depth: number };
  /** Rates over the last traffic generator run, in bps. */
  rates?: { offered: number; drop: number };
  /** WRED counters by DSCP (or precedence), and the mean queue depth it last saw. */
  wred?: Record<number, WredCounters>;
  wredMean?: number;
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
    return policy ? this.applyPolicy(policy, iface, dir, p, '') : p;
  }

  private applyPolicy(policy: PolicyMap, iface: Interface, dir: 'input' | 'output', p: IpPacket, parent: string): IpPacket | undefined {
    const cls = this.classify(policy, p);
    const child = cls.child ? this.policyMaps.get(cls.child) : undefined;
    const key = parent + cls.name;
    // A traffic generator probe only traces the path and markings; the queuing model does the counting.
    if (p.flow !== undefined) {
      const marked = cls.setDscp !== undefined ? { ...p, dscp: cls.setDscp } : p;
      return child ? this.applyPolicy(child, iface, dir, marked, `${key}/`) : marked;
    }
    const c = this.counter(iface, dir, key);
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
    return child ? this.applyPolicy(child, iface, dir, out, `${key}/`) : out;
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
      for (const pm of this.withChildren(policy)) {
        const queued = pm.classes.find((c) => c.priority || c.bandwidth || c.fairQueue || c.shape || c.queueLimit || c.randomDetect);
        if (queued) return `Queueing (priority, bandwidth, fair-queue, shape) is not supported in the input direction (class ${queued.name})`;
      }
      return undefined;
    }
    let used = 0;
    for (const c of policy.classes) {
      const want = Qos.reserved(c, linkKbps);
      if (used + want > linkKbps) return `I/f ${iface.name} class ${c.name} requested bandwidth ${want} (kbps), available only ${linkKbps - used} (kbps)`;
      used += want;
      const child = c.child ? this.policyMaps.get(c.child) : undefined;
      // A child policy shares out whatever its parent class is shaped to (or the whole link).
      const err = child && this.admission(child, iface, dir, c.shape ? c.shape / 1000 : linkKbps);
      if (err) return err;
    }
    return undefined;
  }

  /** A policy and every child policy below it. */
  withChildren(policy: PolicyMap, seen = new Set<string>()): PolicyMap[] {
    if (seen.has(policy.name)) return [];
    seen.add(policy.name);
    const kids = policy.classes.flatMap((c) => (c.child && this.policyMaps.get(c.child) ? this.withChildren(this.policyMaps.get(c.child)!, seen) : []));
    return [policy, ...kids];
  }

  /** The policy maps that use a policy map as a child. */
  parentsOf(policy: string): string[] {
    return [...this.policyMaps.values()].filter((p) => p.classes.some((c) => c.child === policy)).map((p) => p.name);
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
  if (c.queueLimit !== undefined) out.push(`queue-limit ${c.queueLimit} packets`);
  if (c.randomDetect) {
    const rd = c.randomDetect;
    out.push(rd.dscpBased ? 'random-detect dscp-based' : 'random-detect');
    for (const [k, t] of Object.entries(rd.thresholds)) out.push(`random-detect ${rd.dscpBased ? `dscp ${dscpName(Number(k))}` : `precedence ${k}`} ${t.min} ${t.max} ${t.denom}`);
  }
  if (c.child) out.push(`service-policy ${c.child}`);
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
      if (pm) out.push(...policyBlock(q, i, dir, pm, '', 4, linkKbps(i), new Set()));
    }
  }
  return out.join('\n');
}

function policeLines(c: PolicyClass, k: ClassCounters): string[] {
  const p = c.police!;
  const ex = p.exceed;
  return [
    'police:',
    `    cir ${p.cir} bps, bc ${Math.max(1500, Math.round(p.cir / 8 / 32))} bytes`,
    `  conformed ${k.conformed} packets; actions:`,
    '    transmit',
    `  exceeded ${k.exceeded} packets; actions:`,
    `    ${ex === 'drop' ? 'drop' : ex === 'transmit' ? 'transmit' : `set-dscp-transmit ${dscpName(ex.dscp)}`}`,
  ];
}

/** One policy's classes, indented; a child policy nests under its parent class as IOS prints it. */
function policyBlock(q: Qos, i: Interface, dir: 'input' | 'output', pm: PolicyMap, parent: string, indent: number, kbps: number, seen: Set<string>): string[] {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  seen.add(pm.name);
  const classes = pm.classes.some((c) => c.name === CLASS_DEFAULT) ? pm.classes : [...pm.classes, { name: CLASS_DEFAULT }];
  for (const c of classes) {
    const cm = q.classMaps.get(c.name);
    const k = q.counter(i, dir, parent + c.name);
    const child = c.child && !seen.has(c.child) ? q.policyMaps.get(c.child) : undefined;
    const lines = [
      `Class-map: ${c.name} (match-${cm?.matchAll ? 'all' : 'any'})`,
      `  ${k.packets} packets, ${k.bytes} bytes`,
      `  30 second offered rate ${k.rates?.offered ?? 0} bps, drop rate ${k.rates?.drop ?? 0} bps`,
      ...(c.name === CLASS_DEFAULT ? ['  Match: any'] : (cm?.matches ?? []).map((m) => `  Match: ${matchLine(m)}`)),
    ];
    const o = k.output;
    if (c.priority) {
      const reserved = Qos.reserved(c, kbps);
      lines.push(
        '  Priority: Strict, b/w exceed drops: ' + (o?.priorityDrops ?? 0),
        '',
        '  Priority Level: 1',
        `  Priority: ${c.priority.percent !== undefined ? `${c.priority.percent}% (${reserved} kbps)` : `${reserved} (kbps)`}, burst bytes ${Math.round(reserved * 25)}`,
      );
    }
    // Every leaf class of an output policy has its own queue.
    if (dir === 'output' && !child) {
      lines.push(
        '  Queueing',
        `  queue limit ${c.queueLimit ?? DEFAULT_QUEUE_LIMIT} packets`,
        `  (queue depth/total drops/no-buffer drops) ${o?.depth ?? 0}/${o?.drops ?? 0}/0`,
        `  (pkts output/bytes output) ${o?.packets ?? 0}/${o?.bytes ?? 0}`,
      );
      if (c.bandwidth) lines.push(`  bandwidth ${rate(c.bandwidth)}${c.bandwidth.remaining ? '' : ` (${Qos.reserved(c, kbps)} kbps)`}`);
      if (c.fairQueue) lines.push('  Flow Based Fair Queueing');
    }
    if (c.shape !== undefined) lines.push(`  shape (average) cir ${c.shape}, bc ${Math.round(c.shape / 250)}, be ${Math.round(c.shape / 250)}`, `  target shape rate ${c.shape}`);
    if (c.randomDetect) lines.push(...wredLines(c.randomDetect, k));
    if (c.police) lines.push(...policeLines(c, k).map((l) => `  ${l}`));
    if (c.setDscp !== undefined) lines.push('  QoS Set', `    dscp ${dscpName(c.setDscp)}`, `      Packets marked ${k.packets}`);
    out.push(...lines.map((l) => (l ? pad + l : l)));
    if (child) {
      out.push('', `${pad}  Service-policy : ${child.name}`, '');
      out.push(...policyBlock(q, i, dir, child, `${parent}${c.name}/`, indent + 4, c.shape ? c.shape / 1000 : kbps, seen));
    }
    out.push('');
  }
  return out;
}

function wredLines(rd: RandomDetect, k: ClassCounters): string[] {
  const rows = Object.entries(k.wred ?? {}).map(([d, v]) => [Number(d), v] as const);
  const out = [`  Exp-weight-constant: 9 (1/512)`, `  Mean queue depth: ${k.wredMean ?? 0} packets`];
  out.push(`  ${rd.dscpBased ? 'dscp ' : 'class'}     Transmitted      Random drop      Tail drop          Minimum        Maximum     Mark`);
  out.push(`              pkts/bytes       pkts/bytes       pkts/bytes        thresh         thresh     prob`);
  for (const [d, v] of rows.sort((a, b) => a[0] - b[0])) {
    // Counters are kept by DSCP for dscp-based WRED and by IP precedence otherwise.
    const t = wredThreshold(rd, rd.dscpBased ? d : d << 3);
    const label = rd.dscpBased ? dscpName(d) : String(d);
    out.push(`  ${label.padEnd(9)}${`${v.tx}/${v.txBytes}`.padStart(15)}${`${v.random}/${v.randomBytes}`.padStart(17)}${`${v.tail}/${v.tailBytes}`.padStart(15)}${String(t.min).padStart(15)}${String(t.max).padStart(15)}${`1/${t.denom}`.padStart(9)}`);
  }
  return out;
}

/** For `show policy-map interface` on interfaces that have no policy. */
export function interfacesWithPolicy(ifaces: Interface[]): Interface[] {
  return ifaces.filter((i) => i.servicePolicy?.input || i.servicePolicy?.output);
}
