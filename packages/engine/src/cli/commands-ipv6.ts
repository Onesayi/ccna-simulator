import { compareIpv6, iosIpv6, ipv6Network, isLinkLocal, isValidIpv6, normaliseIpv6, parseIpv6Prefix } from '../core/ipv6';
import { shortName, type Interface } from '../devices/device';
import type { IpDevice } from '../devices/ip-device';
import type { Router } from '../devices/router';
import type { Ipv6Route, Ipv6StaticRoute } from '../ipv6/stack';
import { interfaceStatus } from './show';
import { EXEC, IF_MODES, INVALID, iface, requireIp, requireRouter, type Command, type Session } from './common';

/** IPv6 addressing, static routing and show commands for routers. */

function v6iface(s: Session): { r: Router; i: Interface } {
  const r = requireRouter(s);
  const i = iface(s);
  if (i.kind === 'subinterface' && i.encapVlan === undefined) throw new Error('Configure encapsulation on the sub-interface first.');
  return { r, i };
}

/** Parses `ipv6 route <prefix/len> [interface] [next-hop] [distance]`. */
function parseV6Route(r: IpDevice, prefixText: string, rest: string): Ipv6StaticRoute {
  const { address, prefix } = parseIpv6Prefix(prefixText);
  if (ipv6Network(address, prefix) !== address) throw new Error(INVALID);
  let exitInterface: string | undefined;
  let nextHop: string | undefined;
  let ad = 1;
  for (const w of rest.split(/\s+/)) {
    if (w.includes(':') && isValidIpv6(w)) nextHop = normaliseIpv6(w);
    else if (/^\d+$/.test(w)) ad = Number(w);
    else exitInterface = r.iface(w).name;
  }
  if (!nextHop && !exitInterface) throw new Error(INVALID);
  if (ad < 1 || ad > 254) throw new Error('Invalid distance');
  return { network: address, prefix, nextHop, exitInterface, ad };
}

export const IPV6_COMMANDS: Command[] = [
  { syntax: 'ipv6 unicast-routing', modes: ['config'], help: 'Forward IPv6 and send router advertisements', run: (s) => void (requireRouter(s).ipv6Routing = true) },
  { syntax: 'no ipv6 unicast-routing', modes: ['config'], help: 'Stop routing IPv6', run: (s) => void (requireRouter(s).ipv6Routing = false) },
  { syntax: 'ipv6 route <prefix> <via...>', modes: ['config'], help: 'Static route: exit interface and/or next hop [distance]', run: (s, [prefix, rest]) => {
    const r = requireRouter(s);
    r.ipv6.addStatic(parseV6Route(r, prefix!, rest!));
  } },
  { syntax: 'no ipv6 route <prefix> <via...>', modes: ['config'], help: 'Remove a static route', run: (s, [prefix, rest]) => {
    const r = requireRouter(s);
    r.ipv6.removeStatic(parseV6Route(r, prefix!, rest!));
  } },

  { syntax: 'ipv6 address <prefix>', modes: IF_MODES, help: 'Global address, as X:X:X:X::X/<0-128>', run: (s, [text]) => {
    const { r, i } = v6iface(s);
    if (text && abbrevAutoconfig(text)) throw new Error('Use a static address on router interfaces in this simulator');
    const { address, prefix } = parseIpv6Prefix(text!);
    if (isLinkLocal(address)) throw new Error('Use "ipv6 address <address> link-local" for a link-local address');
    r.ipv6.addAddress(i, address, prefix);
  } },
  { syntax: 'ipv6 address <prefix> eui-64', modes: IF_MODES, help: 'Global address with an EUI-64 interface ID', run: (s, [text]) => {
    const { r, i } = v6iface(s);
    const { address, prefix } = parseIpv6Prefix(text!);
    r.ipv6.addAddress(i, address, prefix, true);
  } },
  { syntax: 'ipv6 address <address> link-local', modes: IF_MODES, help: 'Set the link-local address (FE80::/10)', run: (s, [text]) => {
    const { i } = v6iface(s);
    if (!text || !isValidIpv6(text) || !isLinkLocal(normaliseIpv6(text))) throw new Error('Invalid link-local address');
    (i.ipv6 ??= { enabled: false, addresses: [] }).linkLocal = normaliseIpv6(text);
  } },
  { syntax: 'ipv6 enable', modes: IF_MODES, help: 'Link-local address only', run: (s) => {
    const { i } = v6iface(s);
    (i.ipv6 ??= { enabled: false, addresses: [] }).enabled = true;
  } },
  { syntax: 'no ipv6 enable', modes: IF_MODES, help: 'Remove ipv6 enable', run: (s) => {
    const { i } = v6iface(s);
    if (i.ipv6) i.ipv6.enabled = false;
  } },
  { syntax: 'no ipv6 address', modes: IF_MODES, help: 'Remove every IPv6 address', run: (s) => {
    const { i } = v6iface(s);
    if (i.ipv6) Object.assign(i.ipv6, { addresses: [], linkLocal: undefined });
  } },
  { syntax: 'no ipv6 address <prefix...>', modes: IF_MODES, help: 'Remove one IPv6 address', run: (s, [text]) => {
    const { i } = v6iface(s);
    const [addr = ''] = text!.split(/\s+/);
    if (/link-local/i.test(text!)) {
      if (i.ipv6) i.ipv6.linkLocal = undefined;
      return;
    }
    const { address, prefix } = parseIpv6Prefix(addr);
    if (!i.ipv6) return;
    const eui = /eui/i.test(text!);
    i.ipv6.addresses = i.ipv6.addresses.filter((a) =>
      eui ? !(a.eui64 && a.prefix === prefix && ipv6Network(a.address, prefix) === ipv6Network(address, prefix)) : !(a.address === address && a.prefix === prefix),
    );
  } },

  { syntax: 'show ipv6 interface <name...>', modes: EXEC, help: 'brief | <interface>: IPv6 addresses and groups', run: (s, [name]) => {
    const d = requireIp(s);
    if (name && 'brief'.startsWith(name.toLowerCase())) return showIpv6IntBrief(d);
    return showIpv6Interface(d, d.iface(name!));
  } },
  { syntax: 'show ipv6 route', modes: EXEC, help: 'IPv6 routing table', run: (s) => showIpv6Route(requireIp(s)) },
  { syntax: 'show ipv6 route <filter>', modes: EXEC, help: 'connected | static | local', run: (s, [f]) => {
    const codes: Record<string, string[]> = { connected: ['C'], static: ['S'], local: ['L'] };
    const key = Object.keys(codes).find((k) => k.startsWith(f!.toLowerCase()));
    if (!key) throw new Error(INVALID);
    return showIpv6Route(requireIp(s), codes[key]);
  } },
  { syntax: 'show ipv6 neighbors', modes: EXEC, help: 'IPv6 neighbor cache (the ARP of IPv6)', run: (s) => showIpv6Neighbors(requireIp(s)) },
];

function abbrevAutoconfig(text: string): boolean {
  return text.length > 1 && 'autoconfig'.startsWith(text.toLowerCase());
}

// ---------------------------------------------------------------- show output

export function showIpv6IntBrief(d: IpDevice): string {
  const lines: string[] = [];
  for (const i of d.interfaces) {
    if (i.kind === 'svi' || i.kind === 'port-channel') continue;
    const { status, protocol } = interfaceStatus(i);
    lines.push(`${i.name.padEnd(23)}[${status}/${protocol}]`);
    if (!d.ipv6.enabled(i)) lines.push('    unassigned');
    else for (const a of [d.ipv6.linkLocal(i), ...d.ipv6.globals(i).map((g) => g.address)]) lines.push(`    ${iosIpv6(a)}`);
  }
  return lines.join('\n');
}

export function showIpv6Interface(d: IpDevice, i: Interface): string {
  const { status, protocol } = interfaceStatus(i);
  const lines = [`${i.name} is ${status}, line protocol is ${protocol}`];
  if (!d.ipv6.enabled(i)) return [...lines, '  IPv6 is disabled'].join('\n');
  const stalled = !i.isUp ? ' [TEN]' : '';
  lines.push(`  IPv6 is enabled, link-local address is ${iosIpv6(d.ipv6.linkLocal(i))}${stalled}`, '  No Virtual link-local address(es):');
  const globals = d.ipv6.globals(i);
  if (globals.length) {
    lines.push('  Global unicast address(es):');
    for (const a of globals) {
      const tag = a.eui64 ? ' [EUI]' : a.slaac ? ' [EUI/CAL/PRE]' : '';
      lines.push(`    ${iosIpv6(a.address)}, subnet is ${iosIpv6(ipv6Network(a.address, a.prefix))}/${a.prefix}${tag}`);
    }
  }
  lines.push('  Joined group address(es):', ...d.ipv6.groups(i).map((g) => `    ${iosIpv6(g)}`));
  lines.push('  MTU is 1500 bytes', '  ICMP error messages limited to one every 100 milliseconds', '  ND DAD is enabled, number of DAD attempts: 1', '  ND reachable time is 30000 milliseconds (using 30000)');
  return lines.join('\n');
}

const V6_CODES = `IPv6 Routing Table - default - {n} entries
Codes: C - Connected, L - Local, S - Static, U - Per-user Static route
       B - BGP, R - RIP, H - NHRP, I1 - ISIS L1
       I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary, D - EIGRP
       EX - EIGRP external, ND - ND Default, NDp - ND Prefix, DCE - Destination
       NDr - Redirect, O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1
       OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2
       a - Application`;

function v6RouteLines(r: Ipv6Route): string[] {
  const head = `${r.code.padEnd(4)}${iosIpv6(r.network)}/${r.prefix} [${r.ad}/${r.metric}]`;
  if (r.code === 'C') return [head, `     via ${r.iface!.name}, directly connected`];
  if (r.code === 'L') return [head, `     via ${r.iface!.name}, receive`];
  if (r.nextHop && r.iface) return [head, `     via ${iosIpv6(r.nextHop)}, ${r.iface.name}`];
  if (r.nextHop) return [head, `     via ${iosIpv6(r.nextHop)}`];
  return [head, `     via ${r.iface!.name}, directly connected`];
}

export function showIpv6Route(d: IpDevice, codes?: string[]): string {
  const all = d.ipv6.routingTable();
  const table = (codes ? all.filter((r) => codes.includes(r.code)) : all).sort((a, b) => compareIpv6(a.network, b.network) || a.prefix - b.prefix);
  const lines = table.flatMap(v6RouteLines);
  // IOS always lists the multicast range as a local route once IPv6 is on.
  if (!codes || codes.includes('L')) lines.push('L   FF00::/8 [0/0]', '     via Null0, receive');
  return [V6_CODES.replace('{n}', String(table.length + 1)), ...lines].join('\n');
}

export function showIpv6Neighbors(d: IpDevice): string {
  const now = d.network?.scheduler.now ?? 0;
  const rows = [...d.ipv6.neighbors]
    .sort((a, b) => compareIpv6(a.address, b.address))
    .map((n) => `${iosIpv6(n.address).padEnd(42)}${String(Math.floor((now - n.learnedAt) / 60_000)).padStart(3)} ${n.mac}  REACH ${shortName(n.iface.name)}`);
  return ['IPv6 Address                              Age Link-layer Addr State Interface', ...rows].join('\n');
}

/** Running-config lines for an interface's IPv6 settings. */
export function ipv6InterfaceConfig(i: Interface): string[] {
  const v6 = i.ipv6;
  if (!v6) return [];
  const out: string[] = [];
  if (v6.linkLocal) out.push(` ipv6 address ${iosIpv6(v6.linkLocal)} link-local`);
  for (const a of v6.addresses) {
    if (a.slaac) continue;
    out.push(a.eui64 ? ` ipv6 address ${iosIpv6(ipv6Network(a.address, a.prefix))}/${a.prefix} eui-64` : ` ipv6 address ${iosIpv6(a.address)}/${a.prefix}`);
  }
  if (v6.enabled) out.push(' ipv6 enable');
  return out;
}

export function ipv6RouteConfig(r: Ipv6StaticRoute): string {
  const via = [r.exitInterface, r.nextHop && iosIpv6(r.nextHop)].filter(Boolean).join(' ');
  return `ipv6 route ${iosIpv6(r.network)}/${r.prefix} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`;
}
