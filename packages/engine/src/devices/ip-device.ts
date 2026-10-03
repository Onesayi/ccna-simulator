import {
  BROADCAST_MAC,
  ipToInt,
  networkAddress,
  prefixToMask,
  sameSubnet,
  type Ipv4Address,
  type MacAddress,
} from '../core/addressing';
import type { ArpPacket, Frame, IcmpPacket, IpPacket } from '../core/frames';
import type { ScheduledEvent } from '../core/scheduler';
import { Device, type Interface } from './device';

/** How long a ping or traceroute probe waits for an answer (IOS and Windows both use 2 seconds). */
export const ICMP_TIMEOUT_MS = 2_000;
/** How long an unanswered ARP request stays pending before queued packets are dropped. */
export const ARP_TIMEOUT_MS = 2_000;

export type PingStatus = 'pending' | 'success' | 'timeout' | 'unreachable' | 'ttl-exceeded' | 'no-route';

export interface PingResult {
  seq: number;
  /** Kept for convenience: true when an echo reply came back. */
  success: boolean;
  status: PingStatus;
  rttMs?: number;
  /** TTL of the echo reply as received. */
  ttl?: number;
  /** Who answered: the target for a reply, or the router that sent an ICMP error. */
  from?: Ipv4Address;
}

export interface TraceProbe {
  from?: Ipv4Address;
  rttMs?: number;
  unreachable?: boolean;
}

export interface TraceHop {
  ttl: number;
  probes: TraceProbe[];
}

export interface TracerouteResult {
  destination: Ipv4Address;
  hops: TraceHop[];
  done: boolean;
  reached: boolean;
}

export interface ArpEntry {
  mac: MacAddress;
  iface: Interface;
  learnedAt: number;
}

export interface StaticRoute {
  network: Ipv4Address;
  prefix: number;
  nextHop?: Ipv4Address;
  /** Exit interface name as typed, resolved on every lookup so it survives renames and late creation. */
  exitInterface?: string;
  /** Administrative distance; anything above 1 makes a floating static route. */
  ad: number;
}

export type RouteCode = 'C' | 'L' | 'S';

/** An entry in the routing table (RIB) as `show ip route` prints it. */
export interface Route {
  code: RouteCode;
  network: Ipv4Address;
  prefix: number;
  ad: number;
  metric: number;
  nextHop?: Ipv4Address;
  iface?: Interface;
}

interface Resolved {
  route: Route;
  iface: Interface;
  /** The address to ARP for: the next hop, or the destination itself when it is on-link. */
  arpTarget: Ipv4Address;
}

interface Waiter {
  resolve: (reply: IcmpPacket) => void;
  timer?: ScheduledEvent;
}

/**
 * The IPv4 stack shared by PCs, routers and switches (through their SVIs): ARP, a routing
 * table with connected, local and static routes, packet forwarding with TTL handling, and
 * the ICMP behaviour behind ping and traceroute.
 */
export abstract class IpDevice extends Device {
  readonly arpTable = new Map<Ipv4Address, ArpEntry>();
  readonly staticRoutes: StaticRoute[] = [];
  /** `ip default-gateway` on a switch, or the gateway field on a PC. Ignored while routing. */
  defaultGateway?: Ipv4Address;
  /** Answer ARP for remote addresses we have a route to (IOS default on routed interfaces). */
  proxyArp = true;

  /** Routers forward packets between interfaces; hosts only send and receive their own. */
  abstract get forwarding(): boolean;
  /** Hosts hold packets while ARP resolves. IOS drops the packet that triggered ARP, hence ".!!!!". */
  protected readonly queueDuringArp: boolean = false;
  /** TTL for locally originated packets: 255 on IOS, 128 on Windows. */
  protected readonly initialTtl: number = 255;

  private pendingArp = new Map<Ipv4Address, IpPacket[]>();
  private waiters = new Map<string, Waiter>();
  private echoId = 1;

  /** Interfaces that are up and have an address. */
  ipInterfaces(): Interface[] {
    return this.interfaces.filter((i) => i.ip && i.isUp);
  }

  ownsIp(ip: Ipv4Address): boolean {
    return this.interfaces.some((i) => i.ip?.address === ip && i.isUp);
  }

  // ---------------------------------------------------------------- routing table

  /** The routing table as installed: connected and local routes plus every usable static route. */
  routingTable(): Route[] {
    const routes: Route[] = [];
    for (const i of this.ipInterfaces()) {
      const { address, prefix } = i.ip!;
      routes.push({ code: 'C', network: networkAddress(address, prefix), prefix, ad: 0, metric: 0, iface: i });
      if (prefix < 32) routes.push({ code: 'L', network: address, prefix: 32, ad: 0, metric: 0, iface: i });
    }
    const connected = [...routes];

    const statics = this.forwarding
      ? this.staticRoutes
      : this.defaultGateway
        ? [{ network: '0.0.0.0', prefix: 0, nextHop: this.defaultGateway, ad: 1 }]
        : [];
    const candidates: Route[] = [];
    for (const s of statics) {
      const iface = s.exitInterface ? this.findIface(s.exitInterface) : undefined;
      if (s.exitInterface && !iface?.isUp) continue;
      if (!iface && s.nextHop && !this.resolveVia([...connected, ...candidates], s.nextHop, 0)) continue;
      candidates.push({ code: 'S', network: s.network, prefix: s.prefix, ad: s.ad, metric: 0, nextHop: s.nextHop, iface });
    }
    // Statics that recurse through other statics are checked again now that all are known.
    const usable = candidates.filter((r) => r.iface || this.resolveVia([...connected, ...candidates], r.nextHop!, 0));
    // For each prefix only the lowest administrative distance is installed (floating statics wait).
    for (const r of usable) {
      const competing = [...routes, ...usable].filter((o) => o.network === r.network && o.prefix === r.prefix);
      if (competing.every((o) => o.ad >= r.ad)) routes.push(r);
    }
    return routes;
  }

  /** Longest-prefix match, then recursive resolution of the next hop to an exit interface. */
  lookup(dst: Ipv4Address, table = this.routingTable()): Resolved | undefined {
    return this.resolveVia(table, dst, 0);
  }

  private resolveVia(table: Route[], dst: Ipv4Address, depth: number): Resolved | undefined {
    if (depth > 8) return undefined;
    let best: Route | undefined;
    for (const r of table) {
      if (networkAddress(dst, r.prefix) !== r.network) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
    }
    if (!best) return undefined;
    if (best.code !== 'S') return { route: best, iface: best.iface!, arpTarget: dst };
    if (best.iface) return { route: best, iface: best.iface, arpTarget: best.nextHop ?? dst };
    const via = this.resolveVia(table, best.nextHop!, depth + 1);
    return via && { route: best, iface: via.iface, arpTarget: via.arpTarget };
  }

  /** The route a router advertises as its gateway of last resort, if any. */
  gatewayOfLastResort(table = this.routingTable()): Route | undefined {
    return table.find((r) => r.prefix === 0 && r.code === 'S');
  }

  // ---------------------------------------------------------------- ping and traceroute

  /** Sends `count` echo requests one after another. Results fill in as the topology runs. */
  ping(dst: Ipv4Address, count = 4, timeoutMs = ICMP_TIMEOUT_MS): PingResult[] {
    ipToInt(dst); // validates
    const id = this.echoId++;
    const results: PingResult[] = Array.from({ length: count }, (_, seq) => ({ seq, success: false, status: 'pending' }));
    const sendNext = (seq: number) => {
      if (seq >= count) return;
      const result = results[seq]!;
      const sentAt = this.now;
      const done = () => this.schedule(0, `ping ${dst} next`, () => sendNext(seq + 1));
      this.expect(id, seq, timeoutMs, (reply) => {
        result.rttMs = this.now - sentAt;
        result.from = reply?.src;
        if (!reply) result.status = 'timeout';
        else if (reply.type === 'echo-reply') Object.assign(result, { status: 'success', success: true, ttl: reply.ttl });
        else result.status = reply.type === 'time-exceeded' ? 'ttl-exceeded' : 'unreachable';
        done();
      });
      if (!this.originate(dst, { id, seq, ttl: this.initialTtl })) {
        this.forget(id, seq);
        result.status = 'no-route';
        done();
      }
    };
    this.schedule(0, `ping ${dst}`, () => sendNext(0));
    return results;
  }

  /** Probes with rising TTL until the destination answers, it is unreachable, or `maxHops` is hit. */
  traceroute(dst: Ipv4Address, maxHops = 30, probesPerHop = 3, timeoutMs = ICMP_TIMEOUT_MS): TracerouteResult {
    ipToInt(dst);
    const id = this.echoId++;
    const result: TracerouteResult = { destination: dst, hops: [], done: false, reached: false };
    const probe = (ttl: number, n: number) => {
      if (n === 0) result.hops.push({ ttl, probes: [] });
      const hop = result.hops[result.hops.length - 1]!;
      const seq = ttl * probesPerHop + n;
      const sentAt = this.now;
      const next = () =>
        this.schedule(0, `traceroute ${dst} next`, () => {
          if (n + 1 < probesPerHop) return probe(ttl, n + 1);
          const answered = hop.probes.filter((p) => p.from);
          const finished = answered.some((p) => p.from === dst || p.unreachable) || ttl >= maxHops;
          if (finished) Object.assign(result, { done: true, reached: answered.some((p) => p.from === dst) });
          else probe(ttl + 1, 0);
        });
      this.expect(id, seq, timeoutMs, (reply) => {
        hop.probes.push(reply ? { from: reply.src, rttMs: this.now - sentAt, unreachable: reply.type === 'unreachable' } : {});
        next();
      });
      if (!this.originate(dst, { id, seq, ttl })) {
        this.forget(id, seq);
        hop.probes.push({});
        Object.assign(result, { done: true });
      }
    };
    this.schedule(0, `traceroute ${dst}`, () => probe(1, 0));
    return result;
  }

  private expect(id: number, seq: number, timeoutMs: number, resolve: (reply: IcmpPacket | undefined) => void): void {
    const key = `${id}:${seq}`;
    const waiter: Waiter = { resolve };
    waiter.timer = this.schedule(timeoutMs, `icmp timeout ${key}`, () => {
      this.waiters.delete(key);
      resolve(undefined);
    });
    this.waiters.set(key, waiter);
  }

  private forget(id: number, seq: number): void {
    const key = `${id}:${seq}`;
    this.cancel(this.waiters.get(key)?.timer);
    this.waiters.delete(key);
  }

  /** Sends a locally generated echo request. Returns false when there is no route at all. */
  private originate(dst: Ipv4Address, { id, seq, ttl }: { id: number; seq: number; ttl: number }): boolean {
    if (this.ownsIp(dst)) {
      // Pinging yourself never touches the wire.
      this.schedule(0, `local echo ${dst}`, () => this.deliverLocal({ kind: 'icmp', type: 'echo-reply', src: dst, dst, ttl: this.initialTtl, id, seq }));
      return true;
    }
    const path = this.lookup(dst);
    if (!path?.iface.ip) return false;
    this.output({ kind: 'icmp', type: 'echo-request', src: path.iface.ip.address, dst, ttl, id, seq }, path);
    return true;
  }

  // ---------------------------------------------------------------- receive path

  /** Entry point for frames that reached this device's Layer 3 on `iface`. */
  protected receiveL3(iface: Interface, frame: Frame): void {
    if (frame.dst !== iface.mac && frame.dst !== BROADCAST_MAC) return;
    const p = frame.payload;
    if (p.kind === 'arp') return this.handleArp(iface, p);
    if (!iface.ip) return;
    if (this.ownsIp(p.dst)) return this.deliverLocal(p);
    if (frame.dst === BROADCAST_MAC || !this.forwarding) return;
    this.forward(p, iface);
  }

  private deliverLocal(p: IcmpPacket): void {
    if (p.type === 'echo-request') {
      const path = this.lookup(p.src);
      if (path) this.output({ ...p, type: 'echo-reply', src: p.dst, dst: p.src, ttl: this.initialTtl }, path);
      return;
    }
    const key = `${p.id}:${p.seq}`;
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    this.cancel(waiter.timer);
    waiter.resolve(p);
  }

  private forward(p: IpPacket, ingress: Interface): void {
    const ttl = p.ttl - 1;
    if (ttl <= 0) return this.icmpError('time-exceeded', p, ingress);
    const path = this.lookup(p.dst);
    if (!path) return this.icmpError('unreachable', p, ingress);
    this.output({ ...p, ttl }, path);
  }

  /** Errors are sourced from the interface the offending packet arrived on. Never error about an error. */
  private icmpError(type: 'time-exceeded' | 'unreachable', p: IpPacket, ingress: Interface): void {
    if (p.type !== 'echo-request' && p.type !== 'echo-reply') return;
    const path = this.lookup(p.src);
    const src = ingress.ip?.address;
    if (!path || !src) return;
    this.output({ kind: 'icmp', type, src, dst: p.src, ttl: this.initialTtl, id: p.id, seq: p.seq }, path);
  }

  // ---------------------------------------------------------------- ARP and transmit

  private output(p: IpPacket, path: Resolved): void {
    const { iface, arpTarget } = path;
    const entry = this.arpTable.get(arpTarget);
    if (entry && entry.iface === iface) return this.transmitL3(iface, entry.mac, p);

    const queue = this.pendingArp.get(arpTarget);
    if (queue) {
      if (this.queueDuringArp) queue.push(p);
      return;
    }
    this.pendingArp.set(arpTarget, this.queueDuringArp ? [p] : []);
    const ip = iface.ip!;
    this.transmitL3(iface, BROADCAST_MAC, {
      kind: 'arp',
      op: 'request',
      senderMac: iface.mac,
      senderIp: ip.address,
      targetMac: '0000.0000.0000',
      targetIp: arpTarget,
    });
    this.schedule(ARP_TIMEOUT_MS, `arp timeout ${arpTarget}`, () => this.pendingArp.delete(arpTarget));
  }

  private handleArp(iface: Interface, p: ArpPacket): void {
    const ip = iface.ip;
    if (!ip) return;
    const forMe = p.targetIp === ip.address;
    // RFC 826: always refresh an existing entry; only create one when we are the target.
    // Replies to proxy ARP carry an off-subnet sender IP, so no subnet check here.
    if (forMe || this.arpTable.has(p.senderIp)) {
      this.arpTable.set(p.senderIp, { mac: p.senderMac, iface, learnedAt: this.now });
      this.flushPending(p.senderIp);
    }
    if (p.op !== 'request') return;
    if (forMe || this.shouldProxy(iface, p.targetIp)) {
      this.transmitL3(iface, p.senderMac, {
        kind: 'arp',
        op: 'reply',
        senderMac: iface.mac,
        senderIp: p.targetIp,
        targetMac: p.senderMac,
        targetIp: p.senderIp,
      });
    }
  }

  private shouldProxy(iface: Interface, target: Ipv4Address): boolean {
    if (!this.forwarding || !this.proxyArp) return false;
    const ip = iface.ip!;
    if (sameSubnet(target, ip.address, ip.prefix)) return false;
    const path = this.lookup(target);
    return path !== undefined && path.iface !== iface;
  }

  private flushPending(ip: Ipv4Address): void {
    const queue = this.pendingArp.get(ip);
    if (!queue) return;
    this.pendingArp.delete(ip);
    for (const p of queue) {
      const path = this.lookup(p.dst);
      if (path) this.output(p, path);
    }
  }

  /** Puts a packet on the wire from a Layer 3 interface. Sub-interfaces tag; switches override for SVIs. */
  protected transmitL3(iface: Interface, dstMac: MacAddress, payload: IpPacket | ArpPacket): void {
    if (iface.kind === 'subinterface') {
      const parent = iface.parent!;
      const frame: Frame = { src: iface.mac, dst: dstMac, payload };
      if (!iface.encapNative) frame.vlan = iface.encapVlan;
      this.send(parent, frame);
      return;
    }
    if (iface.kind === 'loopback') return;
    this.send(iface, { src: iface.mac, dst: dstMac, payload });
  }

  // ---------------------------------------------------------------- helpers for the CLI

  addStaticRoute(route: StaticRoute): void {
    const network = networkAddress(route.network, route.prefix);
    if (network !== route.network) throw new Error('Inconsistent address and mask');
    this.removeStaticRoute(route);
    this.staticRoutes.push({ ...route });
  }

  removeStaticRoute(route: Pick<StaticRoute, 'network' | 'prefix' | 'nextHop' | 'exitInterface'>): void {
    const i = this.staticRoutes.findIndex(
      (r) => r.network === route.network && r.prefix === route.prefix && r.nextHop === route.nextHop && r.exitInterface === route.exitInterface,
    );
    if (i >= 0) this.staticRoutes.splice(i, 1);
  }

  /** Assigns an address, rejecting overlaps with other interfaces like IOS does. */
  setIp(iface: Interface, address: Ipv4Address, prefix: number): void {
    ipToInt(address);
    const net = networkAddress(address, prefix);
    if (prefix < 31 && (address === net || address === broadcastOf(address, prefix))) throw new Error('Bad mask /' + prefix + ' for address ' + address);
    for (const other of this.interfaces) {
      if (other === iface || !other.ip) continue;
      const shorter = Math.min(prefix, other.ip.prefix);
      if (sameSubnet(address, other.ip.address, shorter)) {
        throw new Error(`${networkAddress(address, prefix)} overlaps with ${other.name}`);
      }
    }
    iface.ip = { address, prefix };
  }
}

function broadcastOf(ip: Ipv4Address, prefix: number): Ipv4Address {
  const mask = ipToInt(prefixToMask(prefix));
  const n = (ipToInt(ip) & mask) | (~mask >>> 0);
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}
