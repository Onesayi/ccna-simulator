import { Scheduler } from './scheduler';
import type { Frame } from './frames';
import type { Device, Interface } from '../devices/device';

/** Propagation delay per hop. Purely cosmetic: it spaces events out for the packet view. */
export const LINK_DELAY_MS = 1;

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
  readonly devices = new Map<string, Device>();
  readonly links: Link[] = [];
  /** Every frame that crossed a cable, in order. Feeds the packet capture panel. */
  readonly trace: TraceEntry[] = [];

  add<T extends Device>(device: T): T {
    if (this.devices.has(device.hostname)) throw new Error(`Duplicate hostname ${device.hostname}`);
    this.devices.set(device.hostname, device);
    device.attach(this);
    return device;
  }

  get(hostname: string): Device {
    const d = this.devices.get(hostname);
    if (!d) throw new Error(`No device named ${hostname}`);
    return d;
  }

  connect(a: Interface, b: Interface): Link {
    if (a.link || b.link) throw new Error('Interface already cabled');
    const link: Link = { id: `${a.fullName}<->${b.fullName}`, a, b };
    a.link = link;
    b.link = link;
    this.links.push(link);
    return link;
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
}
