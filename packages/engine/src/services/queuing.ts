import type { IpPacket } from '../core/frames';
import type { Interface } from '../devices/device';
import { CLASS_DEFAULT, DEFAULT_QUEUE_LIMIT, Qos, wredThreshold, type ClassCounters, type PolicyClass, type PolicyMap } from './qos';

/**
 * A fluid model of router output queues, stepped in fixed ticks. Traffic moves as chunks of bytes
 * (a flow's share of one tick) rather than single packets, which keeps long runs at high rates
 * cheap and the results exactly repeatable. Each tick, a stage takes in what arrived, polices and
 * marks it, drops what does not fit (tail drop or WRED), and then sends as many bytes as the link
 * allows: the LLQ priority queue first, then the CBWFQ classes in proportion to their bandwidth.
 */
export const TICK_MS = 10;

/** IOS's FIFO output hold queue on an interface with no service policy. */
export const HOLD_QUEUE = 40;

/** Fraction of the gap between the queue depth and its average that WRED's average closes each tick. */
const WRED_WEIGHT = 0.2;

const EPSILON = 1e-6;

/** Some of one flow's bytes, travelling together. */
export interface Chunk {
  flow: number;
  /** Index of the stage, in the flow's path, that the chunk is at. */
  hop: number;
  bytes: number;
  /** Packet size of the flow, to turn bytes into packets. */
  size: number;
  /** Queuing delay so far, in ms. */
  delay: number;
  /** A DSCP a policer set on part of the flow, which the probe (and so the stage's view of the packet) never saw. */
  dscp?: number;
  /** The tick the chunk joined its current queue. */
  enq: number;
}

/** What one class (or an interface FIFO) did during a run, before it is written to the router's counters. */
export interface ClassStats {
  offeredBytes: number;
  offeredPkts: number;
  dropBytes: number;
  dropPkts: number;
  conformPkts: number;
  exceedPkts: number;
  outBytes: number;
  outPkts: number;
  /** Queue drops: tail drop plus WRED. */
  queueDrops: number;
  wredDrops: number;
  priorityDrops: number;
  depth: number;
  maxDepth: number;
  wred: NonNullable<ClassCounters['wred']>;
}

function emptyStats(): ClassStats {
  return { offeredBytes: 0, offeredPkts: 0, dropBytes: 0, dropPkts: 0, conformPkts: 0, exceedPkts: 0, outBytes: 0, outPkts: 0, queueDrops: 0, wredDrops: 0, priorityDrops: 0, depth: 0, maxDepth: 0, wred: {} };
}

/** A class at one stage: its queue (or child policy), token buckets and counters. */
export class ClassState {
  readonly stats = emptyStats();
  queue: Chunk[] = [];
  qBytes = 0;
  qPkts = 0;
  wredAvg = 0;
  policeTokens = 0;
  shapeTokens = 0;
  child?: PolicyNode;

  constructor(
    readonly cls: PolicyClass,
    /** Counter key: the class name, prefixed by its parent class for a child policy ("class-default/VOICE"). */
    readonly key: string,
  ) {
    if (cls.police) this.policeTokens = policeBucket(cls.police.cir);
    if (cls.shape) this.shapeTokens = bytesPerTick(cls.shape);
  }

  get limit(): number {
    return this.cls.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  }

  /** Refills the policer and shaper token buckets for a new tick. */
  refill(): void {
    if (this.cls.police) this.policeTokens = Math.min(policeBucket(this.cls.police.cir), this.policeTokens + bytesPerTick(this.cls.police.cir));
    if (this.cls.shape) this.shapeTokens = bytesPerTick(this.cls.shape);
    this.child?.classes.forEach((c) => c.refill());
  }

  /** Bytes this class could send this tick: its backlog, held to its shaper. */
  demand(): number {
    const backlog = this.child ? this.child.demand() : this.qBytes;
    return this.cls.shape ? Math.min(backlog, this.shapeTokens) : backlog;
  }
}

/** A policy map at one stage, with its rate (the link, or a parent class's shaper). */
export class PolicyNode {
  readonly classes: ClassState[];

  constructor(
    readonly qos: Qos,
    policy: PolicyMap,
    /** Rate in bps that percentages refer to. */
    readonly rateBps: number,
    parent = '',
    seen = new Set<string>(),
  ) {
    seen.add(policy.name);
    const classes = policy.classes.some((c) => c.name === CLASS_DEFAULT) ? policy.classes : [...policy.classes, { name: CLASS_DEFAULT }];
    this.classes = classes.map((c) => {
      const st = new ClassState(c, parent + c.name);
      const child = c.child && !seen.has(c.child) ? qos.policyMaps.get(c.child) : undefined;
      if (child) st.child = new PolicyNode(qos, child, c.shape ?? rateBps, `${st.key}/`, new Set(seen));
      return st;
    });
  }

  classify(p: IpPacket): ClassState {
    const policy: PolicyMap = { name: '', classes: this.classes.map((c) => c.cls) };
    const cls = this.qos.classify(policy, p);
    return this.classes.find((c) => c.cls === cls) ?? this.classes.at(-1)!;
  }

  demand(): number {
    return this.classes.reduce((sum, c) => sum + c.demand(), 0);
  }

  /** Every class at every level, parents first. */
  all(): ClassState[] {
    return this.classes.flatMap((c) => [c, ...(c.child?.all() ?? [])]);
  }

  /** CBWFQ weight of a non-priority class: its bandwidth, or an equal cut of whatever no class reserved. */
  weights(): Map<ClassState, number> {
    const kbps = this.rateBps / 1000;
    const priorityKbps = this.classes.reduce((sum, c) => sum + (c.cls.priority ? Qos.reserved(c.cls, kbps) : 0), 0);
    const reserved = this.classes.reduce((sum, c) => sum + Qos.reserved(c.cls, kbps), 0);
    const plain = this.classes.filter((c) => !c.cls.priority && !c.cls.bandwidth);
    const share = Math.max(kbps * 0.01, (kbps - reserved) / Math.max(1, plain.length));
    const out = new Map<ClassState, number>();
    for (const c of this.classes) {
      if (c.cls.priority) continue;
      const bw = c.cls.bandwidth;
      out.set(c, !bw ? share : bw.remaining ? ((bw.percent ?? 0) * (kbps - priorityKbps)) / 100 : Qos.reserved(c.cls, kbps));
    }
    return out;
  }
}

export function bytesPerTick(bps: number): number {
  return (bps / 8) * (TICK_MS / 1000);
}

/** IOS sizes a single-rate policer's committed burst at CIR/32 bytes, at least 1500. */
function policeBucket(cir: number): number {
  return Math.max(1500, cir / 8 / 32);
}

function split(c: Chunk, fraction: number): Chunk {
  return { ...c, bytes: c.bytes * fraction };
}

function pkts(c: Chunk): number {
  return c.bytes / c.size;
}

/**
 * One place where traffic meets QoS: a router interface in one direction. An output stage queues
 * and sends at the link rate; an input stage only polices and marks.
 */
export class Stage {
  /** The interface queue: the service policy, or a 40-packet FIFO when there is none. */
  readonly root: PolicyNode;
  readonly policed: boolean;
  inbox: Chunk[] = [];
  sentBytes = 0;

  constructor(
    readonly iface: Interface,
    readonly dir: 'input' | 'output',
    readonly rateBps: number,
    readonly qos: Qos | undefined,
    readonly packetOf: (c: Chunk) => IpPacket,
  ) {
    const name = iface.servicePolicy?.[dir];
    const policy = name ? qos?.policyMaps.get(name) : undefined;
    this.policed = policy !== undefined;
    const fifo: PolicyMap = { name: '', classes: [{ name: CLASS_DEFAULT, queueLimit: HOLD_QUEUE }] };
    this.root = new PolicyNode(qos ?? new Qos({ aclPermits: () => undefined, now: () => 0 }), policy ?? fifo, rateBps);
  }

  /** Takes in this tick's arrivals. An input stage returns what passes; an output stage queues it and returns nothing. */
  admit(arrivals: Chunk[], tick: number): Chunk[] {
    this.root.classes.forEach((c) => c.refill());
    return this.admitTo(this.root, arrivals, tick);
  }

  private admitTo(node: PolicyNode, chunks: Chunk[], tick: number): Chunk[] {
    const groups = new Map<ClassState, Chunk[]>();
    for (const c of chunks) {
      const st = node.classify(this.packetOf(c));
      groups.set(st, [...(groups.get(st) ?? []), c]);
    }
    const passed: Chunk[] = [];
    for (const [st, group] of groups) {
      let kept = group;
      for (const c of group) {
        st.stats.offeredBytes += c.bytes;
        st.stats.offeredPkts += pkts(c);
      }
      if (st.cls.police) kept = this.police(st, kept);
      if (st.cls.setDscp !== undefined) kept = kept.map((c) => (c.dscp === undefined ? c : { ...c, dscp: st.cls.setDscp }));
      if (st.child) passed.push(...this.admitTo(st.child, kept, tick));
      else if (this.dir === 'input') passed.push(...kept);
      else this.enqueue(st, kept, tick);
    }
    return passed;
  }

  /** A single-rate policer shares its tokens across the tick's arrivals in proportion to their size. */
  private police(st: ClassState, chunks: Chunk[]): Chunk[] {
    const police = st.cls.police!;
    const total = chunks.reduce((sum, c) => sum + c.bytes, 0);
    const conform = Math.min(total, st.policeTokens);
    st.policeTokens -= conform;
    const ratio = total > 0 ? conform / total : 1;
    const out: Chunk[] = [];
    for (const c of chunks) {
      const ok = split(c, ratio);
      const over = split(c, 1 - ratio);
      st.stats.conformPkts += pkts(ok);
      st.stats.exceedPkts += pkts(over);
      if (ok.bytes > EPSILON) out.push(ok);
      if (over.bytes <= EPSILON) continue;
      if (police.exceed === 'drop') {
        st.stats.dropBytes += over.bytes;
        st.stats.dropPkts += pkts(over);
      } else out.push(police.exceed === 'transmit' ? over : { ...over, dscp: police.exceed.dscp });
    }
    return out;
  }

  private dscpOf(c: Chunk): number {
    return c.dscp ?? this.packetOf(c).dscp ?? 0;
  }

  /** WRED drops a share of arrivals once the average depth passes a threshold; tail drop takes what still does not fit. */
  private enqueue(st: ClassState, chunks: Chunk[], tick: number): void {
    const rd = st.cls.randomDetect;
    let accepted: Chunk[] = chunks;
    if (rd) {
      st.wredAvg += (st.qPkts - st.wredAvg) * WRED_WEIGHT;
      accepted = [];
      for (const c of chunks) {
        const dscp = this.dscpOf(c);
        const t = wredThreshold(rd, dscp);
        const p = st.wredAvg < t.min ? 0 : st.wredAvg >= t.max ? 1 : (st.wredAvg - t.min) / (t.max - t.min) / t.denom;
        const lost = split(c, p);
        this.wredRow(st, dscp).random += pkts(lost);
        this.wredRow(st, dscp).randomBytes += lost.bytes;
        this.drop(st, lost);
        st.stats.wredDrops += pkts(lost);
        if (p < 1) accepted.push(split(c, 1 - p));
      }
    }
    // Fair queuing gives each flow its own share of the queue (a quarter of it, as IOS does), so a
    // greedy flow fills only its own part and is the one tail-dropped.
    const fitOf = new Map<number, number>();
    if (st.cls.fairQueue) {
      const perFlow = Math.max(1, st.limit / 4);
      const queued = new Map<number, number>();
      for (const q of st.queue) queued.set(q.flow, (queued.get(q.flow) ?? 0) + pkts(q));
      const arrivingByFlow = new Map<number, number>();
      for (const c of accepted) arrivingByFlow.set(c.flow, (arrivingByFlow.get(c.flow) ?? 0) + pkts(c));
      for (const [f, n] of arrivingByFlow) {
        const room = Math.max(0, perFlow - (queued.get(f) ?? 0));
        fitOf.set(f, n > room ? room / n : 1);
      }
    }
    const arriving = accepted.reduce((sum, c) => sum + pkts(c) * (fitOf.get(c.flow) ?? 1), 0);
    const room = Math.max(0, st.limit - st.qPkts);
    const total = arriving > room ? room / arriving : 1;
    for (const c of accepted) {
      const fit = total * (fitOf.get(c.flow) ?? 1);
      const tail = split(c, 1 - fit);
      if (tail.bytes > EPSILON) {
        this.drop(st, tail);
        if (rd) {
          this.wredRow(st, this.dscpOf(c)).tail += pkts(tail);
          this.wredRow(st, this.dscpOf(c)).tailBytes += tail.bytes;
        }
      }
      const kept = split(c, fit);
      if (kept.bytes <= EPSILON) continue;
      st.queue.push({ ...kept, enq: tick });
      st.qBytes += kept.bytes;
      st.qPkts += pkts(kept);
    }
    st.stats.maxDepth = Math.max(st.stats.maxDepth, st.qPkts);
  }

  private wredRow(st: ClassState, dscp: number) {
    const key = st.cls.randomDetect!.dscpBased ? dscp : dscp >> 3;
    return (st.stats.wred[key] ??= { tx: 0, txBytes: 0, random: 0, randomBytes: 0, tail: 0, tailBytes: 0 });
  }

  private drop(st: ClassState, c: Chunk): void {
    st.stats.dropBytes += c.bytes;
    st.stats.dropPkts += pkts(c);
    st.stats.queueDrops += pkts(c);
  }

  /** Sends one tick's worth of bytes at the link rate. Returns the chunks that left. */
  serve(tick: number): Chunk[] {
    const out: Chunk[] = [];
    this.sentBytes += this.serveNode(this.root, bytesPerTick(this.rateBps), tick, out);
    return out;
  }

  private serveNode(node: PolicyNode, budget: number, tick: number, out: Chunk[]): number {
    const priority = node.classes.filter((c) => c.cls.priority);
    const others = node.classes.filter((c) => !c.cls.priority);
    const congested = node.demand() > budget + EPSILON;
    let remaining = budget;
    let sent = 0;
    // LLQ: the priority queue goes first, held to its rate while the link is congested.
    for (const c of priority) {
      const cap = congested ? bytesPerTick(Qos.reserved(c.cls, node.rateBps / 1000) * 1000) : Infinity;
      const n = this.dequeue(c, Math.min(c.demand(), cap, remaining), tick, out);
      remaining -= n;
      sent += n;
    }
    // CBWFQ: share what is left in proportion to bandwidth, giving unused shares to classes with a backlog.
    const weights = node.weights();
    const alloc = new Map<ClassState, number>(others.map((c) => [c, 0]));
    let active = others.filter((c) => c.demand() > EPSILON);
    while (remaining > EPSILON && active.length) {
      const total = active.reduce((sum, c) => sum + weights.get(c)!, 0);
      let given = 0;
      const next: ClassState[] = [];
      for (const c of active) {
        const want = c.demand() - alloc.get(c)!;
        const give = Math.min(want, (remaining * weights.get(c)!) / total);
        alloc.set(c, alloc.get(c)! + give);
        given += give;
        if (want - give > EPSILON) next.push(c);
      }
      remaining -= given;
      if (next.length === active.length) break;
      active = next;
    }
    for (const c of others) {
      const n = this.dequeue(c, alloc.get(c)!, tick, out);
      sent += n;
      remaining = budget - sent;
    }
    // Spare capacity goes back to the priority queue; whatever it still holds was over its rate.
    for (const c of priority) {
      const n = this.dequeue(c, Math.min(c.demand(), Math.max(0, remaining)), tick, out);
      remaining -= n;
      sent += n;
      for (const q of c.queue) {
        c.stats.priorityDrops += pkts(q);
        c.stats.dropBytes += q.bytes;
        c.stats.dropPkts += pkts(q);
      }
      c.queue = [];
      c.qBytes = 0;
      c.qPkts = 0;
    }
    return sent;
  }

  /** Takes up to `amount` bytes from a class: FIFO, or an equal share per flow with fair-queue. */
  private dequeue(st: ClassState, amount: number, tick: number, out: Chunk[]): number {
    if (amount <= EPSILON) return 0;
    let sent: number;
    if (st.child) sent = this.serveNode(st.child, amount, tick, out);
    else {
      const taken: Chunk[] = st.cls.fairQueue ? this.takeFair(st, amount) : this.takeFifo(st, amount);
      sent = 0;
      for (const c of taken) {
        sent += c.bytes;
        st.qBytes -= c.bytes;
        st.qPkts -= pkts(c);
        st.stats.outBytes += c.bytes;
        st.stats.outPkts += pkts(c);
        if (st.cls.randomDetect) {
          const row = this.wredRow(st, this.dscpOf(c));
          row.tx += pkts(c);
          row.txBytes += c.bytes;
        }
        // Waiting in the queue, plus the time to clock the packet onto the wire.
        out.push({ ...c, delay: c.delay + (tick - c.enq) * TICK_MS + (c.size * 8 * 1000) / this.rateBps });
      }
      if (st.queue.length === 0) st.qBytes = st.qPkts = 0;
    }
    if (st.cls.shape) st.shapeTokens = Math.max(0, st.shapeTokens - sent);
    return sent;
  }

  private takeFifo(st: ClassState, amount: number): Chunk[] {
    const taken: Chunk[] = [];
    let left = amount;
    while (left > EPSILON && st.queue.length) {
      const head = st.queue[0]!;
      if (head.bytes <= left + EPSILON) {
        taken.push(st.queue.shift()!);
        left -= head.bytes;
      } else {
        taken.push(split(head, left / head.bytes));
        head.bytes -= left;
        left = 0;
      }
    }
    return taken;
  }

  private takeFair(st: ClassState, amount: number): Chunk[] {
    const byFlow = new Map<number, number>();
    for (const c of st.queue) byFlow.set(c.flow, (byFlow.get(c.flow) ?? 0) + c.bytes);
    // Water-fill: every flow gets an equal share, and flows that need less leave the rest to the others.
    const share = new Map<number, number>();
    let left = amount;
    let flows = [...byFlow.keys()];
    while (left > EPSILON && flows.length) {
      const each = left / flows.length;
      const next: number[] = [];
      for (const f of flows) {
        const give = Math.min(each, byFlow.get(f)! - (share.get(f) ?? 0));
        share.set(f, (share.get(f) ?? 0) + give);
        left -= give;
        if (byFlow.get(f)! - share.get(f)! > EPSILON) next.push(f);
      }
      if (next.length === flows.length) break;
      flows = next;
    }
    const taken: Chunk[] = [];
    const rest: Chunk[] = [];
    for (const c of st.queue) {
      const want = share.get(c.flow) ?? 0;
      if (want <= EPSILON) rest.push(c);
      else if (c.bytes <= want + EPSILON) {
        taken.push(c);
        share.set(c.flow, want - c.bytes);
      } else {
        taken.push(split(c, want / c.bytes));
        rest.push({ ...c, bytes: c.bytes - want });
        share.set(c.flow, 0);
      }
    }
    st.queue = rest;
    return taken;
  }

  /** Records end-of-generation queue depths (what `show policy-map interface` reports while traffic flows). */
  snapshotDepth(): void {
    for (const c of this.root.all()) c.stats.depth = c.child ? 0 : c.qPkts;
  }

  /** Bytes still queued anywhere in this stage. */
  backlog(): number {
    return this.root.all().reduce((sum, c) => sum + (c.child ? 0 : c.qBytes), 0);
  }
}
