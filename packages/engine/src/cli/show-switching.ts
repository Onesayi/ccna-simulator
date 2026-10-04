import { peerUp, shortName, type Interface, type PortSecurityConfig } from '../devices/device';
import type { Switch } from '../devices/switch';
import { formatVlanList } from './show';

/** `show interfaces status`: one line per switchport, with err-disabled ports called out. */
export function showInterfacesStatus(sw: Switch, onlyErrDisabled = false): string {
  const ports = [...sw.ports, ...sw.portChannels].filter((p) => !onlyErrDisabled || p.errDisabled);
  if (onlyErrDisabled) {
    return [
      'Port      Name               Status       Reason               Err-disabled Vlans',
      ...ports.map((p) => `${shortName(p.name).padEnd(10)}${(p.description ?? '').slice(0, 18).padEnd(19)}err-disabled ${p.errDisabled!}`),
    ].join('\n');
  }
  const rows = ports.map((p) => {
    const status = p.errDisabled ? 'err-disabled' : !p.adminUp ? 'disabled' : p.isUp || (p.kind === 'physical' && peerUp(p)) ? 'connected' : 'notconnect';
    const vlan = p.mode === 'trunk' ? 'trunk' : String(p.accessVlan);
    const type = p.kind === 'port-channel' ? '' : '10/100/1000BaseTX';
    return `${shortName(p.name).padEnd(10)}${(p.description ?? '').slice(0, 18).padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${'a-full'.padEnd(7)}${'a-1000'.padEnd(7)}${type}`.trimEnd();
  });
  return ['Port      Name               Status       Vlan       Duplex Speed  Type', ...rows].join('\n');
}

const ACTION: Record<PortSecurityConfig['violation'], string> = { shutdown: 'Shutdown', restrict: 'Restrict', protect: 'Protect' };

export function showPortSecurity(sw: Switch): string {
  const secured = sw.ports.filter((p) => p.portSecurity?.enabled);
  const rows = secured.map((p) => {
    const ps = p.portSecurity!;
    return `${shortName(p.name).padStart(10)}${String(ps.maximum).padStart(15)}${String(ps.addresses.length).padStart(13)}${String(ps.violations).padStart(19)}${ACTION[ps.violation].padStart(17)}`;
  });
  const total = secured.reduce((n, p) => n + Math.max(0, p.portSecurity!.addresses.length - 1), 0);
  return [
    'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
    '                (Count)       (Count)          (Count)',
    '---------------------------------------------------------------------------',
    ...rows,
    '---------------------------------------------------------------------------',
    `Total Addresses in System (excluding one mac per port)     : ${total}`,
    'Max Addresses limit in System (excluding one mac per port) : 4096',
  ].join('\n');
}

export function showPortSecurityInterface(p: Interface): string {
  const ps = p.portSecurity;
  if (!ps?.enabled) {
    return [
      'Port Security              : Disabled',
      'Port Status                : Secure-down',
      `Violation Mode             : ${ACTION[ps?.violation ?? 'shutdown']}`,
      `Maximum MAC Addresses      : ${ps?.maximum ?? 1}`,
      'Total MAC Addresses        : 0',
      'Security Violation Count   : 0',
    ].join('\n');
  }
  const status = p.errDisabled ? 'Secure-shutdown' : p.isUp ? 'Secure-up' : 'Secure-down';
  const count = (t: string) => ps.addresses.filter((a) => a.type === t).length;
  return [
    'Port Security              : Enabled',
    `Port Status                : ${status}`,
    `Violation Mode             : ${ACTION[ps.violation]}`,
    'Aging Time                 : 0 mins',
    'Aging Type                 : Absolute',
    'SecureStatic Address Aging : Disabled',
    `Maximum MAC Addresses      : ${ps.maximum}`,
    `Total MAC Addresses        : ${ps.addresses.length}`,
    `Configured MAC Addresses   : ${count('static')}`,
    `Sticky MAC Addresses       : ${count('sticky')}`,
    `Last Source Address:Vlan   : ${ps.lastSource ? `${ps.lastSource.mac}:${ps.lastSource.vlan}` : '0000.0000.0000:0'}`,
    `Security Violation Count   : ${ps.violations}`,
  ].join('\n');
}

export function showPortSecurityAddress(sw: Switch): string {
  const TYPE = { static: 'SecureConfigured', sticky: 'SecureSticky', dynamic: 'SecureDynamic' } as const;
  const rows = sw.ports.flatMap((p) =>
    p.portSecurity?.enabled ? p.portSecurity.addresses.map((a) => `${String(a.vlan).padStart(4)}    ${a.mac}    ${TYPE[a.type].padEnd(20)}${shortName(p.name)}`) : [],
  );
  return [
    '               Secure Mac Address Table',
    '-----------------------------------------------------------------------------',
    'Vlan    Mac Address       Type                Ports',
    '----    -----------       ----                -----',
    ...rows,
    '-----------------------------------------------------------------------------',
    `Total Addresses in System (excluding one mac per port)     : ${Math.max(0, rows.length - sw.ports.filter((p) => p.portSecurity?.enabled).length)}`,
  ].join('\n');
}

export function showDhcpSnooping(sw: Switch): string {
  const sn = sw.snooping;
  const vlans = [...sn.vlans].sort((a, b) => a - b);
  const operational = sn.enabled ? vlans.filter((v) => sw.vlans.has(v)) : [];
  const configured = [...sw.ports, ...sw.portChannels].filter((p) => p.dhcpSnooping?.trust || p.dhcpSnooping?.rateLimit);
  return [
    `Switch DHCP snooping is ${sn.enabled ? 'enabled' : 'disabled'}`,
    'Switch DHCP gleaning is disabled',
    'DHCP snooping is configured on following VLANs:',
    formatVlanList(vlans),
    'DHCP snooping is operational on following VLANs:',
    formatVlanList(operational),
    'DHCP snooping is configured on the following L3 Interfaces:',
    '',
    `Insertion of option 82 is ${sn.option82 ? 'enabled' : 'disabled'}`,
    '   circuit-id default format: vlan-mod-port',
    `   remote-id: ${sw.bridgeMac} (MAC)`,
    'Option 82 on untrusted port is not allowed',
    'Verification of hwaddr field is enabled',
    'Verification of giaddr field is enabled',
    'DHCP snooping trust/rate is configured on the following Interfaces:',
    '',
    'Interface                  Trusted    Allow option    Rate limit (pps)',
    '-----------------------    -------    ------------    ----------------',
    ...configured.map((p) => {
      const trusted = p.dhcpSnooping?.trust ? 'yes' : 'no';
      return `${p.name.padEnd(27)}${trusted.padEnd(11)}${trusted.padEnd(16)}${p.dhcpSnooping?.rateLimit ?? 'unlimited'}`;
    }),
  ].join('\n');
}

export function showDhcpSnoopingBinding(sw: Switch): string {
  const rows = sw.snooping.bindings.map((b) => {
    const mac = b.mac.replace(/\./g, '').replace(/(..)(?=.)/g, '$1:').toUpperCase();
    return `${mac.padEnd(20)}${b.ip.padEnd(17)}${String(b.leaseSeconds).padEnd(12)}${'dhcp-snooping'.padEnd(15)}${String(b.vlan).padEnd(6)}${b.port.name}`;
  });
  return [
    'MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface',
    '------------------  ---------------  ----------  -------------  ----  --------------------',
    ...rows,
    `Total number of bindings: ${rows.length}`,
  ].join('\n');
}
