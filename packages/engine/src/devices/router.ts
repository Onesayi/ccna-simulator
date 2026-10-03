import type { Frame } from '../core/frames';
import { displayIfName, normaliseIfName, type Interface } from './device';
import { IpDevice } from './ip-device';

/**
 * An IOS-style router. Physical GigabitEthernet ports start shut down, like a fresh ISR.
 * Supports 802.1Q sub-interfaces for router-on-a-stick and loopbacks.
 */
export class Router extends IpDevice {
  readonly kind = 'router' as const;

  constructor(hostname: string, portCount = 3) {
    super(hostname);
    for (let i = 0; i < portCount; i++) this.addInterface(`GigabitEthernet0/${i}`, false);
  }

  get forwarding(): boolean {
    return true;
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
}
