import type { Frame } from '../core/frames';
import type { Link, Topology } from '../core/topology';
import { nextMac, type Ipv4Address, type MacAddress } from '../core/addressing';

export type SwitchportMode = 'access' | 'trunk';

export interface Interface {
  name: string; // "GigabitEthernet0/1"
  fullName: string; // "SW1 Gi0/1"
  device: Device;
  mac: MacAddress;
  adminUp: boolean;
  link?: Link;
  readonly isUp: boolean;
  // Layer 3 (routers, PCs, SVIs)
  ip?: { address: Ipv4Address; prefix: number };
  // Layer 2 (switches)
  mode: SwitchportMode;
  accessVlan: number;
  allowedVlans: Set<number> | 'all';
  nativeVlan: number;
  description?: string;
}

export function shortName(name: string): string {
  return name.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Ethernet/, 'Eth');
}

export abstract class Device {
  abstract readonly kind: 'pc' | 'switch' | 'router';
  readonly interfaces: Interface[] = [];
  protected topology?: Topology;
  /** Syslog-style messages, shown in the device console and the log panel. */
  readonly log: string[] = [];

  constructor(public hostname: string) {}

  attach(topology: Topology): void {
    this.topology = topology;
  }

  protected addInterface(name: string, adminUp: boolean): Interface {
    const iface: Interface = {
      name,
      get fullName() {
        return `${this.device.hostname} ${shortName(this.name)}`;
      },
      device: this,
      mac: nextMac(),
      adminUp,
      get isUp() {
        return this.adminUp && this.link !== undefined;
      },
      mode: 'access',
      accessVlan: 1,
      allowedVlans: 'all',
      nativeVlan: 1,
    };
    this.interfaces.push(iface);
    return iface;
  }

  /** Accepts "Gi0/1", "g0/1", "GigabitEthernet0/1". */
  iface(name: string): Interface {
    const wanted = normaliseIfName(name);
    const found = this.interfaces.find((i) => normaliseIfName(i.name) === wanted);
    if (!found) throw new Error(`${this.hostname} has no interface ${name}`);
    return found;
  }

  protected send(out: Interface, frame: Frame): void {
    this.topology?.transmit(out, frame);
  }

  protected get now(): number {
    return this.topology?.scheduler.now ?? 0;
  }

  protected schedule(delayMs: number, label: string, run: () => void): void {
    this.topology?.scheduler.schedule(delayMs, `${this.hostname}: ${label}`, run);
  }

  abstract receive(on: Interface, frame: Frame): void;
}

const IF_PREFIXES: Record<string, string> = { gi: 'gigabitethernet', fa: 'fastethernet', eth: 'ethernet', e: 'ethernet', g: 'gigabitethernet', f: 'fastethernet' };

export function normaliseIfName(name: string): string {
  const m = /^([a-z]+)\s*([\d/.]+)$/i.exec(name.trim());
  if (!m) return name.toLowerCase();
  const [, type = '', num = ''] = m;
  const lower = type.toLowerCase();
  const full = Object.values(IF_PREFIXES).find((p) => p === lower) ?? IF_PREFIXES[lower] ?? Object.values(IF_PREFIXES).find((p) => p.startsWith(lower)) ?? lower;
  return `${full}${num}`;
}
