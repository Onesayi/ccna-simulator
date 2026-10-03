import { isValidIp, parsePrefix, networkAddress, prefixToMask } from '../core/addressing';
import type { Router } from '../devices/router';
import { numberedAclType, parseAclEntry, showAccessLists, type Acl } from '../services/acl';
import { showDhcpBinding, showDhcpPool } from '../services/dhcp';
import { showNatTranslations } from '../services/nat';
import { EXEC, IF_MODES, INVALID, abbrev, iface, int, ip, requireIp, requireRouter, type Command, type Session } from './common';

// ---------------------------------------------------------------- ACL helpers

function addEntry(acl: Acl, words: string[], seq?: number): void {
  const rules = acl.entries.filter((e) => e.action !== 'remark');
  const next = seq ?? (rules.length ? Math.max(...rules.map((e) => e.seq)) + 10 : 10);
  const entry = parseAclEntry(acl.type, words, next);
  // A remark takes no sequence number of its own; it sits above the entry that follows it.
  if (entry.action !== 'remark' && rules.some((e) => e.seq === next)) throw new Error('Duplicate sequence number');
  const same = acl.entries.find((e) => e.action !== 'remark' && JSON.stringify({ ...e, seq: 0, matches: 0 }) === JSON.stringify({ ...entry, seq: 0, matches: 0 }));
  if (same) return; // IOS ignores a duplicate entry
  acl.entries.push(entry);
  acl.entries.sort((a, b) => a.seq - b.seq || (a.action === 'remark' ? -1 : 0) - (b.action === 'remark' ? -1 : 0));
}

function numbered(r: Router, num: string): Acl {
  const type = numberedAclType(Number(num));
  let acl = r.acls.get(num);
  if (!acl) r.acls.set(num, (acl = { name: num, type, entries: [] }));
  return acl;
}

function aclType(word: string | undefined): Acl['type'] {
  if (abbrev(word, 'standard')) return 'standard';
  if (abbrev(word, 'extended')) return 'extended';
  throw new Error(INVALID);
}

function currentAcl(s: Session): Acl {
  return s.currentAcl!;
}

const ACL_MODES: Session['mode'][] = ['config-std-nacl', 'config-ext-nacl'];

// ---------------------------------------------------------------- NAT parsing

function natCommand(r: Router, rest: string, remove: boolean): string | void {
  const w = rest.split(/\s+/);
  const nat = r.nat;
  if (abbrev(w[0], 'pool')) {
    const [, name, start, end, kw, val] = w;
    if (!name) throw new Error(INVALID);
    if (remove) return void nat.pools.delete(name);
    ip(start);
    ip(end);
    let prefix: number;
    if (abbrev(kw, 'netmask')) prefix = parsePrefix(ip(val));
    else if (abbrev(kw, 'prefix-length')) prefix = int(val, 1, 32);
    else throw new Error(INVALID);
    if (networkAddress(start!, prefix) !== networkAddress(end!, prefix)) throw new Error(`End address not on same subnet as start address`);
    nat.pools.set(name, { name, start: start!, end: end!, prefix });
    return;
  }
  if (!abbrev(w[0], 'inside') || !abbrev(w[1], 'source')) throw new Error(INVALID);
  if (abbrev(w[2], 'static')) {
    const local = ip(w[3]);
    const global = ip(w[4]);
    const k = nat.statics.findIndex((st) => st.local === local);
    if (remove) {
      if (k >= 0) nat.statics.splice(k, 1);
      return;
    }
    if (k >= 0) throw new Error(`${local} already mapped (${local} -> ${nat.statics[k]!.global})`);
    nat.statics.push({ local, global });
    return;
  }
  if (!abbrev(w[2], 'list') || !w[3]) throw new Error(INVALID);
  const acl = w[3];
  let rule: { acl: string; pool?: string; iface?: string; overload: boolean };
  if (abbrev(w[4], 'interface')) {
    const name = r.iface(w[5] ?? '').name;
    if (!abbrev(w[6], 'overload')) throw new Error(INVALID);
    rule = { acl, iface: name, overload: true };
  } else if (abbrev(w[4], 'pool') && w[5]) {
    rule = { acl, pool: w[5], overload: abbrev(w[6], 'overload') };
    if (!remove && !nat.pools.has(w[5])) throw new Error(`Pool ${w[5]} does not exist`);
  } else throw new Error(INVALID);
  const k = nat.rules.findIndex((x) => x.acl === acl);
  if (k >= 0) nat.rules.splice(k, 1);
  if (!remove) nat.rules.push(rule);
}

function natStatistics(r: Router): string {
  const nat = r.nat;
  const table = nat.table();
  const extended = table.filter((e) => e.proto).length;
  const inside = r.interfaces.filter((i) => i.nat === 'inside').map((i) => i.name);
  const outside = r.interfaces.filter((i) => i.nat === 'outside').map((i) => i.name);
  const lines = [
    `Total active translations: ${table.length} (${nat.statics.length} static, ${table.length - nat.statics.length} dynamic; ${extended} extended)`,
    'Outside interfaces:',
    `  ${outside.join(', ')}`,
    'Inside interfaces:',
    `  ${inside.join(', ')}`,
    `Hits: ${nat.hits}  Misses: ${nat.misses}`,
    'Dynamic mappings:',
  ];
  for (const rule of nat.rules) {
    lines.push('-- Inside Source', `[Id: 1] access-list ${rule.acl} ${rule.iface ? `interface ${rule.iface}` : `pool ${rule.pool}`} refcount ${table.filter((e) => e.dynamic).length}`);
    const pool = rule.pool ? nat.pools.get(rule.pool) : undefined;
    if (pool) {
      const total = ipNum(pool.end) - ipNum(pool.start) + 1;
      const allocated = new Set(table.filter((e) => e.dynamic && ipNum(e.insideGlobal) >= ipNum(pool.start) && ipNum(e.insideGlobal) <= ipNum(pool.end)).map((e) => e.insideGlobal)).size;
      lines.push(` pool ${pool.name}: netmask ${prefixToMask(pool.prefix)}`, `\tstart ${pool.start} end ${pool.end}`, `\ttype generic, total addresses ${total}, allocated ${allocated} (${Math.round((allocated / total) * 100)}%), misses ${nat.misses}`);
    }
  }
  return lines.join('\n');
}

function ipNum(a: string): number {
  return a.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

// ---------------------------------------------------------------- telnet

function telnet(s: Session, dst: string, port: number): string {
  const d = requireIp(s);
  const result = d.connect(ip(dst), port);
  d.network?.run();
  const head = `Trying ${dst}${port !== 23 ? `, ${port}` : ''} ... `;
  switch (result.status) {
    case 'open':
      return `${head}Open\n\n${port === 23 ? 'Password required, but none set\n\n' : ''}[Connection to ${dst} closed by foreign host]`;
    case 'refused':
      return `${head}\n% Connection refused by remote host`;
    case 'unreachable':
    case 'no-route':
      return `${head}\n% Destination unreachable; gateway or host down`;
    default:
      return `${head}\n% Connection timed out; remote host not responding`;
  }
}

/** DHCP, NAT, ACLs and telnet. */
export const SERVICE_COMMANDS: Command[] = [
  // DHCP server
  { syntax: 'ip dhcp excluded-address <low>', modes: ['config'], help: 'Never lease this address', run: (s, [lo]) => void requireRouter(s).dhcpServer.excluded.push([ip(lo), lo!]) },
  { syntax: 'ip dhcp excluded-address <low> <high>', modes: ['config'], help: 'Never lease addresses in this range', run: (s, [lo, hi]) => {
    if (ipNum(ip(hi)) < ipNum(ip(lo))) throw new Error(INVALID);
    requireRouter(s).dhcpServer.excluded.push([lo!, hi!]);
  } },
  { syntax: 'no ip dhcp excluded-address <low...>', modes: ['config'], help: 'Remove an excluded range', run: (s, [range]) => {
    const [lo, hi = lo] = range!.split(/\s+/);
    const ex = requireRouter(s).dhcpServer.excluded;
    const k = ex.findIndex(([a, b]) => a === lo && b === hi);
    if (k >= 0) ex.splice(k, 1);
  } },
  { syntax: 'ip dhcp pool <name>', modes: ['config', 'dhcp-config'], help: 'Create or edit a DHCP pool', run: (s, [name]) => {
    const server = requireRouter(s).dhcpServer;
    let pool = server.pools.get(name!);
    if (!pool) server.pools.set(name!, (pool = { name: name!, leaseDays: 1 }));
    s.currentPool = pool;
    s.mode = 'dhcp-config';
  } },
  { syntax: 'no ip dhcp pool <name>', modes: ['config'], help: 'Delete a DHCP pool', run: (s, [name]) => void requireRouter(s).dhcpServer.pools.delete(name!) },
  { syntax: 'network <ip> <mask>', modes: ['dhcp-config'], help: 'Subnet this pool leases from', run: (s, [net, mask]) => {
    const prefix = parsePrefix(mask!);
    s.currentPool!.network = networkAddress(ip(net), prefix);
    s.currentPool!.prefix = prefix;
  } },
  { syntax: 'default-router <ip>', modes: ['dhcp-config'], help: 'Default gateway handed to clients', run: (s, [gw]) => void (s.currentPool!.defaultRouter = ip(gw)) },
  { syntax: 'no default-router', modes: ['dhcp-config'], help: 'Remove the default gateway', run: (s) => void (s.currentPool!.defaultRouter = undefined) },
  { syntax: 'dns-server <ip>', modes: ['dhcp-config'], help: 'DNS server handed to clients', run: (s, [dns]) => void (s.currentPool!.dns = ip(dns)) },
  { syntax: 'domain-name <name>', modes: ['dhcp-config'], help: 'DNS domain handed to clients', run: (s, [name]) => void (s.currentPool!.domain = name) },
  { syntax: 'lease <days>', modes: ['dhcp-config'], help: 'Lease time in days', run: (s, [days]) => void (s.currentPool!.leaseDays = int(days, 0, 365)) },
  { syntax: 'show ip dhcp binding', modes: EXEC, help: 'Addresses leased by this DHCP server', run: (s) => showDhcpBinding(requireRouter(s).dhcpServer) },
  { syntax: 'show ip dhcp pool', modes: EXEC, help: 'DHCP pools and their usage', run: (s) => showDhcpPool(requireRouter(s).dhcpServer) },
  { syntax: 'clear ip dhcp binding <which>', modes: ['privileged'], help: '* | <address>', run: (s, [which]) => {
    const b = requireRouter(s).dhcpServer.bindings;
    if (which === '*') b.clear();
    else b.delete(ip(which));
  } },

  // DHCP relay and client
  { syntax: 'ip helper-address <ip>', modes: IF_MODES, help: 'Relay DHCP broadcasts to this server', run: (s, [addr]) => {
    requireRouter(s);
    const i = iface(s);
    i.helpers = [...new Set([...(i.helpers ?? []), ip(addr)])];
  } },
  { syntax: 'no ip helper-address', modes: IF_MODES, help: 'Stop relaying', run: (s) => void (iface(s).helpers = undefined) },
  { syntax: 'no ip helper-address <ip>', modes: IF_MODES, help: 'Stop relaying to this server', run: (s, [addr]) => {
    const i = iface(s);
    i.helpers = i.helpers?.filter((h) => h !== addr);
    if (!i.helpers?.length) i.helpers = undefined;
  } },
  { syntax: 'ip address dhcp', modes: IF_MODES, help: 'Get this interface address from a DHCP server', run: (s) => requireRouter(s).enableDhcpClient(iface(s)) },

  // NAT
  { syntax: 'ip nat <side>', modes: IF_MODES, help: 'inside | outside', run: (s, [side]) => {
    requireRouter(s);
    if (abbrev(side, 'inside')) iface(s).nat = 'inside';
    else if (abbrev(side, 'outside')) iface(s).nat = 'outside';
    else throw new Error(INVALID);
  } },
  { syntax: 'no ip nat <side>', modes: IF_MODES, help: 'Remove the NAT role', run: (s) => void (iface(s).nat = undefined) },
  { syntax: 'ip nat <rest...>', modes: ['config'], help: 'inside source static|list ... | pool <name> <start> <end> netmask <mask>', run: (s, [rest]) => natCommand(requireRouter(s), rest!, false) },
  { syntax: 'no ip nat <rest...>', modes: ['config'], help: 'Remove a NAT rule or pool', run: (s, [rest]) => natCommand(requireRouter(s), rest!, true) },
  { syntax: 'show ip nat translations', modes: EXEC, help: 'NAT translation table', run: (s) => showNatTranslations(requireRouter(s).nat) },
  { syntax: 'show ip nat statistics', modes: EXEC, help: 'NAT counters and pools', run: (s) => natStatistics(requireRouter(s)) },
  { syntax: 'clear ip nat translation <which>', modes: ['privileged'], help: 'Clear dynamic translations (*)', run: (s, [which]) => {
    if (which !== '*') throw new Error(INVALID);
    requireRouter(s).nat.clearDynamic();
  } },

  // ACLs
  { syntax: 'access-list <number> <entry...>', modes: ['config'], help: 'Numbered ACL entry: permit|deny|remark ...', run: (s, [num, rest]) => addEntry(numbered(requireRouter(s), num!), rest!.split(/\s+/)) },
  { syntax: 'no access-list <number>', modes: ['config'], help: 'Delete a numbered ACL', run: (s, [num]) => void requireRouter(s).acls.delete(num!) },
  // The classic trap: on a numbered ACL, "no access-list 10 deny ..." deletes the whole list.
  { syntax: 'no access-list <number> <entry...>', modes: ['config'], help: 'Delete a numbered ACL (all of it)', run: (s, [num]) => void requireRouter(s).acls.delete(num!) },
  { syntax: 'ip access-list <type> <name>', modes: ['config', 'config-std-nacl', 'config-ext-nacl'], help: 'standard | extended <name or number>', run: (s, [t, name]) => {
    const r = requireRouter(s);
    const type = aclType(t);
    if (/^\d+$/.test(name!) && numberedAclType(Number(name)) !== type) throw new Error(INVALID);
    let acl = r.acls.get(name!);
    if (acl && acl.type !== type) throw new Error(`A named ${acl.type} IP access list with this name already exists`);
    if (!acl) r.acls.set(name!, (acl = { name: name!, type, entries: [] }));
    s.currentAcl = acl;
    s.mode = type === 'standard' ? 'config-std-nacl' : 'config-ext-nacl';
  } },
  { syntax: 'no ip access-list <type> <name>', modes: ['config'], help: 'Delete a named ACL', run: (s, [, name]) => void requireRouter(s).acls.delete(name!) },
  { syntax: 'permit <entry...>', modes: ACL_MODES, help: 'Add a permit entry', run: (s, [rest]) => addEntry(currentAcl(s), ['permit', ...rest!.split(/\s+/)]) },
  { syntax: 'deny <entry...>', modes: ACL_MODES, help: 'Add a deny entry', run: (s, [rest]) => addEntry(currentAcl(s), ['deny', ...rest!.split(/\s+/)]) },
  { syntax: 'remark <text...>', modes: ACL_MODES, help: 'Add a comment', run: (s, [text]) => addEntry(currentAcl(s), ['remark', ...text!.split(/\s+/)]) },
  { syntax: '<seq> <entry...>', modes: ACL_MODES, help: 'Insert an entry at a sequence number', run: (s, [seq, rest]) => addEntry(currentAcl(s), rest!.split(/\s+/), int(seq, 1, 2147483647)) },
  { syntax: 'no <entry...>', modes: ACL_MODES, help: '<seq> | <entry>: delete an entry', run: (s, [rest]) => {
    const acl = currentAcl(s);
    if (/^\d+$/.test(rest!)) {
      acl.entries = acl.entries.filter((e) => e.seq !== Number(rest));
      return;
    }
    const target = parseAclEntry(acl.type, rest!.split(/\s+/), 0);
    const key = (e: object) => JSON.stringify({ ...e, seq: 0, matches: 0 });
    acl.entries = acl.entries.filter((e) => key(e) !== key(target));
  } },
  { syntax: 'ip access-group <acl> <direction>', modes: IF_MODES, help: 'Filter packets in | out with an ACL', run: (s, [name, dir]) => {
    requireRouter(s);
    const i = iface(s);
    const d = abbrev(dir, 'in') ? 'in' : abbrev(dir, 'out') ? 'out' : undefined;
    if (!d) throw new Error(INVALID);
    i.accessGroup = { ...i.accessGroup, [d]: name };
  } },
  { syntax: 'no ip access-group <acl> <direction>', modes: IF_MODES, help: 'Remove the ACL from this interface', run: (s, [, dir]) => {
    const i = iface(s);
    const d = abbrev(dir, 'in') ? 'in' : 'out';
    if (i.accessGroup) delete i.accessGroup[d];
  } },
  { syntax: 'show access-lists', modes: EXEC, help: 'Every ACL with match counters', run: (s) => showAccessLists(requireRouter(s).acls.values()) },
  { syntax: 'show access-lists <name>', modes: EXEC, help: 'One ACL', run: (s, [name]) => showAccessLists([...requireRouter(s).acls.values()].filter((a) => a.name === name)) },
  { syntax: 'show ip access-lists', modes: EXEC, help: 'Every IP ACL with match counters', run: (s) => showAccessLists(requireRouter(s).acls.values()) },
  { syntax: 'clear access-list counters', modes: ['privileged'], help: 'Reset ACL match counters', run: (s) => {
    for (const acl of requireRouter(s).acls.values()) for (const e of acl.entries) e.matches = 0;
  } },

  // Telnet as a reachability test for TCP (and extended ACLs)
  { syntax: 'telnet <ip>', modes: EXEC, help: 'Open a telnet connection', run: (s, [dst]) => telnet(s, dst!, 23) },
  { syntax: 'telnet <ip> <port>', modes: EXEC, help: 'Open a TCP connection to a port', run: (s, [dst, port]) => {
    if (!isValidIp(dst!)) throw new Error(INVALID);
    return telnet(s, dst!, int(port, 1, 65535));
  } },
];
