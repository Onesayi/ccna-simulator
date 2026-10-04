import { BROADCAST_MAC, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { CapwapMessage, Dot11Frame, Frame, UdpPacket, WlanAdvert, WlanSecurity } from '../core/frames';
import { Aaa, type AaaServer } from '../services/aaa';
import { AKM_FOR, deriveMic } from '../wireless/wifi';
import { CAPWAP_CONTROL, CAPWAP_DATA } from './ap';
import type { Interface } from './device';
import { IpDevice } from './ip-device';

/** AireOS: a new WLAN is WPA2 with 802.1X, and disabled. */
export interface Wlan {
  id: number;
  profile: string;
  ssid: string;
  enabled: boolean;
  /** The interface (and so the VLAN) client traffic is bridged onto. */
  interface: string;
  /** `config wlan security wpa enable|disable`: off means an open WLAN. */
  wpa: boolean;
  wpa2: boolean;
  wpa3: boolean;
  akm: { psk: boolean; sae: boolean; dot1x: boolean };
  /** The WPA2/WPA3-Personal passphrase. */
  psk?: string;
  /** RADIUS server indexes for 802.1X; none means every configured server. */
  radius: number[];
}

/** What a WLAN's settings add up to, or why it cannot be enabled. */
export function wlanSecurity(w: Wlan): WlanSecurity | { error: string } {
  if (!w.wpa) return 'open';
  if (w.wpa3 && w.akm.sae) return w.psk ? 'wpa3-sae' : { error: 'SAE requires a PSK: config wlan security wpa akm psk set-key ascii <key> <id>' };
  if (w.wpa3 && !w.wpa2) return { error: 'WPA3 needs the SAE AKM: config wlan security wpa akm sae enable <id>' };
  if (w.akm.psk) return w.psk ? 'wpa2-psk' : { error: 'PSK is enabled but no key is set: config wlan security wpa akm psk set-key ascii <key> <id>' };
  if (w.akm.dot1x) return 'wpa2-enterprise';
  return { error: 'WPA2 is enabled but no AKM is: enable psk or 802.1x' };
}

export interface WlcInterface {
  name: string;
  /** 0 is untagged. */
  vlan: number;
  address?: Ipv4Address;
  prefix?: number;
  gateway?: Ipv4Address;
}

export interface JoinedAp {
  name: string;
  address: Ipv4Address;
  /** Answered an echo this round. */
  heard: boolean;
  joinedAt: number;
}

export type ClientState = 'AUTHCHECK' | '8021X_REQD' | 'START' | 'RUN';

export interface WirelessClientEntry {
  mac: MacAddress;
  ap: string;
  wlan: number;
  /** The AP radio the client talks to (the BSSID). */
  bssid: MacAddress;
  state: ClientState;
  security: WlanSecurity;
  username?: string;
  ip?: Ipv4Address;
}

/** `config 802.11b|a channel ap <ap> <ch>`: a static channel, or DCA's choice (auto). */
export interface ApRadioConfig {
  b?: number;
  a?: number;
}

const CHANNELS_24 = [1, 6, 11];
const CHANNELS_5 = [36, 40, 44, 48];

/**
 * An AireOS wireless LAN controller. One port (a trunk to the switch) carries the management
 * interface and any dynamic interfaces, each in its own VLAN. APs join it over CAPWAP; every client
 * frame they tunnel is decided here: open, PSK and SAE association, the 4-way handshake, 802.1X
 * against RADIUS. Client data is then bridged onto the VLAN of the WLAN's interface.
 */
export class WirelessController extends IpDevice {
  readonly kind = 'wlc' as const;
  readonly port: Interface;
  readonly wlans = new Map<number, Wlan>();
  readonly aps = new Map<string, JoinedAp>();
  readonly clients = new Map<MacAddress, WirelessClientEntry>();
  /** Per-AP static channels, kept across rejoins. */
  readonly radioConfig = new Map<string, ApRadioConfig>();
  readonly aaa: Aaa;
  /** Event log, like `show msglog`. */
  readonly msglog: string[] = [];
  private changed = false;

  constructor(hostname: string) {
    super(hostname);
    this.port = this.addInterface('GigabitEthernet1', true);
    this.addWlcInterface('management', 0);
    this.aaa = new Aaa({
      users: new Map(),
      enablePassword: () => undefined,
      sendRadius: (server, port, radius) => this.originate(server.address!, (src) => ({ kind: 'udp', src, dst: server.address!, ttl: 255, srcPort: 32768 + server.stats.requests, dstPort: port, radius })),
      sendTacacs: () => false,
      schedule: (ms, label, run) => this.schedule(ms, label, run),
      cancel: (e) => this.cancel(e),
    });
  }

  /** Like a host, the controller holds packets while ARP resolves. */
  protected override readonly queueDuringArp = true;

  get forwarding(): boolean {
    return false;
  }

  get management(): Interface {
    return this.findIface('management')!;
  }

  // ---------------------------------------------------------------- interfaces

  /** The controller's interfaces: management first, then dynamic interfaces. */
  wlcInterfaces(): WlcInterface[] {
    return this.interfaces
      .filter((i) => i.kind === 'subinterface')
      .map((i) => ({ name: i.name, vlan: i.encapNative ? 0 : i.encapVlan!, address: i.ip?.address, prefix: i.ip?.prefix, gateway: this.gateways.get(i.name) }));
  }

  private readonly gateways = new Map<string, Ipv4Address>();

  addWlcInterface(name: string, vlan: number): Interface {
    if (this.findIface(name)) throw new Error(`Interface ${name} already exists.`);
    const i = this.addInterface(name, true, 'subinterface', (x) => x.adminUp && x.parent!.isUp);
    i.parent = this.port;
    i.mac = this.port.mac;
    this.setVlan(i, vlan);
    return i;
  }

  setVlan(i: Interface, vlan: number): void {
    i.encapVlan = vlan || 1;
    i.encapNative = vlan === 0;
  }

  setInterfaceAddress(name: string, address: Ipv4Address, prefix: number, gateway: Ipv4Address): void {
    const i = this.findIface(name);
    if (!i || i.kind !== 'subinterface') throw new Error(`Interface ${name} does not exist.`);
    this.setIp(i, address, prefix);
    this.gateways.set(i.name, gateway);
    if (i.name === 'management') this.defaultGateway = gateway;
  }

  deleteWlcInterface(name: string): void {
    const i = this.findIface(name);
    if (!i || i.kind !== 'subinterface' || i.name === 'management') throw new Error(`Interface ${name} cannot be deleted.`);
    if ([...this.wlans.values()].some((w) => w.interface === i.name)) throw new Error(`Interface ${name} is in use by a WLAN.`);
    this.interfaces.splice(this.interfaces.indexOf(i), 1);
    this.gateways.delete(i.name);
  }

  /** The VLAN (0 untagged) a WLAN's clients are bridged onto. */
  vlanOf(w: Wlan): number | undefined {
    const i = this.findIface(w.interface);
    if (!i) return undefined;
    return i.encapNative ? 0 : i.encapVlan;
  }

  // ---------------------------------------------------------------- WLANs and RADIUS

  createWlan(id: number, profile: string, ssid: string): Wlan {
    if (this.wlans.has(id)) throw new Error(`WLAN ${id} already exists.`);
    if ([...this.wlans.values()].some((w) => w.profile === profile)) throw new Error(`Profile name ${profile} is already in use.`);
    const w: Wlan = { id, profile, ssid, enabled: false, interface: 'management', wpa: true, wpa2: true, wpa3: false, akm: { psk: false, sae: false, dot1x: true }, radius: [] };
    this.wlans.set(id, w);
    return w;
  }

  /** The WLANs the APs should beacon. */
  adverts(): WlanAdvert[] {
    const out: WlanAdvert[] = [];
    for (const w of this.wlans.values()) {
      const security = wlanSecurity(w);
      if (w.enabled && typeof security === 'string') out.push({ id: w.id, ssid: w.ssid, security });
    }
    return out;
  }

  radiusServer(index: number): AaaServer | undefined {
    return this.aaa.servers.get(String(index));
  }

  addRadiusServer(index: number, address: Ipv4Address, port: number, secret: string): void {
    const s = this.aaa.server(String(index), 'radius');
    s.address = address;
    s.authPort = port;
    s.acctPort = port + 1;
    s.key = secret;
  }

  /** Disables a WLAN: its clients are told to leave. */
  disableWlan(w: Wlan): void {
    w.enabled = false;
    for (const c of [...this.clients.values()]) if (c.wlan === w.id) this.deauth(c, 'The network was disabled.');
  }

  // ---------------------------------------------------------------- channels (RRM)

  /** DCA: every AP not set by hand gets the least-used non-overlapping channel. */
  channelsFor(ap: string): [number, number] {
    const pick = (band: 'b' | 'a', choices: number[]): number => {
      const fixed = this.radioConfig.get(ap)?.[band];
      if (fixed !== undefined) return fixed;
      const used = new Map<number, number>(choices.map((c) => [c, 0]));
      for (const other of this.aps.keys()) {
        if (other === ap) continue;
        const ch = this.assigned.get(other)?.[band === 'b' ? 0 : 1];
        if (ch !== undefined && used.has(ch)) used.set(ch, used.get(ch)! + 1);
      }
      return [...used].sort((x, y) => x[1] - y[1] || choices.indexOf(x[0]) - choices.indexOf(y[0]))[0]![0];
    };
    const current = this.assigned.get(ap);
    const b = this.radioConfig.get(ap)?.b ?? current?.[0] ?? pick('b', CHANNELS_24);
    const a = this.radioConfig.get(ap)?.a ?? current?.[1] ?? pick('a', CHANNELS_5);
    const ch: [number, number] = [b, a];
    this.assigned.set(ap, ch);
    return ch;
  }

  /** Channels in use by each joined AP. */
  readonly assigned = new Map<string, [number, number]>();

  /** Re-runs DCA for every AP that is not set by hand (`config 802.11b channel global auto`). */
  rerunDca(): void {
    for (const ap of this.aps.keys()) if (this.radioConfig.get(ap)?.b === undefined || this.radioConfig.get(ap)?.a === undefined) this.assigned.delete(ap);
    for (const ap of this.aps.keys()) this.channelsFor(ap);
  }

  /** 2.4 GHz channels overlap unless they are 5 apart (1, 6, 11). */
  static overlaps24(a: number, b: number): boolean {
    return Math.abs(a - b) < 5;
  }

  // ---------------------------------------------------------------- rounds

  override tick(): void {
    super.tick();
    for (const ap of this.aps.values()) ap.heard = false;
  }

  override settle(): boolean {
    let changed = super.settle() || this.changed;
    this.changed = false;
    for (const ap of [...this.aps.values()]) {
      if (ap.heard) continue;
      this.aps.delete(ap.name);
      this.assigned.delete(ap.name);
      for (const c of [...this.clients.values()]) if (c.ap === ap.name) this.clients.delete(c.mac);
      this.event(`AP ${ap.name} disassociated: heartbeat timeout`);
      changed = true;
    }
    return changed;
  }

  private event(text: string): void {
    this.msglog.push(text);
    this.log.push(text);
  }

  // ---------------------------------------------------------------- wire side

  receive(on: Interface, frame: Frame): void {
    if (on !== this.port) return;
    const p = frame.payload;
    if (p.kind === 'cdp' || p.kind === 'lldp' || p.kind === 'bpdu' || p.kind === 'lacp' || p.kind === 'pagp') return;
    const vlan = frame.vlan ?? 0;
    const { vlan: _tag, ...untagged } = frame;
    // Frames for wireless clients in this VLAN go down the CAPWAP tunnel to their AP.
    const clients = [...this.clients.values()].filter((c) => c.state === 'RUN' && this.vlanOf(this.wlans.get(c.wlan)!) === vlan);
    if (frame.dst === BROADCAST_MAC || frame.dst.startsWith('0100.5e') || frame.dst.startsWith('3333')) {
      for (const c of clients) this.toClient(c, untagged);
    } else {
      const c = clients.find((x) => x.mac === frame.dst);
      if (c) return this.toClient(c, untagged);
    }
    const iface = this.interfaces.find((i) => i.parent === this.port && i.isUp && (i.encapNative ? 0 : i.encapVlan) === vlan);
    if (iface) this.receiveL3(iface, untagged);
  }

  /** Bridges a client's frame onto the wired VLAN of its WLAN's interface. */
  private toWire(c: WirelessClientEntry, frame: Frame): void {
    const vlan = this.vlanOf(this.wlans.get(c.wlan)!);
    if (vlan === undefined) return;
    this.send(this.port, vlan === 0 ? frame : { ...frame, vlan });
  }

  // ---------------------------------------------------------------- CAPWAP

  private capwap(dst: Ipv4Address, capwap: CapwapMessage): void {
    const port = capwap.type === 'data' ? CAPWAP_DATA : CAPWAP_CONTROL;
    this.originate(dst, (src) => ({ kind: 'udp', src, dst, ttl: 255, srcPort: port, dstPort: port + 18, capwap }));
  }

  protected override handleUdp(p: UdpPacket): void {
    if (p.radius) return this.aaa.receiveRadius(p.src, p.radius);
    const c = p.capwap;
    if (!c || (p.dstPort !== CAPWAP_CONTROL && p.dstPort !== CAPWAP_DATA)) return;
    const me = this.management.ip?.address;
    if (!me) return;
    switch (c.type) {
      case 'discovery-request':
        return this.capwap(p.src, { type: 'discovery-response', wlcName: this.hostname, wlcIp: me });
      case 'join-request': {
        const name = c.apName ?? p.src;
        this.aps.set(name, { name, address: p.src, heard: true, joinedAt: this.now });
        this.event(`AP ${name} (${p.src}) joined`);
        this.changed = true;
        return this.capwap(p.src, { type: 'join-response', wlcName: this.hostname, wlans: this.adverts(), channels: this.channelsFor(name) });
      }
      case 'echo-request': {
        const ap = this.aps.get(c.apName ?? '');
        if (!ap || ap.address !== p.src) return;
        ap.heard = true;
        return this.capwap(p.src, { type: 'echo-response', wlcName: this.hostname, wlans: this.adverts(), channels: this.channelsFor(ap.name) });
      }
      case 'data': {
        const ap = this.aps.get(c.apName ?? '');
        if (!ap || ap.address !== p.src || !c.inner) return;
        return this.fromClient(ap, c.inner);
      }
      default:
    }
  }

  private toClient(c: WirelessClientEntry, inner: Frame): void {
    const ap = this.aps.get(c.ap);
    if (ap) this.capwap(ap.address, { type: 'data', apName: ap.name, client: c.mac, inner });
  }

  private reply(c: { mac: MacAddress; bssid: MacAddress; ap: string }, payload: Dot11Frame): void {
    const ap = this.aps.get(c.ap);
    if (ap) this.capwap(ap.address, { type: 'data', apName: ap.name, client: c.mac, inner: { src: c.bssid, dst: c.mac, payload } });
  }

  private deauth(c: WirelessClientEntry, reason: string): void {
    this.reply(c, { kind: 'dot11', subtype: 'deauth', reason });
    this.clients.delete(c.mac);
  }

  /** Disconnects a client (`config client deauthenticate <mac>`). */
  deauthenticate(mac: MacAddress): boolean {
    const c = this.clients.get(mac);
    if (!c) return false;
    this.deauth(c, 'Deauthenticated by the controller.');
    return true;
  }

  // ---------------------------------------------------------------- client state machine

  private fromClient(ap: JoinedAp, frame: Frame): void {
    const p = frame.payload;
    const mac = frame.src;
    if (p.kind !== 'dot11') {
      const c = this.clients.get(mac);
      if (!c || c.state !== 'RUN') return;
      if ((p.kind === 'udp' || p.kind === 'tcp' || p.kind === 'icmp') && p.src !== '0.0.0.0') c.ip = p.src;
      if (p.kind === 'arp' && p.senderIp !== '0.0.0.0') c.ip = p.senderIp;
      // Client to client in the same VLAN stays on the controller; everything else goes to the wire.
      const vlan = this.vlanOf(this.wlans.get(c.wlan)!);
      const peers = [...this.clients.values()].filter((x) => x !== c && x.state === 'RUN' && this.vlanOf(this.wlans.get(x.wlan)!) === vlan);
      const peer = peers.find((x) => x.mac === frame.dst);
      if (peer) return this.toClient(peer, frame);
      if (frame.dst === BROADCAST_MAC) for (const x of peers) this.toClient(x, frame);
      return this.toWire(c, frame);
    }
    const base = { mac, bssid: frame.dst, ap: ap.name };
    switch (p.subtype) {
      case 'auth': {
        const w = [...this.wlans.values()].find((x) => x.enabled && x.ssid === p.ssid);
        const security = w ? wlanSecurity(w) : undefined;
        if (!w || typeof security !== 'string') return this.reply(base, { kind: 'dot11', subtype: 'auth', status: 1, reason: 'The network is not available.' });
        if (security === 'wpa3-sae' && (p.algorithm !== 'sae' || p.mic !== deriveMic(w.ssid, w.psk!))) {
          this.event(`Client ${mac} SAE authentication failed on WLAN ${w.id}: password mismatch`);
          return this.reply(base, { kind: 'dot11', subtype: 'auth', status: 15, reason: 'The network security key isn\'t correct.' });
        }
        this.clients.set(mac, { ...base, wlan: w.id, state: 'AUTHCHECK', security });
        return this.reply(base, { kind: 'dot11', subtype: 'auth', status: 0 });
      }
      case 'assoc-request': {
        const c = this.clients.get(mac);
        if (!c) return this.reply(base, { kind: 'dot11', subtype: 'assoc-response', status: 1, reason: 'Not authenticated.' });
        if (p.akm !== AKM_FOR[c.security]) {
          this.clients.delete(mac);
          return this.reply(base, { kind: 'dot11', subtype: 'assoc-response', status: 43, reason: 'The security settings do not match the network.' });
        }
        this.reply(c, { kind: 'dot11', subtype: 'assoc-response', status: 0 });
        if (c.security === 'open') return this.run(c);
        if (c.security === 'wpa2-enterprise') {
          c.state = '8021X_REQD';
          return this.reply(c, { kind: 'dot11', subtype: 'eap', eap: 'request-identity' });
        }
        c.state = 'START';
        return this.reply(c, { kind: 'dot11', subtype: 'eapol-key', message: 1 });
      }
      case 'eap': {
        const c = this.clients.get(mac);
        if (!c || c.state !== '8021X_REQD' || p.eap !== 'credentials') return;
        c.username = p.identity;
        const w = this.wlans.get(c.wlan)!;
        const group = `wlan${w.id}`;
        this.aaa.groups.set(group, { name: group, protocol: 'radius', servers: w.radius.length ? w.radius.map(String) : [...this.aaa.servers.keys()] });
        this.aaa.authenticate([{ kind: 'group', group }], { username: p.identity, password: p.password, portType: 'Wireless-802.11' }, (o) => {
          if (this.clients.get(mac) !== c) return;
          if (o.status === 'pass') {
            this.event(`Client ${mac} (${p.identity ?? ''}) passed 802.1X on WLAN ${w.id}`);
            c.state = 'START';
            this.reply(c, { kind: 'dot11', subtype: 'eap', eap: 'success' });
            return this.reply(c, { kind: 'dot11', subtype: 'eapol-key', message: 1 });
          }
          const why = o.status === 'fail' ? 'rejected by the RADIUS server' : 'no RADIUS server responded';
          this.event(`Client ${mac} (${p.identity ?? ''}) failed 802.1X on WLAN ${w.id}: ${why}`);
          this.reply(c, { kind: 'dot11', subtype: 'eap', eap: 'failure', reason: o.status === 'fail' ? 'The credentials were rejected by the authentication server.' : 'The authentication server did not respond.' });
          this.clients.delete(mac);
        });
        return;
      }
      case 'eapol-key': {
        const c = this.clients.get(mac);
        if (!c || c.state !== 'START') return;
        const w = this.wlans.get(c.wlan)!;
        if (p.message === 2) {
          const secret = c.security === 'wpa2-enterprise' ? `802.1x:${c.username}` : w.psk!;
          if (p.mic !== deriveMic(w.ssid, secret)) {
            this.event(`Client ${mac} 4-way handshake failed on WLAN ${w.id}: MIC validation failed (wrong PSK)`);
            return this.deauth(c, 'The network security key isn\'t correct.');
          }
          return this.reply(c, { kind: 'dot11', subtype: 'eapol-key', message: 3 });
        }
        if (p.message === 4) this.run(c);
        return;
      }
      case 'deauth':
        this.clients.delete(mac);
        return;
      default:
    }
  }

  private run(c: WirelessClientEntry): void {
    c.state = 'RUN';
    this.event(`Client ${c.mac} associated to AP ${c.ap} on WLAN ${c.wlan}`);
  }
}
