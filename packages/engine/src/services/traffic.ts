import { isValidIp, type Ipv4Address } from '../core/addressing';
import { flowTrace, type FlowHop } from '../core/flow-trace';
import type { IpPacket } from '../core/frames';
import type { Topology } from '../core/topology';
import { portSpeedMbps, shortName, type Interface } from '../devices/device';
import { Pc } from '../devices/pc';
import { Router } from '../devices/router';
import { DSCP_VALUES, dscpName } from './dscp';
import { Stage, TICK_MS, bytesPerTick, type Chunk } from './queuing';

/** A stream of traffic a host sends while the traffic generator runs (`traffic add` on a PC). */
export interface TrafficFlow {
  name: string;
  dst: Ipv4Address;
  rateKbps: number;
  /** Unset: the host's own marking (a softphone marks EF). */
  dscp?: number;
  protocol: 'udp' | 'tcp';
  port: number;
  /** Packet size in bytes. */
  size: number;
  /** On/off traffic: sends at `rateKbps` for `on` ms, then nothing for `off` ms. */
  burst?: { on: number; off: number };
}

export interface FlowResult {
  host: Pc;
  flow: TrafficFlow;
  /** Why the flow never left, or never arrived. */
  unreachable?: string;
  /** The DSCP the flow left the host with. */
  dscp: number;
  offeredBps: number;
  deliveredBps: number;
  lossPct: number;
  /** Average delay across the path (queuing plus serialization), in ms. */
  delayMs: number;
  /** Average change in delay from one 10 ms interval to the next, in ms. */
  jitterMs: number;
  /** Where the flow met QoS: "R1 Gi0/1 out". */
  path: string[];
}

export interface StageResult {
  iface: Interface;
  dir: 'input' | 'output';
  rateBps: number;
  policy?: string;
  offeredBps: number;
  dropBps: number;
}

export interface TrafficReport {
  seconds: number;
  flows: FlowResult[];
  stages: StageResult[];
}

/** Longest the model keeps running after the generators stop, so shaped and queued traffic can drain. */
const DRAIN_MS = 5000;

interface ActiveFlow {
  result: FlowResult;
  hops: FlowHop[];
  stages: Stage[];
  delivered: number;
  delaySum: number;
  offered: number;
  /** Delivered bytes and delay-weighted bytes in the current tick, for jitter. */
  tickBytes: number;
  tickDelay: number;
  delays: number[];
}

/** Every host's flows, in topology order. */
export function trafficFlows(net: Topology): { host: Pc; flow: TrafficFlow }[] {
  return [...net.devices.values()].flatMap((d) => (d instanceof Pc ? d.flows.map((flow) => ({ host: d, flow })) : []));
}

/** Sends one probe along the flow's real path and records where it met a forwarding device. */
function probe(net: Topology, host: Pc, flow: TrafficFlow, index: number): { hops: FlowHop[]; error?: string; dscp: number } {
  const id = `${host.id}:${flow.name}`;
  let dscp = flow.dscp ?? host.marking ?? 0;
  // Routers drop the packet that triggers ARP, so a fresh path may take a few tries, like the first pings.
  for (let attempt = 0; attempt < 8; attempt++) {
    flowTrace.begin();
    const sent = host.sendFlowProbe(flow.dst, (src) => {
      const base = { src, dst: flow.dst, ttl: 128, srcPort: 49152 + index, dstPort: flow.port, flow: id, dscp: flow.dscp };
      return flow.protocol === 'tcp' ? { ...base, kind: 'tcp', flags: 'psh' } : { ...base, kind: 'udp' };
    });
    net.run();
    const trace = flowTrace.end();
    if (!sent) return { hops: [], error: 'no route', dscp };
    if (trace.arrived) return { hops: trace.hops, dscp };
  }
  return { hops: [], error: 'destination unreachable', dscp };
}

/** Takes the probes back out of the packet capture: they stand for traffic, they are not part of it. */
function forgetProbes(net: Topology): void {
  for (let i = net.trace.length - 1; i >= 0; i--) {
    const p = net.trace[i]!.frame.payload as Partial<IpPacket>;
    if (p.flow !== undefined) net.trace.splice(i, 1);
  }
}

/** Upstream stages before downstream ones, so a chunk can cross several hops in one tick. */
function order(stages: Stage[], flows: ActiveFlow[]): Stage[] {
  const indegree = new Map(stages.map((s) => [s, 0]));
  const next = new Map<Stage, Set<Stage>>(stages.map((s) => [s, new Set()]));
  for (const f of flows) {
    for (let i = 1; i < f.stages.length; i++) {
      const [a, b] = [f.stages[i - 1]!, f.stages[i]!];
      if (next.get(a)!.has(b)) continue;
      next.get(a)!.add(b);
      indegree.set(b, indegree.get(b)! + 1);
    }
  }
  const out: Stage[] = [];
  const ready = stages.filter((s) => indegree.get(s) === 0);
  while (ready.length) {
    const s = ready.shift()!;
    out.push(s);
    for (const n of next.get(s)!) {
      indegree.set(n, indegree.get(n)! - 1);
      if (indegree.get(n) === 0) ready.push(n);
    }
  }
  // A routing loop leaves a cycle; those stages simply see their arrivals one tick late.
  return [...out, ...stages.filter((s) => !out.includes(s))];
}

/**
 * Runs every host's flows together for `seconds` and measures what each one gets through: the
 * offered and delivered rates, loss, queuing delay and jitter. With `record`, the routers keep the
 * counters (`show policy-map interface`, `show interfaces`), as if the traffic had just run.
 */
export function runTraffic(net: Topology, { seconds = 10, record = true } = {}): TrafficReport {
  const stages = new Map<string, Stage>();
  const flows: ActiveFlow[] = [];
  trafficFlows(net).forEach(({ host, flow }, index) => {
    const traced = probe(net, host, flow, index);
    const af: ActiveFlow = {
      result: { host, flow, dscp: traced.dscp, unreachable: traced.error, offeredBps: 0, deliveredBps: 0, lossPct: 0, delayMs: 0, jitterMs: 0, path: [] },
      hops: [],
      stages: [],
      delivered: 0,
      delaySum: 0,
      offered: 0,
      tickBytes: 0,
      tickDelay: 0,
      delays: [],
    };
    for (const hop of traced.hops) {
      const router = hop.iface.device instanceof Router ? hop.iface.device : undefined;
      // Input stages only matter where a service policy polices or marks.
      if (hop.dir === 'input' && !hop.iface.servicePolicy?.input) continue;
      const key = `${hop.iface.device.id}|${hop.iface.name}|${hop.dir}`;
      let stage = stages.get(key);
      if (!stage) {
        stage = new Stage(hop.iface, hop.dir, portSpeedMbps(hop.iface) * 1e6, router?.qos, (c) => packetOf(flows, c));
        stages.set(key, stage);
      }
      af.hops.push(hop);
      af.stages.push(stage);
      af.result.path.push(`${hop.iface.fullName} ${hop.dir === 'input' ? 'in' : 'out'}`);
    }
    flows.push(af);
  });
  forgetProbes(net);

  const ordered = order([...stages.values()], flows);
  const genTicks = Math.round((seconds * 1000) / TICK_MS);
  const maxTicks = genTicks + DRAIN_MS / TICK_MS;
  const deliver = (c: Chunk) => {
    const f = flows[c.flow]!;
    if (c.hop + 1 < f.stages.length) return void f.stages[c.hop + 1]!.inbox.push({ ...c, hop: c.hop + 1 });
    f.delivered += c.bytes;
    f.delaySum += c.bytes * c.delay;
    f.tickBytes += c.bytes;
    f.tickDelay += c.bytes * c.delay;
  };

  for (let tick = 0; tick < maxTicks; tick++) {
    if (tick >= genTicks && ordered.every((s) => s.backlog() < 1 && !s.inbox.length)) break;
    if (tick < genTicks) {
      flows.forEach((f, i) => {
        const { flow } = f.result;
        if (f.result.unreachable) return;
        const b = flow.burst;
        if (b && (tick * TICK_MS) % (b.on + b.off) >= b.on) return;
        const bytes = bytesPerTick(flow.rateKbps * 1000);
        f.offered += bytes;
        const chunk: Chunk = { flow: i, hop: -1, bytes, size: flow.size, delay: 0, enq: tick };
        deliver(chunk);
      });
    }
    for (const s of ordered) {
      const arrivals = s.inbox;
      s.inbox = [];
      const passed = s.admit(arrivals, tick);
      passed.forEach(deliver);
      if (s.dir === 'output') s.serve(tick).forEach(deliver);
      if (tick === genTicks - 1) s.snapshotDepth();
    }
    for (const f of flows) {
      if (f.tickBytes > 0) f.delays.push(f.tickDelay / f.tickBytes);
      f.tickBytes = f.tickDelay = 0;
    }
  }

  const bps = (bytes: number) => Math.round((bytes * 8) / seconds);
  for (const f of flows) {
    const r = f.result;
    r.offeredBps = bps(f.offered);
    r.deliveredBps = bps(f.delivered);
    r.lossPct = f.offered > 0 ? Math.max(0, (1 - f.delivered / f.offered) * 100) : 0;
    r.delayMs = f.delivered > 0 ? f.delaySum / f.delivered : 0;
    const steps = f.delays.slice(1).map((d, i) => Math.abs(d - f.delays[i]!));
    r.jitterMs = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
  }

  const stageResults: StageResult[] = ordered.map((s) => {
    const all = s.root.classes;
    return {
      iface: s.iface,
      dir: s.dir,
      rateBps: s.rateBps,
      policy: s.policed ? s.iface.servicePolicy?.[s.dir] : undefined,
      offeredBps: bps(all.reduce((sum, c) => sum + c.stats.offeredBytes, 0)),
      dropBps: bps(s.root.all().reduce((sum, c) => sum + c.stats.dropBytes, 0)),
    };
  });
  if (record) for (const s of ordered) recordStage(s, seconds);
  return { seconds, flows: flows.map((f) => f.result), stages: stageResults };
}

function packetOf(flows: ActiveFlow[], c: Chunk): IpPacket {
  const p = flows[c.flow]!.hops[c.hop]!.packet;
  return c.dscp === undefined ? p : { ...p, dscp: c.dscp };
}

/** Writes a stage's results into the router's QoS counters and the interface's queue counters. */
function recordStage(s: Stage, seconds: number): void {
  const bps = (bytes: number) => Math.round((bytes * 8) / seconds);
  const round = Math.round;
  const router = s.iface.device instanceof Router ? s.iface.device : undefined;
  if (s.policed && router) {
    for (const c of s.root.all()) {
      const k = router.qos.counter(s.iface, s.dir, c.key);
      const st = c.stats;
      k.packets += round(st.offeredPkts);
      k.bytes += round(st.offeredBytes);
      k.conformed += round(st.conformPkts);
      k.exceeded += round(st.exceedPkts);
      k.rates = { offered: bps(st.offeredBytes), drop: bps(st.dropBytes) };
      if (s.dir === 'output' && !c.child) {
        const o = (k.output ??= { packets: 0, bytes: 0, drops: 0, wredDrops: 0, priorityDrops: 0, depth: 0 });
        o.packets += round(st.outPkts);
        o.bytes += round(st.outBytes);
        o.drops += round(st.queueDrops + st.priorityDrops);
        o.wredDrops += round(st.wredDrops);
        o.priorityDrops += round(st.priorityDrops);
        o.depth = round(st.depth);
      }
      if (c.cls.randomDetect) {
        k.wredMean = round(c.wredAvg);
        const rows = (k.wred ??= {});
        for (const [d, v] of Object.entries(st.wred)) {
          const row = (rows[Number(d)] ??= { tx: 0, txBytes: 0, random: 0, randomBytes: 0, tail: 0, tailBytes: 0 });
          row.tx += round(v.tx);
          row.txBytes += round(v.txBytes);
          row.random += round(v.random);
          row.randomBytes += round(v.randomBytes);
          row.tail += round(v.tail);
          row.tailBytes += round(v.tailBytes);
        }
      }
    }
  }
  if (s.dir !== 'output') return;
  const leaves = s.root.all().filter((c) => !c.child);
  const q = (s.iface.queueStats ??= { packets: 0, bytes: 0, drops: 0, outputRate: 0, depth: 0, max: 0 });
  q.packets += round(leaves.reduce((sum, c) => sum + c.stats.outPkts, 0));
  q.bytes += round(leaves.reduce((sum, c) => sum + c.stats.outBytes, 0));
  q.drops += round(leaves.reduce((sum, c) => sum + c.stats.queueDrops + c.stats.priorityDrops, 0));
  q.outputRate = bps(s.sentBytes);
  q.depth = round(leaves.reduce((sum, c) => sum + c.stats.depth, 0));
  q.max = leaves.reduce((sum, c) => sum + c.limit, 0);
}

// ---------------------------------------------------------------- report

export function formatRate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 1 : 2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** Voice needs loss under 1%, one-way delay under 150 ms and jitter under 30 ms (ITU-T G.114 and Cisco's guidance). */
export function voiceQualityGood(r: FlowResult): boolean {
  return !r.unreachable && r.lossPct < 1 && r.delayMs < 150 && r.jitterMs < 30;
}

/** Tenths of a millisecond below 10 ms, whole milliseconds above. */
function ms(n: number): string {
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

export function formatTrafficReport(report: TrafficReport): string {
  if (!report.flows.length) return 'No traffic flows are defined. Add one with: traffic add <name> <destination> rate <kbps> [dscp <value>]';
  const lines = [
    `Running ${report.flows.length} flow${report.flows.length === 1 ? '' : 's'} for ${report.seconds} seconds...`,
    '',
    'Flow          From       To               DSCP     Offered     Delivered   Loss    Delay   Jitter',
  ];
  for (const r of report.flows) {
    const head = `${r.flow.name.slice(0, 13).padEnd(14)}${r.host.hostname.slice(0, 10).padEnd(11)}${r.flow.dst.padEnd(17)}${dscpName(r.dscp).padEnd(9)}`;
    if (r.unreachable) {
      lines.push(`${head}${formatRate(r.flow.rateKbps * 1000).padEnd(12)}${r.unreachable}`);
      continue;
    }
    lines.push(
      `${head}${formatRate(r.offeredBps).padEnd(12)}${formatRate(r.deliveredBps).padEnd(12)}${`${r.lossPct.toFixed(1)}%`.padEnd(8)}${`${ms(r.delayMs)} ms`.padEnd(8)}${ms(r.jitterMs)} ms`,
    );
  }
  const congested = report.stages.filter((s) => s.dropBps > 0);
  lines.push('');
  if (!congested.length) lines.push('No drops: every interface on the way had room for the traffic.');
  else {
    lines.push('Drops:');
    for (const s of congested) {
      const where = `${s.iface.device.hostname} ${shortName(s.iface.name)} ${s.dir}`;
      const how = s.dir === 'output' ? `${formatRate(s.rateBps)} link, ${s.policy ? `service-policy ${s.policy}` : 'FIFO'}` : `service-policy ${s.policy}`;
      lines.push(`  ${where} (${how}): offered ${formatRate(s.offeredBps)}, dropped ${formatRate(s.dropBps)}`);
    }
  }
  const voice = report.flows.filter((r) => r.dscp === 46);
  if (voice.length) {
    lines.push('');
    for (const r of voice) lines.push(`Voice quality for ${r.flow.name}: ${voiceQualityGood(r) ? 'good' : 'poor'} (needs loss < 1%, delay < 150 ms, jitter < 30 ms)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the `traffic` command

export const TRAFFIC_USAGE = `Usage:
  traffic                                List this host's flows
  traffic add <name> <ip> rate <kbps> [dscp <value>] [udp|tcp <port>] [size <bytes>] [burst <on-ms> <off-ms>]
  traffic delete <name> | traffic clear  Remove one flow, or all of this host's flows
  traffic run [seconds]                  Run every host's flows together (default 10 seconds)`;

/** Parses `traffic add` arguments after the name and destination. */
export function parseFlow(name: string, dst: string, words: string[]): TrafficFlow {
  const flow: TrafficFlow = { name, dst, rateKbps: 0, protocol: 'udp', port: 5001, size: 1500 };
  const num = (w: string | undefined, min: number, max: number, what: string): number => {
    const n = Number(w);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Bad value for ${what} (${min}-${max}).`);
    return n;
  };
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!.toLowerCase();
    if (w === 'rate') flow.rateKbps = num(words[++k], 1, 1_000_000, 'rate in kbps');
    else if (w === 'dscp') {
      const v = words[++k]?.toLowerCase() ?? '';
      const n = DSCP_VALUES[v] ?? (/^\d+$/.test(v) ? Number(v) : NaN);
      if (!(n >= 0 && n <= 63)) throw new Error('Bad value for dscp (ef, af11-af43, cs1-cs7, default or 0-63).');
      flow.dscp = n;
    } else if (w === 'udp' || w === 'tcp') {
      flow.protocol = w;
      flow.port = num(words[++k], 1, 65535, 'port');
    } else if (w === 'size') flow.size = num(words[++k], 64, 1500, 'size in bytes');
    else if (w === 'burst') flow.burst = { on: num(words[++k], 10, 10_000, 'burst on-time in ms'), off: num(words[++k], 10, 10_000, 'burst off-time in ms') };
    else throw new Error(`Unknown option ${words[k]}.`);
  }
  if (!flow.rateKbps) throw new Error('A flow needs a rate: rate <kbps>.');
  return flow;
}

function describeFlow(f: TrafficFlow, host: Pc): string {
  const dscp = f.dscp ?? host.marking;
  const burst = f.burst ? `, bursts ${f.burst.on} ms on / ${f.burst.off} ms off` : '';
  return `  ${f.name.padEnd(12)} to ${f.dst.padEnd(16)} ${formatRate(f.rateKbps * 1000).padEnd(11)} ${f.protocol.toUpperCase()} ${String(f.port).padEnd(6)} ${String(f.size).padStart(4)} bytes  DSCP ${dscpName(dscp ?? 0)}${burst}`;
}

/** The `traffic` command on a PC or server: define flows, then run them all together. */
export function trafficCommand(host: Pc, args: string[]): string {
  const [sub = '', ...rest] = args;
  switch (sub.toLowerCase()) {
    case '':
    case 'show':
      return host.flows.length ? [`Flows on ${host.hostname}:`, ...host.flows.map((f) => describeFlow(f, host))].join('\n') : `No flows on ${host.hostname}.\n${TRAFFIC_USAGE}`;
    case 'add': {
      const [name, dst, ...opts] = rest;
      if (!name || !dst) return TRAFFIC_USAGE;
      if (!isValidIp(dst)) return `Bad destination ${dst}: give an IPv4 address.`;
      let flow: TrafficFlow;
      try {
        flow = parseFlow(name, dst, opts);
      } catch (err) {
        return (err as Error).message;
      }
      const at = host.flows.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
      if (at >= 0) host.flows.splice(at, 1, flow);
      else host.flows.push(flow);
      return `Flow ${name} ${at >= 0 ? 'updated' : 'added'}:\n${describeFlow(flow, host)}`;
    }
    case 'delete': {
      const at = host.flows.findIndex((f) => f.name.toLowerCase() === rest[0]?.toLowerCase());
      if (at < 0) return `No flow named ${rest[0] ?? ''}.`;
      host.flows.splice(at, 1);
      return `Flow ${rest[0]} deleted.`;
    }
    case 'clear':
      host.flows.length = 0;
      return `All flows on ${host.hostname} deleted.`;
    case 'run': {
      const seconds = rest[0] === undefined ? 10 : Number(rest[0]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) return 'Bad value for seconds (1-60).';
      if (!host.network) return 'This host is not part of a network.';
      return formatTrafficReport(runTraffic(host.network, { seconds }));
    }
    default:
      return TRAFFIC_USAGE;
  }
}
