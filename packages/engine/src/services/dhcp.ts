import { intToIp, ipToInt, networkAddress, prefixToMask, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { DhcpMessage } from '../core/frames';
import type { ScheduledEvent } from '../core/scheduler';

/** How long a client waits for an offer and an ack before giving up. */
export const DHCP_TIMEOUT_MS = 4_000;
/** Messages sent per attempt before giving up. */
const DHCP_RETRIES = 4;

export interface DhcpPool {
  name: string;
  network?: Ipv4Address;
  prefix?: number;
  defaultRouter?: Ipv4Address;
  dns?: Ipv4Address;
  domain?: string;
  leaseDays: number;
}

export interface DhcpBinding {
  address: Ipv4Address;
  mac: MacAddress;
  pool: string;
  leasedAt: number;
}

/** The IOS DHCP server: pools, excluded ranges and bindings. */
export class DhcpServer {
  readonly pools = new Map<string, DhcpPool>();
  /** `ip dhcp excluded-address low [high]`, as integer ranges. */
  readonly excluded: [Ipv4Address, Ipv4Address][] = [];
  readonly bindings = new Map<Ipv4Address, DhcpBinding>();
  private readonly offers = new Map<MacAddress, Ipv4Address>();

  /** The pool serving a subnet, chosen by the relay address (giaddr) or the receiving interface. */
  poolFor(address: Ipv4Address): DhcpPool | undefined {
    return [...this.pools.values()].find((p) => p.network && networkAddress(address, p.prefix!) === p.network);
  }

  isExcluded(ip: Ipv4Address): boolean {
    const n = ipToInt(ip);
    return this.excluded.some(([lo, hi]) => n >= ipToInt(lo) && n <= ipToInt(hi));
  }

  /**
   * Answers a client message. `via` is the address that identifies the client's subnet (giaddr,
   * or our interface on that subnet) and `serverId` our address the client will talk to.
   */
  respond(msg: DhcpMessage, via: Ipv4Address, serverId: Ipv4Address, ownAddresses: Ipv4Address[], now: number): DhcpMessage | undefined {
    if (msg.op === 'release') {
      for (const [ip, b] of this.bindings) if (b.mac === msg.chaddr) this.bindings.delete(ip);
      return undefined;
    }
    const pool = this.poolFor(via);
    if (!pool) return undefined;
    const reply = (op: DhcpMessage['op'], yiaddr?: Ipv4Address): DhcpMessage => ({
      op,
      xid: msg.xid,
      chaddr: msg.chaddr,
      yiaddr,
      giaddr: msg.giaddr,
      serverId,
      prefix: pool.prefix,
      router: pool.defaultRouter,
      dns: pool.dns,
      domain: pool.domain,
      leaseDays: pool.leaseDays,
    });
    if (msg.op === 'discover') {
      const bound = [...this.bindings.values()].find((b) => b.mac === msg.chaddr && b.pool === pool.name)?.address;
      const address = bound ?? this.offers.get(msg.chaddr) ?? this.allocate(pool, ownAddresses);
      if (!address) return undefined;
      this.offers.set(msg.chaddr, address);
      return reply('offer', address);
    }
    if (msg.op === 'request') {
      // The client picked another server's offer.
      if (msg.serverId && msg.serverId !== serverId) {
        this.offers.delete(msg.chaddr);
        return undefined;
      }
      const ip = msg.requested;
      const holder = ip ? this.bindings.get(ip) : undefined;
      if (!ip || networkAddress(ip, pool.prefix!) !== pool.network || this.isExcluded(ip) || (holder && holder.mac !== msg.chaddr)) return reply('nak');
      this.offers.delete(msg.chaddr);
      this.bindings.set(ip, { address: ip, mac: msg.chaddr, pool: pool.name, leasedAt: now });
      return reply('ack', ip);
    }
    return undefined;
  }

  /** The lowest free host address in the pool: not excluded, not leased, not one of ours. */
  private allocate(pool: DhcpPool, ownAddresses: Ipv4Address[]): Ipv4Address | undefined {
    const first = ipToInt(pool.network!) + 1;
    const last = ipToInt(pool.network!) + 2 ** (32 - pool.prefix!) - 2;
    const offered = new Set(this.offers.values());
    for (let n = first; n <= last; n++) {
      const ip = intToIp(n);
      if (!this.isExcluded(ip) && !this.bindings.has(ip) && !offered.has(ip) && !ownAddresses.includes(ip)) return ip;
    }
    return undefined;
  }
}

export interface DhcpClientHooks {
  send(msg: DhcpMessage): void;
  bound(ack: DhcpMessage): void;
  failed(): void;
  schedule(delayMs: number, label: string, run: () => void): ScheduledEvent | undefined;
  cancel(event: ScheduledEvent | undefined): void;
}

let xidCounter = 0x1000;

/** DHCP client state machine (DORA) for one interface. */
export class DhcpClient {
  state: 'idle' | 'selecting' | 'requesting' | 'bound' = 'idle';
  lease?: DhcpMessage;
  private xid = 0;
  private timer?: ScheduledEvent;
  private last?: DhcpMessage;

  constructor(
    private readonly mac: MacAddress,
    private readonly hooks: DhcpClientHooks,
  ) {}

  start(timeoutMs = DHCP_TIMEOUT_MS): void {
    this.hooks.cancel(this.timer);
    this.xid = xidCounter++;
    this.state = 'selecting';
    this.last = { op: 'discover', xid: this.xid, chaddr: this.mac };
    this.hooks.send(this.last);
    this.retransmit(this.xid, 1);
    this.timer = this.hooks.schedule(timeoutMs, 'dhcp timeout', () => {
      if (this.state === 'bound') return;
      this.state = 'idle';
      this.hooks.failed();
    });
  }

  /** Clients resend until answered: routers drop the first packet while they ARP for the next hop. */
  private retransmit(xid: number, attempt: number): void {
    if (attempt >= DHCP_RETRIES) return;
    this.hooks.schedule(DHCP_TIMEOUT_MS / DHCP_RETRIES, 'dhcp retransmit', () => {
      if (this.xid !== xid || this.state === 'bound' || this.state === 'idle' || !this.last) return;
      this.hooks.send(this.last);
      this.retransmit(xid, attempt + 1);
    });
  }

  /** Returns true when the message was for this client. */
  receive(msg: DhcpMessage): boolean {
    if (msg.xid !== this.xid || msg.chaddr !== this.mac) return false;
    if (msg.op === 'offer' && this.state === 'selecting') {
      this.state = 'requesting';
      this.last = { op: 'request', xid: this.xid, chaddr: this.mac, requested: msg.yiaddr, serverId: msg.serverId };
      this.hooks.send(this.last);
    } else if (msg.op === 'ack' && this.state === 'requesting') {
      this.state = 'bound';
      this.lease = msg;
      this.hooks.cancel(this.timer);
      this.hooks.bound(msg);
    } else if (msg.op === 'nak') {
      this.state = 'idle';
      this.hooks.cancel(this.timer);
      this.hooks.failed();
    }
    return true;
  }

  /** Forgets the lease. Returns the release message to send to the server, if there was a lease. */
  release(): DhcpMessage | undefined {
    const lease = this.lease;
    this.state = 'idle';
    this.lease = undefined;
    return lease && { op: 'release', xid: this.xid, chaddr: this.mac, serverId: lease.serverId, yiaddr: lease.yiaddr };
  }
}

export function showDhcpBinding(server: DhcpServer): string {
  const rows = [...server.bindings.values()]
    .sort((a, b) => ipToInt(a.address) - ipToInt(b.address))
    .map((b) => `${b.address.padEnd(21)}${`01${b.mac.replace(/\./g, '')}`.replace(/(.{4})(?=.)/g, '$1.').padEnd(24)}Infinite                Automatic  Active     Unknown`);
  return [
    'Bindings from all pools not associated with VRF:',
    'IP address           Client-ID/              Lease expiration        Type       State      Interface',
    '                     Hardware address/',
    '                     User name',
    ...rows,
  ].join('\n');
}

export function showDhcpPool(server: DhcpServer): string {
  const out: string[] = [];
  for (const pool of server.pools.values()) {
    const leased = [...server.bindings.values()].filter((b) => b.pool === pool.name).length;
    out.push('', `Pool ${pool.name} :`);
    if (!pool.network) {
      out.push(' Total addresses                : 0');
      continue;
    }
    const size = 2 ** (32 - pool.prefix!) - 2;
    const first = intToIp(ipToInt(pool.network) + 1);
    const last = intToIp(ipToInt(pool.network) + size);
    out.push(
      ` Utilization mark (high/low)    : 100 / 0`,
      ` Subnet size (first/next)       : 0 / 0`,
      ` Total addresses                : ${size}`,
      ` Leased addresses               : ${leased}`,
      ` Excluded addresses             : ${countExcluded(server, pool)}`,
      ` Pending event                  : none`,
      ` 1 subnet is currently in the pool :`,
      ` Current index        IP address range                    Leased/Excluded/Total`,
      ` ${first.padEnd(21)}${first} - ${last.padEnd(17)}${leased} / ${countExcluded(server, pool)} / ${size}`,
      ` Network ${pool.network} ${prefixToMask(pool.prefix!)}${pool.defaultRouter ? `, default router ${pool.defaultRouter}` : ''}`,
    );
  }
  return out.join('\n').trimStart();
}

function countExcluded(server: DhcpServer, pool: DhcpPool): number {
  let n = 0;
  const base = ipToInt(pool.network!);
  for (let k = 1; k < 2 ** (32 - pool.prefix!) - 1; k++) if (server.isExcluded(intToIp(base + k))) n++;
  return n;
}
