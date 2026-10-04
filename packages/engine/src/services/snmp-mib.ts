import { prefixToMask } from '../core/addressing';
import type { Interface } from '../devices/device';
import type { IosDevice } from '../devices/ios-device';
import { compareOid, type MibEntry } from './snmp';

const SYS = '1.3.6.1.2.1.1';
const IF = '1.3.6.1.2.1.2.2.1';
const IFX = '1.3.6.1.2.1.31.1.1.1';
const IPADDR = '1.3.6.1.2.1.4.20.1';

function ifType(i: Interface): number {
  switch (i.kind) {
    case 'loopback':
      return 24;
    case 'svi':
    case 'radio':
      return 53;
    case 'subinterface':
      return 135;
    case 'port-channel':
      return 161;
    default:
      return 6;
  }
}

/** Sets the line protocol the way `shutdown` does, for `ifAdminStatus`. */
function setAdmin(i: Interface, v: string | number): 'wrongValue' | undefined {
  const n = Number(v);
  if (n !== 1 && n !== 2) return 'wrongValue';
  const up = n === 1;
  if (i.adminUp === up) return undefined;
  i.adminUp = up;
  if (!up) i.errDisabled = undefined;
  i.device.log.push(`%LINK-5-CHANGED: Interface ${i.name}, changed state to ${up ? 'up' : 'administratively down'}`);
  return undefined;
}

/** The MIB-II objects a router or switch serves: system, the interfaces table, ifXTable and the IP address table. */
export function buildMib(d: IosDevice): MibEntry[] {
  const snmp = d.snmp;
  const str = (v: string | number) => String(v);
  const entries: MibEntry[] = [
    { oid: `${SYS}.1.0`, type: 'STRING', value: d.software.replace(/\n/g, ' ') },
    { oid: `${SYS}.2.0`, type: 'OID', value: d.kind === 'router' ? '1.3.6.1.4.1.9.1.2068' : '1.3.6.1.4.1.9.1.1208' },
    { oid: `${SYS}.3.0`, type: 'Timeticks', value: Math.floor((d.network?.scheduler.now ?? 0) / 10) },
    { oid: `${SYS}.4.0`, type: 'STRING', value: snmp.contact ?? '', set: (v) => void (snmp.contact = str(v)) },
    {
      oid: `${SYS}.5.0`,
      type: 'STRING',
      value: d.hostname,
      set: (v) => {
        const name = str(v);
        const clash = d.network?.find(name);
        if (!/^[A-Za-z][\w-]*$/.test(name) || (clash && clash !== d)) return 'wrongValue';
        d.hostname = name;
        return undefined;
      },
    },
    { oid: `${SYS}.6.0`, type: 'STRING', value: snmp.location ?? '', set: (v) => void (snmp.location = str(v)) },
    { oid: `${SYS}.7.0`, type: 'INTEGER', value: d.kind === 'router' ? 78 : 2 },
    { oid: '1.3.6.1.2.1.2.1.0', type: 'INTEGER', value: d.interfaces.length },
  ];
  d.interfaces.forEach((i, k) => {
    const n = k + 1;
    entries.push(
      { oid: `${IF}.1.${n}`, type: 'INTEGER', value: n },
      { oid: `${IF}.2.${n}`, type: 'STRING', value: i.name },
      { oid: `${IF}.3.${n}`, type: 'INTEGER', value: ifType(i) },
      { oid: `${IF}.4.${n}`, type: 'INTEGER', value: i.kind === 'loopback' ? 1514 : 1500 },
      { oid: `${IF}.5.${n}`, type: 'Gauge32', value: i.kind === 'loopback' ? 4294967295 : 1_000_000_000 },
      { oid: `${IF}.6.${n}`, type: 'Hex-STRING', value: i.mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1 ').toUpperCase() },
      { oid: `${IF}.7.${n}`, type: 'INTEGER', value: i.adminUp ? 1 : 2, set: (v) => setAdmin(i, v) },
      { oid: `${IF}.8.${n}`, type: 'INTEGER', value: i.isUp ? 1 : 2 },
      { oid: `${IF}.11.${n}`, type: 'Counter32', value: i.counters.in },
      { oid: `${IF}.17.${n}`, type: 'Counter32', value: i.counters.out },
      { oid: `${IFX}.1.${n}`, type: 'STRING', value: shortIf(i.name) },
      {
        oid: `${IFX}.18.${n}`,
        type: 'STRING',
        value: i.description ?? '',
        set: (v) => {
          i.description = str(v) || undefined;
          return undefined;
        },
      },
    );
    if (i.ip) {
      const a = i.ip.address;
      entries.push(
        { oid: `${IPADDR}.1.${a}`, type: 'IpAddress', value: a },
        { oid: `${IPADDR}.2.${a}`, type: 'INTEGER', value: n },
        { oid: `${IPADDR}.3.${a}`, type: 'IpAddress', value: prefixToMask(i.ip.prefix) },
      );
    }
  });
  // Walks follow OID order, so the tables come out column by column like on a real agent.
  entries.sort((a, b) => compareOid(a.oid, b.oid));
  return entries;
}

function shortIf(name: string): string {
  return name.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Loopback/, 'Lo').replace(/^Port-channel/, 'Po').replace(/^Vlan/, 'Vl');
}
