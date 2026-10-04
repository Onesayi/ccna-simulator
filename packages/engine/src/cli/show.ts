import { classfulPrefix, networkAddress, prefixToMask } from '../core/addressing';
import { peerUp, shortName, type Device, type Interface } from '../devices/device';
import type { IpDevice, PingResult, Route, TracerouteResult } from '../devices/ip-device';
import { Router } from '../devices/router';
import { ospfConfig } from '../routing/ospf';
import { formatAclEntry } from '../services/acl';
import { Switch } from '../devices/switch';
import { IosDevice } from '../devices/ios-device';
import { ipv6InterfaceConfig, ipv6RouteConfig } from './commands-ipv6';
import { daiInterfaceConfig } from '../switching/arp-inspection';

/** Formatters for IOS show commands and ping/traceroute output. Pure functions of engine state. */

export function interfaceStatus(i: Interface): { status: string; protocol: string } {
  if (!i.adminUp) return { status: 'administratively down', protocol: 'down' };
  if (i.errDisabled) return { status: 'down', protocol: 'down' };
  const linkUp = i.kind === 'physical' ? peerUp(i) : i.kind === 'subinterface' ? i.parent!.isUp : i.kind === 'port-channel' ? i.isUp : true;
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

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** One route line. Inside a group the code column is wider, and single-mask groups drop the prefix. */
function routeLine(r: Route, indent: boolean, showPrefix: boolean, now: number, continuation: boolean): string {
  const code = r.code + (r.prefix === 0 && r.code !== 'C' && r.code !== 'L' ? '*' : '') + (r.external ? 'E2' : '');
  const dest = `${code.padEnd(indent ? 9 : 6)}${r.network}${showPrefix ? `/${r.prefix}` : ''}`;
  if (r.code === 'C' || r.code === 'L' || !r.nextHop) return `${dest} is directly connected, ${r.iface!.name}`;
  const learned = r.learnedAt !== undefined ? `, ${age(now - r.learnedAt)}` : '';
  const via = `[${r.ad}/${r.metric}] via ${r.nextHop}${learned}${r.iface ? `, ${r.iface.name}` : ''}`;
  // Equal-cost paths: IOS prints the extra next hops under the first, aligned with its "[AD/metric]".
  return continuation ? `${' '.repeat(dest.length + 1)}${via}` : `${dest} ${via}`;
}

export function showIpRoute(d: IpDevice, codes?: string[]): string {
  const full = d.routingTable();
  const table = codes ? full.filter((r) => codes.includes(r.code)) : full;
  const now = d.network?.scheduler.now ?? 0;
  const glr = d.gatewayOfLastResort(full);
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
    const render = (indent: boolean, showPrefix: boolean) =>
      routes.map((r, k) => {
        const prev = routes[k - 1];
        const same = prev !== undefined && prev.network === r.network && prev.prefix === r.prefix && prev.code === r.code;
        return routeLine(r, indent, showPrefix, now, same);
      });
    if (key.endsWith('#flat') || routes.every((r) => r.prefix === Number(cp))) {
      lines.push(...render(false, true));
      continue;
    }
    const masks = new Set(routes.map((r) => r.prefix));
    const subnets = new Set(routes.map((r) => `${r.network}/${r.prefix}`)).size;
    const plural = subnets > 1 ? 's' : '';
    if (masks.size === 1) lines.push(`      ${net}/${[...masks][0]} is subnetted, ${subnets} subnet${plural}`);
    else lines.push(`      ${net}/${cp} is variably subnetted, ${subnets} subnet${plural}, ${masks.size} masks`);
    lines.push(...render(true, masks.size > 1));
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
    // Bundled members are listed as their port-channel.
    const ports = [...sw.ports.filter((i) => !i.channelGroup), ...sw.portChannels]
      .filter((i) => i.mode === 'access' && i.accessVlan === id)
      .map((i) => shortName(i.name))
      .join(', ');
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
  const trunks = [...sw.ports.filter((i) => !i.channelGroup), ...sw.portChannels].filter((i) => i.mode === 'trunk');
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
  const ios = d instanceof IosDevice ? d : undefined;
  const out: string[] = ['Building configuration...', '', 'Current configuration : {bytes} bytes', '!', 'version 15.2'];
  const ts = ios?.logTimestamps;
  if (ts) out.push(`service timestamps log ${ts.kind}${ts.msec ? ' msec' : ''}${ts.localtime ? ' localtime' : ''}${ts.showTimezone ? ' show-timezone' : ''}`);
  if (ios?.mgmt.passwordEncryption) out.push('service password-encryption');
  out.push('!', `hostname ${d.hostname}`, '!');
  if (ios) {
    const access = ios.mgmt.globalConfig().filter((l) => l !== 'service password-encryption');
    if (access.length) out.push(...access, '!');
    const aaa = ios.aaa.config();
    if (aaa.length) out.push(...aaa, '!');
    const tz = ios.ntp.config().filter((l) => l.startsWith('clock'));
    if (tz.length) out.push(...tz, '!');
    const discovery = [...(ios.discovery.cdpEnabled ? [] : ['no cdp run']), ...(ios.discovery.lldpEnabled ? ['lldp run'] : [])];
    if (discovery.length) out.push(...discovery, '!');
  }
  if (d instanceof Router && d.dhcpRelayTrustAll) out.push('ip dhcp relay information trust-all', '!');
  if (d instanceof Switch && (d.snooping.vlans.size || d.snooping.enabled || !d.snooping.option82)) {
    if (d.snooping.vlans.size) out.push(`ip dhcp snooping vlan ${formatVlanList(d.snooping.vlans)}`);
    if (!d.snooping.option82) out.push('no ip dhcp snooping information option');
    if (d.snooping.enabled) out.push('ip dhcp snooping');
    out.push('!');
  }
  if (d instanceof Switch) {
    const l2 = [
      ...d.staticBindings.map((b) => `ip source binding ${b.mac} vlan ${b.vlan} ${b.ip} interface ${shortName(b.port.name)}`),
      ...d.dai.runningConfig(),
      ...[...d.errRecovery.causes].map((c) => `errdisable recovery cause ${c}`),
      ...(d.errRecovery.interval !== 300 ? [`errdisable recovery interval ${d.errRecovery.interval}`] : []),
    ];
    if (l2.length) out.push(...l2, '!');
  }
  if (d instanceof Router && d.ipv6Routing) out.push('ipv6 unicast-routing', '!');
  if (d instanceof Switch) {
    const stp = d.stp;
    out.push(`spanning-tree mode ${stp.mode}`);
    if (stp.portfastDefault) out.push('spanning-tree portfast default');
    if (stp.bpduGuardDefault) out.push('spanning-tree portfast bpduguard default');
    if (stp.disabled.size) out.push(`no spanning-tree vlan ${formatVlanList(stp.disabled)}`);
    const byPriority = new Map<number, number[]>();
    for (const [v, p] of stp.priorities) byPriority.set(p, [...(byPriority.get(p) ?? []), v]);
    for (const [p, vlans] of [...byPriority].sort(([a], [b]) => a - b)) out.push(`spanning-tree vlan ${formatVlanList(vlans)} priority ${p}`);
    out.push('!');
    if (d.ipRouting) out.push('ip routing', '!');
    for (const [id, name] of [...d.vlans].sort(([a], [b]) => a - b)) {
      if (id === 1) continue;
      out.push(`vlan ${id}`);
      if (name !== `VLAN${String(id).padStart(4, '0')}`) out.push(` name ${name}`);
      out.push('!');
    }
  }
  if (d instanceof Router) {
    for (const [lo, hi] of d.dhcpServer.excluded) out.push(`ip dhcp excluded-address ${lo}${hi !== lo ? ` ${hi}` : ''}`);
    if (d.dhcpServer.excluded.length) out.push('!');
    for (const pool of d.dhcpServer.pools.values()) {
      out.push(`ip dhcp pool ${pool.name}`);
      if (pool.network) out.push(` network ${pool.network} ${prefixToMask(pool.prefix!)}`);
      if (pool.defaultRouter) out.push(` default-router ${pool.defaultRouter}`);
      if (pool.dns) out.push(` dns-server ${pool.dns}`);
      if (pool.domain) out.push(` domain-name ${pool.domain}`);
      if (pool.leaseDays !== 1) out.push(` lease ${pool.leaseDays}`);
      out.push('!');
    }
  }
  for (const i of d.interfaces) {
    out.push(`interface ${i.name}`);
    if (i.description) out.push(` description ${i.description}`);
    if (i.kind === 'subinterface' && i.encapVlan !== undefined) out.push(` encapsulation dot1Q ${i.encapVlan}${i.encapNative ? ' native' : ''}`);
    if (d instanceof Switch && (i.kind === 'physical' || i.kind === 'port-channel')) {
      if (i.accessVlan !== 1) out.push(` switchport access vlan ${i.accessVlan}`);
      if (i.nativeVlan !== 1) out.push(` switchport trunk native vlan ${i.nativeVlan}`);
      if (i.allowedVlans !== 'all') out.push(` switchport trunk allowed vlan ${formatVlanList(i.allowedVlans)}`);
      if (i.mode === 'trunk') out.push(' switchport mode trunk');
      else if (i.mode === 'access') out.push(' switchport mode access');
      const ps = i.portSecurity;
      if (ps?.enabled) {
        out.push(' switchport port-security');
        if (ps.maximum !== 1) out.push(` switchport port-security maximum ${ps.maximum}`);
        if (ps.violation !== 'shutdown') out.push(` switchport port-security violation ${ps.violation}`);
        if (ps.sticky) out.push(' switchport port-security mac-address sticky');
      }
      for (const a of ps?.addresses ?? []) {
        if (a.type !== 'dynamic') out.push(` switchport port-security mac-address ${a.type === 'sticky' ? 'sticky ' : ''}${a.mac}`);
      }
      if (i.channelGroup) out.push(` channel-group ${i.channelGroup.id} mode ${i.channelGroup.mode}`);
      const st = i.stp;
      if (st?.portfast === true) out.push(' spanning-tree portfast');
      if (st?.portfast === false) out.push(' spanning-tree portfast disable');
      if (st?.bpduGuard !== undefined) out.push(` spanning-tree bpduguard ${st.bpduGuard ? 'enable' : 'disable'}`);
      if (st?.guardRoot) out.push(' spanning-tree guard root');
      if (st?.cost) out.push(` spanning-tree cost ${st.cost}`);
      if (st?.priority !== undefined) out.push(` spanning-tree port-priority ${st.priority}`);
      if (i.dhcpSnooping?.rateLimit) out.push(` ip dhcp snooping limit rate ${i.dhcpSnooping.rateLimit}`);
      if (i.dhcpSnooping?.trust) out.push(' ip dhcp snooping trust');
      out.push(...daiInterfaceConfig(i));
      if (i.sourceGuard) out.push(` ip verify source${i.sourceGuard === 'ip-mac' ? ' port-security' : ''}`);
    } else {
      out.push(i.dhcpClient ? ' ip address dhcp' : i.ip ? ` ip address ${i.ip.address} ${prefixToMask(i.ip.prefix)}` : ' no ip address');
      out.push(...ipv6InterfaceConfig(i));
    }
    for (const h of i.helpers ?? []) out.push(` ip helper-address ${h}`);
    if (i.accessGroup?.in) out.push(` ip access-group ${i.accessGroup.in} in`);
    if (i.accessGroup?.out) out.push(` ip access-group ${i.accessGroup.out} out`);
    if (i.nat) out.push(` ip nat ${i.nat}`);
    if (i.bandwidth) out.push(` bandwidth ${i.bandwidth}`);
    const o = i.ospf;
    if (o?.process) out.push(` ip ospf ${o.process.pid} area ${o.process.area}`);
    if (o?.network) out.push(` ip ospf network ${o.network}`);
    if (o?.cost) out.push(` ip ospf cost ${o.cost}`);
    if (o?.priority !== undefined) out.push(` ip ospf priority ${o.priority}`);
    if (o?.helloInterval) out.push(` ip ospf hello-interval ${o.helloInterval}`);
    if (o?.deadInterval) out.push(` ip ospf dead-interval ${o.deadInterval}`);
    if (i.dhcpRelayTrusted) out.push(' ip dhcp relay information trusted');
    if (i.hsrp) {
      if (i.hsrp.version === 2) out.push(' standby version 2');
      for (const g of i.hsrp.groups) {
        const n = g.group === 0 ? '' : ` ${g.group}`;
        out.push(` standby${n} ip${g.vip ? ` ${g.vip}` : ''}`);
        if (g.priority !== 100) out.push(` standby${n} priority ${g.priority}`);
        if (g.preempt) out.push(` standby${n} preempt`);
        for (const t of g.tracks) out.push(` standby${n} track ${t.iface}${t.decrement !== 10 ? ` ${t.decrement}` : ''}`);
      }
    }
    if (i.cdp === false) out.push(' no cdp enable');
    if (i.lldp?.transmit === false) out.push(' no lldp transmit');
    if (i.lldp?.receive === false) out.push(' no lldp receive');
    if (!i.adminUp) out.push(' shutdown');
    if (d instanceof Router && i.kind === 'physical') out.push(' duplex auto', ' speed auto');
    out.push('!');
  }
  if (d instanceof Router) for (const p of d.ospf.values()) out.push(...ospfConfig(p));
  if (d instanceof Switch && d.defaultGateway) out.push(`ip default-gateway ${d.defaultGateway}`);
  if (d instanceof Router) {
    const nat = d.nat;
    for (const pool of nat.pools.values()) out.push(`ip nat pool ${pool.name} ${pool.start} ${pool.end} netmask ${prefixToMask(pool.prefix)}`);
    for (const r of nat.rules) out.push(`ip nat inside source list ${r.acl} ${r.iface ? `interface ${r.iface}` : `pool ${r.pool}`}${r.overload ? ' overload' : ''}`);
    for (const st of nat.statics) out.push(`ip nat inside source static ${st.local} ${st.global}`);
  }
  for (const r of d.staticRoutes) {
    const via = [r.exitInterface, r.nextHop].filter(Boolean).join(' ');
    out.push(`ip route ${r.network} ${prefixToMask(r.prefix)} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
  }
  for (const r of d.ipv6.statics) out.push(ipv6RouteConfig(r));
  if (d instanceof Router) {
    for (const acl of d.acls.values()) {
      if (/^\d+$/.test(acl.name)) {
        out.push('!');
        for (const e of acl.entries) out.push(`access-list ${acl.name} ${formatAclEntry(e, acl.type, true)}`);
      } else {
        out.push('!', `ip access-list ${acl.type} ${acl.name}`);
        for (const e of acl.entries) out.push(` ${e.action === 'remark' ? '' : `${e.seq} `}${formatAclEntry(e, acl.type, true)}`);
      }
    }
  }
  if (ios) {
    const http = [
      ...(ios.http.server ? ['ip http server'] : []),
      ...(ios.http.authLocal ? ['ip http authentication local'] : []),
      ...(ios.http.secure ? ['ip http secure-server'] : []),
    ];
    if (http.length) out.push('!', ...http);
    const snmp = ios.snmp.config();
    if (snmp.length) out.push('!', ...snmp);
    if (ios.http.restconf) out.push('!', 'restconf');
  }
  out.push('!', ...(ios ? ios.mgmt.lineConfig() : ['line con 0', '!', 'line vty 0 4', ' login']), '!');
  const ntp = ios?.ntp.config().filter((l) => l.startsWith('ntp')) ?? [];
  if (ntp.length) out.push(...ntp, '!');
  out.push('end');
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
  // IOS prints IPv6 addresses in upper case.
  const show = (a: string) => (a.includes(':') ? a.toUpperCase() : a);
  const lines = ['Type escape sequence to abort.', `Tracing the route to ${show(t.destination)}`, 'VRF info: (vrf in name/id, vrf out name/id)'];
  for (const hop of t.hops) {
    let line = `${String(hop.ttl).padStart(3)}`;
    let last: string | undefined;
    for (const p of hop.probes) {
      if (!p.from) {
        line += ' *';
        continue;
      }
      if (p.from !== last) line += ` ${show(p.from)}`;
      last = p.from;
      line += p.unreachable ? ' !H' : ` ${p.rttMs} msec`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- show ip interface and logging

export function showIpInterface(i: Interface): string {
  const { status, protocol } = interfaceStatus(i);
  const lines = [`${i.name} is ${status}, line protocol is ${protocol}`];
  if (!i.ip) return [...lines, '  Internet protocol processing disabled'].join('\n');
  lines.push(`  Internet address is ${i.ip.address}/${i.ip.prefix}`, '  Broadcast address is 255.255.255.255');
  if (i.dhcpClient) lines.push('  Address determined by DHCP');
  else lines.push('  Address determined by non-volatile memory');
  lines.push('  MTU is 1500 bytes');
  if (i.helpers?.length) lines.push(`  Helper addresses are ${i.helpers.join(' ')}`);
  else lines.push('  Helper address is not set');
  lines.push(`  Outgoing Common access list is not set`, `  Outgoing access list is ${i.accessGroup?.out ?? 'not set'}`);
  lines.push(`  Inbound Common access list is not set`, `  Inbound  access list is ${i.accessGroup?.in ?? 'not set'}`);
  lines.push(`  Proxy ARP is enabled`);
  lines.push(`  IP NAT ${i.nat ? `${i.nat === 'inside' ? 'Inside' : 'Outside'} interface` : 'disabled'}`);
  return lines.join('\n');
}

export function showLogging(d: Device): string {
  return [
    'Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)',
    '',
    `    Console logging: level debugging, ${d.log.length} messages logged, xml disabled,`,
    '                     filtering disabled',
    `    Buffer logging:  level debugging, ${d.log.length} messages logged, xml disabled,`,
    '                    filtering disabled',
    '',
    'Log Buffer (8192 bytes):',
    '',
    ...d.log,
  ].join('\n');
}
