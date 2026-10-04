import type { Device } from '../devices/device';

/** The five domains of the CCNA 200-301 v2.0 blueprint. */
export const DOMAINS = {
  '1.0': 'Network Infrastructure and Connectivity',
  '2.0': 'Switching and Network Access',
  '3.0': 'IP Routing',
  '4.0': 'Network Services and Security',
  '5.0': 'AI, and Network Operations and Management',
} as const;

export type DomainId = keyof typeof DOMAINS;

/**
 * - `guided`: a step-by-step task list on a fresh topology.
 * - `troubleshoot`: a pre-built network with faults to find and fix.
 * - `challenge`: an outcome to reach with little guidance.
 */
export type LabKind = 'guided' | 'troubleshoot' | 'challenge';

export interface LabDeviceSpec {
  hostname: string;
  kind: Device['kind'];
  /** Canvas position. */
  at: [number, number];
  /** PCs only: "192.168.1.10/24", or "dhcp" to start as a DHCP client (with no server yet, that means APIPA). */
  ip?: string;
  /** PCs only. */
  gateway?: string;
  /** PCs only: "2001:db8:1::10/64", or "auto" for SLAAC. */
  ipv6?: string;
  /** PCs only: the IPv6 default gateway. */
  gateway6?: string;
  /** PCs only: a fixed MAC address, for labs whose solution has to name it (ARP ACLs, static bindings). */
  mac?: string;
  /** Commands run before the lab starts: IOS from privileged EXEC, or the device's own shell (servers, controllers). */
  config?: string;
  /** Servers only: files to put on the server (inventories, playbooks), by name. */
  files?: Record<string, string>;
}

export interface LabTopology {
  devices: LabDeviceSpec[];
  /** Cables as "PC1 Eth0", "SW1 Gi0/1" pairs, using the hostnames above. */
  links: [string, string][];
}

/**
 * A check the grader runs against engine state. `device`, `from` and `to` name devices by their
 * hostname in the lab definition, so renaming a device with `hostname` does not break grading.
 */
export type Check =
  | { type: 'hostname'; device: string; name: string }
  | { type: 'interfaceUp'; device: string; interface: string }
  /** An exact `address`, or any usable host address inside `network`. */
  | { type: 'interfaceIp'; device: string; interface: string; prefix: number; address?: string; network?: string }
  | { type: 'defaultGateway'; device: string; address: string }
  | { type: 'vlan'; device: string; id: number; name?: string }
  | { type: 'accessVlan'; device: string; interface: string; vlan: number }
  /** `allowed` must match the allowed VLAN list exactly. */
  | { type: 'trunk'; device: string; interface: string; nativeVlan?: number; allowed?: number[] }
  | { type: 'subinterface'; device: string; interface: string; vlan: number; native?: boolean }
  | { type: 'ipRouting'; device: string }
  /** A route installed in the routing table. With `absent`, passes only when no such route is installed. */
  | { type: 'route'; device: string; network: string; prefix: number; code?: 'C' | 'L' | 'S' | 'O'; nextHop?: string; absent?: boolean }
  /** A static route as configured (installed or not), for floating statics. */
  | { type: 'staticRoute'; device: string; network: string; prefix: number; nextHop?: string; ad?: number }
  | { type: 'ping'; from: string; to: string; expect: 'success' | 'fail' }
  /** Every address in `via` answers a traceroute probe, in this order. */
  | { type: 'traceroute'; from: string; to: string; via: string[] }
  /** An OSPF neighbor (by router ID) in the given state, FULL by default. */
  | { type: 'ospfNeighbor'; device: string; neighbor: string; state?: 'FULL' | '2WAY' }
  | { type: 'ospfRouterId'; device: string; routerId: string }
  /** OSPF runs on the interface, optionally in a given DR role, passive state or priority. */
  | { type: 'ospfInterface'; device: string; interface: string; role?: 'DR' | 'BDR' | 'DROTHER' | 'P2P'; passive?: boolean; priority?: number }
  /** A PC holds a DHCP lease inside `network`, optionally with this default gateway. */
  | { type: 'dhcpLease'; device: string; network: string; prefix: number; gateway?: string }
  | { type: 'dhcpPool'; device: string; network: string; prefix: number; defaultRouter?: string }
  /** The DHCP server will never lease this address. */
  | { type: 'dhcpExcluded'; device: string; address: string }
  | { type: 'helperAddress'; device: string; interface: string; address: string }
  | { type: 'natInterface'; device: string; interface: string; side: 'inside' | 'outside' }
  | { type: 'natStatic'; device: string; local: string; global: string }
  /** Some `ip nat inside source list ... overload` rule exists. */
  | { type: 'natOverload'; device: string }
  /** An ACL applied to an interface in a direction (any ACL unless `acl` is given). */
  | { type: 'accessGroup'; device: string; interface: string; direction: 'in' | 'out'; acl?: string }
  /** A TCP connection to `port`: `open` when it connects, `blocked` when it does not. */
  | { type: 'connect'; from: string; to: string; port: number; expect: 'open' | 'blocked' }
  /** A global IPv6 address: exact, or any address inside `network`; optionally built with EUI-64 or learned by SLAAC. */
  | { type: 'ipv6Address'; device: string; interface: string; prefix: number; address?: string; network?: string; eui64?: boolean; slaac?: boolean }
  | { type: 'ipv6LinkLocal'; device: string; interface: string; address: string }
  | { type: 'ipv6Routing'; device: string }
  /** A route in the IPv6 routing table, or with `absent`, no such route. */
  | { type: 'ipv6Route'; device: string; network: string; prefix: number; code?: 'C' | 'L' | 'S'; nextHop?: string; absent?: boolean }
  | { type: 'stpMode'; device: string; mode: 'pvst' | 'rapid-pvst' }
  /** The device is the root bridge for the VLAN. */
  | { type: 'stpRoot'; device: string; vlan: number }
  | { type: 'stpPortRole'; device: string; interface: string; vlan: number; role: 'root' | 'designated' | 'alternate' }
  | { type: 'portfast'; device: string; interface: string }
  | { type: 'bpduGuard'; device: string; interface: string }
  | { type: 'errDisabled'; device: string; interface: string; expect: boolean }
  /** An EtherChannel with at least `bundled` member ports in it, optionally negotiated with `protocol`. */
  | { type: 'etherchannel'; device: string; group: number; bundled: number; protocol?: 'lacp' | 'pagp' | 'on' }
  | { type: 'portSecurity'; device: string; interface: string; maximum?: number; violation?: 'shutdown' | 'restrict' | 'protect'; sticky?: boolean }
  /** At least `count` (default 1) secure addresses on the port, optionally of one type. */
  | { type: 'secureMac'; device: string; interface: string; kind?: 'sticky' | 'static'; count?: number }
  /** An HSRP group on the interface, optionally in a state, with a virtual IP, priority, preempt or a tracked interface. */
  | { type: 'hsrp'; device: string; interface: string; group: number; state?: 'Active' | 'Standby'; vip?: string; priority?: number; preempt?: boolean; track?: string }
  /** DHCP snooping runs for the VLAN; optionally with option 82 insertion on or off. */
  | { type: 'dhcpSnooping'; device: string; vlan: number; option82?: boolean }
  | { type: 'dhcpSnoopingTrust'; device: string; interface: string; trusted: boolean }
  /** The switch has a snooping binding for this client (a PC from the lab). */
  | { type: 'dhcpSnoopingBinding'; device: string; client: string }
  /** Dynamic ARP Inspection runs for the VLAN, optionally with exactly these validation checks. */
  | { type: 'arpInspection'; device: string; vlan: number; validate?: ('src-mac' | 'dst-mac' | 'ip')[] }
  /** The port's DAI trust state, optionally with this rate limit (pps). */
  | { type: 'arpInspectionTrust'; device: string; interface: string; trusted: boolean; rate?: number }
  /** An ARP ACL is applied to the VLAN and permits this PC's address and MAC. */
  | { type: 'arpAclPermits'; device: string; vlan: number; client: string }
  /** IP Source Guard on the port, optionally in `ip` or `ip-mac` mode. */
  | { type: 'sourceGuard'; device: string; interface: string; mode?: 'ip' | 'ip-mac' }
  /** A static `ip source binding` for this PC's MAC and address. */
  | { type: 'sourceBinding'; device: string; client: string; interface?: string }
  | { type: 'errdisableRecovery'; device: string; cause: string; interval?: number }
  /** `from` sends a gratuitous ARP claiming `claim`; `blocked` passes when `victim` keeps its real entry for it. */
  | { type: 'arpSpoof'; from: string; claim: string; victim: string; expect: 'blocked' | 'poisoned' }
  /** The SSH server runs, optionally at version 2 and with a key of at least `modulus` bits. */
  | { type: 'sshServer'; device: string; version?: 2; modulus?: number }
  /** The VTY lines accept exactly these transports, optionally with this login method. */
  | { type: 'vtyAccess'; device: string; transport?: ('ssh' | 'telnet')[]; login?: 'local' | 'line' | 'none' }
  | { type: 'localUser'; device: string; username: string; privilege?: number; secret?: boolean }
  | { type: 'enableSecret'; device: string }
  | { type: 'passwordEncryption'; device: string }
  /** Logs in over telnet or SSH with these credentials: `success` when a session opens. */
  | { type: 'remoteLogin'; from: string; to: string; protocol: 'ssh' | 'telnet'; username?: string; password: string; expect: 'success' | 'fail' }
  /** The clock is synchronized by NTP, optionally to this server and at this stratum. */
  | { type: 'ntpSynced'; device: string; server?: string; stratum?: number }
  | { type: 'ntpMaster'; device: string; stratum?: number }
  /** The device clock is in `minYear` or later (it was set or synchronized), optionally in a named time zone. */
  | { type: 'clock'; device: string; minYear: number; timezone?: string }
  /** Log messages carry timestamps (`service timestamps log datetime`). */
  | { type: 'logTimestamps'; device: string }
  /** A CDP (default) or LLDP neighbor, optionally seen on a given local interface. With `absent`, no such neighbor. */
  | { type: 'neighbor'; device: string; neighbor: string; protocol?: 'cdp' | 'lldp'; interface?: string; absent?: boolean }
  /** CDP or LLDP runs globally, or with `interface` on that port (LLDP: transmit). */
  | { type: 'discovery'; device: string; protocol: 'cdp' | 'lldp'; enabled: boolean; interface?: string }
  /** The interface description contains this text (case-insensitive). */
  | { type: 'description'; device: string; interface: string; contains: string }
  /** A multiple-choice question; `answer` is the index of the right option. */
  | { type: 'quiz'; question: string; options: string[]; answer: number; explain?: string };

export type CheckType = Check['type'];

/** Checks that send traffic. They change ARP and MAC tables, so they run on demand, not live. */
export const PROBE_CHECKS: CheckType[] = ['ping', 'traceroute', 'connect', 'remoteLogin', 'arpSpoof'];

export interface Objective {
  text: string;
  check: Check;
  hint?: string;
}

export interface AddressingRow {
  device: string;
  interface: string;
  address: string;
  gateway?: string;
  note?: string;
}

export interface LabDefinition {
  id: string;
  title: string;
  domain: DomainId;
  /** Blueprint objectives covered, such as "2.1.b". */
  blueprint: string[];
  kind: LabKind;
  difficulty: 1 | 2 | 3;
  /** One line for the catalog. */
  summary: string;
  /** Paragraphs separated by blank lines; `code` spans and "- " bullets are rendered. */
  briefing: string;
  addressing?: AddressingRow[];
  topology: LabTopology;
  objectives: Objective[];
  /** Commands per device (hostname as defined above), entered from user EXEC through the device's shell. */
  solution: Record<string, string>;
  /** Shown once the lab is complete: what to remember and what to try next. */
  debrief?: string;
}
