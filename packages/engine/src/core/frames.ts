import type { Ipv4Address, MacAddress } from './addressing';

/** Layer 3 payloads the engine understands. New protocols extend this union. */
export type Packet =
  | { kind: 'arp'; op: 'request' | 'reply'; senderMac: MacAddress; senderIp: Ipv4Address; targetMac: MacAddress; targetIp: Ipv4Address }
  | { kind: 'icmp'; type: 'echo-request' | 'echo-reply' | 'time-exceeded' | 'unreachable'; src: Ipv4Address; dst: Ipv4Address; ttl: number; id: number; seq: number };

/** An Ethernet II frame, optionally carrying an 802.1Q tag while on a trunk. */
export interface Frame {
  src: MacAddress;
  dst: MacAddress;
  vlan?: number;
  payload: Packet;
}
