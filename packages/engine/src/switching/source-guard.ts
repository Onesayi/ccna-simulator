import type { Ipv4Address, MacAddress } from '../core/addressing';
import type { Frame, IpPacket } from '../core/frames';
import { shortName, type Interface } from '../devices/device';

/** A row of `show ip source binding`: a DHCP snooping lease, or a static `ip source binding`. */
export interface SourceBinding {
  mac: MacAddress;
  ip: Ipv4Address;
  vlan: number;
  port: Interface;
  type: 'dhcp-snooping' | 'static';
  /** DHCP leases only. */
  leaseSeconds?: number;
}

/** Why IP Source Guard is configured on a port but not filtering. */
export type SourceGuardState = 'active' | 'inactive-no-snooping-vlan' | 'inactive-trust-port';

export interface SourceGuardHost {
  snoopingOn(vlan: number): boolean;
  /** Snooping leases and static bindings together. */
  sourceBindings(): SourceBinding[];
}

/** The VLAN an access port filters in. Trunks filter in their native VLAN here (a simplification). */
function portVlan(p: Interface): number {
  return p.mode === 'access' ? p.accessVlan : p.nativeVlan;
}

export function sourceGuardState(host: SourceGuardHost, port: Interface): SourceGuardState {
  if (port.dhcpSnooping?.trust) return 'inactive-trust-port';
  return host.snoopingOn(portVlan(port)) ? 'active' : 'inactive-no-snooping-vlan';
}

/**
 * IP Source Guard: on a port with `ip verify source`, IPv4 packets pass only when their source
 * address (and, with `port-security`, their source MAC) matches a binding for that port and VLAN.
 * DHCP is always let through, so a host can still get the lease that creates its binding.
 */
export function sourceGuardAllows(host: SourceGuardHost, port: Interface, vlan: number, frame: Frame, p: IpPacket): boolean {
  const mode = port.sourceGuard;
  if (!mode || sourceGuardState(host, port) !== 'active') return true;
  if (p.kind === 'udp' && p.dhcp) return true;
  return host.sourceBindings().some((b) => b.port === port && b.vlan === vlan && b.ip === p.src && (mode === 'ip' || b.mac === frame.src));
}

/** `show ip verify source`. */
export function showIpVerifySource(host: SourceGuardHost, ports: Interface[]): string {
  const rows = ports
    .filter((p) => p.sourceGuard)
    .flatMap((p) => {
      const type = p.sourceGuard!;
      const state = sourceGuardState(host, p);
      const head = `${shortName(p.name).padEnd(11)}${type.padEnd(13)}${state.padEnd(13)}`;
      if (state !== 'active') return [`${shortName(p.name).padEnd(11)}${type.padEnd(13)}${state}`];
      const vlan = portVlan(p);
      const bindings = host.sourceBindings().filter((b) => b.port === p && b.vlan === vlan);
      if (!bindings.length) return [`${head}${'deny-all'.padEnd(17)}${''.padEnd(19)}${vlan}`];
      return bindings.map((b) => `${head}${b.ip.padEnd(17)}${(type === 'ip-mac' ? b.mac : '').padEnd(19)}${vlan}`);
    });
  return [
    'Interface  Filter-type  Filter-mode  IP-address       Mac-address        Vlan',
    '---------  -----------  -----------  ---------------  -----------------  ----',
    ...rows,
  ].join('\n');
}

/** `show ip source binding` and `show ip dhcp snooping binding` share this layout. */
export function showBindings(bindings: SourceBinding[]): string {
  const rows = bindings.map((b) => {
    const mac = b.mac.replace(/\./g, '').replace(/(..)(?=.)/g, '$1:').toUpperCase();
    const lease = b.type === 'static' ? 'infinite' : String(b.leaseSeconds ?? 86_400);
    return `${mac.padEnd(20)}${b.ip.padEnd(17)}${lease.padEnd(12)}${b.type.padEnd(15)}${String(b.vlan).padEnd(6)}${b.port.name}`;
  });
  return [
    'MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface',
    '------------------  ---------------  ----------  -------------  ----  --------------------',
    ...rows,
    `Total number of bindings: ${rows.length}`,
  ].join('\n');
}
