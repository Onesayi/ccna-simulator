import type { Ipv4Address } from '../core/addressing';
import type { DiscoveryPdu } from '../core/frames';
import { shortName, type Interface } from '../devices/device';

/** CDP sends every 60 seconds and neighbors keep an entry for 180; LLDP uses 30 and 120. */
export const CDP_HOLDTIME = 180;
export const LLDP_HOLDTIME = 120;

export interface DiscoveryNeighbor {
  local: Interface;
  pdu: DiscoveryPdu;
  /** Virtual time the last advertisement arrived, for the holdtime column. */
  heardAt: number;
}

export interface DiscoveryHooks {
  /** Ports that send and receive advertisements: physical ports, bundled or not. */
  ports(): Interface[];
  /** Builds this device's advertisement for one port. */
  advertise(port: Interface, kind: 'cdp' | 'lldp'): DiscoveryPdu;
  send(port: Interface, pdu: DiscoveryPdu): void;
  now(): number;
}

/**
 * CDP and LLDP for one router or switch. Every round each enabled port advertises, and a
 * neighbor that was not heard in a round is dropped, standing in for the holdtime running out.
 * CDP runs by default; LLDP has to be turned on with `lldp run`.
 */
export class Discovery {
  cdpEnabled = true;
  lldpEnabled = false;
  private readonly table = new Map<string, DiscoveryNeighbor>();
  private heard = new Set<string>();

  constructor(private readonly hooks: DiscoveryHooks) {}

  tick(): void {
    this.heard = new Set();
    for (const port of this.hooks.ports()) {
      if (!port.isUp) continue;
      if (this.cdpEnabled && port.cdp !== false) this.hooks.send(port, this.hooks.advertise(port, 'cdp'));
      if (this.lldpEnabled && port.lldp?.transmit !== false) this.hooks.send(port, this.hooks.advertise(port, 'lldp'));
    }
  }

  receive(port: Interface, pdu: DiscoveryPdu): void {
    if (pdu.kind === 'cdp' && (!this.cdpEnabled || port.cdp === false)) return;
    if (pdu.kind === 'lldp' && (!this.lldpEnabled || port.lldp?.receive === false)) return;
    const key = `${pdu.kind}|${port.name}|${pdu.deviceId}|${pdu.portId}`;
    this.table.set(key, { local: port, pdu, heardAt: this.hooks.now() });
    this.heard.add(key);
  }

  /** Forgets neighbors not heard this round. Neighbor tables never change another protocol, so this reports no change. */
  settle(): boolean {
    for (const key of [...this.table.keys()]) if (!this.heard.has(key)) this.table.delete(key);
    return false;
  }

  neighbors(kind: 'cdp' | 'lldp'): DiscoveryNeighbor[] {
    return [...this.table.values()].filter((n) => n.pdu.kind === kind).sort((a, b) => a.pdu.deviceId.localeCompare(b.pdu.deviceId) || a.local.name.localeCompare(b.local.name));
  }
}

// ---------------------------------------------------------------- show commands

/** CDP abbreviates interface names with a space: "Gig 0/1". */
function cdpPort(name: string): string {
  return name.replace(/^GigabitEthernet/, 'Gig ').replace(/^FastEthernet/, 'Fas ').replace(/^Ethernet/, 'Eth ');
}

const CDP_CAPABILITY_NAMES: Record<string, string> = { R: 'Router', B: 'Source-Route-Bridge', S: 'Switch', I: 'IGMP' };

function remaining(n: DiscoveryNeighbor, now: number): number {
  return Math.max(0, n.pdu.holdtime - Math.floor((now - n.heardAt) / 1000));
}

export function showCdp(d: Discovery): string {
  if (!d.cdpEnabled) return '% CDP is not enabled';
  return ['Global CDP information:', '\tSending CDP packets every 60 seconds', `\tSending a holdtime value of ${CDP_HOLDTIME} seconds`, '\tSending CDPv2 advertisements is  enabled'].join('\n');
}

export function showCdpNeighbors(d: Discovery, now: number, detail = false): string {
  if (!d.cdpEnabled) return '% CDP is not enabled';
  const all = d.neighbors('cdp');
  if (detail) {
    return all
      .map((n) => {
        const p = n.pdu;
        return [
          '-------------------------',
          `Device ID: ${p.deviceId}`,
          'Entry address(es): ',
          ...(p.address ? [`  IP address: ${p.address}`] : []),
          `Platform: ${p.platform},  Capabilities: ${p.capabilities.map((c) => CDP_CAPABILITY_NAMES[c]).join(' ')} `,
          `Interface: ${n.local.name},  Port ID (outgoing port): ${p.portId}`,
          `Holdtime : ${remaining(n, now)} sec`,
          '',
          'Version :',
          p.version,
          '',
          'advertisement version: 2',
          ...(p.nativeVlan !== undefined ? [`Native VLAN: ${p.nativeVlan}`] : []),
          'Duplex: full',
          '',
        ].join('\n');
      })
      .join('\n')
      .concat(all.length ? '' : '\n')
      .concat(`Total cdp entries displayed : ${all.length}`);
  }
  const rows = all.map((n) => {
    const p = n.pdu;
    const id = p.deviceId.length > 16 ? `${p.deviceId}\n${' '.repeat(17)}` : p.deviceId.padEnd(17);
    const platform = p.platform.replace(/^cisco /, '').slice(0, 9);
    return `${id}${cdpPort(n.local.name).padEnd(18)}${String(remaining(n, now)).padEnd(11)}${p.capabilities.join(' ').padStart(10)}  ${platform.padEnd(10)}${cdpPort(p.portId)}`;
  });
  return [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,',
    '                  D - Remote, C - CVTA, M - Two-port Mac Relay',
    '',
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    ...rows,
    '',
    `Total cdp entries displayed : ${rows.length}`,
  ].join('\n');
}

export function showLldp(d: Discovery): string {
  if (!d.lldpEnabled) return '% LLDP is not enabled';
  return [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    '    LLDP advertisements are sent every 30 seconds',
    `    LLDP hold time advertised is ${LLDP_HOLDTIME} seconds`,
    '    LLDP interface reinitialisation delay is 2 seconds',
  ].join('\n');
}

export function showLldpNeighbors(d: Discovery, now: number, detail = false): string {
  if (!d.lldpEnabled) return '% LLDP is not enabled';
  const all = d.neighbors('lldp');
  if (detail) {
    return [
      ...all.map((n) => {
        const p = n.pdu;
        return [
          '------------------------------------------------',
          `Local Intf: ${shortName(n.local.name)}`,
          `Chassis id: ${p.chassisId}`,
          `Port id: ${shortName(p.portId)}`,
          `Port Description: ${p.portId}`,
          `System Name: ${p.deviceId}`,
          '',
          'System Description: ',
          p.version,
          '',
          `Time remaining: ${remaining(n, now)} seconds`,
          `System Capabilities: ${p.capabilities.join(',')}`,
          `Enabled Capabilities: ${p.capabilities.join(',')}`,
          'Management Addresses:',
          p.address ? `    IP: ${p.address}` : '    not advertised',
          'Auto Negotiation - supported, enabled',
          '',
        ].join('\n');
      }),
      '',
      `Total entries displayed: ${all.length}`,
    ].join('\n');
  }
  const rows = all.map((n) => {
    const p = n.pdu;
    return `${p.deviceId.slice(0, 20).padEnd(20)}${shortName(n.local.name).padEnd(15)}${String(remaining(n, now)).padEnd(11)}${p.capabilities.join(',').padEnd(16)}${shortName(p.portId)}`;
  });
  return [
    'Capability codes:',
    '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
    '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
    '',
    'Device ID           Local Intf     Hold-time  Capability      Port ID',
    ...rows,
    '',
    `Total entries displayed: ${rows.length}`,
  ].join('\n');
}

/** The address a device advertises from a port: the port's own, else its first other address. */
export function advertisedAddress(port: Interface, all: Interface[]): Ipv4Address | undefined {
  return port.ip?.address ?? all.find((i) => i.ip && i.isUp && i.kind !== 'loopback')?.ip?.address ?? all.find((i) => i.ip)?.ip?.address;
}
