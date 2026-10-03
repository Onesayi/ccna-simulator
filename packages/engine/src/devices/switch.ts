import { BROADCAST_MAC, type MacAddress } from '../core/addressing';
import type { ArpPacket, Frame, IpPacket } from '../core/frames';
import { normaliseIfName, type Interface } from './device';
import { IpDevice } from './ip-device';

export interface MacTableEntry {
  vlan: number;
  mac: MacAddress;
  port: Interface;
  learnedAt: number;
}

/** MAC address table aging time, matching the Catalyst default of 300 seconds. */
export const MAC_AGING_MS = 300_000;

/**
 * A Catalyst-style switch: VLAN-aware MAC learning, flooding and 802.1Q trunking, plus
 * SVIs (`interface vlan 10`) for management, and inter-VLAN routing once `ip routing` is on.
 */
export class Switch extends IpDevice {
  readonly kind = 'switch' as const;
  readonly vlans = new Map<number, string>([[1, 'default']]);
  readonly macTable: MacTableEntry[] = [];
  /** `ip routing`: turns the switch into a Layer 3 switch that routes between its SVIs. */
  ipRouting = false;

  constructor(hostname: string, portCount = 8) {
    super(hostname);
    for (let i = 1; i <= portCount; i++) this.addInterface(`GigabitEthernet0/${i}`, true);
    this.configureInterface('Vlan1'); // every Catalyst ships with a (shut down) management SVI
  }

  get forwarding(): boolean {
    return this.ipRouting;
  }

  /** Physical switchports, without SVIs. */
  get ports(): Interface[] {
    return this.interfaces.filter((i) => i.kind === 'physical');
  }

  svi(vlan: number): Interface | undefined {
    return this.interfaces.find((i) => i.kind === 'svi' && i.vlan === vlan);
  }

  override configureInterface(name: string): Interface {
    const existing = this.findIface(name);
    if (existing) return existing;
    const m = /^vlan(\d+)$/.exec(normaliseIfName(name));
    if (!m) throw new Error(`Invalid interface ${name}`);
    const vlan = Number(m[1]);
    if (vlan < 1 || vlan > 4094) throw new Error('Invalid VLAN');
    // SVI autostate: up only while the VLAN exists and some port carrying it is up. New SVIs start shut down.
    const iface = this.addInterface(`Vlan${vlan}`, false, 'svi', (i) => i.adminUp && this.vlanActive(i.vlan!));
    iface.vlan = vlan;
    return iface;
  }

  private vlanActive(vlan: number): boolean {
    return this.vlans.has(vlan) && this.ports.some((p) => p.isUp && this.carriesVlan(p, vlan));
  }

  receive(on: Interface, frame: Frame): void {
    const vlan = this.ingressVlan(on, frame);
    if (vlan === undefined) return; // dropped: VLAN not allowed on this port

    this.learn(vlan, frame.src, on);
    this.switchFrame(vlan, frame, on);
  }

  /** Forwards a frame within a VLAN. `ingress` is undefined when the frame comes from our own SVI. */
  private switchFrame(vlan: number, frame: Frame, ingress: Interface | undefined): void {
    const svi = this.svi(vlan);
    if (ingress && svi?.isUp && (frame.dst === svi.mac || frame.dst === BROADCAST_MAC)) {
      const { vlan: _tag, ...untagged } = frame;
      this.receiveL3(svi, untagged);
      if (frame.dst === svi.mac) return;
    }

    const known = frame.dst === BROADCAST_MAC ? undefined : this.macLookup(vlan, frame.dst);
    if (known) {
      if (known.port !== ingress) this.egress(known.port, vlan, frame);
      return;
    }
    for (const port of this.ports) {
      if (port !== ingress && port.isUp && this.carriesVlan(port, vlan)) this.egress(port, vlan, frame);
    }
  }

  protected override transmitL3(iface: Interface, dstMac: MacAddress, payload: IpPacket | ArpPacket): void {
    if (iface.kind !== 'svi') return super.transmitL3(iface, dstMac, payload);
    this.switchFrame(iface.vlan!, { src: iface.mac, dst: dstMac, payload }, undefined);
  }

  /** MAC table lookup (`lookup` on the base class is the routing table lookup). */
  macLookup(vlan: number, mac: MacAddress): MacTableEntry | undefined {
    return this.macTable.find((e) => e.vlan === vlan && e.mac === mac && this.now - e.learnedAt < MAC_AGING_MS);
  }

  private learn(vlan: number, mac: MacAddress, port: Interface): void {
    const existing = this.macTable.find((e) => e.vlan === vlan && e.mac === mac);
    if (existing) {
      existing.port = port;
      existing.learnedAt = this.now;
    } else {
      this.macTable.push({ vlan, mac, port, learnedAt: this.now });
    }
  }

  private ingressVlan(port: Interface, frame: Frame): number | undefined {
    if (port.mode === 'access') return frame.vlan === undefined ? port.accessVlan : undefined;
    const vlan = frame.vlan ?? port.nativeVlan;
    return this.carriesVlan(port, vlan) ? vlan : undefined;
  }

  carriesVlan(port: Interface, vlan: number): boolean {
    if (!this.vlans.has(vlan)) return false;
    if (port.mode === 'access') return port.accessVlan === vlan;
    return port.allowedVlans === 'all' || port.allowedVlans.has(vlan);
  }

  private egress(port: Interface, vlan: number, frame: Frame): void {
    const tagged = port.mode === 'trunk' && vlan !== port.nativeVlan;
    const { vlan: _drop, ...untagged } = frame;
    this.send(port, tagged ? { ...untagged, vlan } : untagged);
  }
}
