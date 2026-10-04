import type { Frame } from '../core/frames';
import type { Link, Topology } from '../core/topology';
import type { ScheduledEvent } from '../core/scheduler';
import { nextMac, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { Ipv6Address } from '../core/ipv6';

export type SwitchportMode = 'access' | 'trunk';

/**
 * - `physical`: a port with a cable socket.
 * - `subinterface`: a router sub-interface (Gi0/0.10) that rides its parent's cable with an 802.1Q tag.
 * - `svi`: a switch virtual interface (Vlan10), the switch's own Layer 3 presence in a VLAN.
 * - `loopback`: a virtual interface that is always up once enabled.
 * - `port-channel`: an EtherChannel (Port-channel1), up while at least one member port is bundled.
 */
export type InterfaceKind = 'physical' | 'subinterface' | 'svi' | 'loopback' | 'port-channel';

/** Why a port was err-disabled. `shutdown` then `no shutdown` brings it back. */
export type ErrDisableReason = 'bpduguard' | 'psecure-violation';

export type ChannelMode = 'on' | 'active' | 'passive' | 'desirable' | 'auto';

export type ViolationMode = 'shutdown' | 'restrict' | 'protect';

export interface SecureMac {
  mac: MacAddress;
  vlan: number;
  type: 'static' | 'sticky' | 'dynamic';
}

/** `switchport port-security ...` on an access port. */
export interface PortSecurityConfig {
  enabled: boolean;
  maximum: number;
  violation: ViolationMode;
  sticky: boolean;
  addresses: SecureMac[];
  violations: number;
  /** The source MAC and VLAN of the last frame seen, as `show port-security interface` reports it. */
  lastSource?: { mac: MacAddress; vlan: number };
}

/** Per-port spanning tree settings. */
export interface InterfaceStpConfig {
  portfast?: boolean;
  bpduGuard?: boolean;
  /** `spanning-tree guard root`: never let this port become the root port. */
  guardRoot?: boolean;
  cost?: number;
  priority?: number;
}

export interface Ipv6InterfaceAddress {
  address: Ipv6Address;
  prefix: number;
  /** Typed as `<prefix>/64 eui-64`; the interface ID comes from the MAC. */
  eui64?: boolean;
  /** Learned from a router advertisement (SLAAC). */
  slaac?: boolean;
}

export interface Ipv6InterfaceConfig {
  /** `ipv6 enable`: a link-local address without any global one. */
  enabled: boolean;
  addresses: Ipv6InterfaceAddress[];
  /** `ipv6 address fe80::1 link-local`; otherwise the link-local address is derived with EUI-64. */
  linkLocal?: Ipv6Address;
  /** `ipv6 address autoconfig` on a router, or SLAAC on a PC. */
  autoconfig?: boolean;
}

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
  /** `bandwidth` in kbps, used for the OSPF cost. Defaults to the port speed. */
  bandwidth?: number;
  /** Per-interface OSPF settings (`ip ospf ...`). */
  ospf?: InterfaceOspfConfig;
  /** `ip access-group <acl> in|out`. */
  accessGroup?: { in?: string; out?: string };
  /** `ip nat inside` / `ip nat outside`. */
  nat?: 'inside' | 'outside';
  /** `ip helper-address`: DHCP relay targets. */
  helpers?: Ipv4Address[];
  /** `ip address dhcp`: the address comes from a DHCP server. */
  dhcpClient?: boolean;
  /** Set when a violation shut the port down (BPDU guard, port security). */
  errDisabled?: ErrDisableReason;
  /** `channel-group <n> mode <mode>` on a member port. */
  channelGroup?: { id: number; mode: ChannelMode };
  /** Members only: true while the port is bundled into its port-channel. */
  bundled?: boolean;
  stp?: InterfaceStpConfig;
  portSecurity?: PortSecurityConfig;
  ipv6?: Ipv6InterfaceConfig;
  /** `no cdp enable` sets this to false. */
  cdp?: boolean;
  /** `no lldp transmit` / `no lldp receive`. */
  lldp?: { transmit?: boolean; receive?: boolean };
  /** HSRP groups on this interface (`standby ...`). */
  hsrp?: HsrpInterfaceConfig;
  /** `ip dhcp snooping trust` and `ip dhcp snooping limit rate`. */
  dhcpSnooping?: { trust?: boolean; rateLimit?: number };
  /** `ip dhcp relay information trusted`: accept DHCP packets carrying option 82 without a relay address. */
  dhcpRelayTrusted?: boolean;
}

export interface HsrpGroupConfig {
  group: number;
  vip?: Ipv4Address;
  priority: number;
  preempt: boolean;
  /** `standby <g> track <interface> [decrement]`: lower the priority while that interface is down. */
  tracks: { iface: string; decrement: number }[];
}

export interface HsrpInterfaceConfig {
  version: 1 | 2;
  groups: HsrpGroupConfig[];
}

export interface InterfaceOspfConfig {
  /** `ip ospf <pid> area <area>`: enables OSPF here without a `network` statement. */
  process?: { pid: number; area: number };
  cost?: number;
  priority?: number;
  helloInterval?: number;
  deadInterval?: number;
  network?: 'broadcast' | 'point-to-point';
}

/** Ethernet only comes up when both ends of the cable are enabled; a shut (or err-disabled) far end leaves us down/down. */
export function peerUp(i: Interface): boolean {
  const link = i.link;
  if (!link) return false;
  const far = link.a === i ? link.b : link.a;
  return far.adminUp && !far.errDisabled;
}

export function shortName(name: string): string {
  return name
    .replace(/^GigabitEthernet/, 'Gi')
    .replace(/^FastEthernet/, 'Fa')
    .replace(/^Ethernet/, 'Eth')
    .replace(/^Loopback/, 'Lo')
    .replace(/^Port-channel/, 'Po');
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
    const upRule = isUp ?? ((i: Interface) => i.adminUp && !i.errDisabled && peerUp(i));
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

  /** Start of a convergence round: send periodic control-plane messages (OSPF hellos). */
  tick(): void {}

  /** End of a convergence round. Returns true when state changed and another round is needed. */
  settle(): boolean {
    return false;
  }
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
  po: 'port-channel',
};

/** Canonical lower-case interface name: "g0/1" and "GigabitEthernet 0/1" both become "gigabitethernet0/1". */
export function normaliseIfName(name: string): string {
  const m = /^([a-z-]+)\s*([\d/.]+)$/i.exec(name.trim());
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
    'port-channel': 'Port-channel',
  };
  const m = /^([a-z-]+)(.*)$/.exec(n);
  if (!m) return name;
  return `${proper[m[1]!] ?? m[1]}${m[2]}`;
}
