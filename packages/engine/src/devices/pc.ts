import { ipToInt, type Ipv4Address } from '../core/addressing';
import type { Frame } from '../core/frames';
import type { Interface } from './device';
import { IpDevice } from './ip-device';

export type { PingResult } from './ip-device';

/** An end host with one NIC, a static IP config, an ARP cache and ping/tracert clients. */
export class Pc extends IpDevice {
  readonly kind = 'pc' as const;
  readonly nic: Interface;
  protected override readonly queueDuringArp = true;
  protected override readonly initialTtl = 128;

  constructor(hostname: string) {
    super(hostname);
    this.nic = this.addInterface('Ethernet0', true);
  }

  get forwarding(): boolean {
    return false;
  }

  get gateway(): Ipv4Address | undefined {
    return this.defaultGateway;
  }

  /** ARP cache keyed by IP, for `arp -a` and tests. */
  get arpCache(): Map<Ipv4Address, string> {
    return new Map([...this.arpTable].map(([ip, e]) => [ip, e.mac]));
  }

  configure(address: Ipv4Address, prefix: number, gateway?: Ipv4Address): void {
    ipToInt(address); // validates
    if (gateway) ipToInt(gateway);
    this.nic.ip = { address, prefix };
    this.defaultGateway = gateway;
  }

  receive(on: Interface, frame: Frame): void {
    this.receiveL3(on, frame);
  }
}
