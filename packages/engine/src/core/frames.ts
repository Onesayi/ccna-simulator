import type { Ipv4Address, MacAddress } from './addressing';

export type IcmpType = 'echo-request' | 'echo-reply' | 'time-exceeded' | 'unreachable';

interface IpHeader {
  src: Ipv4Address;
  dst: Ipv4Address;
  ttl: number;
  /** DiffServ code point (0-63) from the ToS byte. Unset means 0 (best effort). */
  dscp?: number;
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
  flags: 'syn' | 'syn-ack' | 'rst' | 'psh';
  /** A data segment (`psh`) carrying TACACS+. The simulator skips the handshake for these. */
  tacacs?: TacacsMessage;
  /** A data segment carrying a whole FTP, SCP or SFTP file transfer (or its reply). */
  transfer?: TransferMessage;
}

/**
 * A file transfer over TCP, squeezed into one request and one reply: FTP on port 21 (user,
 * password and file travel in clear text), SCP and SFTP on port 22 (inside SSH, so encrypted).
 */
export interface TransferMessage {
  protocol: 'ftp' | 'scp' | 'sftp';
  op: 'get' | 'put' | 'reply';
  /** Matches a reply to its request. */
  id: number;
  file: string;
  username?: string;
  password?: string;
  /** The file's contents: in a put, or in the reply to a get. */
  data?: string;
  status?: 'ok' | 'login-failed' | 'not-found';
}

/** TFTP (UDP 69): no login at all. A read or write request, the data, and an ACK or an error. */
export interface TftpMessage {
  op: 'rrq' | 'wrq' | 'data' | 'ack' | 'error';
  id: number;
  file: string;
  data?: string;
  error?: string;
}

/**
 * TACACS+ (TCP 49). The whole body is encrypted with the shared key, so a capture shows only the
 * header. `key` is the key the sender used; a server with a different key cannot read the body.
 */
export interface TacacsMessage {
  type: 'authen' | 'author' | 'acct';
  session: number;
  /** Requests carry the user; replies carry the status. */
  username?: string;
  password?: string;
  status?: 'pass' | 'fail' | 'error' | 'success';
  /** Authorization replies: `priv-lvl` for an EXEC shell. */
  privilege?: number;
  /** Accounting: start or stop record. */
  record?: 'start' | 'stop';
  key: string;
}

/**
 * RADIUS (UDP 1812 for authentication, 1813 for accounting). Only the password is hidden with the
 * shared secret; the user name and attributes travel in clear text.
 */
export interface RadiusMessage {
  code: 'access-request' | 'access-accept' | 'access-reject' | 'accounting-request' | 'accounting-response';
  id: number;
  username?: string;
  password?: string;
  /** Access-Accept: Cisco-AVPair `shell:priv-lvl=N`. */
  privilege?: number;
  /** Accounting-Request: Acct-Status-Type. */
  record?: 'start' | 'stop';
  /** NAS-Port-Type: a VTY login, or a wireless client authenticating with 802.1X. */
  portType?: 'Virtual' | 'Wireless-802.11';
  /** The secret the sender signed with (the Request/Response Authenticator stands in for it). */
  key: string;
}

/** An SNMP variable binding: an OID and, in responses and sets, its value. */
export interface SnmpVarbind {
  oid: string;
  type?: 'INTEGER' | 'STRING' | 'OID' | 'Timeticks' | 'Counter32' | 'Gauge32' | 'IpAddress' | 'Hex-STRING' | 'noSuchObject' | 'endOfMibView';
  value?: string | number;
}

/** SNMP over UDP 161 (requests) and 162 (traps). */
export interface SnmpMessage {
  version: '1' | '2c' | '3';
  pdu: 'get' | 'getnext' | 'set' | 'response' | 'trap' | 'report';
  requestId: number;
  /** v1/v2c: the community string, sent in clear text. */
  community?: string;
  /** v3 (USM): the user, security level and the passwords the sender keyed with. */
  user?: string;
  level?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authKey?: string;
  privKey?: string;
  varbinds: SnmpVarbind[];
  error?: 'noError' | 'noSuchName' | 'noAccess' | 'badValue' | 'notWritable' | 'wrongValue';
  /** v3 reports: why the agent refused the request. */
  report?: 'unknownUserName' | 'wrongDigest' | 'unsupportedSecLevel';
}

/**
 * CAPWAP between a lightweight AP and its controller: control messages on UDP 5246 (discovery,
 * join, echo), and client traffic tunneled on UDP 5247 with the client's frame inside.
 */
/** The security a WLAN asks for, as clients see it in beacons. */
export type WlanSecurity = 'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa2-enterprise';

/** A WLAN as the controller pushes it to its APs, which beacon it. */
export interface WlanAdvert {
  id: number;
  ssid: string;
  security: WlanSecurity;
}

export interface CapwapMessage {
  type: 'discovery-request' | 'discovery-response' | 'join-request' | 'join-response' | 'echo-request' | 'echo-response' | 'data';
  apName?: string;
  wlcName?: string;
  /** The controller's management address, in discovery responses. */
  wlcIp?: string;
  /** Join and echo responses: the WLANs to beacon and the radio channels (2.4 GHz, 5 GHz) to use. */
  wlans?: WlanAdvert[];
  channels?: [number, number];
  /** Data: the wireless client the frame is from or to, and the 802.11 or Ethernet frame itself. */
  client?: MacAddress;
  inner?: Frame;
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
  /** Relay agent information (option 82), inserted by a DHCP snooping switch. */
  option82?: { circuitId: string; remoteId: string };
  /** Vendor-specific option 43, as hex: Cisco APs read their controller addresses from it. */
  option43?: string;
}

/** An HSRP hello (UDP 1985). Active and standby routers send one every hello interval. */
export interface HsrpMessage {
  version: 1 | 2;
  group: number;
  state: 'speak' | 'standby' | 'active';
  priority: number;
  /** The virtual IP, when the sender knows it. */
  vip?: Ipv4Address;
}

/** A VRRP advertisement (IP protocol 112). Only the master sends them, from the virtual MAC. */
export interface VrrpMessage {
  group: number;
  priority: number;
  vip: Ipv4Address;
  /** Advertisement interval in seconds. */
  interval: number;
}

/**
 * A GLBP hello (UDP 3222). Every member sends one: it carries the sender's AVG priority and state,
 * and from the active virtual gateway the forwarder table (which router answers for which virtual MAC).
 */
export interface GlbpMessage {
  group: number;
  priority: number;
  state: 'speak' | 'standby' | 'active';
  weighting: number;
  vip?: Ipv4Address;
  forwarders?: GlbpForwarder[];
}

export interface GlbpForwarder {
  /** 1 to 4: the last byte of the virtual MAC. */
  number: number;
  /** The router the AVG first gave this forwarder to. */
  primary: Ipv4Address;
  /** The router answering for it now (another one after the primary fails). */
  owner: Ipv4Address;
}

/** An NTP request (mode 3) or reply (mode 4) on UDP 123. */
export interface NtpMessage {
  mode: 'client' | 'server';
  /** Server replies: the server's stratum and its clock, in milliseconds since 1970. */
  stratum?: number;
  time?: number;
  /** The server's reference, for `show ntp associations` on the client. */
  reference?: string;
}

export interface UdpPacket extends IpHeader {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  dhcp?: DhcpMessage;
  hsrp?: HsrpMessage;
  glbp?: GlbpMessage;
  tftp?: TftpMessage;
  ntp?: NtpMessage;
  radius?: RadiusMessage;
  snmp?: SnmpMessage;
  capwap?: CapwapMessage;
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

export interface VrrpPacket extends IpHeader {
  kind: 'vrrp';
  vrrp: VrrpMessage;
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
export type IpPacket = IcmpPacket | TcpPacket | UdpPacket | OspfPacket | VrrpPacket;

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

/**
 * A CDP or LLDP advertisement: who the sender is, which port it left from and what it can do.
 * Both protocols carry the same facts, so one shape serves both.
 */
interface DiscoveryFields {
  deviceId: string;
  /** Full interface name of the sending port. */
  portId: string;
  platform: string;
  /** CDP letters (R, B, S, I) for CDP; LLDP letters (R, B) for LLDP. */
  capabilities: string[];
  /** The sender's management address, if it has one. */
  address?: Ipv4Address;
  /** CDP only: the sending port's native (or access) VLAN. */
  nativeVlan?: number;
  /** Seconds a receiver keeps the entry: 180 for CDP, 120 for LLDP. */
  holdtime: number;
  version: string;
  /** LLDP chassis ID: the sender's base MAC. */
  chassisId: MacAddress;
}

export type DiscoveryPdu = (DiscoveryFields & { kind: 'cdp' }) | (DiscoveryFields & { kind: 'lldp' });

export const STP_MAC: MacAddress = '0100.0ccc.cccd';
export const CDP_MAC: MacAddress = '0100.0ccc.cccc';
export const LLDP_MAC: MacAddress = '0180.c200.000e';
export const HSRP_V1_GROUP: Ipv4Address = '224.0.0.2';
export const HSRP_V2_GROUP: Ipv4Address = '224.0.0.102';
export const HSRP_V1_MAC: MacAddress = '0100.5e00.0002';
export const HSRP_V2_MAC: MacAddress = '0100.5e00.0066';
export const VRRP_GROUP: Ipv4Address = '224.0.0.18';
export const VRRP_MAC: MacAddress = '0100.5e00.0012';
/** GLBP shares 224.0.0.102 with HSRP version 2, on its own UDP port. */
export const GLBP_GROUP: Ipv4Address = '224.0.0.102';
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

// ---------------------------------------------------------------- 802.11

/**
 * 802.11 management frames and EAPOL between a wireless client and its AP. With a lightweight
 * AP these are relayed to the controller inside CAPWAP, which makes every decision (split MAC).
 */
export interface Dot11Frame {
  kind: 'dot11';
  subtype: 'auth' | 'assoc-request' | 'assoc-response' | 'deauth' | 'eapol-key' | 'eap';
  /** Authentication: open system, or WPA3's SAE (the password is proven without being sent). */
  algorithm?: 'open' | 'sae';
  ssid?: string;
  /** 0 is success; other values are IEEE status or reason codes. */
  status?: number;
  reason?: string;
  /** Association request: the security the client offers. */
  akm?: 'none' | 'psk' | 'sae' | '802.1x';
  /** EAPOL-Key: message 1 to 4 of the 4-way handshake. */
  message?: 1 | 2 | 3 | 4;
  /** EAPOL-Key message 2: a MIC derived from the client's key; SAE: the password-derived commit. */
  mic?: string;
  /** EAP: identity request or response, credentials (stands in for PEAP), success or failure. */
  eap?: 'request-identity' | 'response-identity' | 'credentials' | 'success' | 'failure';
  identity?: string;
  password?: string;
}

/** Layer 3 payloads the engine understands. New protocols extend this union. */
export type Packet = ArpPacket | IpPacket | Icmpv6Packet | BpduPacket | ChannelPdu | DiscoveryPdu | Dot11Frame;

/** An Ethernet II frame, optionally carrying an 802.1Q tag while on a trunk. */
export interface Frame {
  src: MacAddress;
  dst: MacAddress;
  vlan?: number;
  payload: Packet;
}
