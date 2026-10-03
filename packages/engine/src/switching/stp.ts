import type { MacAddress } from '../core/addressing';
import type { BpduPacket, BridgeId } from '../core/frames';
import { shortName, type Interface } from '../devices/device';

export type StpMode = 'pvst' | 'rapid-pvst';
export type StpRole = 'root' | 'designated' | 'alternate' | 'backup';

/** IOS default bridge priority, before the VLAN is added as the system ID extension. */
export const DEFAULT_BRIDGE_PRIORITY = 32768;
export const DEFAULT_PORT_PRIORITY = 128;
/** BPDUs that have crossed this many bridges are discarded, so stale root information dies out. */
export const MAX_AGE = 20;

export interface StpPort {
  role: StpRole;
  cost: number;
  portId: { priority: number; number: number };
  /** PortFast port that has not heard a BPDU. */
  edge: boolean;
  /** Root guard heard a superior BPDU here, so the port is blocked (root-inconsistent). */
  rootInconsistent: boolean;
}

export interface StpVlan {
  vlan: number;
  root: BridgeId;
  rootCost: number;
  rootPort?: Interface;
  /** Bridges between the root and us, carried in the BPDUs we send. */
  messageAge: number;
  ports: Map<Interface, StpPort>;
}

/** What the spanning tree needs from its switch. */
export interface StpHost {
  readonly bridgeMac: MacAddress;
  readonly log: string[];
  /** VLANs that exist on the switch. */
  vlanIds(): number[];
  /** Ports STP runs on: physical ports outside a bundle, plus port-channels that are up. */
  logicalPorts(): Interface[];
  carriesVlan(port: Interface, vlan: number): boolean;
  sendBpdu(port: Interface, bpdu: BpduPacket): void;
  /** Port cost from the link speed (short method: 1 Gb/s is 4, a 2-4 Gb/s bundle is 3). */
  defaultCost(port: Interface): number;
  portNumber(port: Interface): number;
  /** Forget MAC addresses in a VLAN after the topology changed (RSTP topology change flush). */
  flushMacs(vlan: number): void;
}

interface Vector {
  root: BridgeId;
  cost: number;
  bridge: BridgeId;
  port: number;
}

export function compareBridge(a: BridgeId, b: BridgeId): number {
  return a.priority - b.priority || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);
}

const portKey = (p: { priority: number; number: number }) => p.priority * 4096 + p.number;

/** Lower is better at every step: root ID, cost to the root, sender bridge ID, sender port ID. */
function compareVector(a: Vector, b: Vector): number {
  return compareBridge(a.root, b.root) || a.cost - b.cost || compareBridge(a.bridge, b.bridge) || a.port - b.port;
}

/**
 * Per-VLAN spanning tree (PVST+ and Rapid PVST+). Each convergence round, designated ports send
 * BPDUs; at the end of the round every switch elects the root from what it heard, picks its root
 * port, and makes each other port designated (forwarding) or alternate (discarding).
 *
 * Simplifications: the proposal/agreement handshake and the PVST+ listening and learning timers
 * are not modelled, so both modes converge as soon as the round ends. A BPDU not heard in a
 * round counts as lost, which stands in for max age expiry.
 */
export class SpanningTree {
  mode: StpMode = 'pvst';
  /** `no spanning-tree vlan <id>`. */
  readonly disabled = new Set<number>();
  /** `spanning-tree vlan <id> priority <n>`, without the system ID extension. */
  readonly priorities = new Map<number, number>();
  /** `spanning-tree portfast default`: access ports are edge ports unless told otherwise. */
  portfastDefault = false;
  /** `spanning-tree portfast bpduguard default`: BPDU guard on every operational edge port. */
  bpduGuardDefault = false;
  readonly vlans = new Map<number, StpVlan>();
  /** False until the first round has run, so a switch that never converged still forwards. */
  computed = false;
  private heard = new Map<number, Map<Interface, BpduPacket>>();

  constructor(private readonly host: StpHost) {}

  enabled(vlan: number): boolean {
    return !this.disabled.has(vlan);
  }

  bridgeId(vlan: number): BridgeId {
    return { priority: (this.priorities.get(vlan) ?? DEFAULT_BRIDGE_PRIORITY) + vlan, mac: this.host.bridgeMac };
  }

  isRoot(vlan: number): boolean {
    const st = this.vlans.get(vlan);
    return st !== undefined && compareBridge(st.root, this.bridgeId(vlan)) === 0;
  }

  portfast(port: Interface): boolean {
    return port.stp?.portfast ?? (this.portfastDefault && port.mode === 'access' && port.kind === 'physical');
  }

  bpduGuard(port: Interface): boolean {
    return port.stp?.bpduGuard ?? (this.bpduGuardDefault && this.portfast(port));
  }

  cost(port: Interface): number {
    return port.stp?.cost ?? this.host.defaultCost(port);
  }

  portId(port: Interface): { priority: number; number: number } {
    return { priority: port.stp?.priority ?? DEFAULT_PORT_PRIORITY, number: this.host.portNumber(port) };
  }

  /** Can data frames in `vlan` enter and leave `port`? */
  forwarding(port: Interface, vlan: number): boolean {
    if (!this.enabled(vlan) || !this.computed) return true;
    const info = this.vlans.get(vlan)?.ports.get(port);
    // A port that came up since the last round waits for the next one, unless it is an edge port.
    if (!info) return this.portfast(port);
    return !info.rootInconsistent && (info.role === 'root' || info.role === 'designated');
  }

  /** VLANs this port discards in (for the topology view). */
  blockedVlans(port: Interface): number[] {
    return [...this.vlans.values()].filter((st) => st.ports.has(port) && !this.forwarding(port, st.vlan)).map((st) => st.vlan);
  }

  blocking(port: Interface): boolean {
    return this.blockedVlans(port).length > 0;
  }

  private participating(vlan: number): Interface[] {
    return this.host.logicalPorts().filter((p) => p.isUp && this.host.carriesVlan(p, vlan));
  }

  private activeVlans(): number[] {
    return this.host.vlanIds().filter((v) => this.enabled(v) && this.participating(v).length > 0);
  }

  receive(port: Interface, bpdu: BpduPacket): void {
    if (!this.enabled(bpdu.vlan) || !this.host.carriesVlan(port, bpdu.vlan)) return;
    let perVlan = this.heard.get(bpdu.vlan);
    if (!perVlan) this.heard.set(bpdu.vlan, (perVlan = new Map()));
    perVlan.set(port, bpdu);
  }

  /** Start of a round: forget last round's BPDUs and send ours out of every designated port. */
  tick(): void {
    this.heard.clear();
    for (const vlan of this.activeVlans()) {
      const st = this.vlans.get(vlan);
      const me = this.bridgeId(vlan);
      for (const port of this.participating(vlan)) {
        const role = st?.ports.get(port)?.role;
        if (role !== undefined && role !== 'designated') continue;
        this.host.sendBpdu(port, {
          kind: 'bpdu',
          vlan,
          root: st?.root ?? me,
          rootCost: st?.rootCost ?? 0,
          bridge: me,
          portId: this.portId(port),
          messageAge: st?.messageAge ?? 0,
        });
      }
    }
  }

  /** End of a round: elect the root and assign port roles. Returns true when anything changed. */
  settle(): boolean {
    const wasComputed = this.computed;
    this.computed = true;
    let changed = false;
    const active = new Set(this.activeVlans());
    for (const vlan of [...this.vlans.keys()]) {
      if (active.has(vlan)) continue;
      this.vlans.delete(vlan);
      changed = true;
    }
    for (const vlan of active) changed = this.compute(vlan) || changed;
    return changed || !wasComputed;
  }

  private compute(vlan: number): boolean {
    const me = this.bridgeId(vlan);
    const ports = this.participating(vlan);
    const heard = this.heard.get(vlan) ?? new Map<Interface, BpduPacket>();
    const usable = (p: Interface) => {
      const b = heard.get(p);
      return b && b.messageAge < MAX_AGE ? b : undefined;
    };
    const designatedVector = (p: Interface, root: BridgeId, cost: number): Vector => ({ root, cost, bridge: me, port: portKey(this.portId(p)) });
    const theirs = (b: BpduPacket): Vector => ({ root: b.root, cost: b.rootCost, bridge: b.bridge, port: portKey(b.portId) });

    let best = { vector: { root: me, cost: 0, bridge: me, port: 0 } as Vector, local: 0, via: undefined as Interface | undefined, age: 0 };
    const candidate = (p: Interface, b: BpduPacket) => ({
      vector: { root: b.root, cost: b.rootCost + this.cost(p), bridge: b.bridge, port: portKey(b.portId) },
      local: portKey(this.portId(p)),
      via: p as Interface | undefined,
      age: b.messageAge + 1,
    });
    const better = (a: typeof best, b: typeof best) => {
      const cmp = compareVector(a.vector, b.vector);
      return cmp < 0 || (cmp === 0 && a.local < b.local);
    };
    for (const p of ports) {
      const b = usable(p);
      if (!b || compareBridge(b.bridge, me) === 0 || p.stp?.guardRoot) continue;
      const cand = candidate(p, b);
      if (better(cand, best)) best = cand;
    }
    // Root guard: a port that would become the root port is blocked (root-inconsistent) instead.
    const inconsistent = new Set<Interface>();
    for (const p of ports) {
      const b = usable(p);
      if (p.stp?.guardRoot && b && compareBridge(b.bridge, me) !== 0 && better(candidate(p, b), best)) inconsistent.add(p);
    }

    const prev = this.vlans.get(vlan);
    const next: StpVlan = { vlan, root: best.vector.root, rootCost: best.vector.cost, rootPort: best.via, messageAge: best.age, ports: new Map() };
    for (const p of ports) {
      const b = usable(p);
      let role: StpRole;
      if (p === best.via) role = 'root';
      else if (!b || inconsistent.has(p) || compareVector(designatedVector(p, next.root, next.rootCost), theirs(b)) < 0) role = 'designated';
      else role = compareBridge(b.bridge, me) === 0 ? 'backup' : 'alternate';
      next.ports.set(p, {
        role,
        cost: this.cost(p),
        portId: this.portId(p),
        edge: this.portfast(p) && heard.get(p) === undefined,
        rootInconsistent: inconsistent.has(p),
      });
      const was = prev?.ports.get(p);
      if (inconsistent.has(p) && !was?.rootInconsistent) this.host.log.push(`%SPANTREE-2-ROOTGUARD_BLOCK: Root guard blocking port ${p.name} on VLAN${String(vlan).padStart(4, '0')}.`);
      if (!inconsistent.has(p) && was?.rootInconsistent) this.host.log.push(`%SPANTREE-2-ROOTGUARD_UNBLOCK: Root guard unblocking port ${p.name} on VLAN${String(vlan).padStart(4, '0')}.`);
    }
    this.vlans.set(vlan, next);

    const changed =
      !prev ||
      compareBridge(prev.root, next.root) !== 0 ||
      prev.rootCost !== next.rootCost ||
      prev.rootPort !== next.rootPort ||
      prev.ports.size !== next.ports.size ||
      [...next.ports].some(([p, info]) => {
        const was = prev.ports.get(p);
        return !was || was.role !== info.role || was.rootInconsistent !== info.rootInconsistent;
      });
    if (changed && prev) this.host.flushMacs(vlan);
    return changed;
  }
}

// ---------------------------------------------------------------- show spanning-tree

const ROLE: Record<StpRole, string> = { root: 'Root', designated: 'Desg', alternate: 'Altn', backup: 'Back' };

function bridgeLines(label: string, id: BridgeId, vlan: number, extra: string[]): string[] {
  return [
    `  ${label.padEnd(11)}Priority    ${id.priority}${label === 'Bridge ID' ? `  (priority ${id.priority - vlan} sys-id-ext ${vlan})` : ''}`,
    `             Address     ${id.mac}`,
    ...extra.map((l) => `             ${l}`),
    '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
  ];
}

export function showSpanningTreeVlan(stp: SpanningTree, vlan: number): string {
  const st = stp.vlans.get(vlan);
  const name = `VLAN${String(vlan).padStart(4, '0')}`;
  if (!stp.enabled(vlan)) return `Spanning tree instance(s) for vlan ${vlan} does not exist.`;
  if (!st) return `Spanning tree instance(s) for vlan ${vlan} does not exist.`;
  const me = stp.bridgeId(vlan);
  const rootExtra = stp.isRoot(vlan)
    ? ['This bridge is the root']
    : [`Cost        ${st.rootCost}`, `Port        ${stp.portId(st.rootPort!).number} (${st.rootPort!.name})`];
  const rows = [...st.ports]
    .sort(([a], [b]) => stp.portId(a).number - stp.portId(b).number)
    .map(([p, info]) => {
      const sts = info.rootInconsistent ? 'BKN*' : stp.forwarding(p, vlan) ? 'FWD' : 'BLK';
      const type = `P2p${info.edge ? ' Edge' : ''}${info.rootInconsistent ? ' *ROOT_Inc' : ''}`;
      return `${shortName(p.name).padEnd(20)}${ROLE[info.role]} ${sts.padEnd(4)}${String(info.cost).padEnd(10)}${`${info.portId.priority}.${info.portId.number}`.padEnd(9)}${type}`;
    });
  return [
    name,
    `  Spanning tree enabled protocol ${stp.mode === 'rapid-pvst' ? 'rstp' : 'ieee'}`,
    ...bridgeLines('Root ID', st.root, vlan, rootExtra),
    '',
    ...bridgeLines('Bridge ID', me, vlan, []),
    '             Aging Time  300 sec',
    '',
    'Interface           Role Sts Cost      Prio.Nbr Type',
    '------------------- ---- --- --------- -------- --------------------------------',
    ...rows,
  ].join('\n');
}

export function showSpanningTree(stp: SpanningTree): string {
  const vlans = [...stp.vlans.keys()].sort((a, b) => a - b);
  if (!vlans.length) return 'No spanning tree instance exists.';
  return vlans.map((v) => showSpanningTreeVlan(stp, v)).join('\n\n');
}

export function showSpanningTreeSummary(stp: SpanningTree): string {
  const vlans = [...stp.vlans.values()].sort((a, b) => a.vlan - b.vlan);
  const roots = vlans.filter((st) => stp.isRoot(st.vlan)).map((st) => `VLAN${String(st.vlan).padStart(4, '0')}`);
  const rows = vlans.map((st) => {
    const ports = [...st.ports.keys()];
    const blocking = ports.filter((p) => !stp.forwarding(p, st.vlan)).length;
    const fwd = ports.length - blocking;
    return `${`VLAN${String(st.vlan).padStart(4, '0')}`.padEnd(25)}${String(blocking).padStart(8)}${'0'.padStart(10)}${'0'.padStart(9)}${String(fwd).padStart(11)}${String(ports.length).padStart(11)}`;
  });
  const onOff = (b: boolean) => (b ? 'enabled' : 'disabled');
  return [
    `Switch is in ${stp.mode} mode`,
    `Root bridge for: ${roots.join(', ') || 'none'}`,
    `Portfast Default                        is ${onOff(stp.portfastDefault)}`,
    `PortFast BPDU Guard Default             is ${onOff(stp.bpduGuardDefault)}`,
    'Pathcost method used                    is short',
    '',
    'Name                   Blocking Listening Learning Forwarding STP Active',
    '---------------------- -------- --------- -------- ---------- ----------',
    ...rows,
  ].join('\n');
}
