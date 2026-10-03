import { BROADCAST_MAC, ipToInt, sameSubnet, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { Frame, Packet } from '../core/frames';
import { Device, type Interface } from './device';

export interface PingResult {
  seq: number;
  success: boolean;
  rttMs?: number;
}

const ARP_TIMEOUT_MS = 2_000;

/** An end host with one NIC, a static IP config, an ARP cache and a ping client. */
export class Pc extends Device {
  readonly kind = 'pc' as const;
  readonly nic: Interface;
  gateway?: Ipv4Address;
  readonly arpCache = new Map<Ipv4Address, MacAddress>();
  private pendingArp = new Map<Ipv4Address, Packet[]>();
  private echoWaiters = new Map<string, (rtt: number) => void>();
  private pingId = 1;

  constructor(hostname: string) {
    super(hostname);
    this.nic = this.addInterface('Ethernet0', true);
  }

  configure(address: Ipv4Address, prefix: number, gateway?: Ipv4Address): void {
    ipToInt(address); // validates
    this.nic.ip = { address, prefix };
    this.gateway = gateway;
  }

  /** Sends `count` echo requests. Results arrive once the topology has run. */
  ping(dst: Ipv4Address, count = 4): PingResult[] {
    const results: PingResult[] = [];
    const id = this.pingId++;
    for (let seq = 0; seq < count; seq++) {
      const result: PingResult = { seq, success: false };
      results.push(result);
      this.schedule(seq * 10, `ping ${dst} seq ${seq}`, () => {
        const sentAt = this.now;
        this.echoWaiters.set(`${id}:${seq}`, (now) => {
          result.success = true;
          result.rttMs = now - sentAt;
        });
        this.sendIp({ kind: 'icmp', type: 'echo-request', src: this.nic.ip?.address ?? '0.0.0.0', dst, ttl: 64, id, seq });
      });
    }
    return results;
  }

  receive(_on: Interface, frame: Frame): void {
    if (frame.dst !== this.nic.mac && frame.dst !== BROADCAST_MAC) return;
    const p = frame.payload;
    const myIp = this.nic.ip?.address;
    if (p.kind === 'arp') {
      this.arpCache.set(p.senderIp, p.senderMac);
      this.flushPending(p.senderIp);
      if (p.op === 'request' && p.targetIp === myIp) {
        this.send(this.nic, {
          src: this.nic.mac,
          dst: p.senderMac,
          payload: { kind: 'arp', op: 'reply', senderMac: this.nic.mac, senderIp: myIp, targetMac: p.senderMac, targetIp: p.senderIp },
        });
      }
      return;
    }
    if (p.dst !== myIp) return;
    if (p.type === 'echo-request') {
      this.sendIp({ ...p, type: 'echo-reply', src: myIp, dst: p.src, ttl: 64 });
    } else if (p.type === 'echo-reply') {
      const key = `${p.id}:${p.seq}`;
      this.echoWaiters.get(key)?.(this.now);
      this.echoWaiters.delete(key);
    }
  }

  private sendIp(packet: Packet & { kind: 'icmp' }): void {
    const ip = this.nic.ip;
    if (!ip) return;
    const nextHop = sameSubnet(ip.address, packet.dst, ip.prefix) ? packet.dst : this.gateway;
    if (!nextHop) return; // no default gateway: destination unreachable
    const mac = this.arpCache.get(nextHop);
    if (mac) {
      this.send(this.nic, { src: this.nic.mac, dst: mac, payload: packet });
      return;
    }
    const queue = this.pendingArp.get(nextHop);
    if (queue) {
      queue.push(packet);
      return;
    }
    this.pendingArp.set(nextHop, [packet]);
    this.send(this.nic, {
      src: this.nic.mac,
      dst: BROADCAST_MAC,
      payload: { kind: 'arp', op: 'request', senderMac: this.nic.mac, senderIp: ip.address, targetMac: '0000.0000.0000', targetIp: nextHop },
    });
    this.schedule(ARP_TIMEOUT_MS, `arp timeout ${nextHop}`, () => this.pendingArp.delete(nextHop));
  }

  private flushPending(ip: Ipv4Address): void {
    const queue = this.pendingArp.get(ip);
    if (!queue) return;
    this.pendingArp.delete(ip);
    for (const packet of queue) if (packet.kind === 'icmp') this.sendIp(packet);
  }
}
