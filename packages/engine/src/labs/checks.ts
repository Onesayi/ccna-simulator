import { networkAddress, prefixToMask, sameSubnet } from '../core/addressing';
import type { Device, Interface } from '../devices/device';
import { IpDevice } from '../devices/ip-device';
import { Switch } from '../devices/switch';
import type { Check } from './types';

export interface CheckResult {
  pass: boolean;
  /** What the grader saw when the check failed, phrased as a nudge rather than the answer. */
  detail?: string;
}

/** Resolves a lab hostname to the device it was built as, even after a `hostname` change. */
export type DeviceLookup = (name: string) => Device;

const ok: CheckResult = { pass: true };
const fail = (detail: string): CheckResult => ({ pass: false, detail });

function findIface(d: Device, name: string): Interface | undefined {
  return d.findIface(name);
}

function ipDevice(d: Device): IpDevice {
  if (!(d instanceof IpDevice)) throw new Error(`${d.hostname} has no IP stack`);
  return d;
}

function switchOf(d: Device): Switch {
  if (!(d instanceof Switch)) throw new Error(`${d.hostname} is not a switch`);
  return d;
}

function vlanList(v: Set<number> | 'all'): string {
  return v === 'all' ? 'all' : [...v].sort((a, b) => a - b).join(',') || 'none';
}

/**
 * Evaluates one non-quiz check. Probe checks (ping, traceroute) send real traffic through the
 * topology and run it to completion.
 */
export function evaluate(check: Check, device: DeviceLookup): CheckResult {
  switch (check.type) {
    case 'hostname': {
      const d = device(check.device);
      return d.hostname === check.name ? ok : fail(`The hostname is ${d.hostname}`);
    }
    case 'interfaceUp': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (!i.adminUp) return fail(`${i.name} is administratively down`);
      return i.isUp ? ok : fail(`${i.name} is enabled but its line protocol is down`);
    }
    case 'interfaceIp': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (!i.ip) return fail(`${i.name} has no IP address`);
      const { address, prefix } = i.ip;
      if (prefix !== check.prefix) return fail(`${i.name} has mask ${prefixToMask(prefix)} (/${prefix})`);
      if (check.address && address !== check.address) return fail(`${i.name} is ${address}/${prefix}`);
      if (check.network) {
        if (!sameSubnet(address, check.network, check.prefix)) return fail(`${address}/${prefix} is outside ${check.network}/${check.prefix}`);
        if (address === networkAddress(address, prefix)) return fail(`${address} is the network address, not a host`);
        if (address === broadcast(address, prefix)) return fail(`${address} is the broadcast address, not a host`);
      }
      return ok;
    }
    case 'defaultGateway': {
      const d = ipDevice(device(check.device));
      if (!d.defaultGateway) return fail(`${d.hostname} has no default gateway`);
      return d.defaultGateway === check.address ? ok : fail(`${d.hostname} uses ${d.defaultGateway} as its gateway`);
    }
    case 'vlan': {
      const sw = switchOf(device(check.device));
      const name = sw.vlans.get(check.id);
      if (name === undefined) return fail(`VLAN ${check.id} does not exist on ${sw.hostname}`);
      return check.name === undefined || name === check.name ? ok : fail(`VLAN ${check.id} is named ${name}`);
    }
    case 'accessVlan': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (i.mode !== 'access') return fail(`${i.name} is a ${i.mode} port`);
      return i.accessVlan === check.vlan ? ok : fail(`${i.name} is in VLAN ${i.accessVlan}`);
    }
    case 'trunk': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (i.mode !== 'trunk') return fail(`${i.name} is an access port`);
      if (check.nativeVlan !== undefined && i.nativeVlan !== check.nativeVlan) return fail(`The native VLAN on ${i.name} is ${i.nativeVlan}`);
      if (check.allowed) {
        const want = [...check.allowed].sort((a, b) => a - b).join(',');
        if (vlanList(i.allowedVlans) !== want) return fail(`${i.name} allows VLANs ${vlanList(i.allowedVlans)}`);
      }
      return ok;
    }
    case 'subinterface': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (i.encapVlan === undefined) return fail(`${i.name} has no encapsulation`);
      if (i.encapVlan !== check.vlan) return fail(`${i.name} tags frames for VLAN ${i.encapVlan}`);
      if (Boolean(check.native) !== Boolean(i.encapNative)) return fail(check.native ? `${i.name} is not the native VLAN` : `${i.name} is marked native`);
      return ok;
    }
    case 'ipRouting': {
      const sw = switchOf(device(check.device));
      return sw.ipRouting ? ok : fail(`IP routing is off on ${sw.hostname}`);
    }
    case 'route': {
      const d = ipDevice(device(check.device));
      const match = d
        .routingTable()
        .find(
          (r) =>
            r.network === check.network &&
            r.prefix === check.prefix &&
            (!check.code || r.code === check.code) &&
            (!check.nextHop || r.nextHop === check.nextHop),
        );
      const what = `${check.network}/${check.prefix}${check.nextHop ? ` via ${check.nextHop}` : ''}`;
      if (check.absent) return match ? fail(`${what} is in the routing table`) : ok;
      return match ? ok : fail(`No route to ${what} in the routing table`);
    }
    case 'staticRoute': {
      const d = ipDevice(device(check.device));
      const routes = d.staticRoutes.filter((r) => r.network === check.network && r.prefix === check.prefix);
      if (!routes.length) return fail(`No static route for ${check.network}/${check.prefix} is configured`);
      const viaHop = check.nextHop ? routes.filter((r) => r.nextHop === check.nextHop) : routes;
      if (!viaHop.length) return fail(`The route for ${check.network}/${check.prefix} points somewhere else`);
      if (check.ad !== undefined && !viaHop.some((r) => r.ad === check.ad)) return fail(`The administrative distance is ${viaHop[0]!.ad}`);
      return ok;
    }
    case 'ping': {
      const from = ipDevice(device(check.from));
      const net = from.network;
      // Routers drop the packet that triggers ARP, so warm the path before judging it.
      const warm = from.ping(check.to, 4, 1_000);
      net?.run();
      const final = from.ping(check.to, 3, 1_000);
      net?.run();
      const reached = final.every((r) => r.success);
      const any = [...warm, ...final].some((r) => r.success);
      if (check.expect === 'success') return reached ? ok : fail(`${from.hostname} cannot reach ${check.to}${describeFailure(final)}`);
      return any ? fail(`${from.hostname} can still reach ${check.to}`) : ok;
    }
    case 'traceroute': {
      const from = ipDevice(device(check.from));
      from.ping(check.to, 4, 1_000);
      from.network?.run();
      const result = from.traceroute(check.to, 15, 1, 1_000);
      from.network?.run();
      const seen = result.hops.flatMap((h) => h.probes.map((p) => p.from).filter((x): x is string => !!x));
      let at = 0;
      for (const hop of check.via) {
        const idx = seen.indexOf(hop, at);
        if (idx < 0) return fail(`The path from ${from.hostname} goes ${seen.join(' → ') || 'nowhere'}`);
        at = idx + 1;
      }
      return ok;
    }
    case 'quiz':
      throw new Error('Quiz checks are graded from the answer, not the network');
  }
}

function describeFailure(results: { status: string; from?: string }[]): string {
  const r = results.find((x) => x.status !== 'success');
  if (!r) return '';
  if (r.status === 'unreachable') return ` (${r.from} reports it unreachable)`;
  if (r.status === 'no-route') return ' (no route or gateway to send it)';
  if (r.status === 'ttl-exceeded') return ` (TTL expired at ${r.from}: a routing loop?)`;
  return ' (requests time out)';
}

function broadcast(ip: string, prefix: number): string {
  const net = networkAddress(ip, prefix).split('.').map(Number);
  const mask = prefixToMask(prefix).split('.').map(Number);
  return net.map((o, k) => o | (~mask[k]! & 0xff)).join('.');
}
