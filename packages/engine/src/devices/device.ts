import type { Frame } from '../core/frames';
import type { Link, Topology } from '../core/topology';
import type { ScheduledEvent } from '../core/scheduler';
import { nextMac, type Ipv4Address, type MacAddress } from '../core/addressing';

export type SwitchportMode = 'access' | 'trunk';

/**
 * - `physical`: a port with a cable socket.
 * - `subinterface`: a router sub-interface (Gi0/0.10) that rides its parent's cable with an 802.1Q tag.
 * - `svi`: a switch virtual interface (Vlan10), the switch's own Layer 3 presence in a VLAN.
 * - `loopback`: a virtual interface that is always up once enabled.
 */
export type InterfaceKind = 'physical' | 'subinterface' | 'svi' | 'loopback';

export interface Interface {
  name: string; // "GigabitEthernet0/1"
  readonly fullName: string; // "SW1 Gi0/1"
  kind: InterfaceKind;
  device: Device;
  mac: MacAddress;
  adminUp: boolean;
  link?: Link;
  /** Line protocol state. Physical ports need a cable; virtual interfaces follow their own rules. */
  readonly isUp: boolean;
  // Layer 3 (routers, PCs, SVIs)
  ip?: { address: Ipv4Address; prefix: number };
  // Sub-interfaces
  parent?: Interface;
  /** `encapsulation dot1Q <vlan>` on a sub-interface. */
  encapVlan?: number;
  encapNative?: boolean;
  // SVIs
  vlan?: number;
  // Layer 2 (switches)
  mode: SwitchportMode;
  accessVlan: number;
  allowedVlans: Set<number> | 'all';
  nativeVlan: number;
  description?: string;
}

/** Ethernet only comes up when both ends of the cable are enabled; a shut far end leaves us down/down. */
export function peerUp(i: Interface): boolean {
  const link = i.link;
  if (!link) return false;
  return (link.a === i ? link.b : link.a).adminUp;
}

export function shortName(name: string): string {
  return name
    .replace(/^GigabitEthernet/, 'Gi')
    .replace(/^FastEthernet/, 'Fa')
    .replace(/^Ethernet/, 'Eth')
    .replace(/^Loopback/, 'Lo');
}

let deviceCounter = 0;

export abstract class Device {
  abstract readonly kind: 'pc' | 'switch' | 'router';
  /** Stable identity: survives `hostname` changes, so the UI and topology can key on it. */
  readonly id = `dev${++deviceCounter}`;
  readonly interfaces: Interface[] = [];
  protected topology?: Topology;
  /** Syslog-style messages, shown in the device console and the log panel. */
  readonly log: string[] = [];

  constructor(public hostname: string) {}

  attach(topology: Topology): void {
    this.topology = topology;
  }

  /** The topology this device belongs to, if any. */
  get network(): Topology | undefined {
    return this.topology;
  }

  protected addInterface(name: string, adminUp: boolean, kind: InterfaceKind = 'physical', isUp?: (i: Interface) => boolean): Interface {
    const upRule = isUp ?? ((i: Interface) => i.adminUp && peerUp(i));
    const iface: Interface = {
      name,
      kind,
      get fullName() {
        return `${this.device.hostname} ${shortName(this.name)}`;
      },
      device: this,
      mac: nextMac(),
      adminUp,
      get isUp() {
        return upRule(this);
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
    const found = this.findIface(name);
    if (!found) throw new Error(`${this.hostname} has no interface ${name}`);
    return found;
  }

  findIface(name: string): Interface | undefined {
    const wanted = normaliseIfName(name);
    return this.interfaces.find((i) => normaliseIfName(i.name) === wanted);
  }

  /**
   * The `interface <name>` command. Devices that support virtual interfaces (sub-interfaces,
   * SVIs, loopbacks) override this to create them on first use, like IOS does.
   */
  configureInterface(name: string): Interface {
    return this.iface(name);
  }

  /** Physical ports without a cable, in order. Used when the UI draws a new link. */
  freePorts(): Interface[] {
    return this.interfaces.filter((i) => i.kind === 'physical' && !i.link);
  }

  protected send(out: Interface, frame: Frame): void {
    this.topology?.transmit(out, frame);
  }

  protected get now(): number {
    return this.topology?.scheduler.now ?? 0;
  }

  protected schedule(delayMs: number, label: string, run: () => void): ScheduledEvent | undefined {
    return this.topology?.scheduler.schedule(delayMs, `${this.hostname}: ${label}`, run);
  }

  protected cancel(event: ScheduledEvent | undefined): void {
    if (event) this.topology?.scheduler.cancel(event);
  }

  abstract receive(on: Interface, frame: Frame): void;
}

const IF_PREFIXES: Record<string, string> = {
  gi: 'gigabitethernet',
  fa: 'fastethernet',
  eth: 'ethernet',
  e: 'ethernet',
  g: 'gigabitethernet',
  f: 'fastethernet',
  lo: 'loopback',
  vl: 'vlan',
};

/** Canonical lower-case interface name: "g0/1" and "GigabitEthernet 0/1" both become "gigabitethernet0/1". */
export function normaliseIfName(name: string): string {
  const m = /^([a-z]+)\s*([\d/.]+)$/i.exec(name.trim());
  if (!m) return name.toLowerCase();
  const [, type = '', num = ''] = m;
  const lower = type.toLowerCase();
  const full = Object.values(IF_PREFIXES).find((p) => p === lower) ?? IF_PREFIXES[lower] ?? Object.values(IF_PREFIXES).find((p) => p.startsWith(lower)) ?? lower;
  return `${full}${num}`;
}

/** Proper-case IOS name for a normalised one: "gigabitethernet0/0.10" -> "GigabitEthernet0/0.10". */
export function displayIfName(name: string): string {
  const n = normaliseIfName(name);
  const proper: Record<string, string> = {
    gigabitethernet: 'GigabitEthernet',
    fastethernet: 'FastEthernet',
    ethernet: 'Ethernet',
    loopback: 'Loopback',
    vlan: 'Vlan',
  };
  const m = /^([a-z]+)(.*)$/.exec(n);
  if (!m) return name;
  return `${proper[m[1]!] ?? m[1]}${m[2]}`;
}
