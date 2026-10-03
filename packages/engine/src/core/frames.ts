import type { Ipv4Address, MacAddress } from './addressing';

export type IcmpType = 'echo-request' | 'echo-reply' | 'time-exceeded' | 'unreachable';

interface IpHeader {
  src: Ipv4Address;
  dst: Ipv4Address;
  ttl: number;
}

export interface IcmpPacket extends IpHeader {
  kind: 'icmp';
  type: IcmpType;
  /** Echo identifier and sequence. Error messages (time-exceeded, unreachable) copy them from the
   *  packet that caused the error, standing in for the quoted original header. */
  id: number;
  seq: number;
  /** Errors only: the packet that caused the error, so the sender (and NAT) can match it up. */
  original?: IpPacket;
}

/** Just enough TCP for a connection attempt: SYN out, then SYN-ACK (open) or RST (refused). */
export interface TcpPacket extends IpHeader {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  flags: 'syn' | 'syn-ack' | 'rst';
}

export interface DhcpMessage {
  op: 'discover' | 'offer' | 'request' | 'ack' | 'nak' | 'release';
  xid: number;
  /** Client hardware address. */
  chaddr: MacAddress;
  /** Address offered or assigned. */
  yiaddr?: Ipv4Address;
  /** Relay agent address, set by the router running `ip helper-address`. */
  giaddr?: Ipv4Address;
  /** Server identifier (option 54). */
  serverId?: Ipv4Address;
  /** Requested address (option 50). */
  requested?: Ipv4Address;
  prefix?: number;
  router?: Ipv4Address;
  dns?: Ipv4Address;
  domain?: string;
  leaseDays?: number;
}

export interface UdpPacket extends IpHeader {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  dhcp?: DhcpMessage;
}

// ---------------------------------------------------------------- OSPF

export type LsaLink =
  /** A point-to-point adjacency: `id` is the neighbor's router ID, `data` our interface address. */
  | { type: 'p2p'; id: Ipv4Address; data: Ipv4Address; cost: number }
  /** A link to a multi-access network: `id` is the DR's interface address, `data` ours. */
  | { type: 'transit'; id: Ipv4Address; data: Ipv4Address; cost: number }
  /** A network with no OSPF neighbors on it (a LAN, a loopback, a passive interface). */
  | { type: 'stub'; id: Ipv4Address; prefix: number; cost: number };

interface LsaHeader {
  advRouter: Ipv4Address;
  seq: number;
  /** Virtual time the LSA was originated, for the age column. */
  originatedAt: number;
  /** Set when the originator withdraws the LSA (MaxAge); receivers delete it. */
  flushed?: boolean;
}

/** Type 1: every router describes its own links. */
export interface RouterLsa extends LsaHeader {
  lsType: 'router';
  id: Ipv4Address;
  links: LsaLink[];
}

/** Type 2: the DR describes a multi-access network and the routers attached to it. */
export interface NetworkLsa extends LsaHeader {
  lsType: 'network';
  id: Ipv4Address;
  prefix: number;
  attached: Ipv4Address[];
}

/** Type 5: an external route; here only the default route from `default-information originate`. */
export interface ExternalLsa extends LsaHeader {
  lsType: 'external';
  id: Ipv4Address;
  prefix: number;
  metric: number;
}

export type Lsa = RouterLsa | NetworkLsa | ExternalLsa;

export interface OspfHello {
  type: 'hello';
  routerId: Ipv4Address;
  area: number;
  prefix: number;
  helloInterval: number;
  deadInterval: number;
  priority: number;
  dr: Ipv4Address;
  bdr: Ipv4Address;
  /** Router IDs heard on this segment. Seeing ourselves here is what makes a neighbor 2-Way. */
  neighbors: Ipv4Address[];
}

/**
 * Database description and link state update. Real OSPF trades LSA headers first and then
 * requests what is missing; the simulator sends whole LSAs in the DBD, which ends in the same state.
 */
export interface OspfDbd {
  type: 'dbd' | 'lsu';
  routerId: Ipv4Address;
  area: number;
  lsas: Lsa[];
}

export type OspfMessage = OspfHello | OspfDbd;

export interface OspfPacket extends IpHeader {
  kind: 'ospf';
  ospf: OspfMessage;
}

export const OSPF_ALL_ROUTERS: Ipv4Address = '224.0.0.5';
export const OSPF_ALL_ROUTERS_MAC: MacAddress = '0100.5e00.0005';

export interface ArpPacket {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: MacAddress;
  senderIp: Ipv4Address;
  targetMac: MacAddress;
  targetIp: Ipv4Address;
}

/** IP packets, i.e. everything that is routed (ARP is not). */
export type IpPacket = IcmpPacket | TcpPacket | UdpPacket | OspfPacket;

// ---------------------------------------------------------------- Layer 2 control protocols

/** A bridge ID: priority (with the VLAN added as the system ID extension) then the switch MAC. */
export interface BridgeId {
  priority: number;
  mac: MacAddress;
}

/** A Rapid PVST+ BPDU. PVST+ sends one per VLAN, so the VLAN travels in the BPDU itself. */
export interface BpduPacket {
  kind: 'bpdu';
  vlan: number;
  root: BridgeId;
  /** Cost from the sender to the root. */
  rootCost: number;
  bridge: BridgeId;
  /** Port priority and number, as `show spanning-tree` prints them ("128.1"). */
  portId: { priority: number; number: number };
  /** Bridges the BPDU has crossed since the root. Stale information dies at max age (20). */
  messageAge: number;
}

/** PAgP or LACP: each member port tells the far end how it is set up, so both sides agree to bundle. */
interface ChannelPduFields {
  mode: 'active' | 'passive' | 'desirable' | 'auto';
  /** The sending switch, so ports wired to different switches never bundle together. */
  system: MacAddress;
  group: number;
}

export type ChannelPdu = (ChannelPduFields & { kind: 'lacp' }) | (ChannelPduFields & { kind: 'pagp' });

export const STP_MAC: MacAddress = '0100.0ccc.cccd';
export const SLOW_PROTOCOLS_MAC: MacAddress = '0180.c200.0002';

// ---------------------------------------------------------------- IPv6

export type Icmpv6Type = 'echo-request' | 'echo-reply' | 'time-exceeded' | 'unreachable' | 'ns' | 'na' | 'rs' | 'ra';

/**
 * IPv6 with an ICMPv6 payload. Neighbor Discovery (NS, NA, RS, RA) replaces ARP and carries
 * SLAAC, so ICMPv6 is the only IPv6 payload the engine needs for ping, traceroute and addressing.
 */
export interface Icmpv6Packet {
  kind: 'icmpv6';
  src: string;
  dst: string;
  hopLimit: number;
  type: Icmpv6Type;
  id: number;
  seq: number;
  /** NS and NA: the address being resolved. */
  target?: string;
  /** NA and RA: the sender's link-layer address. */
  mac?: MacAddress;
  /** RA: on-link prefixes for SLAAC. */
  prefixes?: { prefix: string; length: number }[];
  /** Errors only: the packet that caused the error. */
  original?: Icmpv6Packet;
}

/** Layer 3 payloads the engine understands. New protocols extend this union. */
export type Packet = ArpPacket | IpPacket | Icmpv6Packet | BpduPacket | ChannelPdu;

/** An Ethernet II frame, optionally carrying an 802.1Q tag while on a trunk. */
export interface Frame {
  src: MacAddress;
  dst: MacAddress;
  vlan?: number;
  payload: Packet;
}
