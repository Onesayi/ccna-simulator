import type { Ipv4Address, MacAddress } from './addressing';

export type IcmpType = 'echo-request' | 'echo-reply' | 'time-exceeded' | 'unreachable';

export interface IcmpPacket {
  kind: 'icmp';
  type: IcmpType;
  src: Ipv4Address;
  dst: Ipv4Address;
  ttl: number;
  /** Echo identifier and sequence. Error messages (time-exceeded, unreachable) copy them from the
   *  packet that caused the error, standing in for the quoted original header. */
  id: number;
  seq: number;
}

export interface ArpPacket {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: MacAddress;
  senderIp: Ipv4Address;
  targetMac: MacAddress;
  targetIp: Ipv4Address;
}

/** Layer 3 payloads the engine understands. New protocols extend this union. */
export type Packet = ArpPacket | IcmpPacket;

/** IP packets, i.e. everything that is routed (ARP is not). */
export type IpPacket = IcmpPacket;

/** An Ethernet II frame, optionally carrying an 802.1Q tag while on a trunk. */
export interface Frame {
  src: MacAddress;
  dst: MacAddress;
  vlan?: number;
  payload: Packet;
}
