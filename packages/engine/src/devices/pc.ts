import { BROADCAST_MAC, ipToInt, type Ipv4Address } from '../core/addressing';
import { isLinkLocal, normaliseIpv6, type Ipv6Address } from '../core/ipv6';
import type { DhcpMessage, Dot11Frame, Frame, UdpPacket } from '../core/frames';
import { DhcpClient } from '../services/dhcp';
import { WifiClient, isBeaconing } from '../wireless/wifi';
import type { Interface } from './device';
import { IpDevice, LIMITED_BROADCAST } from './ip-device';

export type { PingResult } from './ip-device';

export interface PcOptions {
  /** A laptop: the NIC is a Wi-Fi radio (`Wireless0`) that is up only while associated. */
  wireless?: boolean;
  /** The NIC's name, for devices built on the PC (`GigabitEthernet0` on an AP). */
  nicName?: string;
}

/**
 * An end host with one NIC, a static or DHCP-assigned IP config, an ARP cache, ping/tracert
 * clients and a web server on ports 80 and 443 (so it can stand in for a server in ACL labs).
 */
export class Pc extends IpDevice {
  readonly kind: 'pc' | 'server' | 'ap' = 'pc';
  readonly nic: Interface;
  protected override readonly queueDuringArp = true;
  protected override readonly initialTtl = 128;
  protected override readonly ipv6HopLimit = 128;
  protected override get listeningPorts(): readonly number[] {
    return [80, 443];
  }
  /** True when the address comes from DHCP rather than static configuration. */
  dhcp = false;
  /** Set while the PC has a self-assigned 169.254.x.x address because no DHCP server answered. */
  apipa = false;
  dnsServer?: Ipv4Address;
  lease?: DhcpMessage;
  /** The Wi-Fi supplicant, on wireless clients only. */
  readonly wifi?: WifiClient;
  private readonly client: DhcpClient;

  constructor(hostname: string, options: PcOptions = {}) {
    super(hostname);
    this.nic = options.wireless
      ? this.addInterface('Wireless0', true, 'radio', (i) => i.adminUp && this.wifi!.connected)
      : this.addInterface(options.nicName ?? 'Ethernet0', true);
    if (options.wireless) {
      this.wifi = new WifiClient({
        radio: this.nic,
        scan: () => [...(this.network?.devices.values() ?? [])].flatMap((d) => (isBeaconing(d) ? d.beacons() : [])),
        transmit: (to, frame) => this.network?.transmitAir(this.nic, to, `air:${to.device.id}`, { src: this.nic.mac, dst: to.mac, payload: frame }),
        // A new network means a new subnet: ask DHCP again, as Windows does.
        connected: () => {
          if (this.dhcp) this.renew();
        },
        disconnected: () => this.arpTable.clear(),
      });
    }
    // Windows runs IPv6 out of the box: a link-local address, and no global one until configured.
    this.nic.ipv6 = { enabled: true, addresses: [] };
    this.client = new DhcpClient(this.nic.mac, {
      send: (msg) => this.broadcast({ kind: 'udp', src: '0.0.0.0', dst: LIMITED_BROADCAST, ttl: 128, srcPort: 68, dstPort: 67, dhcp: msg }),
      bound: (ack) => {
        this.nic.ip = { address: ack.yiaddr!, prefix: ack.prefix ?? 24 };
        this.defaultGateway = ack.router;
        this.dnsServer = ack.dns;
        this.lease = ack;
        this.apipa = false;
      },
      failed: () => this.autoconfigure(),
      schedule: (ms, label, run) => this.schedule(ms, label, run),
      cancel: (e) => this.cancel(e),
    });
  }

  get forwarding(): boolean {
    return false;
  }

  get gateway(): Ipv4Address | undefined {
    return this.defaultGateway;
  }

  /** ARP cache keyed by IP, for `arp -a` and tests. */
  get arpCache(): Map<Ipv4Address, string> {
    return new Map([...this.arpTable].map(([ip, e]) => [ip, e.mac]));
  }

  /** The DHCP exchange in progress or finished: idle, selecting, requesting or bound. */
  get dhcpState(): DhcpClient['state'] {
    return this.client.state;
  }

  configure(address: Ipv4Address, prefix: number, gateway?: Ipv4Address): void {
    ipToInt(address); // validates
    if (gateway) ipToInt(gateway);
    this.nic.ip = { address, prefix };
    this.defaultGateway = gateway;
    this.dhcp = false;
    this.apipa = false;
    this.lease = undefined;
  }

  /** A static IPv6 address and, optionally, a default gateway (often the router's link-local address). */
  configureIpv6(address: Ipv6Address, prefix: number, gateway?: Ipv6Address): void {
    const v6 = this.nic.ipv6!;
    v6.autoconfig = false;
    v6.addresses = [{ address: normaliseIpv6(address), prefix }];
    this.ipv6.gateway = gateway ? normaliseIpv6(gateway) : undefined;
  }

  /** SLAAC: ask for a router advertisement and build addresses from its /64 prefixes with EUI-64. */
  autoconfigureIpv6(): void {
    const v6 = this.nic.ipv6!;
    v6.autoconfig = true;
    v6.addresses = v6.addresses.filter((a) => a.slaac);
    this.ipv6.gateway = undefined;
    this.ipv6.solicit(this.nic);
  }

  get gateway6(): Ipv6Address | undefined {
    return this.ipv6.gateway;
  }

  /** True when the default gateway is a link-local address, as SLAAC sets it. */
  get gateway6IsLinkLocal(): boolean {
    return this.ipv6.gateway !== undefined && isLinkLocal(this.ipv6.gateway);
  }

  /** Switches the NIC to DHCP and starts DORA (`ipconfig /renew`). Run the topology to finish it. */
  renew(): void {
    if (!this.dhcp) {
      this.nic.ip = undefined;
      this.defaultGateway = undefined;
    }
    this.dhcp = true;
    this.client.start();
  }

  /** `ipconfig /release`: tells the server and drops the address. */
  release(): void {
    const msg = this.client.release();
    if (msg && this.nic.ip && msg.serverId) this.sendIp({ kind: 'udp', src: this.nic.ip.address, dst: msg.serverId, ttl: 128, srcPort: 68, dstPort: 67, dhcp: msg });
    this.dhcp = true;
    this.nic.ip = undefined;
    this.defaultGateway = undefined;
    this.lease = undefined;
    this.apipa = false;
  }

  /** Windows falls back to a link-local 169.254.0.0/16 address derived from the MAC, with no gateway. */
  private autoconfigure(): void {
    if (this.lease) return;
    const tail = parseInt(this.nic.mac.slice(-4), 16);
    this.nic.ip = { address: `169.254.${(tail >> 8) % 254 + 1}.${(tail & 0xff) % 254 + 1}`, prefix: 16 };
    this.defaultGateway = undefined;
    this.apipa = true;
  }

  /**
   * A lab attack tool: broadcasts gratuitous ARP replies claiming `ip` with this PC's MAC, which
   * overwrites the entry in every neighbour that already knows `ip` (ARP poisoning). Packets go
   * out `intervalMs` apart, so a large `count` is also an ARP flood.
   */
  gratuitousArp(ip: Ipv4Address, count = 1, intervalMs = 10): void {
    ipToInt(ip);
    for (let k = 0; k < count; k++) {
      this.schedule(k * intervalMs, `gratuitous ARP ${ip}`, () =>
        this.transmitL3(this.nic, BROADCAST_MAC, { kind: 'arp', op: 'reply', senderMac: this.nic.mac, senderIp: ip, targetMac: BROADCAST_MAC, targetIp: ip }),
      );
    }
  }

  private broadcast(p: UdpPacket): void {
    this.transmitL3(this.nic, BROADCAST_MAC, p);
  }

  protected override handleDhcp(_iface: Interface, p: UdpPacket): boolean {
    if (p.dstPort !== 68 || !this.dhcp) return false;
    return this.client.receive(p.dhcp!);
  }

  /** A wireless client reconnects on its own while it still has a profile, like Windows does. */
  override tick(): void {
    super.tick();
    if (this.wifi && this.wifi.state === 'disconnected' && this.wifi.profile) this.wifi.connect(this.wifi.profile);
  }

  /** On a wireless client, everything leaves through the radio to the AP we are associated with. */
  protected override send(out: Interface, frame: Frame): void {
    if (out.kind !== 'radio') return super.send(out, frame);
    const bss = this.wifi?.bss;
    if (!bss || (!this.wifi!.connected && frame.payload.kind !== 'dot11')) return;
    this.network?.transmitAir(out, bss.radio, `air:${bss.radio.device.id}`, frame);
  }

  receive(on: Interface, frame: Frame, from?: Interface): void {
    if (frame.payload.kind === 'dot11') {
      if (this.wifi && from) this.wifi.receive(frame.payload as Dot11Frame, from);
      return;
    }
    if (on.kind === 'radio' && !this.wifi?.connected) return;
    this.receiveL3(on, frame);
  }
}
