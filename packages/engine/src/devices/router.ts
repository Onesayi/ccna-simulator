import { BROADCAST_MAC, prefixToMask, sameSubnet, type Ipv4Address, type MacAddress } from '../core/addressing';
import { OSPF_ALL_ROUTERS, OSPF_ALL_ROUTERS_MAC, type DhcpMessage, type Frame, type IpPacket, type OspfMessage, type UdpPacket } from '../core/frames';
import { OspfProcess } from '../routing/ospf';
import { evaluateAcl, type Acl } from '../services/acl';
import { DhcpClient, DhcpServer } from '../services/dhcp';
import { Nat } from '../services/nat';
import { displayIfName, normaliseIfName, type Interface } from './device';
import { IpDevice, LIMITED_BROADCAST, type Route, type StaticRoute } from './ip-device';

/**
 * An IOS-style router. Physical GigabitEthernet ports start shut down, like a fresh ISR.
 * Supports 802.1Q sub-interfaces for router-on-a-stick and loopbacks, single-area OSPFv2,
 * IPv4 ACLs, NAT/PAT, and DHCP as a server, relay and client.
 */
export class Router extends IpDevice {
  readonly kind = 'router' as const;
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
  /** Telnet and SSH answer on the VTY lines. */
  protected override readonly listeningPorts = [22, 23];
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
    for (const p of this.ospf.values()) p.tick();
    for (const [iface, client] of this.dhcpClients) {
      if (!iface.isUp) this.dhcpWasDown.add(iface);
      else if (this.dhcpWasDown.delete(iface) && client.state !== 'bound') client.start();
    }
  }

  override settle(): boolean {
    let changed = false;
    for (const p of this.ospf.values()) changed = p.settle() || changed;
    return changed;
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
