import { BROADCAST_MAC } from '../core/addressing';
import type { Frame } from '../core/frames';
import { shortName, type Interface, type StormLevel } from '../devices/device';

export type TrafficClass = 'broadcast' | 'multicast' | 'unicast';
export const TRAFFIC_CLASSES: TrafficClass[] = ['broadcast', 'multicast', 'unicast'];

/**
 * The simulator treats every link as carrying at most 1,000 frames per second, so a storm-control
 * level of 1.00% is 10 frames per second. Real thresholds scale with link speed and frame size;
 * this keeps storms visible with a few hundred frames instead of millions.
 */
export const LINE_RATE_FPS = 1000;

/** Storm control measures traffic over one-second intervals. */
const INTERVAL_MS = 1000;

export function classify(frame: Frame): TrafficClass {
  if (frame.dst === BROADCAST_MAC) return 'broadcast';
  return parseInt(frame.dst.slice(0, 2), 16) & 1 ? 'multicast' : 'unicast';
}

/** A threshold in frames per second. */
function fps(level: number, unit: StormLevel['unit']): number {
  return unit === 'pps' ? level : (level * LINE_RATE_FPS) / 100;
}

interface PortCounters {
  /** The one-second interval being counted, and the frames per class seen in it. */
  interval: number;
  counts: Record<TrafficClass, number>;
  /** Frames per class in the last complete interval, for the Current column. */
  last: Record<TrafficClass, number>;
  /** Classes being dropped until the rate falls back under the falling threshold. */
  blocking: Set<TrafficClass>;
  /** Frames dropped by storm control since the port was configured. */
  dropped: number;
}

export interface StormHooks {
  now(): number;
  log: string[];
  errDisable(port: Interface): void;
  /** `storm-control action trap`: an SNMP trap to the trap hosts. */
  trap(port: Interface): void;
}

const zero = (): Record<TrafficClass, number> => ({ broadcast: 0, multicast: 0, unicast: 0 });

/**
 * Storm control on a switch: counts broadcast, multicast and unicast frames arriving on each port
 * per one-second interval. Once a class passes its rising threshold the rest of that class is
 * dropped until an interval ends under the falling threshold, or with `action shutdown` the port
 * is err-disabled.
 */
export class StormControl {
  private readonly ports = new Map<Interface, PortCounters>();

  constructor(private readonly hooks: StormHooks) {}

  private counters(port: Interface): PortCounters {
    const interval = Math.floor(this.hooks.now() / INTERVAL_MS);
    let c = this.ports.get(port);
    if (!c) {
      c = { interval, counts: zero(), last: zero(), blocking: new Set(), dropped: 0 };
      this.ports.set(port, c);
    }
    if (c.interval !== interval) {
      // A new interval: the previous one becomes "current", or zero if a whole interval went by quietly.
      c.last = interval === c.interval + 1 ? c.counts : zero();
      c.counts = zero();
      c.interval = interval;
      const cfg = port.stormControl;
      for (const cls of [...c.blocking]) {
        const level = cfg?.[cls];
        if (!level || c.last[cls] <= fps(level.falling ?? level.rising, level.unit)) c.blocking.delete(cls);
      }
    }
    return c;
  }

  /** Counts a frame arriving on `port`. Returns false when storm control drops it. */
  admit(port: Interface, frame: Frame): boolean {
    const cfg = port.stormControl;
    if (!cfg) return true;
    const cls = classify(frame);
    const level = cfg[cls];
    if (!level) return true;
    const c = this.counters(port);
    c.counts[cls]++;
    if (c.blocking.has(cls)) {
      c.dropped++;
      return false;
    }
    if (c.counts[cls] <= fps(level.rising, level.unit)) return true;
    c.dropped++;
    if (cfg.action === 'shutdown') {
      this.hooks.log.push(`%STORM_CONTROL-3-SHUTDOWN: A packet storm was detected on ${shortName(port.name)}. The interface has been disabled.`);
      this.hooks.errDisable(port);
      return false;
    }
    c.blocking.add(cls);
    this.hooks.log.push(`%STORM_CONTROL-3-FILTERED: A ${cls} storm detected on ${shortName(port.name)}. A packet filter action has been applied on the interface.`);
    if (cfg.action === 'trap') this.hooks.trap(port);
    return false;
  }

  /** The filter state and current rate of one class on a port, for `show storm-control`. */
  status(port: Interface, cls: TrafficClass): { state: 'Forwarding' | 'Blocking' | 'Link Down'; current: number } {
    const c = this.ports.has(port) ? this.counters(port) : undefined;
    const state = !port.isUp ? 'Link Down' : c?.blocking.has(cls) ? 'Blocking' : 'Forwarding';
    return { state, current: c?.last[cls] ?? 0 };
  }

  dropped(port: Interface): number {
    return this.ports.get(port)?.dropped ?? 0;
  }

  /** Forgets a port's counters, when its storm-control settings are removed. */
  reset(port: Interface): void {
    this.ports.delete(port);
  }
}

function formatLevel(value: number, unit: StormLevel['unit']): string {
  return unit === 'pps' ? `${value} pps` : `${value.toFixed(2)}%`;
}

/** `show storm-control [interface] [broadcast|multicast|unicast]`. */
export function showStormControl(sc: StormControl, ports: Interface[], cls: TrafficClass): string {
  const rows = ports
    .filter((p) => p.stormControl?.[cls])
    .map((p) => {
      const level = p.stormControl![cls]!;
      const { state, current } = sc.status(p, cls);
      const now = level.unit === 'pps' ? current : (current * 100) / LINE_RATE_FPS;
      return `${shortName(p.name).padEnd(11)}${state.padEnd(15)}${formatLevel(level.rising, level.unit).padStart(11)}  ${formatLevel(level.falling ?? level.rising, level.unit).padStart(11)}  ${formatLevel(now, level.unit).padStart(10)}`;
    });
  return ['Interface  Filter State   Upper        Lower        Current', '---------  -------------  -----------  -----------  ----------', ...rows].join('\n');
}

/** `storm-control broadcast level 1.00 [0.50]` or `storm-control broadcast level pps 100 [50]`. */
export function parseStormLevel(args: string[]): StormLevel {
  const pps = args[0]?.toLowerCase() === 'pps';
  const values = (pps ? args.slice(1) : args).map((a) => {
    // pps values take k and m suffixes, as on IOS (`pps 1k`).
    const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(a);
    if (!m) throw new Error(`Invalid input detected at '^' marker.`);
    return Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
  });
  const [rising, falling] = values;
  if (rising === undefined || values.length > 2) throw new Error(`Invalid input detected at '^' marker.`);
  if (!pps && (rising > 100 || (falling ?? 0) > 100)) throw new Error(`Invalid input detected at '^' marker.`);
  if (falling !== undefined && falling > rising) throw new Error('Falling threshold cannot be greater than rising threshold');
  return { unit: pps ? 'pps' : 'percent', rising, falling };
}

export function stormLevelConfig(cls: TrafficClass, l: StormLevel): string {
  const n = (v: number) => (l.unit === 'pps' ? String(v) : v.toFixed(2));
  return ` storm-control ${cls} level ${l.unit === 'pps' ? 'pps ' : ''}${n(l.rising)}${l.falling !== undefined ? ` ${n(l.falling)}` : ''}`;
}
