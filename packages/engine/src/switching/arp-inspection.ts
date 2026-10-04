import { ipToInt, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { ArpPacket, Frame } from '../core/frames';
import { shortName, type ErrDisableReason, type Interface } from '../devices/device';

/** `ip arp inspection validate ...`: extra checks on top of the binding lookup. */
export type ArpValidation = 'src-mac' | 'dst-mac' | 'ip';
export const ARP_VALIDATIONS: ArpValidation[] = ['src-mac', 'dst-mac', 'ip'];

/** Untrusted ports accept 15 ARP packets per second unless told otherwise. */
export const DAI_DEFAULT_RATE = 15;

/** One line of an ARP ACL: `permit ip host 10.1.1.5 mac host 0050.7966.6805`. */
export interface ArpAclEntry {
  action: 'permit' | 'deny';
  /** Sender IP: one host, a network with a wildcard mask, or any. */
  ip: { host: Ipv4Address } | { network: Ipv4Address; wildcard: Ipv4Address } | 'any';
  /** Sender MAC: one host, or any. */
  mac: MacAddress | 'any';
}

export interface ArpAcl {
  name: string;
  entries: ArpAclEntry[];
}

/** The counters `show ip arp inspection` prints per VLAN. */
export interface DaiStats {
  forwarded: number;
  dropped: number;
  dhcpDrops: number;
  aclDrops: number;
  dhcpPermits: number;
  aclPermits: number;
  srcMacFailures: number;
  dstMacFailures: number;
  ipFailures: number;
}

export interface DaiBinding {
  mac: MacAddress;
  ip: Ipv4Address;
  vlan: number;
}

/** What the inspection engine needs from its switch. */
export interface DaiHost {
  now(): number;
  readonly log: string[];
  /** DHCP snooping bindings: the table DAI checks sender addresses against. */
  bindings(): DaiBinding[];
  errDisable(port: Interface, reason: ErrDisableReason): void;
  vlanExists(vlan: number): boolean;
}

/**
 * Dynamic ARP Inspection. On untrusted ports in the VLANs it runs on, every ARP message must
 * match an ARP ACL or a DHCP snooping binding (sender MAC and IP), pass the optional validation
 * checks, and arrive within the port's rate limit. Trusted ports skip all of it.
 */
export class ArpInspection {
  readonly vlans = new Set<number>();
  /** Replaced as a whole by each `ip arp inspection validate` command, as IOS does. */
  validate = new Set<ArpValidation>();
  /** `ip arp inspection filter <acl> vlan <list> [static]`. */
  readonly filters = new Map<number, { acl: string; static: boolean }>();
  readonly acls = new Map<string, ArpAcl>();
  readonly stats = new Map<number, DaiStats>();
  /** Arrival times of recent ARP packets per port, for the rate limit. */
  private readonly arrivals = new Map<Interface, number[]>();
  /** When each kind of drop was last logged, so a flood logs once rather than a hundred times. */
  private readonly lastLogged = new Map<string, number>();

  constructor(private readonly host: DaiHost) {}

  enabled(vlan: number): boolean {
    return this.vlans.has(vlan);
  }

  statsFor(vlan: number): DaiStats {
    let s = this.stats.get(vlan);
    if (!s) {
      s = { forwarded: 0, dropped: 0, dhcpDrops: 0, aclDrops: 0, dhcpPermits: 0, aclPermits: 0, srcMacFailures: 0, dstMacFailures: 0, ipFailures: 0 };
      this.stats.set(vlan, s);
    }
    return s;
  }

  clearStatistics(): void {
    this.stats.clear();
  }

  /** Inspects an ARP message that arrived on untrusted `port` in `vlan`. Returns true to forward it. */
  inspect(port: Interface, vlan: number, frame: Frame, arp: ArpPacket): boolean {
    if (!this.withinRate(port)) return false;
    const stats = this.statsFor(vlan);
    const drop = (counter: keyof DaiStats, tag: string) => {
      stats[counter]++;
      stats.dropped++;
      this.logDrop(tag, port, vlan, arp);
      return false;
    };
    const reply = arp.op === 'reply';
    if (this.validate.has('src-mac') && frame.src !== arp.senderMac) return drop('srcMacFailures', 'INVALID_ARP');
    if (this.validate.has('dst-mac') && reply && frame.dst !== arp.targetMac) return drop('dstMacFailures', 'INVALID_ARP');
    if (this.validate.has('ip') && (!hostAddress(arp.senderIp) || (reply && !hostAddress(arp.targetIp)))) return drop('ipFailures', 'INVALID_ARP');

    const filter = this.filters.get(vlan);
    if (filter) {
      const verdict = this.matchAcl(filter.acl, arp);
      if (verdict === 'permit') {
        stats.aclPermits++;
        stats.forwarded++;
        return true;
      }
      if (verdict === 'deny' || filter.static) return drop('aclDrops', 'ACL_DENY');
    }
    if (this.host.bindings().some((b) => b.vlan === vlan && b.mac === arp.senderMac && b.ip === arp.senderIp)) {
      stats.dhcpPermits++;
      stats.forwarded++;
      return true;
    }
    return drop('dhcpDrops', 'DHCP_SNOOPING_DENY');
  }

  /** The first ARP ACL line that matches the sender, if any. A missing ACL matches nothing. */
  private matchAcl(name: string, arp: ArpPacket): 'permit' | 'deny' | undefined {
    for (const e of this.acls.get(name)?.entries ?? []) {
      const ipOk = e.ip === 'any' || ('host' in e.ip ? e.ip.host === arp.senderIp : wildcardMatch(arp.senderIp, e.ip.network, e.ip.wildcard));
      const macOk = e.mac === 'any' || e.mac === arp.senderMac;
      if (ipOk && macOk) return e.action;
    }
    return undefined;
  }

  /** Counts ARP packets in the port's burst interval; too many err-disables the port. */
  private withinRate(port: Interface): boolean {
    const cfg = port.arpInspection;
    if (cfg?.rate === 'none') return true;
    const rate = cfg?.rate ?? DAI_DEFAULT_RATE;
    const windowMs = (cfg?.burst ?? 1) * 1000;
    const now = this.host.now();
    const times = (this.arrivals.get(port) ?? []).filter((t) => now - t < windowMs);
    times.push(now);
    this.arrivals.set(port, times);
    if (times.length <= rate * (cfg?.burst ?? 1)) return true;
    this.arrivals.delete(port);
    this.host.log.push(`%SW_DAI-4-PACKET_RATE_EXCEEDED: ${times.length} packets received in ${windowMs} milliseconds on ${shortName(port.name)}.`);
    this.host.errDisable(port, 'arp-inspection');
    return false;
  }

  private logDrop(tag: string, port: Interface, vlan: number, arp: ArpPacket): void {
    const key = `${tag}|${port.name}|${arp.senderMac}|${arp.senderIp}`;
    const now = this.host.now();
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < 1000) return;
    this.lastLogged.set(key, now);
    const kind = arp.op === 'request' ? 'Req' : 'Res';
    this.host.log.push(`%SW_DAI-4-${tag}: 1 Invalid ARPs (${kind}) on ${shortName(port.name)}, vlan ${vlan}.([${arp.senderMac}/${arp.senderIp}/${arp.targetMac}/${arp.targetIp}])`);
  }

  // ---------------------------------------------------------------- show commands

  /** `show ip arp inspection` (all VLANs it runs on) or `show ip arp inspection vlan <list>`. */
  show(only?: Set<number>): string {
    const vlans = [...(only ?? this.vlans)].sort((a, b) => a - b);
    const on = (v: ArpValidation) => (this.validate.has(v) ? 'Enabled' : 'Disabled');
    const n = (x: number, w: number) => String(x).padStart(w);
    const rows = (head: string, line: (v: number) => string) => [head, head.replace(/[^ ]/g, '-'), ...vlans.map(line)];
    return [
      '',
      `Source Mac Validation      : ${on('src-mac')}`,
      `Destination Mac Validation : ${on('dst-mac')}`,
      `IP Address Validation      : ${on('ip')}`,
      '',
      ...rows(' Vlan     Configuration    Operation   ACL Match          Static ACL', (v) => {
        const configured = this.vlans.has(v);
        const f = this.filters.get(v);
        const operation = configured && this.host.vlanExists(v) ? 'Active' : 'Inactive';
        return `${n(v, 5)}     ${(configured ? 'Enabled' : 'Disabled').padEnd(17)}${operation.padEnd(12)}${(f?.acl ?? '').padEnd(19)}${f ? (f.static ? 'Yes' : 'No') : ''}`.trimEnd();
      }),
      '',
      ...rows(' Vlan     ACL Logging      DHCP Logging      Probe Logging', (v) => `${n(v, 5)}     ${'Deny'.padEnd(17)}${'Deny'.padEnd(18)}Off`),
      '',
      ...rows(' Vlan      Forwarded        Dropped     DHCP Drops      ACL Drops', (v) => {
        const s = this.statsFor(v);
        return `${n(v, 5)}${n(s.forwarded, 15)}${n(s.dropped, 15)}${n(s.dhcpDrops, 15)}${n(s.aclDrops, 15)}`;
      }),
      '',
      ...rows(' Vlan   DHCP Permits    ACL Permits  Probe Permits   Source MAC Failures', (v) => {
        const s = this.statsFor(v);
        return `${n(v, 5)}${n(s.dhcpPermits, 15)}${n(s.aclPermits, 15)}${n(0, 15)}${n(s.srcMacFailures, 22)}`;
      }),
      '',
      ...rows(' Vlan   Dest MAC Failures   IP Validation Failures   Invalid Protocol Data', (v) => {
        const s = this.statsFor(v);
        return `${n(v, 5)}${n(s.dstMacFailures, 20)}${n(s.ipFailures, 25)}${n(0, 24)}`;
      }),
    ].join('\n');
  }

  /** `show ip arp inspection interfaces`: trust state and rate limit per port. */
  showInterfaces(ports: Interface[]): string {
    return [
      '',
      ' Interface        Trust State     Rate (pps)    Burst Interval',
      ' ---------------  -----------     ----------    --------------',
      ...ports.map((p) => {
        const cfg = p.arpInspection;
        const trusted = cfg?.trust === true;
        // Trusted ports have no limit unless one is configured; untrusted ones default to 15 pps.
        const rate = cfg?.rate ?? (trusted ? 'none' : DAI_DEFAULT_RATE);
        const rateText = rate === 'none' ? 'None' : String(rate);
        const burst = rate === 'none' ? 'N/A' : String(cfg?.burst ?? 1);
        return ` ${shortName(p.name).padEnd(17)}${(trusted ? 'Trusted' : 'Untrusted').padEnd(16)}${rateText.padStart(10)}${burst.padStart(18)}`;
      }),
    ].join('\n');
  }

  /** `show arp access-list`. */
  showAcls(): string {
    return [...this.acls.values()].map((acl) => [`ARP access list ${acl.name}`, ...acl.entries.map((e) => `    ${formatArpAclEntry(e)}`)].join('\n')).join('\n');
  }

  /** Global configuration lines for `show running-config`. */
  runningConfig(): string[] {
    const out: string[] = [];
    for (const acl of this.acls.values()) out.push(`arp access-list ${acl.name}`, ...acl.entries.map((e) => ` ${formatArpAclEntry(e)}`), '!');
    for (const [vlan, f] of [...this.filters].sort((a, b) => a[0] - b[0])) out.push(`ip arp inspection filter ${f.acl} vlan ${vlan}${f.static ? ' static' : ''}`);
    if (this.vlans.size) out.push(`ip arp inspection vlan ${[...this.vlans].sort((a, b) => a - b).join(',')}`);
    if (this.validate.size) out.push(`ip arp inspection validate ${ARP_VALIDATIONS.filter((v) => this.validate.has(v)).join(' ')}`);
    return out;
  }
}

/** Interface lines for `show running-config`. */
export function daiInterfaceConfig(p: Interface): string[] {
  const cfg = p.arpInspection;
  if (!cfg) return [];
  const out: string[] = [];
  if (cfg.trust) out.push(' ip arp inspection trust');
  if (cfg.rate === 'none') out.push(' ip arp inspection limit none');
  else if (cfg.rate !== undefined) out.push(` ip arp inspection limit rate ${cfg.rate}${cfg.burst && cfg.burst !== 1 ? ` burst interval ${cfg.burst}` : ''}`);
  return out;
}

export function formatArpAclEntry(e: ArpAclEntry): string {
  const ip = e.ip === 'any' ? 'any' : 'host' in e.ip ? `host ${e.ip.host}` : `${e.ip.network} ${e.ip.wildcard}`;
  return `${e.action} ip ${ip} mac ${e.mac === 'any' ? 'any' : `host ${e.mac}`}`;
}

/** Parses the tail of an ARP ACL line: `ip host <ip> mac host <mac>`, with `any` or a wildcard for the IP. */
export function parseArpAclEntry(action: 'permit' | 'deny', words: string[]): ArpAclEntry {
  const w = words.map((x) => x.toLowerCase());
  let k = 0;
  const expect = (kw: string) => {
    if (!w[k] || !kw.startsWith(w[k]!)) throw new Error(`Invalid input detected at '^' marker.`);
    k++;
  };
  expect('ip');
  let ip: ArpAclEntry['ip'];
  if (w[k] === 'any') {
    ip = 'any';
    k++;
  } else if (w[k] === 'host') {
    ip = { host: checkedIp(w[k + 1]) };
    k += 2;
  } else {
    ip = { network: checkedIp(w[k]), wildcard: checkedIp(w[k + 1]) };
    k += 2;
  }
  expect('mac');
  let mac: ArpAclEntry['mac'];
  if (w[k] === 'any') {
    mac = 'any';
    k++;
  } else {
    expect('host');
    if (!/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(w[k] ?? '')) throw new Error(`Invalid input detected at '^' marker.`);
    mac = w[k]!;
    k++;
  }
  if (k !== w.length) throw new Error(`Invalid input detected at '^' marker.`);
  return { action, ip, mac };
}

function checkedIp(arg: string | undefined): Ipv4Address {
  try {
    ipToInt(arg ?? '');
  } catch {
    throw new Error(`Invalid input detected at '^' marker.`);
  }
  return arg!;
}

function wildcardMatch(ip: Ipv4Address, network: Ipv4Address, wildcard: Ipv4Address): boolean {
  const care = ~ipToInt(wildcard) >>> 0;
  return ((ipToInt(ip) & care) >>> 0) === ((ipToInt(network) & care) >>> 0);
}

/** `validate ip` rejects addresses no host can own: 0.0.0.0, broadcast and multicast. */
function hostAddress(ip: Ipv4Address): boolean {
  const n = ipToInt(ip);
  return n !== 0 && ip !== '255.255.255.255' && (n >>> 28) !== 0xe;
}

