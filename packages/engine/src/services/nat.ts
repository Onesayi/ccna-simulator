import { intToIp, ipToInt, type Ipv4Address } from '../core/addressing';
import type { IpPacket } from '../core/frames';

export interface NatStatic {
  local: Ipv4Address;
  global: Ipv4Address;
}

export interface NatPool {
  name: string;
  start: Ipv4Address;
  end: Ipv4Address;
  prefix: number;
}

/** `ip nat inside source list <acl> pool <name> [overload]` or `... interface <if> overload`. */
export interface NatRule {
  acl: string;
  pool?: string;
  iface?: string;
  overload: boolean;
}

export interface NatEntry {
  /** Absent for simple (address-only) entries: statics and one-to-one dynamic mappings. */
  proto?: 'icmp' | 'tcp' | 'udp';
  insideLocal: Ipv4Address;
  insideGlobal: Ipv4Address;
  localPort?: number;
  globalPort?: number;
  outside?: Ipv4Address;
  outsidePort?: number;
  dynamic: boolean;
}

/** What NAT needs from its router: ACL checks and interface addresses. */
export interface NatHost {
  /** `undefined` when the ACL does not exist. */
  aclPermits(acl: string, p: IpPacket): boolean | undefined;
  interfaceAddress(name: string): Ipv4Address | undefined;
}

type Ported = Extract<IpPacket, { kind: 'icmp' | 'tcp' | 'udp' }>;

/** The port NAT tracks: TCP/UDP ports, or the echo identifier for ping (which is how PAT handles ICMP). */
function portOf(p: IpPacket, side: 'src' | 'dst'): number | undefined {
  if (p.kind === 'tcp' || p.kind === 'udp') return side === 'src' ? p.srcPort : p.dstPort;
  if (p.kind === 'icmp' && (p.type === 'echo-request' || p.type === 'echo-reply')) return p.id;
  return undefined;
}

function withPort<T extends IpPacket>(p: T, side: 'src' | 'dst', port: number | undefined): T {
  if (port === undefined) return p;
  if (p.kind === 'tcp' || p.kind === 'udp') return { ...p, [side === 'src' ? 'srcPort' : 'dstPort']: port };
  if (p.kind === 'icmp') return { ...p, id: port };
  return p;
}

/** Inside source NAT as on IOS: static one-to-one, dynamic pools, and PAT (overload). */
export class Nat {
  readonly statics: NatStatic[] = [];
  readonly pools = new Map<string, NatPool>();
  readonly rules: NatRule[] = [];
  readonly entries: NatEntry[] = [];
  hits = 0;
  misses = 0;

  constructor(private readonly host: NatHost) {}

  get configured(): boolean {
    return this.statics.length > 0 || this.rules.length > 0;
  }

  /** Inside-to-outside: rewrites the source. `undefined` means drop (no address left in the pool). */
  outbound(p: IpPacket): IpPacket | undefined {
    if (p.kind === 'ospf' || p.kind === 'vrrp') return p;
    const proto = p.kind;
    const localPort = portOf(p, 'src');
    const existing = this.entries.find((e) => e.proto === proto && e.insideLocal === p.src && e.localPort === localPort && e.outside === p.dst);
    if (existing) return this.hit(withPort({ ...p, src: existing.insideGlobal }, 'src', existing.globalPort));

    const fixed = this.statics.find((s) => s.local === p.src);
    if (fixed) return this.translate(p, fixed.global, localPort, false);

    for (const rule of this.rules) {
      if (!this.host.aclPermits(rule.acl, p)) continue;
      const pool = rule.pool ? this.pools.get(rule.pool) : undefined;
      if (rule.overload) {
        const global = rule.iface ? this.host.interfaceAddress(rule.iface) : pool?.start;
        if (!global) break;
        return this.translate(p, global, this.freePort(proto, global, localPort), true);
      }
      if (!pool) break;
      const mapped = this.entries.find((e) => !e.proto && e.dynamic && e.insideLocal === p.src);
      const global = mapped?.insideGlobal ?? this.freeAddress(pool);
      if (!global) {
        this.misses++;
        return undefined;
      }
      if (!mapped) this.entries.push({ insideLocal: p.src, insideGlobal: global, dynamic: true });
      return this.translate(p, global, localPort, true);
    }
    return p;
  }

  /** Outside-to-inside: rewrites the destination of return traffic, and of traffic to static globals. */
  inbound(p: IpPacket): IpPacket {
    if (p.kind === 'icmp' && p.original) {
      // An ICMP error about a translated packet: fix the quoted header and send it to the inside host.
      const o = p.original;
      const e = this.find(o.kind, o.src, portOf(o, 'src'));
      if (!e) return p;
      return this.hit({ ...p, dst: e.insideLocal, original: withPort({ ...o, src: e.insideLocal }, 'src', e.localPort) });
    }
    if (p.kind === 'ospf' || p.kind === 'vrrp') return p;
    const port = portOf(p, 'dst');
    const e = this.find(p.kind, p.dst, port);
    if (e) return this.hit(withPort({ ...p, dst: e.insideLocal }, 'dst', e.localPort));
    const simple = this.entries.find((x) => !x.proto && x.insideGlobal === p.dst);
    const fixed = simple ? { local: simple.insideLocal } : this.statics.find((s) => s.global === p.dst);
    if (!fixed) return p;
    // Traffic started from outside (to a static global): remember the flow so replies match it.
    this.entries.push({ proto: p.kind, insideLocal: fixed.local, insideGlobal: p.dst, localPort: port, globalPort: port, outside: p.src, outsidePort: portOf(p, 'src'), dynamic: true });
    return this.hit({ ...p, dst: fixed.local });
  }

  /** Global addresses we must answer ARP for on the outside. */
  globals(): Ipv4Address[] {
    const out = this.statics.map((s) => s.global);
    for (const pool of this.pools.values()) {
      for (let n = ipToInt(pool.start); n <= ipToInt(pool.end); n++) out.push(intToIp(n));
    }
    return out;
  }

  clearDynamic(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.dynamic) this.entries.splice(i, 1);
  }

  /** Every translation, with static mappings listed as simple entries like IOS does. */
  table(): NatEntry[] {
    return [...this.entries, ...this.statics.map((s) => ({ insideLocal: s.local, insideGlobal: s.global, dynamic: false }))];
  }

  private find(proto: IpPacket['kind'], global: Ipv4Address, port: number | undefined): NatEntry | undefined {
    return this.entries.find((e) => e.proto === proto && e.insideGlobal === global && e.globalPort === port);
  }

  private translate(p: Ported, global: Ipv4Address, globalPort: number | undefined, dynamic: boolean): IpPacket {
    this.entries.push({
      proto: p.kind,
      insideLocal: p.src,
      insideGlobal: global,
      localPort: portOf(p, 'src'),
      globalPort,
      outside: p.dst,
      outsidePort: portOf(p, 'dst'),
      dynamic,
    });
    return this.hit(withPort({ ...p, src: global }, 'src', globalPort));
  }

  private hit<T>(p: T): T {
    this.hits++;
    return p;
  }

  /** PAT keeps the inside port when it is free on the global address, otherwise takes the next one. */
  private freePort(proto: IpPacket['kind'], global: Ipv4Address, wanted: number | undefined): number | undefined {
    if (wanted === undefined) return undefined;
    let port = wanted;
    while (this.find(proto, global, port)) port++;
    return port;
  }

  private freeAddress(pool: NatPool): Ipv4Address | undefined {
    const used = new Set([...this.entries.map((e) => e.insideGlobal), ...this.statics.map((s) => s.global)]);
    for (let n = ipToInt(pool.start); n <= ipToInt(pool.end); n++) if (!used.has(intToIp(n))) return intToIp(n);
    return undefined;
  }
}

export function showNatTranslations(nat: Nat): string {
  const cell = (ip: Ipv4Address | undefined, port: number | undefined) => (ip ? `${ip}${port !== undefined ? `:${port}` : ''}` : '---');
  const rows = nat.table().map((e) => {
    const cols = [(e.proto ?? '---').padEnd(5), cell(e.insideGlobal, e.globalPort).padEnd(22), cell(e.insideLocal, e.localPort).padEnd(22)];
    cols.push(cell(e.outside, e.outsidePort).padEnd(22), cell(e.outside, e.outsidePort));
    return cols.join('');
  });
  return ['Pro  Inside global         Inside local          Outside local         Outside global', ...rows, `Total number of translations: ${rows.length}`].join('\n');
}
