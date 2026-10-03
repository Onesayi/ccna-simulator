import { classfulPrefix, networkAddress, prefixToMask } from '../core/addressing';
import { peerUp, shortName, type Device, type Interface } from '../devices/device';
import type { IpDevice, PingResult, Route, TracerouteResult } from '../devices/ip-device';
import { Router } from '../devices/router';
import { Switch } from '../devices/switch';

/** Formatters for IOS show commands and ping/traceroute output. Pure functions of engine state. */

export function interfaceStatus(i: Interface): { status: string; protocol: string } {
  if (!i.adminUp) return { status: 'administratively down', protocol: 'down' };
  const linkUp = i.kind === 'physical' ? peerUp(i) : i.kind === 'subinterface' ? i.parent!.isUp : true;
  return { status: linkUp ? 'up' : 'down', protocol: i.isUp ? 'up' : 'down' };
}

export function showIpIntBrief(d: Device): string {
  const rows = d.interfaces.map((i) => {
    const { status, protocol } = interfaceStatus(i);
    const method = i.ip ? 'manual' : 'unset';
    return `${i.name.padEnd(23)}${(i.ip?.address ?? 'unassigned').padEnd(16)}YES ${method.padEnd(7)}${status.padEnd(22)}${protocol}`;
  });
  return ['Interface              IP-Address      OK? Method Status                Protocol', ...rows].join('\n');
}

const ROUTE_CODES = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       + - replicated route, % - next hop override`;

/** One route line. Inside a group the code column is wider, and single-mask groups drop the prefix. */
function routeLine(r: Route, indent: boolean, showPrefix = true): string {
  const code = r.code + (r.prefix === 0 && r.code === 'S' ? '*' : '');
  const dest = `${code.padEnd(indent ? 9 : 6)}${r.network}${showPrefix ? `/${r.prefix}` : ''}`;
  if (r.code !== 'S') return `${dest} is directly connected, ${r.iface!.name}`;
  if (!r.nextHop) return `${dest} is directly connected, ${r.iface!.name}`;
  return `${dest} [${r.ad}/${r.metric}] via ${r.nextHop}${r.iface ? `, ${r.iface.name}` : ''}`;
}

export function showIpRoute(d: IpDevice): string {
  const table = d.routingTable();
  const glr = d.gatewayOfLastResort(table);
  const lines = [ROUTE_CODES, ''];
  if (!glr) lines.push('Gateway of last resort is not set');
  else if (glr.nextHop) lines.push(`Gateway of last resort is ${glr.nextHop} to network 0.0.0.0`);
  else lines.push(`Gateway of last resort is 0.0.0.0 to network 0.0.0.0`);
  lines.push('');

  const ipNum = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);
  const sorted = [...table].sort((a, b) => ipNum(a.network) - ipNum(b.network) || a.prefix - b.prefix || (a.code === 'C' ? -1 : 1));
  // IOS groups everything inside a classful network under one header line once that network is
  // subnetted ("10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks"); other routes print flat.
  const groups = new Map<string, Route[]>();
  for (const r of sorted) {
    const cp = classfulPrefix(r.network);
    const key = r.prefix >= cp && r.prefix > 0 ? `${networkAddress(r.network, cp)}/${cp}` : `${r.network}/${r.prefix}#flat`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, routes] of groups) {
    const [net = '', cp = ''] = key.split('/');
    if (key.endsWith('#flat') || routes.every((r) => r.prefix === Number(cp))) {
      lines.push(...routes.map((r) => routeLine(r, false)));
      continue;
    }
    const masks = new Set(routes.map((r) => r.prefix));
    const subnets = new Set(routes.map((r) => `${r.network}/${r.prefix}`)).size;
    const plural = subnets > 1 ? 's' : '';
    if (masks.size === 1) lines.push(`      ${net}/${[...masks][0]} is subnetted, ${subnets} subnet${plural}`);
    else lines.push(`      ${net}/${cp} is variably subnetted, ${subnets} subnet${plural}, ${masks.size} masks`);
    lines.push(...routes.map((r) => routeLine(r, true, masks.size > 1)));
  }
  return lines.join('\n');
}

export function showArp(d: IpDevice): string {
  const now = d.network?.scheduler.now ?? 0;
  const rows: [ip: string, age: string, mac: string, iface: string][] = [];
  for (const i of d.ipInterfaces()) if (i.kind !== 'loopback') rows.push([i.ip!.address, '-', i.mac, i.name]);
  for (const [ip, e] of d.arpTable) rows.push([ip, String(Math.floor((now - e.learnedAt) / 60_000)), e.mac, e.iface.name]);
  const ipNum = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);
  rows.sort((a, b) => ipNum(a[0]) - ipNum(b[0]));
  return [
    'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
    ...rows.map(([ip, age, mac, iface]) => `Internet  ${ip.padEnd(17)}${age.padStart(8)}   ${mac}  ARPA   ${iface}`),
  ].join('\n');
}

export function showVlanBrief(sw: Switch): string {
  const rows = [...sw.vlans.entries()].sort(([a], [b]) => a - b).map(([id, name]) => {
    const ports = sw.ports.filter((i) => i.mode === 'access' && i.accessVlan === id).map((i) => shortName(i.name)).join(', ');
    return `${String(id).padEnd(5)}${name.padEnd(33)}active    ${ports}`;
  });
  return ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------', ...rows].join('\n');
}

export function showMacTable(sw: Switch): string {
  const live = sw.macTable.filter((e) => sw.macLookup(e.vlan, e.mac) === e).sort((a, b) => a.vlan - b.vlan);
  const rows = live.map((e) => `${String(e.vlan).padStart(4)}    ${e.mac}    DYNAMIC     ${shortName(e.port.name)}`);
  return ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----', ...rows, `Total Mac Addresses for this criterion: ${rows.length}`].join('\n');
}

/** "1,2,3,5,10-20" style compression used by IOS for VLAN lists. */
export function formatVlanList(vlans: Iterable<number>): string {
  const sorted = [...new Set(vlans)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(','));
    i = j;
  }
  return parts.join(',') || 'none';
}

export function showTrunks(sw: Switch): string {
  const trunks = sw.ports.filter((i) => i.mode === 'trunk');
  const allowed = (i: Interface) => (i.allowedVlans === 'all' ? '1-4094' : formatVlanList(i.allowedVlans));
  const active = (i: Interface) => formatVlanList([...sw.vlans.keys()].filter((v) => sw.carriesVlan(i, v)));
  const pad = (i: Interface) => shortName(i.name).padEnd(12);
  return [
    'Port        Mode             Encapsulation  Status        Native vlan',
    ...trunks.map((i) => `${pad(i)}on               802.1q         ${(i.isUp ? 'trunking' : 'not-trunking').padEnd(14)}${i.nativeVlan}`),
    '',
    'Port        Vlans allowed on trunk',
    ...trunks.map((i) => `${pad(i)}${allowed(i)}`),
    '',
    'Port        Vlans allowed and active in management domain',
    ...trunks.map((i) => `${pad(i)}${active(i)}`),
  ].join('\n');
}

export function showInterfacesSwitchport(sw: Switch, i: Interface): string {
  const admin = i.mode === 'trunk' ? 'trunk' : 'static access';
  const oper = i.isUp ? (i.mode === 'trunk' ? 'trunk' : 'static access') : 'down';
  return [
    `Name: ${shortName(i.name)}`,
    'Switchport: Enabled',
    `Administrative Mode: ${admin}`,
    `Operational Mode: ${oper}`,
    'Administrative Trunking Encapsulation: dot1q',
    `Access Mode VLAN: ${i.accessVlan} (${sw.vlans.get(i.accessVlan) ?? 'Inactive'})`,
    `Trunking Native Mode VLAN: ${i.nativeVlan} (${sw.vlans.get(i.nativeVlan) ?? 'Inactive'})`,
    `Trunking VLANs Enabled: ${i.allowedVlans === 'all' ? 'ALL' : formatVlanList(i.allowedVlans)}`,
  ].join('\n');
}

// ---------------------------------------------------------------- running-config

export function runningConfig(d: Device & IpDevice): string {
  const out: string[] = ['Building configuration...', '', 'Current configuration : {bytes} bytes', '!', 'version 15.2', '!', `hostname ${d.hostname}`, '!'];
  if (d instanceof Switch) {
    if (d.ipRouting) out.push('ip routing', '!');
    for (const [id, name] of [...d.vlans].sort(([a], [b]) => a - b)) {
      if (id === 1) continue;
      out.push(`vlan ${id}`);
      if (name !== `VLAN${String(id).padStart(4, '0')}`) out.push(` name ${name}`);
      out.push('!');
    }
  }
  for (const i of d.interfaces) {
    out.push(`interface ${i.name}`);
    if (i.description) out.push(` description ${i.description}`);
    if (i.kind === 'subinterface' && i.encapVlan !== undefined) out.push(` encapsulation dot1Q ${i.encapVlan}${i.encapNative ? ' native' : ''}`);
    if (d instanceof Switch && i.kind === 'physical') {
      if (i.accessVlan !== 1) out.push(` switchport access vlan ${i.accessVlan}`);
      if (i.nativeVlan !== 1) out.push(` switchport trunk native vlan ${i.nativeVlan}`);
      if (i.allowedVlans !== 'all') out.push(` switchport trunk allowed vlan ${formatVlanList(i.allowedVlans)}`);
      if (i.mode === 'trunk') out.push(' switchport mode trunk');
      else if (i.mode === 'access') out.push(' switchport mode access');
    } else {
      out.push(i.ip ? ` ip address ${i.ip.address} ${prefixToMask(i.ip.prefix)}` : ' no ip address');
    }
    if (!i.adminUp) out.push(' shutdown');
    if (d instanceof Router && i.kind === 'physical') out.push(' duplex auto', ' speed auto');
    out.push('!');
  }
  if (d instanceof Switch && d.defaultGateway) out.push(`ip default-gateway ${d.defaultGateway}`);
  for (const r of d.staticRoutes) {
    const via = [r.exitInterface, r.nextHop].filter(Boolean).join(' ');
    out.push(`ip route ${r.network} ${prefixToMask(r.prefix)} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
  }
  out.push('!', 'line con 0', '!', 'line vty 0 4', ' login', '!', 'end');
  const text = out.join('\n');
  return text.replace('{bytes}', String(text.length));
}

// ---------------------------------------------------------------- ping and traceroute

const PING_SYMBOL: Record<PingResult['status'], string> = {
  pending: '.',
  success: '!',
  timeout: '.',
  'no-route': '.',
  unreachable: 'U',
  'ttl-exceeded': '&',
};

export function formatIosPing(dst: string, results: PingResult[]): string {
  const ok = results.filter((r) => r.success);
  const pct = Math.round((ok.length / results.length) * 100);
  const lines = [
    'Type escape sequence to abort.',
    `Sending ${results.length}, 100-byte ICMP Echos to ${dst}, timeout is 2 seconds:`,
    results.map((r) => PING_SYMBOL[r.status]).join(''),
  ];
  if (ok.length) {
    const rtts = ok.map((r) => r.rttMs ?? 0);
    const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
    lines.push(`Success rate is ${pct} percent (${ok.length}/${results.length}), round-trip min/avg/max = ${Math.min(...rtts)}/${avg}/${Math.max(...rtts)} ms`);
  } else {
    lines.push(`Success rate is 0 percent (0/${results.length})`);
  }
  return lines.join('\n');
}

export function formatIosTraceroute(t: TracerouteResult): string {
  const lines = ['Type escape sequence to abort.', `Tracing the route to ${t.destination}`, 'VRF info: (vrf in name/id, vrf out name/id)'];
  for (const hop of t.hops) {
    let line = `${String(hop.ttl).padStart(3)}`;
    let last: string | undefined;
    for (const p of hop.probes) {
      if (!p.from) {
        line += ' *';
        continue;
      }
      if (p.from !== last) line += ` ${p.from}`;
      last = p.from;
      line += p.unreachable ? ' !H' : ` ${p.rttMs} msec`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
