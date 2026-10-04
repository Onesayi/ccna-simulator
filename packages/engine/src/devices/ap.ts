import { BROADCAST_MAC, isValidIp, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { CapwapMessage, Frame, UdpPacket, WlanAdvert } from '../core/frames';
import type { Beacon, Beaconing } from '../wireless/wifi';
import type { Interface } from './device';
import { LIMITED_BROADCAST } from './ip-device';
import { Pc } from './pc';

/** CAPWAP control (discovery, join, echo) and data (tunneled client frames). */
export const CAPWAP_CONTROL = 5246;
export const CAPWAP_DATA = 5247;

/** Option 43 for Cisco APs: type 0xf1, length 4 per controller, then each address in hex. */
export function parseOption43(hex: string | undefined): Ipv4Address[] {
  const h = (hex ?? '').replace(/\./g, '').toLowerCase();
  if (!h.startsWith('f1')) return [];
  const len = parseInt(h.slice(2, 4), 16);
  const out: Ipv4Address[] = [];
  for (let k = 0; k + 4 <= len; k += 4) {
    const bytes = h.slice(4 + k * 2, 4 + (k + 4) * 2);
    if (bytes.length < 8) break;
    out.push([0, 2, 4, 6].map((o) => parseInt(bytes.slice(o, o + 2), 16)).join('.'));
  }
  return out;
}

export interface ApController {
  name: string;
  address: Ipv4Address;
}

/**
 * A lightweight (CAPWAP) access point. It boots as a DHCP client, finds a controller (a primed
 * `primary-base`, DHCP option 43, or a broadcast on its own subnet), joins it, and from then on
 * beacons the controller's WLANs and tunnels every client frame to it: split MAC, where the AP
 * handles the radio and the controller makes every decision. Losing the echo exchange with the
 * controller drops the join, and every client with it.
 */
export class LightweightAp extends Pc implements Beaconing {
  override readonly kind = 'ap' as const;
  /** Dot11Radio0 (2.4 GHz) and Dot11Radio1 (5 GHz). */
  readonly radios: [Interface, Interface];
  /** `capwap ap primary-base <name> <ip>`. */
  primaryBase?: ApController;
  /** The controller this AP has joined. */
  controller?: ApController;
  wlans: WlanAdvert[] = [];
  /** Channels on the 2.4 GHz and 5 GHz radios, set by the controller. */
  channels: [number, number] = [1, 36];
  /** Associated stations: the client radio, and which of our radios it talks to. */
  readonly stations = new Map<MacAddress, { peer: Interface; radio: Interface }>();
  /** Controllers that answered discovery this round. */
  private discovered: ApController[] = [];
  private joining?: Ipv4Address;
  private awaitingEcho = false;
  private changed = false;
  private lastCandidates = '[]';

  constructor(hostname: string) {
    super(hostname, { nicName: 'GigabitEthernet0' });
    const up = (i: Interface) => i.adminUp && this.controller !== undefined;
    this.radios = [this.addInterface('Dot11Radio0', true, 'radio', up), this.addInterface('Dot11Radio1', true, 'radio', up)];
    // Lightweight APs boot as DHCP clients.
    this.dhcp = true;
  }

  get joined(): boolean {
    return this.controller !== undefined;
  }

  beacons(): Beacon[] {
    if (!this.joined) return [];
    return this.radios.flatMap((radio, band) => (radio.isUp ? this.wlans.map((wlan) => ({ radio, apName: this.hostname, wlan, channel: this.channels[band]! })) : []));
  }

  /** `capwap ap ip address`: a static address instead of DHCP. */
  setStaticIp(address: Ipv4Address, prefix: number, gateway?: Ipv4Address): void {
    this.configure(address, prefix, gateway);
    this.leaveController('static IP configured');
  }

  /** `clear capwap ap ip address`: back to DHCP. */
  useDhcp(): void {
    this.dhcp = true;
    this.nic.ip = undefined;
    this.defaultGateway = undefined;
    this.leaveController('IP address cleared');
  }

  // ---------------------------------------------------------------- rounds

  override tick(): void {
    super.tick();
    if (!this.nic.isUp) return;
    // Until it joins a controller, a DHCP-addressed AP keeps asking DHCP (and so picks up a new option 43).
    if (this.dhcp && !this.controller && (this.dhcpState === 'idle' || this.dhcpState === 'bound')) this.renew();
    if (!this.nic.ip || this.apipa) return;
    if (this.controller) {
      this.awaitingEcho = true;
      this.capwap(this.controller.address, { type: 'echo-request', apName: this.hostname });
      return;
    }
    this.discover();
  }

  override settle(): boolean {
    let changed = super.settle() || this.changed;
    this.changed = false;
    const candidates = JSON.stringify(this.controllerCandidates);
    if (!this.controller && candidates !== this.lastCandidates) changed = true;
    this.lastCandidates = candidates;
    if (this.controller && this.awaitingEcho) {
      this.leaveController('echo timer expired');
      changed = true;
    }
    if (this.controller && !this.nic.isUp) {
      this.leaveController('uplink down');
      changed = true;
    }
    return changed;
  }

  /** Discovery: unicast to a primed controller and to each option 43 address, and broadcast locally. */
  private discover(): void {
    this.discovered = [];
    this.joining = undefined;
    const targets = new Set<Ipv4Address>();
    if (this.primaryBase) targets.add(this.primaryBase.address);
    for (const a of parseOption43(this.lease?.option43)) targets.add(a);
    for (const t of targets) this.capwap(t, { type: 'discovery-request', apName: this.hostname });
    this.transmitL3(this.nic, BROADCAST_MAC, this.capwapPacket(LIMITED_BROADCAST, { type: 'discovery-request', apName: this.hostname }));
  }

  private leaveController(why: string): void {
    if (!this.controller) return;
    this.log.push(`%CAPWAP-3-ERRORLOG: Lost connection to controller ${this.controller.name} (${why}). Go join a capwap controller`);
    for (const [mac, s] of this.stations) {
      this.network?.transmitAir(s.radio, s.peer, `air:${this.id}`, { src: s.radio.mac, dst: mac, payload: { kind: 'dot11', subtype: 'deauth', reason: 'The access point lost its controller.' } });
    }
    this.stations.clear();
    this.controller = undefined;
    this.wlans = [];
    this.awaitingEcho = false;
    this.changed = true;
  }

  // ---------------------------------------------------------------- CAPWAP

  private capwapPacket(dst: Ipv4Address, capwap: CapwapMessage): UdpPacket {
    const port = capwap.type === 'data' ? CAPWAP_DATA : CAPWAP_CONTROL;
    return { kind: 'udp', src: this.nic.ip?.address ?? '0.0.0.0', dst, ttl: 64, srcPort: 5264 + (port - CAPWAP_CONTROL), dstPort: port, capwap };
  }

  private capwap(dst: Ipv4Address, capwap: CapwapMessage): void {
    this.originate(dst, (src) => ({ ...this.capwapPacket(dst, capwap), src }));
  }

  protected override handleUdp(p: UdpPacket): void {
    const c = p.capwap;
    if (!c || (p.srcPort !== CAPWAP_CONTROL && p.srcPort !== CAPWAP_DATA)) return super.handleUdp(p);
    switch (c.type) {
      case 'discovery-response': {
        if (this.controller || !c.wlcName || !c.wlcIp) return;
        const found = { name: c.wlcName, address: c.wlcIp };
        this.discovered.push(found);
        // Join the first controller that answers, unless the primed one answers too.
        const primed = found.name === this.primaryBase?.name && this.discovered[0]!.name !== found.name;
        if (this.joining && !primed) return;
        this.joining = found.address;
        this.capwap(found.address, { type: 'join-request', apName: this.hostname });
        return;
      }
      case 'join-response':
        if (this.controller || p.src !== this.joining) return;
        this.controller = { name: c.wlcName ?? 'WLC', address: p.src };
        this.apply(c);
        this.log.push(`%CAPWAP-5-JOINEDCONTROLLER: AP has joined controller ${this.controller.name}`);
        this.changed = true;
        return;
      case 'echo-response':
        if (p.src !== this.controller?.address) return;
        this.awaitingEcho = false;
        this.apply(c);
        return;
      case 'data': {
        // A frame from the controller for one of our clients.
        if (p.src !== this.controller?.address || !c.inner || !c.client) return;
        const s = this.stations.get(c.client);
        if (!s) return;
        const inner: Frame = { ...c.inner, src: c.inner.payload.kind === 'dot11' ? s.radio.mac : c.inner.src };
        this.network?.transmitAir(s.radio, s.peer, `air:${this.id}`, inner);
        if (inner.payload.kind === 'dot11' && inner.payload.subtype === 'deauth') this.stations.delete(c.client);
        return;
      }
      default:
    }
  }

  /** Takes the controller's WLANs and channels; a change means another round, so clients can react. */
  private apply(c: CapwapMessage): void {
    const before = JSON.stringify([this.wlans, this.channels]);
    if (c.wlans) this.wlans = c.wlans;
    if (c.channels) this.channels = c.channels;
    if (JSON.stringify([this.wlans, this.channels]) !== before) this.changed = true;
  }

  override receive(on: Interface, frame: Frame, from?: Interface): void {
    if (on.kind !== 'radio') return super.receive(on, frame, from);
    if (!this.controller || !from) return;
    // Split MAC: the AP keeps track of who is on which radio and forwards everything to the controller.
    this.stations.set(frame.src, { peer: from, radio: on });
    if (frame.payload.kind === 'dot11' && frame.payload.subtype === 'deauth') this.stations.delete(frame.src);
    this.capwap(this.controller.address, { type: 'data', apName: this.hostname, client: frame.src, inner: frame });
  }

  /** `show capwap client rcb`-style summary for the shell. */
  get controllerCandidates(): ApController[] {
    return [...(this.primaryBase ? [this.primaryBase] : []), ...parseOption43(this.lease?.option43).filter(isValidIp).map((address) => ({ name: '(option 43)', address }))];
  }
}
