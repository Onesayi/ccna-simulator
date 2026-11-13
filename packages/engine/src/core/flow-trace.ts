import type { IpPacket } from './frames';
import type { Device, Interface } from '../devices/device';

/** One place a traffic generator probe met a QoS decision: entering or leaving a forwarding device. */
export interface FlowHop {
  iface: Interface;
  dir: 'input' | 'output';
  /** The packet as the service policy in this direction would see it (after NAT and upstream marking). */
  packet: IpPacket;
}

/**
 * Records the path of one traffic generator probe as it is forwarded for real, so the queuing
 * model follows exactly the routes, ACLs, NAT and markings the network applies. Only one probe
 * is in flight at a time, so a single recorder is enough.
 */
class FlowTracer {
  private current?: { hops: FlowHop[]; arrived?: Device };

  begin(): void {
    this.current = { hops: [] };
  }

  end(): { hops: FlowHop[]; arrived?: Device } {
    const out = this.current ?? { hops: [] };
    this.current = undefined;
    return out;
  }

  hop(iface: Interface, dir: 'input' | 'output', packet: IpPacket): void {
    this.current?.hops.push({ iface, dir, packet });
  }

  arrive(device: Device, _p: IpPacket): void {
    if (this.current) this.current.arrived = device;
  }
}

export const flowTrace = new FlowTracer();
