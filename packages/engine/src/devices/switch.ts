import { BROADCAST_MAC, type MacAddress } from '../core/addressing';
import type { Frame } from '../core/frames';
import { Device, type Interface } from './device';

export interface MacTableEntry {
  vlan: number;
  mac: MacAddress;
  port: Interface;
  learnedAt: number;
}

/** MAC address table aging time, matching the Catalyst default of 300 seconds. */
export const MAC_AGING_MS = 300_000;

/** A Layer 2 switch: VLAN-aware MAC learning, flooding and 802.1Q trunking. */
export class Switch extends Device {
  readonly kind = 'switch' as const;
  readonly vlans = new Map<number, string>([[1, 'default']]);
  readonly macTable: MacTableEntry[] = [];

  constructor(hostname: string, portCount = 8) {
    super(hostname);
    for (let i = 1; i <= portCount; i++) this.addInterface(`GigabitEthernet0/${i}`, true);
  }

  receive(on: Interface, frame: Frame): void {
    const vlan = this.ingressVlan(on, frame);
    if (vlan === undefined) return; // dropped: VLAN not allowed on this port

    this.learn(vlan, frame.src, on);

    const known = frame.dst === BROADCAST_MAC ? undefined : this.lookup(vlan, frame.dst);
    if (known) {
      if (known.port !== on) this.egress(known.port, vlan, frame);
      return;
    }
    for (const port of this.interfaces) {
      if (port !== on && port.isUp && this.carriesVlan(port, vlan)) this.egress(port, vlan, frame);
    }
  }

  lookup(vlan: number, mac: MacAddress): MacTableEntry | undefined {
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

  private carriesVlan(port: Interface, vlan: number): boolean {
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
