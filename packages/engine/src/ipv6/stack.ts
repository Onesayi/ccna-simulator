import type { MacAddress } from '../core/addressing';
import type { Frame, Icmpv6Packet } from '../core/frames';
import {
  ALL_NODES,
  ALL_ROUTERS,
  eui64Address,
  ipv6InPrefix,
  ipv6MulticastMac,
  ipv6Network,
  isIpv6Multicast,
  isLinkLocal,
  linkLocalFor,
  normaliseIpv6,
  parseIpv6,
  solicitedNode,
  type Ipv6Address,
} from '../core/ipv6';
import type { ScheduledEvent } from '../core/scheduler';
import type { Interface, Ipv6InterfaceAddress } from '../devices/device';
import type { PingResult, TracerouteResult } from '../devices/ip-device';

/** How long a Neighbor Solicitation waits for an answer before queued packets are dropped. */
export const ND_TIMEOUT_MS = 2_000;

export interface Ipv6StaticRoute {
  network: Ipv6Address;
  prefix: number;
  nextHop?: Ipv6Address;
  exitInterface?: string;
  ad: number;
}

export interface Ipv6Route {
  code: 'C' | 'L' | 'S';
  network: Ipv6Address;
  prefix: number;
  ad: number;
  metric: number;
  nextHop?: Ipv6Address;
  iface?: Interface;
}

export interface NeighborEntry {
  address: Ipv6Address;
  mac: MacAddress;
  iface: Interface;
  learnedAt: number;
  /** Learned from a router advertisement (the neighbor is a router). */
  router?: boolean;
}

interface Path {
  iface: Interface;
  /** The neighbor to resolve: the next hop, or the destination itself when it is on-link. */
  nextHop: Ipv6Address;
}

/** What the stack needs from the device it runs on. */
export interface Ipv6Host {
  readonly interfaces: Interface[];
  /** `ipv6 unicast-routing`: forward packets and send router advertisements. */
  routing(): boolean;
  /** Hop limit for locally originated packets: 64 on IOS, 128 on Windows. */
  readonly hopLimit: number;
  transmit(iface: Interface, dstMac: MacAddress, p: Icmpv6Packet): void;
  schedule(delayMs: number, label: string, run: () => void): ScheduledEvent | undefined;
  cancel(e: ScheduledEvent | undefined): void;
  now(): number;
}

/**
 * IPv6 for routers and PCs: link-local and global addresses (static, EUI-64 and SLAAC),
 * Neighbor Discovery in place of ARP, router advertisements, static routes, forwarding with
 * hop limit handling, and the ICMPv6 behind ping and traceroute.
 *
 * Simplifications: no duplicate address detection, no DHCPv6, and neighbors never go stale.
 */
export class Ipv6Stack {
  readonly statics: Ipv6StaticRoute[] = [];
  readonly neighbors: NeighborEntry[] = [];
  /** A host's default router: learned from an RA (link-local) or configured. */
  gateway?: Ipv6Address;
  private pending = new Map<string, Icmpv6Packet[]>();
  private waiters = new Map<string, { resolve: (p: Icmpv6Packet | undefined) => void; timer?: ScheduledEvent }>();
  private echoId = 1;

  constructor(private readonly host: Ipv6Host) {}

  // ---------------------------------------------------------------- addresses

  /** IPv6 runs on an interface once it has an address, `ipv6 enable`, or autoconfig. */
  enabled(i: Interface): boolean {
    const v6 = i.ipv6;
    return v6 !== undefined && (v6.enabled || v6.addresses.length > 0 || !!v6.autoconfig || !!v6.linkLocal);
  }

  linkLocal(i: Interface): Ipv6Address {
    return i.ipv6?.linkLocal ?? linkLocalFor(i.mac);
  }

  /** Global (and unique local) addresses on an interface. */
  globals(i: Interface): Ipv6InterfaceAddress[] {
    return this.enabled(i) ? i.ipv6!.addresses : [];
  }

  activeInterfaces(): Interface[] {
    return this.host.interfaces.filter((i) => i.isUp && this.enabled(i));
  }

  ownsOn(i: Interface, address: Ipv6Address): boolean {
    return this.enabled(i) && (this.linkLocal(i) === address || this.globals(i).some((a) => a.address === address));
  }

  owns(address: Ipv6Address): boolean {
    return this.activeInterfaces().some((i) => this.ownsOn(i, address));
  }

  /** Multicast groups an interface listens to: all-nodes, all-routers when routing, and a solicited-node group per address. */
  groups(i: Interface): Ipv6Address[] {
    const out = [ALL_NODES, solicitedNode(this.linkLocal(i)), ...this.globals(i).map((a) => solicitedNode(a.address))];
    if (this.host.routing()) out.push(ALL_ROUTERS);
    return out;
  }

  // ---------------------------------------------------------------- routing table

  routingTable(): Ipv6Route[] {
    const routes: Ipv6Route[] = [];
    for (const i of this.activeInterfaces()) {
      for (const a of this.globals(i)) {
        if (a.prefix < 128) routes.push({ code: 'C', network: ipv6Network(a.address, a.prefix), prefix: a.prefix, ad: 0, metric: 0, iface: i });
        routes.push({ code: 'L', network: a.address, prefix: 128, ad: 0, metric: 0, iface: i });
      }
    }
    const connected = [...routes];
    const statics: Ipv6StaticRoute[] = this.host.routing() ? this.statics : this.gateway ? [{ network: '::', prefix: 0, nextHop: this.gateway, ad: 1 }] : [];
    const candidates: Ipv6Route[] = [];
    for (const s of statics) {
      const named = s.exitInterface ? this.host.interfaces.find((i) => i.name === s.exitInterface) : undefined;
      // A host's link-local gateway is reached on its only interface.
      const iface = named ?? (s.nextHop && isLinkLocal(s.nextHop) && !s.exitInterface ? this.activeInterfaces()[0] : undefined);
      if ((s.exitInterface || (s.nextHop && isLinkLocal(s.nextHop))) && !(iface?.isUp && this.enabled(iface))) continue;
      candidates.push({ code: 'S', network: s.network, prefix: s.prefix, ad: s.ad, metric: 0, nextHop: s.nextHop, iface });
    }
    const usable = candidates.filter((r) => r.iface || this.resolve([...connected, ...candidates], r.nextHop!, 0));
    for (const r of usable) {
      const competing = [...routes, ...usable].filter((o) => o.network === r.network && o.prefix === r.prefix);
      if (competing.every((o) => o.ad >= r.ad)) routes.push(r);
    }
    return routes;
  }

  lookup(dst: Ipv6Address, table = this.routingTable()): Path | undefined {
    return this.resolve(table, dst, 0);
  }

  private resolve(table: Ipv6Route[], dst: Ipv6Address, depth: number): Path | undefined {
    if (depth > 8) return undefined;
    let best: Ipv6Route | undefined;
    for (const r of table) {
      if (!ipv6InPrefix(dst, r.network, r.prefix)) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
    }
    if (!best) return undefined;
    if (best.code !== 'S') return { iface: best.iface!, nextHop: dst };
    if (best.iface) return { iface: best.iface, nextHop: best.nextHop ?? dst };
    const via = this.resolve(table, best.nextHop!, depth + 1);
    return via && { iface: via.iface, nextHop: via.nextHop };
  }

  addStatic(route: Ipv6StaticRoute): void {
    if (ipv6Network(route.network, route.prefix) !== route.network) throw new Error('Inconsistent address and prefix');
    if (route.nextHop && isLinkLocal(route.nextHop) && !route.exitInterface) throw new Error('Interface has to be specified for a link-local nexthop');
    this.removeStatic(route);
    this.statics.push({ ...route });
  }

  removeStatic(route: Pick<Ipv6StaticRoute, 'network' | 'prefix' | 'nextHop' | 'exitInterface'>): void {
    const k = this.statics.findIndex((r) => r.network === route.network && r.prefix === route.prefix && r.nextHop === route.nextHop && r.exitInterface === route.exitInterface);
    if (k >= 0) this.statics.splice(k, 1);
  }

  /** Adds a global address, rejecting a prefix that overlaps another interface's. */
  addAddress(i: Interface, address: Ipv6Address, prefix: number, eui64 = false): void {
    const addr = eui64 ? eui64Address(address, i.mac) : normaliseIpv6(address);
    if (eui64 && prefix > 64) throw new Error('EUI-64 needs a prefix of /64 or shorter');
    for (const other of this.host.interfaces) {
      if (other === i) continue;
      for (const a of other.ipv6?.addresses ?? []) {
        if (ipv6InPrefix(addr, a.address, Math.min(prefix, a.prefix))) throw new Error(`${ipv6Network(addr, prefix).toUpperCase()}/${prefix} overlaps with ${other.name}`);
      }
    }
    const v6 = (i.ipv6 ??= { enabled: false, addresses: [] });
    v6.addresses = v6.addresses.filter((a) => a.address !== addr);
    v6.addresses.push({ address: addr, prefix, eui64: eui64 || undefined });
  }

  // ---------------------------------------------------------------- ping and traceroute

  ping(dst: Ipv6Address, count = 4, timeoutMs = 2_000): PingResult[] {
    const target = normaliseIpv6(dst);
    const id = this.echoId++;
    const results: PingResult[] = Array.from({ length: count }, (_, seq) => ({ seq, success: false, status: 'pending' }));
    const sendNext = (seq: number) => {
      if (seq >= count) return;
      const result = results[seq]!;
      const sentAt = this.host.now();
      const done = () => this.host.schedule(0, `ping ${target} next`, () => sendNext(seq + 1));
      this.expect(`${id}:${seq}`, timeoutMs, (reply) => {
        result.rttMs = this.host.now() - sentAt;
        result.from = reply?.src;
        if (!reply) result.status = 'timeout';
        else if (reply.type === 'echo-reply') Object.assign(result, { status: 'success', success: true, ttl: reply.hopLimit });
        else result.status = reply.type === 'time-exceeded' ? 'ttl-exceeded' : 'unreachable';
        done();
      });
      if (!this.originate(target, (src) => ({ kind: 'icmpv6', type: 'echo-request', src, dst: target, hopLimit: this.host.hopLimit, id, seq }))) {
        this.forget(`${id}:${seq}`);
        result.status = 'no-route';
        done();
      }
    };
    this.host.schedule(0, `ping ${target}`, () => sendNext(0));
    return results;
  }

  traceroute(dst: Ipv6Address, maxHops = 30, probesPerHop = 3, timeoutMs = 2_000): TracerouteResult {
    const target = normaliseIpv6(dst);
    const id = this.echoId++;
    const result: TracerouteResult = { destination: target, hops: [], done: false, reached: false };
    const probe = (ttl: number, n: number) => {
      if (n === 0) result.hops.push({ ttl, probes: [] });
      const hop = result.hops[result.hops.length - 1]!;
      const seq = ttl * probesPerHop + n;
      const sentAt = this.host.now();
      const next = () =>
        this.host.schedule(0, `traceroute ${target} next`, () => {
          if (n + 1 < probesPerHop) return probe(ttl, n + 1);
          const answered = hop.probes.filter((p) => p.from);
          const finished = answered.some((p) => p.from === target || p.unreachable) || ttl >= maxHops;
          if (finished) Object.assign(result, { done: true, reached: answered.some((p) => p.from === target) });
          else probe(ttl + 1, 0);
        });
      this.expect(`${id}:${seq}`, timeoutMs, (reply) => {
        hop.probes.push(reply ? { from: reply.src, rttMs: this.host.now() - sentAt, unreachable: reply.type === 'unreachable' } : {});
        next();
      });
      if (!this.originate(target, (src) => ({ kind: 'icmpv6', type: 'echo-request', src, dst: target, hopLimit: ttl, id, seq }))) {
        this.forget(`${id}:${seq}`);
        hop.probes.push({});
        Object.assign(result, { done: true });
      }
    };
    this.host.schedule(0, `traceroute ${target}`, () => probe(1, 0));
    return result;
  }

  private expect(key: string, timeoutMs: number, resolve: (p: Icmpv6Packet | undefined) => void): void {
    const waiter: { resolve: typeof resolve; timer?: ScheduledEvent } = { resolve };
    waiter.timer = this.host.schedule(timeoutMs, `timeout v6 ${key}`, () => {
      this.waiters.delete(key);
      resolve(undefined);
    });
    this.waiters.set(key, waiter);
  }

  private forget(key: string): void {
    this.host.cancel(this.waiters.get(key)?.timer);
    this.waiters.delete(key);
  }

  private resolveWaiter(key: string, p: Icmpv6Packet): void {
    const w = this.waiters.get(key);
    if (!w) return;
    this.waiters.delete(key);
    this.host.cancel(w.timer);
    w.resolve(p);
  }

  /** Source address selection: link-local for link-local destinations, else a global address, preferring the exit interface's. */
  private sourceFor(iface: Interface, dst: Ipv6Address): Ipv6Address {
    if (isLinkLocal(dst)) return this.linkLocal(iface);
    const own = this.globals(iface)[0]?.address;
    if (own) return own;
    const any = this.activeInterfaces().flatMap((i) => this.globals(i))[0]?.address;
    return any ?? this.linkLocal(iface);
  }

  private originate(dst: Ipv6Address, build: (src: Ipv6Address) => Icmpv6Packet): boolean {
    if (this.owns(dst)) {
      const p = build(dst);
      this.host.schedule(0, `local ${dst}`, () => this.deliverLocal(p, undefined));
      return true;
    }
    if (isLinkLocal(dst)) return false; // needs an output interface, which this simulator does not ask for
    const path = this.lookup(dst);
    if (!path) return false;
    this.output(build(this.sourceFor(path.iface, dst)), path);
    return true;
  }

  private send(p: Icmpv6Packet, via?: Interface): void {
    if (this.owns(p.dst)) {
      this.host.schedule(0, `local ${p.dst}`, () => this.deliverLocal(p, undefined));
      return;
    }
    // Replies to a link-local source go back out the interface the request came in on.
    if (isLinkLocal(p.dst)) {
      if (via) this.output(p, { iface: via, nextHop: p.dst });
      return;
    }
    const path = this.lookup(p.dst);
    if (path) this.output(p, path);
  }

  // ---------------------------------------------------------------- receive path

  /** Does this frame's destination MAC belong to us on `iface`? */
  accepts(i: Interface, dstMac: MacAddress): boolean {
    return dstMac === i.mac || this.groups(i).some((g) => ipv6MulticastMac(g) === dstMac);
  }

  receive(iface: Interface, p: Icmpv6Packet, frame: Frame): void {
    if (!this.enabled(iface) || !this.accepts(iface, frame.dst)) return;
    if (p.type === 'ns' || p.type === 'na' || p.type === 'rs' || p.type === 'ra') return this.neighborDiscovery(iface, p, frame);
    if (this.ownsOn(iface, p.dst) || this.owns(p.dst) || (isIpv6Multicast(p.dst) && this.groups(iface).includes(p.dst))) return this.deliverLocal(p, iface);
    if (!this.host.routing() || isLinkLocal(p.dst) || isLinkLocal(p.src)) return;
    this.forward(p, iface);
  }

  private neighborDiscovery(iface: Interface, p: Icmpv6Packet, frame: Frame): void {
    if (p.type === 'ns') {
      if (!p.target || !this.ownsOn(iface, p.target)) return;
      this.learn(p.src, frame.src, iface);
      this.host.transmit(iface, frame.src, { kind: 'icmpv6', type: 'na', src: p.target, dst: p.src, hopLimit: 255, id: 0, seq: 0, target: p.target, mac: iface.mac });
      return;
    }
    if (p.type === 'na') {
      if (p.target && p.mac) this.learn(p.target, p.mac, iface);
      return;
    }
    if (p.type === 'rs') {
      if (!this.host.routing()) return;
      this.learn(p.src, frame.src, iface);
      this.advertise(iface, p.src, frame.src);
      return;
    }
    // Router advertisement: hosts learn their default router and, with autoconfig on, SLAAC addresses.
    if (this.host.routing()) return;
    this.learn(p.src, p.mac ?? frame.src, iface, true);
    if (!iface.ipv6?.autoconfig) return;
    this.gateway = p.src;
    for (const pre of p.prefixes ?? []) {
      if (pre.length !== 64) continue; // SLAAC only works with a /64
      const address = eui64Address(pre.prefix, iface.mac);
      if (!iface.ipv6.addresses.some((a) => a.address === address)) iface.ipv6.addresses.push({ address, prefix: 64, slaac: true });
    }
  }

  /** Sends a router advertisement listing the interface's prefixes. */
  advertise(iface: Interface, dst: Ipv6Address = ALL_NODES, dstMac: MacAddress = ipv6MulticastMac(ALL_NODES)): void {
    const prefixes = this.globals(iface).map((a) => ({ prefix: ipv6Network(a.address, a.prefix), length: a.prefix }));
    this.host.transmit(iface, dstMac, { kind: 'icmpv6', type: 'ra', src: this.linkLocal(iface), dst, hopLimit: 255, id: 0, seq: 0, mac: iface.mac, prefixes });
  }

  /** Asks for a router advertisement, as a host does when its interface comes up. */
  solicit(iface: Interface): void {
    if (!this.enabled(iface) || !iface.isUp) return;
    this.host.transmit(iface, ipv6MulticastMac(ALL_ROUTERS), { kind: 'icmpv6', type: 'rs', src: this.linkLocal(iface), dst: ALL_ROUTERS, hopLimit: 255, id: 0, seq: 0, mac: iface.mac });
  }

  /** Periodic router advertisements (each convergence round stands in for the RA interval). */
  tick(): void {
    if (!this.host.routing()) return;
    for (const i of this.activeInterfaces()) if (i.kind !== 'loopback' && this.globals(i).length) this.advertise(i);
  }

  private deliverLocal(p: Icmpv6Packet, ingress: Interface | undefined): void {
    if (p.type === 'echo-request') {
      const src = isIpv6Multicast(p.dst) ? (ingress ? this.sourceFor(ingress, p.src) : p.dst) : p.dst;
      return this.send({ ...p, type: 'echo-reply', src, dst: p.src, hopLimit: this.host.hopLimit }, ingress);
    }
    if (p.type === 'echo-reply') return this.resolveWaiter(`${p.id}:${p.seq}`, p);
    if (p.type === 'time-exceeded' || p.type === 'unreachable') return this.resolveWaiter(`${p.id}:${p.seq}`, p);
  }

  private forward(p: Icmpv6Packet, ingress: Interface): void {
    const hopLimit = p.hopLimit - 1;
    if (hopLimit <= 0) return this.error('time-exceeded', p, ingress);
    const path = this.lookup(p.dst);
    if (!path) return this.error('unreachable', p, ingress);
    this.output({ ...p, hopLimit }, path);
  }

  private error(type: 'time-exceeded' | 'unreachable', p: Icmpv6Packet, ingress: Interface): void {
    if (p.type !== 'echo-request' && p.type !== 'echo-reply') return;
    const src = this.sourceFor(ingress, p.src);
    this.send({ kind: 'icmpv6', type, src, dst: p.src, hopLimit: this.host.hopLimit, id: p.id, seq: p.seq, original: p }, ingress);
  }

  // ---------------------------------------------------------------- Neighbor Discovery

  private key(address: Ipv6Address, iface: Interface): string {
    return `${address}%${iface.name}`;
  }

  neighbor(address: Ipv6Address, iface: Interface): NeighborEntry | undefined {
    return this.neighbors.find((n) => n.address === address && n.iface === iface);
  }

  private learn(address: Ipv6Address, mac: MacAddress, iface: Interface, router = false): void {
    if (parseIpv6(address) === 0n) return;
    const existing = this.neighbor(address, iface);
    if (existing) Object.assign(existing, { mac, learnedAt: this.host.now(), router: existing.router || router });
    else this.neighbors.push({ address, mac, iface, learnedAt: this.host.now(), router });
    const key = this.key(address, iface);
    const queue = this.pending.get(key);
    if (!queue) return;
    this.pending.delete(key);
    for (const q of queue) this.host.transmit(iface, mac, q);
  }

  /** Sends to a neighbor, resolving its MAC with a Neighbor Solicitation first. Packets wait in a queue meanwhile. */
  private output(p: Icmpv6Packet, path: Path): void {
    const { iface, nextHop } = path;
    const entry = this.neighbor(nextHop, iface);
    if (entry) return this.host.transmit(iface, entry.mac, p);
    const key = this.key(nextHop, iface);
    const queue = this.pending.get(key);
    if (queue) {
      queue.push(p);
      return;
    }
    this.pending.set(key, [p]);
    const group = solicitedNode(nextHop);
    this.host.transmit(iface, ipv6MulticastMac(group), { kind: 'icmpv6', type: 'ns', src: this.sourceFor(iface, nextHop), dst: group, hopLimit: 255, id: 0, seq: 0, target: nextHop, mac: iface.mac });
    this.host.schedule(ND_TIMEOUT_MS, `nd timeout ${nextHop}`, () => this.pending.delete(key));
  }
}
