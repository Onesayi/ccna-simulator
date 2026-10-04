import { BROADCAST_MAC, prefixToMask, sameSubnet, type Ipv4Address, type MacAddress } from '../core/addressing';
import {
  HSRP_V1_GROUP,
  HSRP_V1_MAC,
  HSRP_V2_GROUP,
  HSRP_V2_MAC,
  OSPF_ALL_ROUTERS,
  OSPF_ALL_ROUTERS_MAC,
  type DhcpMessage,
  type Frame,
  type IpPacket,
  type OspfMessage,
  type UdpPacket,
} from '../core/frames';
import { Hsrp } from '../routing/hsrp';
import { OspfProcess } from '../routing/ospf';
import { evaluateAcl, type Acl } from '../services/acl';
import { DhcpClient, DhcpServer } from '../services/dhcp';
import { Nat } from '../services/nat';
import { displayIfName, normaliseIfName, type Interface } from './device';
import { IosDevice } from './ios-device';
import { LIMITED_BROADCAST, type Route, type StaticRoute } from './ip-device';

/**
 * An IOS-style router. Physical GigabitEthernet ports start shut down, like a fresh ISR.
 * Supports 802.1Q sub-interfaces for router-on-a-stick and loopbacks, single-area OSPFv2,
 * IPv4 ACLs, NAT/PAT, DHCP as a server, relay and client, and HSRP.
 */
export class Router extends IosDevice {
  readonly kind = 'router' as const;
  readonly platform = 'cisco ISR4331';
  readonly software = 'Cisco IOS Software, ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 15.2(4)M, RELEASE SOFTWARE (fc1)';
  readonly ospf = new Map<number, OspfProcess>();
  readonly acls = new Map<string, Acl>();
  readonly dhcpServer = new DhcpServer();
  readonly dhcpClients = new Map<Interface, DhcpClient>();
  readonly nat = new Nat({
    aclPermits: (name, p) => {
      const acl = this.acls.get(name);
      return acl ? evaluateAcl(acl, p) === 'permit' : undefined;
    },
    interfaceAddress: (name) => this.findIface(name)?.ip?.address,
  });
  readonly hsrp = new Hsrp({
    interfaces: this.interfaces,
    log: this.log,
    now: () => this.now,
    findIface: (name) => this.findIface(name),
    send: (iface, msg, srcMac) => {
      if (!iface.ip) return;
      const v2 = msg.version === 2;
      const packet: IpPacket = { kind: 'udp', src: iface.ip.address, dst: v2 ? HSRP_V2_GROUP : HSRP_V1_GROUP, ttl: 1, srcPort: 1985, dstPort: 1985, hsrp: msg };
      this.transmitL3(iface, v2 ? HSRP_V2_MAC : HSRP_V1_MAC, packet, srcMac);
    },
  });
  /** `ip dhcp relay information trust-all`. */
  dhcpRelayTrustAll = false;
  /** `ipv6 unicast-routing`. */
  ipv6Routing = false;
  /** DHCP client interfaces that were down at the last round, so a lease is requested when they come up. */
  private readonly dhcpWasDown = new Set<Interface>();

  constructor(hostname: string, portCount = 3) {
    super(hostname);
    for (let i = 0; i < portCount; i++) this.addInterface(`GigabitEthernet0/${i}`, false);
  }

  get forwarding(): boolean {
    return true;
  }

  protected override get routesIpv6(): boolean {
    return this.ipv6Routing;
  }

  override configureInterface(name: string): Interface {
    const existing = this.findIface(name);
    if (existing) return existing;
    const canonical = normaliseIfName(name);
    const sub = /^(.+)\.(\d+)$/.exec(canonical);
    if (sub) {
      const parent = this.findIface(sub[1]!);
      if (!parent || parent.kind !== 'physical') throw new Error(`Invalid interface ${name}`);
      const iface = this.addInterface(displayIfName(canonical), true, 'subinterface', (i) => i.adminUp && i.parent!.isUp && i.encapVlan !== undefined);
      iface.parent = parent;
      iface.mac = parent.mac; // sub-interfaces share the physical port's burned-in address
      return iface;
    }
    if (/^loopback\d+$/.test(canonical)) return this.addInterface(displayIfName(canonical), true, 'loopback', (i) => i.adminUp);
    throw new Error(`Invalid interface ${name}`);
  }

  receive(on: Interface, frame: Frame): void {
    if (this.receiveDiscovery(on, frame)) return;
    const subs = this.interfaces.filter((i) => i.parent === on && i.isUp);
    let target: Interface | undefined;
    if (frame.vlan !== undefined) target = subs.find((i) => i.encapVlan === frame.vlan && !i.encapNative);
    else target = subs.find((i) => i.encapNative) ?? on;
    if (!target) return; // tag with no matching sub-interface: dropped
    const { vlan: _tag, ...untagged } = frame;
    this.receiveL3(target, untagged);
  }

  // ---------------------------------------------------------------- control plane rounds

  override tick(): void {
    super.tick();
    this.tickServices();
    this.hsrp.tick();
    for (const p of this.ospf.values()) p.tick();
    for (const [iface, client] of this.dhcpClients) {
      if (!iface.isUp) this.dhcpWasDown.add(iface);
      else if (this.dhcpWasDown.delete(iface) && client.state !== 'bound') client.start();
    }
  }

  override settle(): boolean {
    let changed = this.settleServices();
    changed = this.hsrp.settle() || changed;
    for (const p of this.ospf.values()) changed = p.settle() || changed;
    return changed;
  }

  protected cdpCapabilities(): string[] {
    return ['R', 'B', 'S', 'I'];
  }

  protected lldpCapabilities(): string[] {
    return ['R'];
  }

  // ---------------------------------------------------------------- HSRP

  protected override handleUdpControl(iface: Interface, p: UdpPacket): boolean {
    if (!p.hsrp || p.dstPort !== 1985) return false;
    this.hsrp.receive(iface, p.hsrp, p.src);
    return true;
  }

  protected override acceptsMac(mac: MacAddress, iface: Interface): boolean {
    return this.hsrp.ownsMac(iface, mac);
  }

  protected override virtualMacFor(iface: Interface, ip: Ipv4Address): MacAddress | undefined {
    return this.hsrp.activeMacFor(iface, ip);
  }

  protected override ownsVirtualIp(ip: Ipv4Address): boolean {
    return this.hsrp.ownsVip(ip);
  }

  ospfProcess(pid: number): OspfProcess {
    let p = this.ospf.get(pid);
    if (!p) {
      const clock = () => this.now;
      p = new OspfProcess(pid, {
        interfaces: this.interfaces,
        log: this.log,
        get clock() {
          return clock();
        },
        sendOspf: (iface, msg, to) => this.sendOspf(iface, msg, to),
        hasNonOspfDefault: () => this.routingTable().some((r) => r.prefix === 0 && r.code !== 'O'),
      });
      this.ospf.set(pid, p);
    }
    return p;
  }

  private sendOspf(iface: Interface, ospf: OspfMessage, to?: { ip: Ipv4Address; mac: MacAddress }): void {
    if (!iface.ip) return;
    const packet: IpPacket = { kind: 'ospf', src: iface.ip.address, dst: to?.ip ?? OSPF_ALL_ROUTERS, ttl: 1, ospf };
    this.transmitL3(iface, to?.mac ?? OSPF_ALL_ROUTERS_MAC, packet);
  }

  protected override acceptsMulticast(mac: MacAddress, iface: Interface): boolean {
    if (mac === HSRP_V1_MAC || mac === HSRP_V2_MAC) return (iface.hsrp?.groups.length ?? 0) > 0 && (iface.hsrp!.version === 2) === (mac === HSRP_V2_MAC);
    if (mac !== OSPF_ALL_ROUTERS_MAC) return false;
    return [...this.ospf.values()].some((p) => {
      const oi = p.ifaces.get(iface);
      return oi !== undefined && !oi.passive;
    });
  }

  protected override handleOspf(iface: Interface, p: IpPacket, frame: Frame): void {
    if (p.kind !== 'ospf') return;
    for (const proc of this.ospf.values()) proc.receive(iface, p, frame.src);
  }

  protected override dynamicRoutes(): Route[] {
    return [...this.ospf.values()].flatMap((p) => p.routes);
  }

  // ---------------------------------------------------------------- ACLs and NAT

  protected override standardAclPermits(name: string, src: Ipv4Address): boolean | undefined {
    const acl = this.acls.get(name);
    return acl ? evaluateAcl(acl, { kind: 'udp', src, dst: '0.0.0.0', ttl: 255, srcPort: 0, dstPort: 161 }) === 'permit' : undefined;
  }

  protected override permits(iface: Interface, dir: 'in' | 'out', p: IpPacket): boolean {
    const name = iface.accessGroup?.[dir];
    const acl = name ? this.acls.get(name) : undefined;
    // An access-group pointing at an ACL that does not exist filters nothing.
    return !acl || evaluateAcl(acl, p) === 'permit';
  }

  protected override natInbound(iface: Interface, p: IpPacket): IpPacket {
    return iface.nat === 'outside' && this.nat.configured ? this.nat.inbound(p) : p;
  }

  protected override natOutbound(ingress: Interface, egress: Interface, p: IpPacket): IpPacket | undefined {
    if (ingress.nat !== 'inside' || egress.nat !== 'outside' || !this.nat.configured) return p;
    return this.nat.outbound(p);
  }

  /** Answer ARP on the outside for NAT global addresses (static and pool), as IOS does. */
  protected override answersArpFor(iface: Interface, ip: Ipv4Address): boolean {
    if (iface.nat !== 'outside' || !iface.ip || !sameSubnet(ip, iface.ip.address, iface.ip.prefix)) return false;
    return this.nat.globals().includes(ip);
  }

  // ---------------------------------------------------------------- DHCP

  protected override extraStatics(): StaticRoute[] {
    // A DHCP-learned default route is installed with administrative distance 254.
    const out: StaticRoute[] = [];
    for (const [iface, c] of this.dhcpClients) {
      if (c.state === 'bound' && c.lease?.router && iface.ip) out.push({ network: '0.0.0.0', prefix: 0, nextHop: c.lease.router, ad: 254 });
    }
    return out;
  }

  /** `ip address dhcp`: become a DHCP client on this interface and ask for a lease now. */
  enableDhcpClient(iface: Interface): void {
    iface.ip = undefined;
    iface.dhcpClient = true;
    let client = this.dhcpClients.get(iface);
    if (!client) {
      client = new DhcpClient(iface.mac, {
        send: (msg) => this.dhcpBroadcast(iface, { kind: 'udp', src: '0.0.0.0', dst: LIMITED_BROADCAST, ttl: 255, srcPort: 68, dstPort: 67, dhcp: msg }),
        bound: (ack) => {
          iface.ip = { address: ack.yiaddr!, prefix: ack.prefix ?? 24 };
          this.log.push(`%DHCP-6-ADDRESS_ASSIGN: Interface ${iface.name} assigned DHCP address ${ack.yiaddr}, mask ${prefixToMask(ack.prefix ?? 24)}, hostname ${this.hostname}`);
        },
        failed: () => {},
        schedule: (ms, label, run) => this.schedule(ms, label, run),
        cancel: (e) => this.cancel(e),
      });
      this.dhcpClients.set(iface, client);
    }
    if (iface.isUp) client.start();
    else this.dhcpWasDown.add(iface);
  }

  disableDhcpClient(iface: Interface): void {
    const client = this.dhcpClients.get(iface);
    const release = client?.release();
    if (release && iface.ip && release.serverId) {
      this.sendIp({ kind: 'udp', src: iface.ip.address, dst: release.serverId, ttl: 255, srcPort: 68, dstPort: 67, dhcp: release });
    }
    this.dhcpClients.delete(iface);
    this.dhcpWasDown.delete(iface);
    iface.dhcpClient = undefined;
    iface.ip = undefined;
  }

  private dhcpBroadcast(iface: Interface, p: UdpPacket): void {
    this.transmitL3(iface, BROADCAST_MAC, p);
  }

  protected override handleDhcp(iface: Interface, p: UdpPacket): boolean {
    const msg = p.dhcp!;
    // Server-to-client traffic: either for our own DHCP client, or for a client behind us we relay for.
    if (p.dstPort === 68) return this.dhcpClients.get(iface)?.receive(msg) ?? false;
    if (!iface.ip) return false;
    const toUs = this.ownsIp(p.dst);
    if (msg.op === 'offer' || msg.op === 'ack' || msg.op === 'nak') {
      if (!toUs || !msg.giaddr) return false;
      const out = this.interfaces.find((i) => i.ip?.address === msg.giaddr && i.isUp);
      if (out) this.dhcpBroadcast(out, { kind: 'udp', src: msg.giaddr, dst: LIMITED_BROADCAST, ttl: 255, srcPort: 67, dstPort: 68, dhcp: msg });
      return true;
    }
    if (p.dst !== LIMITED_BROADCAST && !toUs) return false;
    // Option 82 with no relay address means a snooping switch added it. IOS drops such packets
    // unless the interface (or the whole router) trusts relay information.
    if (msg.option82 && !msg.giaddr && !iface.dhcpRelayTrusted && !this.dhcpRelayTrustAll) return true;
    // Client-to-server. Serve it if a pool covers the client's subnet, otherwise relay it.
    const via = msg.giaddr ?? iface.ip.address;
    if (this.dhcpServer.poolFor(via) || msg.op === 'release') {
      const reply = this.dhcpServer.respond(msg, via, iface.ip.address, this.interfaces.flatMap((i) => (i.ip ? [i.ip.address] : [])), this.now);
      if (reply) this.dhcpReply(iface, reply);
      return true;
    }
    if (p.dst === LIMITED_BROADCAST && iface.helpers?.length) {
      for (const helper of iface.helpers) {
        this.sendIp({ kind: 'udp', src: iface.ip.address, dst: helper, ttl: 255, srcPort: 67, dstPort: 67, dhcp: { ...msg, giaddr: msg.giaddr ?? iface.ip.address } });
      }
      return true;
    }
    return true;
  }

  private dhcpReply(iface: Interface, reply: DhcpMessage): void {
    if (reply.giaddr) {
      this.sendIp({ kind: 'udp', src: iface.ip!.address, dst: reply.giaddr, ttl: 255, srcPort: 67, dstPort: 67, dhcp: reply });
    } else {
      this.dhcpBroadcast(iface, { kind: 'udp', src: iface.ip!.address, dst: LIMITED_BROADCAST, ttl: 255, srcPort: 67, dstPort: 68, dhcp: reply });
    }
  }
}
