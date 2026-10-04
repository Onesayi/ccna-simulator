import {
  BROADCAST_MAC,
  ipToInt,
  networkAddress,
  prefixToMask,
  sameSubnet,
  type Ipv4Address,
  type MacAddress,
} from '../core/addressing';
import type { ArpPacket, Frame, IpPacket, Packet, UdpPacket } from '../core/frames';
import type { ScheduledEvent } from '../core/scheduler';
import { Ipv6Stack } from '../ipv6/stack';
import { Device, type Interface } from './device';

/** How long a ping or traceroute probe waits for an answer (IOS and Windows both use 2 seconds). */
export const ICMP_TIMEOUT_MS = 2_000;
/** How long an unanswered ARP request stays pending before queued packets are dropped. */
export const ARP_TIMEOUT_MS = 2_000;
/** How long a TCP connection attempt waits for a SYN-ACK. */
export const TCP_TIMEOUT_MS = 4_000;
const TCP_RETRANSMIT_MS = 1_000;
export const LIMITED_BROADCAST: Ipv4Address = '255.255.255.255';

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

/** - `open`: SYN-ACK came back. `refused`: RST (nothing listening). `unreachable`: an ICMP error, such as an ACL deny. */
export type ConnectStatus = 'pending' | 'open' | 'refused' | 'unreachable' | 'timeout' | 'no-route';

export interface ConnectResult {
  destination: Ipv4Address;
  port: number;
  status: ConnectStatus;
  /** Who sent the ICMP error, for `unreachable`. */
  from?: Ipv4Address;
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

export type RouteCode = 'C' | 'L' | 'S' | 'O';

/** An entry in the routing table (RIB) as `show ip route` prints it. */
export interface Route {
  code: RouteCode;
  network: Ipv4Address;
  prefix: number;
  ad: number;
  metric: number;
  nextHop?: Ipv4Address;
  iface?: Interface;
  /** OSPF external type 2, shown as `O E2`. */
  external?: boolean;
  /** When a dynamic route was learned, for the age column. */
  learnedAt?: number;
}

interface Resolved {
  route: Route;
  iface: Interface;
  /** The address to ARP for: the next hop, or the destination itself when it is on-link. */
  arpTarget: Ipv4Address;
}

interface Waiter {
  resolve: (reply: IpPacket) => void;
  timer?: ScheduledEvent;
}

/**
 * The IPv4 stack shared by PCs, routers and switches (through their SVIs): ARP, a routing
 * table with connected, local, static and dynamic routes, packet forwarding with TTL handling,
 * the ICMP behaviour behind ping and traceroute, and TCP connection attempts. Routers plug
 * ACLs, NAT, DHCP and OSPF in through the protected hooks.
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
  /** TCP ports with a service listening (SYN gets SYN-ACK; anything else gets RST). */
  protected get listeningPorts(): readonly number[] {
    return [];
  }

  /** Hop limit for locally originated IPv6 packets: 64 on IOS, 128 on Windows. */
  protected readonly ipv6HopLimit: number = 64;
  readonly ipv6: Ipv6Stack;

  private pendingArp = new Map<Ipv4Address, IpPacket[]>();
  private waiters = new Map<string, Waiter>();
  private echoId = 1;
  private nextPort = 49152;

  constructor(hostname: string) {
    super(hostname);
    const device = this;
    this.ipv6 = new Ipv6Stack({
      interfaces: this.interfaces,
      routing: () => this.routesIpv6,
      get hopLimit() {
        return device.ipv6HopLimit;
      },
      transmit: (iface, mac, p) => this.transmitL3(iface, mac, p),
      schedule: (ms, label, run) => this.schedule(ms, label, run),
      cancel: (e) => this.cancel(e),
      now: () => this.now,
    });
  }

  /** `ipv6 unicast-routing`: only routers forward IPv6 and send router advertisements. */
  protected get routesIpv6(): boolean {
    return false;
  }

  override tick(): void {
    this.ipv6.tick();
  }

  /** Pings an IPv4 or IPv6 address. */
  pingAny(dst: string, count = 4, timeoutMs = ICMP_TIMEOUT_MS): PingResult[] {
    return dst.includes(':') ? this.ipv6.ping(dst, count, timeoutMs) : this.ping(dst, count, timeoutMs);
  }

  /** Traceroute to an IPv4 or IPv6 address. */
  tracerouteAny(dst: string, maxHops = 30, probesPerHop = 3, timeoutMs = ICMP_TIMEOUT_MS): TracerouteResult {
    return dst.includes(':') ? this.ipv6.traceroute(dst, maxHops, probesPerHop, timeoutMs) : this.traceroute(dst, maxHops, probesPerHop, timeoutMs);
  }

  /** Interfaces that are up and have an address. */
  ipInterfaces(): Interface[] {
    return this.interfaces.filter((i) => i.ip && i.isUp);
  }

  ownsIp(ip: Ipv4Address): boolean {
    return this.interfaces.some((i) => i.ip?.address === ip && i.isUp);
  }

  // ---------------------------------------------------------------- hooks for routers

  /** Extra static routes from the control plane, such as the default route DHCP hands a router. */
  protected extraStatics(): StaticRoute[] {
    return [];
  }

  /** Routes from a routing protocol, competing with statics on administrative distance. */
  protected dynamicRoutes(): Route[] {
    return [];
  }

  /** ACL check for a packet entering or leaving `iface`. */
  protected permits(_iface: Interface, _dir: 'in' | 'out', _p: IpPacket): boolean {
    return true;
  }

  /** NAT outside-to-inside, applied before routing. */
  protected natInbound(_iface: Interface, p: IpPacket): IpPacket {
    return p;
  }

  /** NAT inside-to-outside, applied after routing. `undefined` drops the packet (pool exhausted). */
  protected natOutbound(_ingress: Interface, _egress: Interface, p: IpPacket): IpPacket | undefined {
    return p;
  }

  /** Multicast groups this interface listens to (OSPF's 224.0.0.5). */
  protected acceptsMulticast(_mac: MacAddress, _iface: Interface): boolean {
    return false;
  }

  /** Virtual MACs this interface also receives frames for (HSRP). */
  protected acceptsMac(_mac: MacAddress, _iface: Interface): boolean {
    return false;
  }

  /** The virtual MAC to answer ARP with when `ip` is a virtual address we own on `iface` (HSRP). */
  protected virtualMacFor(_iface: Interface, _ip: Ipv4Address): MacAddress | undefined {
    return undefined;
  }

  /** Virtual addresses delivered locally, such as an HSRP virtual IP while we are active. */
  protected ownsVirtualIp(_ip: Ipv4Address): boolean {
    return false;
  }

  /** UDP control traffic that arrives on an interface (HSRP hellos). Returns true when consumed. */
  protected handleUdpControl(_iface: Interface, _p: UdpPacket, _frame: Frame): boolean {
    return false;
  }

  /** UDP addressed to us (NTP). */
  protected handleUdp(_p: UdpPacket): void {}

  /** Addresses we answer ARP for besides our own, such as NAT global addresses. */
  protected answersArpFor(_iface: Interface, _ip: Ipv4Address): boolean {
    return false;
  }

  /** DHCP client, server and relay. Returns true when the message was consumed. */
  protected handleDhcp(_iface: Interface, _p: UdpPacket): boolean {
    return false;
  }

  protected handleOspf(_iface: Interface, _p: IpPacket, _frame: Frame): void {}

  // ---------------------------------------------------------------- routing table

  /** The routing table as installed: connected and local routes plus the best static and dynamic routes. */
  routingTable(): Route[] {
    const routes: Route[] = [];
    for (const i of this.ipInterfaces()) {
      const { address, prefix } = i.ip!;
      routes.push({ code: 'C', network: networkAddress(address, prefix), prefix, ad: 0, metric: 0, iface: i });
      if (prefix < 32) routes.push({ code: 'L', network: address, prefix: 32, ad: 0, metric: 0, iface: i });
    }
    const connected = [...routes];

    const statics = this.forwarding
      ? [...this.staticRoutes, ...this.extraStatics()]
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
    const usable = [
      ...candidates.filter((r) => r.iface || this.resolveVia([...connected, ...candidates], r.nextHop!, 0)),
      ...(this.forwarding ? this.dynamicRoutes().filter((r) => r.iface?.isUp) : []),
    ];
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
    if (best.code === 'C' || best.code === 'L') return { route: best, iface: best.iface!, arpTarget: dst };
    if (best.iface) return { route: best, iface: best.iface, arpTarget: best.nextHop ?? dst };
    const via = this.resolveVia(table, best.nextHop!, depth + 1);
    return via && { route: best, iface: via.iface, arpTarget: via.arpTarget };
  }

  /** The route a router advertises as its gateway of last resort, if any. */
  gatewayOfLastResort(table = this.routingTable()): Route | undefined {
    return table.find((r) => r.prefix === 0 && r.code !== 'C' && r.code !== 'L');
  }

  // ---------------------------------------------------------------- ping, traceroute, connect

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
      this.expect(`icmp:${id}:${seq}`, timeoutMs, (reply) => {
        result.rttMs = this.now - sentAt;
        result.from = reply?.src;
        if (!reply) result.status = 'timeout';
        else if (reply.kind === 'icmp' && reply.type === 'echo-reply') Object.assign(result, { status: 'success', success: true, ttl: reply.ttl });
        else result.status = reply.kind === 'icmp' && reply.type === 'time-exceeded' ? 'ttl-exceeded' : 'unreachable';
        done();
      });
      if (!this.originate(dst, (src) => ({ kind: 'icmp', type: 'echo-request', src, dst, ttl: this.initialTtl, id, seq }))) {
        this.forget(`icmp:${id}:${seq}`);
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
      this.expect(`icmp:${id}:${seq}`, timeoutMs, (reply) => {
        const unreachable = reply?.kind === 'icmp' && reply.type === 'unreachable';
        hop.probes.push(reply ? { from: reply.src, rttMs: this.now - sentAt, unreachable } : {});
        next();
      });
      if (!this.originate(dst, (src) => ({ kind: 'icmp', type: 'echo-request', src, dst, ttl, id, seq }))) {
        this.forget(`icmp:${id}:${seq}`);
        hop.probes.push({});
        Object.assign(result, { done: true });
      }
    };
    this.schedule(0, `traceroute ${dst}`, () => probe(1, 0));
    return result;
  }

  /** Opens a TCP connection (SYN, then SYN-ACK or RST). The result fills in as the topology runs. */
  connect(dst: Ipv4Address, port: number, timeoutMs = TCP_TIMEOUT_MS): ConnectResult {
    ipToInt(dst);
    const result: ConnectResult = { destination: dst, port, status: 'pending' };
    const srcPort = this.nextPort++;
    this.schedule(0, `connect ${dst}:${port}`, () => {
      this.expect(`tcp:${srcPort}`, timeoutMs, (reply) => {
        if (!reply) result.status = 'timeout';
        else if (reply.kind === 'tcp') result.status = reply.flags === 'syn-ack' ? 'open' : 'refused';
        else Object.assign(result, { status: 'unreachable', from: reply.src });
      });
      const syn = (src: Ipv4Address): IpPacket => ({ kind: 'tcp', src, dst, ttl: this.initialTtl, srcPort, dstPort: port, flags: 'syn' });
      if (!this.originate(dst, syn)) {
        this.forget(`tcp:${srcPort}`);
        result.status = 'no-route';
        return;
      }
      // TCP retransmits an unanswered SYN, which covers the packets routers drop while they ARP.
      const retransmit = (at: number): void => {
        if (at >= timeoutMs) return;
        this.schedule(TCP_RETRANSMIT_MS, `connect ${dst}:${port} retransmit`, () => {
          if (result.status !== 'pending') return;
          this.originate(dst, syn);
          retransmit(at + TCP_RETRANSMIT_MS);
        });
      };
      retransmit(TCP_RETRANSMIT_MS);
    });
    return result;
  }

  private expect(key: string, timeoutMs: number, resolve: (reply: IpPacket | undefined) => void): void {
    const waiter: Waiter = { resolve };
    waiter.timer = this.schedule(timeoutMs, `timeout ${key}`, () => {
      this.waiters.delete(key);
      resolve(undefined);
    });
    this.waiters.set(key, waiter);
  }

  private forget(key: string): void {
    this.cancel(this.waiters.get(key)?.timer);
    this.waiters.delete(key);
  }

  private resolveWaiter(key: string, p: IpPacket): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    this.cancel(waiter.timer);
    waiter.resolve(p);
  }

  /** Sends a locally generated packet, sourced from the exit interface. Returns false when there is no route at all. */
  protected originate(dst: Ipv4Address, build: (src: Ipv4Address) => IpPacket): boolean {
    if (this.ownsIp(dst)) {
      // Talking to yourself never touches the wire.
      const p = build(dst);
      this.schedule(0, `local ${dst}`, () => this.deliverLocal(p));
      return true;
    }
    const path = this.lookup(dst);
    if (!path?.iface.ip) return false;
    this.output(build(path.iface.ip.address), path);
    return true;
  }

  /** Routes a packet we built ourselves (replies, relayed DHCP). Locally generated traffic skips outbound ACLs. */
  protected sendIp(p: IpPacket): void {
    if (this.ownsIp(p.dst)) {
      this.schedule(0, `local ${p.dst}`, () => this.deliverLocal(p));
      return;
    }
    const path = this.lookup(p.dst);
    if (path) this.output(p, path);
  }

  // ---------------------------------------------------------------- receive path

  /** Entry point for frames that reached this device's Layer 3 on `iface`. */
  protected receiveL3(iface: Interface, frame: Frame): void {
    const p = frame.payload;
    if (p.kind === 'icmpv6') return this.ipv6.receive(iface, p, frame);
    if (p.kind === 'bpdu' || p.kind === 'lacp' || p.kind === 'pagp' || p.kind === 'cdp' || p.kind === 'lldp') return; // link-local protocols
    const multicast = this.acceptsMulticast(frame.dst, iface);
    if (frame.dst !== iface.mac && frame.dst !== BROADCAST_MAC && !multicast && !this.acceptsMac(frame.dst, iface)) return;
    if (p.kind === 'arp') return this.handleArp(iface, p);
    const dhcp = p.kind === 'udp' && p.dhcp !== undefined;
    // A DHCP client has no address yet, so DHCP is the one thing an unaddressed interface takes.
    if (!iface.ip) {
      if (dhcp) this.handleDhcp(iface, p);
      return;
    }
    if (!this.permits(iface, 'in', p)) return this.icmpError('unreachable', p, iface);
    if (dhcp && this.handleDhcp(iface, p)) return;
    if (p.kind === 'ospf') return this.handleOspf(iface, p, frame);
    if (p.kind === 'udp' && this.handleUdpControl(iface, p, frame)) return;
    if (multicast) return;
    const q = this.natInbound(iface, p);
    if (this.ownsIp(q.dst) || q.dst === LIMITED_BROADCAST || this.ownsVirtualIp(q.dst)) return this.deliverLocal(q);
    if (frame.dst === BROADCAST_MAC || !this.forwarding) return;
    this.forward(q, iface);
  }

  private deliverLocal(p: IpPacket): void {
    if (p.kind === 'icmp') {
      if (p.type === 'echo-request') return this.sendIp({ ...p, type: 'echo-reply', src: p.dst, dst: p.src, ttl: this.initialTtl });
      if (p.type === 'echo-reply') return this.resolveWaiter(`icmp:${p.id}:${p.seq}`, p);
      // An error: match it to whatever we sent, using the quoted original.
      const o = p.original;
      return this.resolveWaiter(o?.kind === 'tcp' ? `tcp:${o.srcPort}` : `icmp:${p.id}:${p.seq}`, p);
    }
    if (p.kind === 'tcp') {
      if (p.flags !== 'syn') return this.resolveWaiter(`tcp:${p.dstPort}`, p);
      const flags = this.listeningPorts.includes(p.dstPort) ? 'syn-ack' : 'rst';
      return this.sendIp({ kind: 'tcp', src: p.dst, dst: p.src, ttl: this.initialTtl, srcPort: p.dstPort, dstPort: p.srcPort, flags });
    }
    if (p.kind === 'udp') this.handleUdp(p);
  }

  private forward(p: IpPacket, ingress: Interface): void {
    const ttl = p.ttl - 1;
    if (ttl <= 0) return this.icmpError('time-exceeded', p, ingress);
    const path = this.lookup(p.dst);
    if (!path) return this.icmpError('unreachable', p, ingress);
    const out = this.natOutbound(ingress, path.iface, { ...p, ttl });
    if (!out) return;
    if (!this.permits(path.iface, 'out', out)) return this.icmpError('unreachable', p, ingress);
    this.output(out, path);
  }

  /** Errors are sourced from the interface the offending packet arrived on. Never error about an error. */
  private icmpError(type: 'time-exceeded' | 'unreachable', p: IpPacket, ingress: Interface): void {
    if (p.kind === 'ospf' || p.kind === 'udp') return;
    if (p.kind === 'icmp' && p.type !== 'echo-request' && p.type !== 'echo-reply') return;
    const path = this.lookup(p.src);
    const src = ingress.ip?.address;
    if (!path || !src) return;
    const [id, seq] = p.kind === 'icmp' ? [p.id, p.seq] : [0, 0];
    this.output({ kind: 'icmp', type, src, dst: p.src, ttl: this.initialTtl, id, seq, original: p }, path);
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
    if (p.senderIp === ip.address && p.senderMac !== iface.mac) {
      // Someone else claims our address: a misconfigured host, or ARP poisoning.
      this.log.push(`%IP-4-DUPADDR: Duplicate address ${ip.address} on ${iface.name}, sourced by ${p.senderMac}`);
      return;
    }
    const virtual = this.virtualMacFor(iface, p.targetIp);
    const forMe = p.targetIp === ip.address || virtual !== undefined;
    // RFC 826: always refresh an existing entry; only create one when we are the target.
    // Replies to proxy ARP carry an off-subnet sender IP, so no subnet check here.
    if (forMe || this.arpTable.has(p.senderIp)) {
      this.arpTable.set(p.senderIp, { mac: p.senderMac, iface, learnedAt: this.now });
      this.flushPending(p.senderIp);
    }
    if (p.op !== 'request') return;
    if (forMe || this.answersArpFor(iface, p.targetIp) || this.shouldProxy(iface, p.targetIp)) {
      this.transmitL3(iface, p.senderMac, {
        kind: 'arp',
        op: 'reply',
        senderMac: virtual ?? iface.mac,
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
  protected transmitL3(iface: Interface, dstMac: MacAddress, payload: Packet, srcMac: MacAddress = iface.mac): void {
    if (iface.kind === 'subinterface') {
      const parent = iface.parent!;
      const frame: Frame = { src: srcMac, dst: dstMac, payload };
      if (!iface.encapNative) frame.vlan = iface.encapVlan;
      this.send(parent, frame);
      return;
    }
    if (iface.kind === 'loopback') return;
    this.send(iface, { src: srcMac, dst: dstMac, payload });
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
    iface.dhcpClient = undefined;
  }
}

export function broadcastOf(ip: Ipv4Address, prefix: number): Ipv4Address {
  const mask = ipToInt(prefixToMask(prefix));
  const n = (ipToInt(ip) & mask) | (~mask >>> 0);
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}


