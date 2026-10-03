import { ipToInt, networkAddress, type Ipv4Address, type MacAddress } from '../core/addressing';
import type { ExternalLsa, Lsa, LsaLink, NetworkLsa, OspfHello, OspfMessage, OspfPacket, RouterLsa } from '../core/frames';
import { shortName, type Interface } from '../devices/device';
import type { Route } from '../devices/ip-device';

export const OSPF_AD = 110;
export const NO_DR: Ipv4Address = '0.0.0.0';
/** Convergence rounds an interface spends in WAITING before it elects a DR (stands in for the 40 s wait timer). */
const WAIT_ROUNDS = 2;

export type NeighborState = 'INIT' | '2WAY' | 'EXSTART' | 'FULL';
export type OspfNetworkType = 'broadcast' | 'point-to-point';

export interface OspfNeighbor {
  routerId: Ipv4Address;
  address: Ipv4Address;
  mac: MacAddress;
  priority: number;
  dr: Ipv4Address;
  bdr: Ipv4Address;
  state: NeighborState;
  /** The convergence round this neighbor's last valid hello arrived in. */
  heardInRound: number;
  sentDbd: boolean;
}

export interface OspfInterface {
  iface: Interface;
  area: number;
  passive: boolean;
  /** Rounds since OSPF came up here; the interface waits before electing. */
  age: number;
  dr: Ipv4Address;
  bdr: Ipv4Address;
  neighbors: Map<Ipv4Address, OspfNeighbor>;
}

export interface OspfNetworkStatement {
  address: Ipv4Address;
  wildcard: Ipv4Address;
  area: number;
}

/** What the OSPF process needs from its router. */
export interface OspfHost {
  readonly interfaces: Interface[];
  readonly log: string[];
  readonly clock: number;
  sendOspf(iface: Interface, msg: OspfMessage, to?: { ip: Ipv4Address; mac: MacAddress }): void;
  /** A default route from somewhere other than OSPF, for `default-information originate`. */
  hasNonOspfDefault(): boolean;
}

interface NextHop {
  iface: Interface;
  gw?: Ipv4Address;
}

export function parseArea(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  return ipToInt(text);
}

/** One `router ospf <pid>` process: neighbors, DR election, the link-state database and SPF. */
export class OspfProcess {
  configuredRouterId?: Ipv4Address;
  /** The router ID in use. It only changes on `clear ip ospf process` once neighbors exist. */
  routerId?: Ipv4Address;
  readonly networks: OspfNetworkStatement[] = [];
  readonly passive = new Set<string>();
  passiveDefault = false;
  /** With `passive-interface default`: the interfaces made active again. */
  readonly active = new Set<string>();
  defaultOriginate = false;
  /** `auto-cost reference-bandwidth`, in Mbps. */
  referenceBandwidth = 100;
  readonly ifaces = new Map<Interface, OspfInterface>();
  readonly lsdb = new Map<string, Lsa>();
  /** Sequence number of the last flush seen per LSA, so stale copies cannot bring it back. */
  private readonly flushed = new Map<string, number>();
  routes: Route[] = [];

  private round = 0;
  private dirty = false;
  private seq = 0x80000001;
  private readonly learnedAt = new Map<string, number>();
  private readonly reported = new Set<string>();

  constructor(
    readonly pid: number,
    private readonly host: OspfHost,
  ) {}

  // ---------------------------------------------------------------- interfaces

  /** The area an interface belongs to, from `ip ospf <pid> area` or the most specific `network` statement. */
  areaFor(i: Interface): number | undefined {
    if (i.ospf?.process) return i.ospf.process.pid === this.pid ? i.ospf.process.area : undefined;
    if (!i.ip) return undefined;
    let best: OspfNetworkStatement | undefined;
    const ip = ipToInt(i.ip.address);
    for (const n of this.networks) {
      const care = ~ipToInt(n.wildcard) >>> 0;
      if (((ip & care) >>> 0) !== ((ipToInt(n.address) & care) >>> 0)) continue;
      if (!best || ipToInt(n.wildcard) < ipToInt(best.wildcard)) best = n;
    }
    return best?.area;
  }

  isPassive(i: Interface): boolean {
    const name = i.name.toLowerCase();
    return this.passiveDefault ? !this.active.has(name) : this.passive.has(name);
  }

  networkType(i: Interface): OspfNetworkType | 'loopback' {
    if (i.kind === 'loopback' && !i.ospf?.network) return 'loopback';
    return i.ospf?.network ?? 'broadcast';
  }

  cost(i: Interface): number {
    if (i.ospf?.cost) return i.ospf.cost;
    const kbps = i.bandwidth ?? (i.kind === 'loopback' ? 8_000_000 : 1_000_000);
    return Math.max(1, Math.floor((this.referenceBandwidth * 1000) / kbps));
  }

  helloInterval(i: Interface): number {
    return i.ospf?.helloInterval ?? (i.ospf?.deadInterval ? Math.floor(i.ospf.deadInterval / 4) : 10);
  }

  deadInterval(i: Interface): number {
    return i.ospf?.deadInterval ?? this.helloInterval(i) * 4;
  }

  priority(i: Interface): number {
    return i.ospf?.priority ?? 1;
  }

  /** Brings the interface list in line with configuration and link state. */
  private syncInterfaces(): void {
    for (const i of this.host.interfaces) {
      const area = i.isUp && i.ip ? this.areaFor(i) : undefined;
      const oi = this.ifaces.get(i);
      if (area === undefined) {
        if (oi) this.dropInterface(oi, 'Interface down or detached');
        continue;
      }
      if (!oi) {
        this.ifaces.set(i, { iface: i, area, passive: this.isPassive(i), age: 0, dr: NO_DR, bdr: NO_DR, neighbors: new Map() });
        this.dirty = true;
        continue;
      }
      const passive = this.isPassive(i);
      if (oi.area !== area || oi.passive !== passive) {
        for (const n of [...oi.neighbors.values()]) this.dropNeighbor(oi, n, 'Interface down or detached');
        Object.assign(oi, { area, passive, age: 0, dr: NO_DR, bdr: NO_DR });
        this.dirty = true;
      }
    }
  }

  private dropInterface(oi: OspfInterface, reason: string): void {
    for (const n of [...oi.neighbors.values()]) this.dropNeighbor(oi, n, reason);
    this.ifaces.delete(oi.iface);
    this.dirty = true;
  }

  private dropNeighbor(oi: OspfInterface, n: OspfNeighbor, reason: string): void {
    if (n.state === 'FULL') this.logAdj(n, oi, 'FULL', 'DOWN', `Neighbor Down: ${reason}`);
    oi.neighbors.delete(n.routerId);
    this.dirty = true;
  }

  private logAdj(n: OspfNeighbor, oi: OspfInterface, from: string, to: string, why: string): void {
    this.host.log.push(`%OSPF-5-ADJCHG: Process ${this.pid}, Nbr ${n.routerId} on ${oi.iface.name} from ${from} to ${to}, ${why}`);
  }

  private report(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.host.log.push(message);
  }

  // ---------------------------------------------------------------- router ID

  /** Manual `router-id`, else the highest loopback address, else the highest address on an up interface. */
  private chooseRouterId(): Ipv4Address | undefined {
    if (this.configuredRouterId) return this.configuredRouterId;
    const up = this.host.interfaces.filter((i) => i.ip && i.isUp);
    const pick = (list: Interface[]) => list.map((i) => i.ip!.address).sort((a, b) => ipToInt(b) - ipToInt(a))[0];
    return pick(up.filter((i) => i.kind === 'loopback')) ?? pick(up);
  }

  /** `router-id <ip>`: takes effect now if there are no neighbors yet, otherwise on `clear ip ospf process`. */
  setRouterId(rid: Ipv4Address | undefined): string | undefined {
    this.configuredRouterId = rid;
    const hasNeighbors = [...this.ifaces.values()].some((oi) => oi.neighbors.size > 0);
    if (this.routerId && hasNeighbors) return '% OSPF: Reload or use "clear ip ospf process" command, for this to take effect';
    if (this.routerId) this.reset();
    return undefined;
  }

  /** `clear ip ospf process`: drops every adjacency, withdraws our LSAs and picks the router ID again. */
  reset(): void {
    const own = [...this.lsdb.values()].filter((l) => l.advRouter === this.routerId);
    if (own.length) this.flood(own.map((l) => ({ ...l, seq: l.seq + 1, flushed: true })));
    for (const oi of this.ifaces.values()) {
      for (const n of [...oi.neighbors.values()]) this.dropNeighbor(oi, n, 'Adjacency forced to reset');
      Object.assign(oi, { age: 0, dr: NO_DR, bdr: NO_DR });
    }
    this.lsdb.clear();
    this.flushed.clear();
    this.routes = [];
    this.routerId = undefined;
    this.reported.clear();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- hello protocol

  /** Start of a round: send a hello out of every active, non-passive interface. */
  tick(): void {
    this.round++;
    this.syncInterfaces();
    if (!this.routerId) {
      this.routerId = this.chooseRouterId();
      if (!this.routerId) return this.report('nortrid', `%OSPF-4-NORTRID: OSPF process ${this.pid} failed to allocate unique router-id and cannot start`);
      this.dirty = true;
    }
    for (const oi of this.ifaces.values()) {
      if (oi.passive || this.networkType(oi.iface) === 'loopback') continue;
      const i = oi.iface;
      const hello: OspfHello = {
        type: 'hello',
        routerId: this.routerId,
        area: oi.area,
        prefix: i.ip!.prefix,
        helloInterval: this.helloInterval(i),
        deadInterval: this.deadInterval(i),
        priority: this.priority(i),
        dr: oi.dr,
        bdr: oi.bdr,
        neighbors: [...oi.neighbors.keys()],
      };
      this.host.sendOspf(i, hello);
    }
  }

  receive(iface: Interface, p: OspfPacket, srcMac: MacAddress): void {
    const oi = this.ifaces.get(iface);
    if (!oi || oi.passive || !this.routerId) return;
    const msg = p.ospf;
    if (msg.routerId === this.routerId) {
      return this.report(`dup:${p.src}`, `%OSPF-4-DUPID: OSPF detected duplicate router-id ${this.routerId} from ${p.src} on interface ${iface.name}`);
    }
    if (msg.area !== oi.area) {
      const theirs = msg.area === 0 ? 'backbone area' : `area ${msg.area}`;
      return this.report(`area:${p.src}:${msg.area}`, `%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID from ${theirs} from ${p.src}, ${iface.name}`);
    }
    if (msg.type === 'hello') return this.receiveHello(oi, p, msg, srcMac);
    const n = oi.neighbors.get(msg.routerId);
    if (!n) return;
    if (msg.type === 'dbd') {
      if (n.state === 'INIT' || !this.adjacent(oi, n)) return;
      this.dropWithdrawn(msg.routerId, msg.lsas);
      this.install(msg.lsas, n);
      // Answer every DBD until we are FULL: ours may have been dropped before they were ready.
      if (!n.sentDbd || n.state !== 'FULL') this.sendDbd(oi, n);
      if (n.state !== 'FULL') {
        n.state = 'FULL';
        this.logAdj(n, oi, 'LOADING', 'FULL', 'Loading Done');
        this.dirty = true;
      }
      return;
    }
    if (n.state === 'FULL' || n.state === 'EXSTART') this.install(msg.lsas, n);
  }

  private receiveHello(oi: OspfInterface, p: OspfPacket, hello: OspfHello, srcMac: MacAddress): void {
    const i = oi.iface;
    // Hellos must agree on timers, and on the subnet mask unless the link is point-to-point.
    if (hello.helloInterval !== this.helloInterval(i) || hello.deadInterval !== this.deadInterval(i)) return;
    if (this.networkType(i) !== 'point-to-point' && hello.prefix !== i.ip!.prefix) return;
    let n = oi.neighbors.get(hello.routerId);
    if (!n) {
      n = { routerId: hello.routerId, address: p.src, mac: srcMac, priority: hello.priority, dr: hello.dr, bdr: hello.bdr, state: 'INIT', heardInRound: this.round, sentDbd: false };
      oi.neighbors.set(n.routerId, n);
      this.dirty = true;
    }
    if (n.priority !== hello.priority || n.dr !== hello.dr || n.bdr !== hello.bdr || n.address !== p.src) this.dirty = true;
    Object.assign(n, { address: p.src, mac: srcMac, priority: hello.priority, dr: hello.dr, bdr: hello.bdr, heardInRound: this.round });
    const twoWay = hello.neighbors.includes(this.routerId!);
    if (twoWay && n.state === 'INIT') {
      n.state = '2WAY';
      this.dirty = true;
    } else if (!twoWay && n.state !== 'INIT') {
      // 1-Way: the neighbor restarted or lost us. Start over.
      Object.assign(n, { state: 'INIT', sentDbd: false });
      this.dirty = true;
    }
  }

  // ---------------------------------------------------------------- DR election and adjacencies

  /** Point-to-point links always form a full adjacency; on a LAN only with the DR and BDR. */
  private adjacent(oi: OspfInterface, n: OspfNeighbor): boolean {
    if (this.networkType(oi.iface) === 'point-to-point') return true;
    if (oi.age < WAIT_ROUNDS) return false;
    const me = oi.iface.ip!.address;
    return [me, n.address].some((a) => a === oi.dr || a === oi.bdr);
  }

  /** RFC 2328 section 9.4. Routers already claiming DR or BDR keep the job, so elections never preempt. */
  private elect(oi: OspfInterface): boolean {
    const me = { routerId: this.routerId!, address: oi.iface.ip!.address, priority: this.priority(oi.iface), dr: oi.dr, bdr: oi.bdr };
    const others = [...oi.neighbors.values()].filter((n) => n.state !== 'INIT');
    const before = `${oi.dr}/${oi.bdr}`;
    const better = (a: typeof me, b: typeof me) => a.priority > b.priority || (a.priority === b.priority && ipToInt(a.routerId) > ipToInt(b.routerId));
    const best = (list: (typeof me)[]) => list.reduce<typeof me | undefined>((acc, c) => (!acc || better(c, acc) ? c : acc), undefined);
    const run = () => {
      const eligible = [me, ...others].filter((c) => c.priority > 0);
      const notDr = eligible.filter((c) => c.dr !== c.address);
      const claimsBdr = notDr.filter((c) => c.bdr === c.address);
      const bdr = best(claimsBdr.length ? claimsBdr : notDr);
      const dr = best(eligible.filter((c) => c.dr === c.address)) ?? bdr;
      // When the BDR is promoted, the simulator fills the empty BDR slot straight away instead of
      // waiting a hello interval; that choice is not a role change for step 4 below.
      const filled = bdr === dr ? best(notDr.filter((c) => c !== dr)) : bdr;
      return { dr: dr?.address ?? NO_DR, bdr: bdr?.address ?? NO_DR, filled: filled?.address ?? NO_DR };
    };
    let result = run();
    const changed = (r: { dr: string; bdr: string }) => (r.dr === me.address) !== (me.dr === me.address) || (r.bdr === me.address) !== (me.bdr === me.address);
    if (changed(result)) {
      // Our own role changed: declare it and run the election once more (RFC step 4).
      Object.assign(me, { dr: result.dr, bdr: result.bdr });
      result = run();
    }
    result = { ...result, bdr: result.filled };
    oi.dr = result.dr;
    oi.bdr = result.bdr;
    return before !== `${oi.dr}/${oi.bdr}`;
  }

  private sendDbd(oi: OspfInterface, n: OspfNeighbor): void {
    n.sentDbd = true;
    this.host.sendOspf(oi.iface, { type: 'dbd', routerId: this.routerId!, area: oi.area, lsas: [...this.lsdb.values()] }, { ip: n.address, mac: n.mac });
  }

  /** End of a round: expire silent neighbors, elect, form adjacencies, originate LSAs and run SPF. */
  settle(): boolean {
    this.syncInterfaces();
    if (!this.routerId) return this.consumeDirty();
    for (const oi of this.ifaces.values()) {
      for (const n of [...oi.neighbors.values()]) if (n.heardInRound < this.round) this.dropNeighbor(oi, n, 'Dead timer expired');
      oi.age++;
      if (this.networkType(oi.iface) === 'broadcast' && oi.age >= WAIT_ROUNDS && !oi.passive && this.elect(oi)) this.dirty = true;
      for (const n of oi.neighbors.values()) {
        if (n.state === 'INIT') continue;
        const adjacent = this.adjacent(oi, n);
        if (adjacent && n.state === '2WAY') {
          n.state = 'EXSTART';
          this.sendDbd(oi, n);
          this.dirty = true;
        } else if (!adjacent && (n.state === 'FULL' || n.state === 'EXSTART')) {
          Object.assign(n, { state: '2WAY', sentDbd: false });
          this.dirty = true;
        }
      }
    }
    this.originate();
    this.routes = this.spf();
    return this.consumeDirty();
  }

  private consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  // ---------------------------------------------------------------- LSDB and flooding

  private key(l: Lsa): string {
    return `${l.lsType}:${l.id}:${l.advRouter}`;
  }

  /** Installs newer LSAs and floods them on. Our own LSAs coming back stale are ignored. */
  private install(lsas: Lsa[], from: OspfNeighbor): void {
    const fresh: Lsa[] = [];
    for (const l of lsas) {
      const have = this.lsdb.get(this.key(l));
      if (have && have.seq >= l.seq) continue;
      // A copy older than a flush we already saw: someone's stale database, not news.
      if (l.seq <= (this.flushed.get(this.key(l)) ?? -1)) continue;
      if (l.flushed && !have) continue;
      if (l.advRouter === this.routerId) {
        // Someone holds a newer copy of an LSA we originated before a restart: outnumber it, and
        // re-originate ours (originate() runs again at the end of this round).
        this.seq = Math.max(this.seq, l.seq + 1);
        if (have || l.lsType === 'router') {
          this.lsdb.delete(this.key(l));
          this.dirty = true;
        } else {
          // An LSA we no longer originate (a network LSA from when we were DR): withdraw it.
          this.flush(l);
        }
        continue;
      }
      if (l.flushed) {
        this.lsdb.delete(this.key(l));
        this.flushed.set(this.key(l), l.seq);
      } else {
        this.lsdb.set(this.key(l), l);
        this.flushed.delete(this.key(l));
      }
      fresh.push(l);
    }
    if (fresh.length) {
      this.dirty = true;
      this.flood(fresh, from);
    }
  }

  /**
   * A neighbor's database description lists every LSA it originated, so any of its LSAs we hold
   * that it no longer lists were withdrawn while we could not hear it. Real OSPF ages them out.
   */
  private dropWithdrawn(advRouter: Ipv4Address, lsas: Lsa[]): void {
    const listed = new Set(lsas.map((l) => this.key(l)));
    for (const [k, l] of this.lsdb) {
      if (l.advRouter === advRouter && !listed.has(k)) {
        this.lsdb.delete(k);
        this.flushed.set(k, l.seq);
        this.dirty = true;
      }
    }
  }

  private flood(lsas: Lsa[], except?: OspfNeighbor): void {
    for (const oi of this.ifaces.values()) {
      const targets = [...oi.neighbors.values()].filter((n) => n !== except && (n.state === 'FULL' || n.state === 'EXSTART'));
      if (targets.length) this.host.sendOspf(oi.iface, { type: 'lsu', routerId: this.routerId!, area: oi.area, lsas });
    }
  }

  private originateLsa(l: Lsa): void {
    const have = this.lsdb.get(this.key(l));
    const body = (x: Lsa | undefined) => x && JSON.stringify({ ...x, seq: 0, originatedAt: 0 });
    if (have && body(have) === body(l)) return;
    const lsa = { ...l, seq: this.seq++, originatedAt: this.host.clock };
    this.lsdb.set(this.key(lsa), lsa);
    this.flood([lsa]);
    this.dirty = true;
  }

  private flush(l: Lsa): void {
    const seq = this.seq++;
    this.lsdb.delete(this.key(l));
    this.flushed.set(this.key(l), seq);
    this.flood([{ ...l, seq, flushed: true }]);
    this.dirty = true;
  }

  private originate(): void {
    const rid = this.routerId!;
    const links: LsaLink[] = [];
    const networks: NetworkLsa[] = [];
    for (const oi of this.ifaces.values()) {
      const i = oi.iface;
      const { address, prefix } = i.ip!;
      const cost = this.cost(i);
      const stub: LsaLink = { type: 'stub', id: networkAddress(address, prefix), prefix, cost };
      const type = this.networkType(i);
      const full = [...oi.neighbors.values()].filter((n) => n.state === 'FULL');
      if (type === 'loopback') links.push({ type: 'stub', id: address, prefix: 32, cost });
      else if (oi.passive || !full.length) links.push(stub);
      else if (type === 'point-to-point') links.push(...full.map((n): LsaLink => ({ type: 'p2p', id: n.routerId, data: address, cost })), stub);
      else if (oi.dr === address || full.some((n) => n.address === oi.dr)) {
        links.push({ type: 'transit', id: oi.dr, data: address, cost });
        if (oi.dr === address) networks.push({ lsType: 'network', id: address, advRouter: rid, seq: 0, originatedAt: 0, prefix, attached: [rid, ...full.map((n) => n.routerId)] });
      } else links.push(stub);
    }
    this.originateLsa({ lsType: 'router', id: rid, advRouter: rid, seq: 0, originatedAt: 0, links });
    for (const n of networks) this.originateLsa(n);
    for (const l of this.lsdb.values()) {
      if (l.advRouter === rid && l.lsType === 'network' && !networks.some((n) => n.id === l.id)) this.flush(l);
    }
    const external: ExternalLsa = { lsType: 'external', id: '0.0.0.0', advRouter: rid, seq: 0, originatedAt: 0, prefix: 0, metric: 1 };
    const haveExternal = this.lsdb.get(this.key(external));
    if (this.defaultOriginate && this.host.hasNonOspfDefault()) this.originateLsa(external);
    else if (haveExternal) this.flush(haveExternal);
  }

  // ---------------------------------------------------------------- SPF

  /** Dijkstra over router and network vertices, with equal-cost paths kept (up to four, like IOS). */
  private spf(): Route[] {
    const rid = this.routerId!;
    const routers = new Map<Ipv4Address, RouterLsa>();
    const networks = new Map<Ipv4Address, NetworkLsa>();
    for (const l of this.lsdb.values()) {
      if (l.lsType === 'router') routers.set(l.advRouter, l);
      else if (l.lsType === 'network') networks.set(l.id, l);
    }
    type Vertex = { key: string; cost: number; hops: NextHop[] };
    const done = new Map<string, Vertex>();
    const open = new Map<string, Vertex>([[`R:${rid}`, { key: `R:${rid}`, cost: 0, hops: [] }]]);
    const relax = (key: string, cost: number, hops: NextHop[]) => {
      if (done.has(key)) return;
      const cur = open.get(key);
      if (!cur || cost < cur.cost) open.set(key, { key, cost, hops: [...hops] });
      else if (cost === cur.cost) for (const h of hops) if (!cur.hops.some((x) => x.iface === h.iface && x.gw === h.gw)) cur.hops.push(h);
    };
    while (open.size) {
      const v = [...open.values()].reduce((a, b) => (b.cost < a.cost ? b : a));
      open.delete(v.key);
      done.set(v.key, v);
      const [kind, id = ''] = v.key.split(/:(.*)/);
      const root = v.key === `R:${rid}`;
      if (kind === 'R') {
        const lsa = routers.get(id);
        for (const link of lsa?.links ?? []) {
          if (link.type === 'p2p') {
            const back = routers.get(link.id)?.links.some((l) => l.type === 'p2p' && l.id === id);
            if (!back) continue;
            let hops = v.hops;
            if (root) {
              const oi = [...this.ifaces.values()].find((o) => o.iface.ip?.address === link.data);
              const n = oi?.neighbors.get(link.id);
              if (!oi || !n) continue;
              hops = [{ iface: oi.iface, gw: n.address }];
            }
            relax(`R:${link.id}`, v.cost + link.cost, hops);
          } else if (link.type === 'transit') {
            if (!networks.get(link.id)?.attached.includes(id)) continue;
            let hops = v.hops;
            if (root) {
              const oi = [...this.ifaces.values()].find((o) => o.iface.ip?.address === link.data);
              if (!oi) continue;
              hops = [{ iface: oi.iface }];
            }
            relax(`N:${link.id}`, v.cost + link.cost, hops);
          }
        }
      } else {
        const net = networks.get(id)!;
        for (const r of net.attached) {
          const link = routers.get(r)?.links.find((l) => l.type === 'transit' && l.id === id);
          if (!link || link.type !== 'transit') continue;
          // Directly attached network: the next hop is that router's own address on it.
          const hops = v.hops.map((h) => (h.gw ? h : { iface: h.iface, gw: link.data }));
          relax(`R:${r}`, v.cost, hops);
        }
      }
    }

    const best = new Map<string, { network: Ipv4Address; prefix: number; cost: number; hops: NextHop[]; external?: boolean }>();
    const offer = (network: Ipv4Address, prefix: number, cost: number, hops: NextHop[], external?: boolean) => {
      if (!hops.length || hops.some((h) => !h.gw)) return;
      const k = `${network}/${prefix}`;
      const cur = best.get(k);
      if (!cur || cost < cur.cost) best.set(k, { network, prefix, cost, hops: [...hops], external });
      else if (cost === cur.cost) for (const h of hops) if (!cur.hops.some((x) => x.iface === h.iface && x.gw === h.gw)) cur.hops.push(h);
    };
    for (const v of done.values()) {
      if (v.key === `R:${rid}`) continue;
      const [kind, id = ''] = v.key.split(/:(.*)/);
      if (kind === 'N') {
        const net = networks.get(id)!;
        offer(networkAddress(id, net.prefix), net.prefix, v.cost, v.hops);
        continue;
      }
      for (const link of routers.get(id)?.links ?? []) if (link.type === 'stub') offer(link.id, link.prefix, v.cost + link.cost, v.hops);
    }
    // Externals are type 2: the metric stays as advertised, whatever the internal path cost.
    for (const l of this.lsdb.values()) {
      if (l.lsType !== 'external' || l.advRouter === rid) continue;
      const asbr = done.get(`R:${l.advRouter}`);
      if (asbr) offer(l.id, l.prefix, l.metric, asbr.hops, true);
    }

    const routes: Route[] = [];
    const seen = new Set<string>();
    for (const [k, r] of best) {
      seen.add(k);
      if (!this.learnedAt.has(k)) this.learnedAt.set(k, this.host.clock);
      for (const h of r.hops.slice(0, 4)) {
        routes.push({ code: 'O', network: r.network, prefix: r.prefix, ad: OSPF_AD, metric: r.cost, nextHop: h.gw, iface: h.iface, external: r.external, learnedAt: this.learnedAt.get(k) });
      }
    }
    for (const k of [...this.learnedAt.keys()]) if (!seen.has(k)) this.learnedAt.delete(k);
    return routes;
  }

  neighbors(): { oi: OspfInterface; n: OspfNeighbor }[] {
    return [...this.ifaces.values()].flatMap((oi) => [...oi.neighbors.values()].map((n) => ({ oi, n })));
  }

  /** The interface state column: DR, BDR, DROTHER, WAIT, P2P or LOOP. */
  interfaceState(oi: OspfInterface): string {
    const type = this.networkType(oi.iface);
    if (type === 'loopback') return 'LOOP';
    if (type === 'point-to-point') return 'P2P';
    if (oi.age < WAIT_ROUNDS) return 'WAIT';
    const me = oi.iface.ip!.address;
    return oi.dr === me ? 'DR' : oi.bdr === me ? 'BDR' : 'DROTHER';
  }

  /** The neighbor state as `show ip ospf neighbor` prints it: FULL/DR, 2WAY/DROTHER, FULL/  -. */
  neighborState(oi: OspfInterface, n: OspfNeighbor): string {
    if (this.networkType(oi.iface) === 'point-to-point') return `${n.state}/  -`;
    const role = n.address === oi.dr ? 'DR' : n.address === oi.bdr ? 'BDR' : 'DROTHER';
    return `${n.state}/${role}`;
  }
}

// ---------------------------------------------------------------- show commands

function routerIdOf(oi: OspfInterface, address: Ipv4Address, self: OspfProcess): Ipv4Address {
  if (address === oi.iface.ip?.address) return self.routerId!;
  return [...oi.neighbors.values()].find((n) => n.address === address)?.routerId ?? address;
}

export function showOspfNeighbor(processes: OspfProcess[]): string {
  const rows = processes.flatMap((p) =>
    p.neighbors().map(({ oi, n }) => {
      const dead = `00:00:${String(p.deadInterval(oi.iface) - 4).padStart(2, '0')}`;
      const pri = p.networkType(oi.iface) === 'point-to-point' ? 0 : n.priority;
      return `${n.routerId.padEnd(16)}${String(pri).padStart(3)}   ${p.neighborState(oi, n).padEnd(16)}${dead.padEnd(12)}${n.address.padEnd(16)}${oi.iface.name}`;
    }),
  );
  return ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...rows].join('\n');
}

export function showOspfInterfaceBrief(processes: OspfProcess[]): string {
  const rows = processes.flatMap((p) =>
    [...p.ifaces.values()].map((oi) => {
      const ip = `${oi.iface.ip!.address}/${oi.iface.ip!.prefix}`;
      const full = [...oi.neighbors.values()].filter((n) => n.state === 'FULL').length;
      return `${shortName(oi.iface.name).padEnd(13)}${String(p.pid).padEnd(6)}${String(oi.area).padEnd(16)}${ip.padEnd(19)}${String(p.cost(oi.iface)).padEnd(6)}${p.interfaceState(oi).padEnd(6)}${full}/${oi.neighbors.size}`;
    }),
  );
  return ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C', ...rows].join('\n');
}

export function showOspfInterface(p: OspfProcess, i: Interface): string {
  const oi = p.ifaces.get(i);
  if (!oi) return `${i.name} is ${i.isUp ? 'up' : 'down'}, line protocol is ${i.isUp ? 'up' : 'down'}\n  OSPF not enabled on this interface`;
  const type = p.networkType(i);
  const lines = [
    `${i.name} is up, line protocol is up`,
    `  Internet Address ${i.ip!.address}/${i.ip!.prefix}, Area ${oi.area}, Attached via ${i.ospf?.process ? 'Interface Enable' : 'Network Statement'}`,
    `  Process ID ${p.pid}, Router ID ${p.routerId ?? NO_DR}, Network Type ${type === 'loopback' ? 'LOOPBACK' : type === 'point-to-point' ? 'POINT_TO_POINT' : 'BROADCAST'}, Cost: ${p.cost(i)}`,
  ];
  if (type === 'loopback') return [...lines, '  Loopback interface is treated as a stub Host'].join('\n');
  const state = p.interfaceState(oi);
  lines.push(`  Transmit Delay is 1 sec, State ${state === 'WAIT' ? 'WAITING' : state === 'P2P' ? 'POINT_TO_POINT' : state}${type === 'broadcast' ? `, Priority ${p.priority(i)}` : ''}`);
  if (type === 'broadcast') {
    if (oi.dr !== NO_DR) lines.push(`  Designated Router (ID) ${routerIdOf(oi, oi.dr, p)}, Interface address ${oi.dr}`);
    else lines.push('  No designated router on this network');
    if (oi.bdr !== NO_DR) lines.push(`  Backup Designated router (ID) ${routerIdOf(oi, oi.bdr, p)}, Interface address ${oi.bdr}`);
    else lines.push('  No backup designated router on this network');
  }
  lines.push(`  Timer intervals configured, Hello ${p.helloInterval(i)}, Dead ${p.deadInterval(i)}, Wait ${p.deadInterval(i)}, Retransmit 5`);
  if (oi.passive) lines.push('    No Hellos (Passive interface)');
  else lines.push(`    Hello due in 00:00:0${Math.min(9, p.helloInterval(i) - 1)}`);
  const full = [...oi.neighbors.values()].filter((n) => n.state === 'FULL');
  lines.push(`  Neighbor Count is ${oi.neighbors.size}, Adjacent neighbor count is ${full.length}`);
  for (const n of full) lines.push(`    Adjacent with neighbor ${n.routerId}${n.address === oi.dr ? '  (Designated Router)' : n.address === oi.bdr ? '  (Backup Designated Router)' : ''}`);
  return lines.join('\n');
}

export function showIpOspf(p: OspfProcess): string {
  const areaIfaces = [...p.ifaces.values()];
  return [
    ` Routing Process "ospf ${p.pid}" with ID ${p.routerId ?? NO_DR}`,
    ' Start time: 00:00:00.000, Time elapsed: 00:00:00.000',
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    p.defaultOriginate ? ' It is an autonomous system boundary router' : '',
    ' Router is not originating router-LSAs with maximum metric',
    ` Reference bandwidth unit is ${p.referenceBandwidth} mbps`,
    ` Number of areas in this router is ${new Set(areaIfaces.map((oi) => oi.area)).size}. ${new Set(areaIfaces.map((oi) => oi.area)).size} normal 0 stub 0 nssa`,
    ...[...new Set(areaIfaces.map((oi) => oi.area))].map((a) => `    Area ${a === 0 ? 'BACKBONE(0)' : a}\n        Number of interfaces in this area is ${areaIfaces.filter((oi) => oi.area === a).length}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function checksum(l: Lsa): string {
  let h = 0;
  for (const c of JSON.stringify({ ...l, originatedAt: 0 })) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return `0x${h.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function showOspfDatabase(p: OspfProcess, now: number): string {
  const age = (l: Lsa) => String(Math.min(3600, Math.floor((now - l.originatedAt) / 1000)));
  const seq = (l: Lsa) => `0x${l.seq.toString(16).toUpperCase()}`;
  const sorted = (type: Lsa['lsType']) => [...p.lsdb.values()].filter((l) => l.lsType === type).sort((a, b) => ipToInt(a.id) - ipToInt(b.id));
  const out = ['', `            OSPF Router with ID (${p.routerId ?? NO_DR}) (Process ID ${p.pid})`, '', '                Router Link States (Area 0)', '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count'];
  for (const l of sorted('router')) out.push(`${l.id.padEnd(16)}${l.advRouter.padEnd(16)}${age(l).padEnd(12)}${seq(l).padEnd(11)}${checksum(l)}   ${(l as RouterLsa).links.length}`);
  const nets = sorted('network');
  if (nets.length) {
    out.push('', '                Net Link States (Area 0)', '', 'Link ID         ADV Router      Age         Seq#       Checksum');
    for (const l of nets) out.push(`${l.id.padEnd(16)}${l.advRouter.padEnd(16)}${age(l).padEnd(12)}${seq(l).padEnd(11)}${checksum(l)}`);
  }
  const ext = sorted('external');
  if (ext.length) {
    out.push('', '                Type-5 AS External Link States', '', 'Link ID         ADV Router      Age         Seq#       Checksum Tag');
    for (const l of ext) out.push(`${l.id.padEnd(16)}${l.advRouter.padEnd(16)}${age(l).padEnd(12)}${seq(l).padEnd(11)}${checksum(l)} 1`);
  }
  return out.join('\n');
}

export function showIpProtocols(processes: OspfProcess[]): string {
  const out: string[] = ['*** IP Routing is NSF aware ***', ''];
  for (const p of processes) {
    out.push(
      `Routing Protocol is "ospf ${p.pid}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${p.routerId ?? NO_DR}`,
      `  Number of areas in this router is 1. 1 normal 0 stub 0 nssa`,
      '  Maximum path: 4',
      '  Routing for Networks:',
      ...p.networks.map((n) => `    ${n.address} ${n.wildcard} area ${n.area}`),
    );
    const enabled = [...p.ifaces.values()].filter((oi) => oi.iface.ospf?.process);
    if (enabled.length) out.push('  Routing on Interfaces Configured Explicitly (Area 0):', ...enabled.map((oi) => `    ${oi.iface.name}`));
    const passive = [...p.ifaces.values()].filter((oi) => oi.passive);
    if (passive.length) out.push('  Passive Interface(s):', ...passive.map((oi) => `    ${oi.iface.name}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    const sources = new Set(p.routes.map((r) => r.nextHop).filter((x): x is string => !!x));
    for (const s of sources) {
      const rid = p.neighbors().find(({ n }) => n.address === s)?.n.routerId ?? s;
      out.push(`    ${rid.padEnd(16)}${String(OSPF_AD).padEnd(14)}00:00:12`);
    }
    out.push(`  Distance: (default is ${OSPF_AD})`, '');
  }
  return out.join('\n');
}

/** Running-config lines for the process. */
export function ospfConfig(p: OspfProcess): string[] {
  const out = [`router ospf ${p.pid}`];
  if (p.configuredRouterId) out.push(` router-id ${p.configuredRouterId}`);
  if (p.referenceBandwidth !== 100) out.push(` auto-cost reference-bandwidth ${p.referenceBandwidth}`);
  if (p.passiveDefault) out.push(' passive-interface default');
  for (const name of p.passiveDefault ? p.active : p.passive) out.push(` ${p.passiveDefault ? 'no ' : ''}passive-interface ${displayName(name)}`);
  for (const n of p.networks) out.push(` network ${n.address} ${n.wildcard} area ${n.area}`);
  if (p.defaultOriginate) out.push(' default-information originate');
  out.push('!');
  return out;
}

function displayName(lower: string): string {
  return lower.replace(/^gigabitethernet/, 'GigabitEthernet').replace(/^loopback/, 'Loopback').replace(/^fastethernet/, 'FastEthernet');
}

