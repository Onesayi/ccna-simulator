import { Scheduler } from './scheduler';
import type { Frame } from './frames';
import type { Device, Interface } from '../devices/device';

/** Propagation delay per hop. Purely cosmetic: it spaces events out for the packet view. */
export const LINK_DELAY_MS = 1;

let linkCounter = 0;

export interface Link {
  id: string;
  a: Interface;
  b: Interface;
}

export interface TraceEntry {
  at: number;
  from: string; // "SW1 Gi0/1"
  to: string;
  frame: Frame;
}

/** Owns devices, cables and the clock. The UI and the lab grader talk to the network through this. */
export class Topology {
  readonly scheduler = new Scheduler();
  /** Keyed by `Device.id`, so renaming a device with `hostname` does not orphan it. */
  readonly devices = new Map<string, Device>();
  readonly links: Link[] = [];
  /** Every frame that crossed a cable, in order. Feeds the packet capture panel. */
  readonly trace: TraceEntry[] = [];

  add<T extends Device>(device: T): T {
    if (this.find(device.hostname)) throw new Error(`Duplicate hostname ${device.hostname}`);
    this.devices.set(device.id, device);
    device.attach(this);
    return device;
  }

  find(hostname: string): Device | undefined {
    const wanted = hostname.toLowerCase();
    return [...this.devices.values()].find((d) => d.hostname.toLowerCase() === wanted);
  }

  /** Looks a device up by hostname (case-insensitive) or by id. */
  get(hostnameOrId: string): Device {
    const d = this.devices.get(hostnameOrId) ?? this.find(hostnameOrId);
    if (!d) throw new Error(`No device named ${hostnameOrId}`);
    return d;
  }

  remove(device: Device): void {
    for (const link of this.links.filter((l) => l.a.device === device || l.b.device === device)) this.disconnect(link);
    this.devices.delete(device.id);
  }

  connect(a: Interface, b: Interface): Link {
    if (a.link || b.link) throw new Error('Interface already cabled');
    if (a.kind !== 'physical' || b.kind !== 'physical') throw new Error('Only physical ports take a cable');
    if (a.device === b.device) throw new Error('Cannot cable a device to itself');
    const link: Link = { id: `link${++linkCounter}`, a, b };
    a.link = link;
    b.link = link;
    this.links.push(link);
    return link;
  }

  disconnect(link: Link): void {
    const i = this.links.indexOf(link);
    if (i < 0) return;
    this.links.splice(i, 1);
    link.a.link = undefined;
    link.b.link = undefined;
  }

  /** Called by a device to put a frame on the wire. Delivery happens on a later tick. */
  transmit(from: Interface, frame: Frame): void {
    const link = from.link;
    if (!link || !from.isUp) return;
    const to = link.a === from ? link.b : link.a;
    if (!to.isUp) return;
    this.scheduler.schedule(LINK_DELAY_MS, `${from.fullName} -> ${to.fullName}`, () => {
      this.trace.push({ at: this.scheduler.now, from: from.fullName, to: to.fullName, frame });
      to.device.receive(to, frame);
    });
  }

  run(): number {
    return this.scheduler.runUntilIdle();
  }

  /**
   * Lets control-plane protocols (OSPF) catch up after a change. Each round stands in for one
   * hello interval: every device sends its periodic messages, the network runs, then each device
   * reacts (expires silent neighbors, elects a DR, floods LSAs, runs SPF). Rounds repeat until
   * nothing changes, so the CLI and the grader always see a converged network.
   */
  converge(maxRounds = 8): void {
    this.run();
    for (let round = 0; round < maxRounds; round++) {
      for (const d of this.devices.values()) d.tick();
      this.run();
      let changed = false;
      for (const d of this.devices.values()) changed = d.settle() || changed;
      this.run();
      if (!changed) break;
    }
  }
}
