import { intToIp, ipToInt, isValidIp, type Ipv4Address } from '../core/addressing';
import type { IpPacket } from '../core/frames';

/** An address with wildcard bits: `any` is 0.0.0.0 255.255.255.255, `host x` is x 0.0.0.0. */
export interface AddressMatch {
  address: Ipv4Address;
  wildcard: Ipv4Address;
}

export interface PortMatch {
  op: 'eq' | 'neq' | 'lt' | 'gt' | 'range';
  ports: number[];
}

export type AclProtocol = 'ip' | 'icmp' | 'tcp' | 'udp' | 'ospf';

export interface AclEntry {
  seq: number;
  action: 'permit' | 'deny' | 'remark';
  remark?: string;
  protocol: AclProtocol;
  src: AddressMatch;
  srcPort?: PortMatch;
  dst?: AddressMatch;
  dstPort?: PortMatch;
  icmpType?: string;
  /** TCP `established`: matches everything but the opening SYN. */
  established?: boolean;
  log?: boolean;
  matches: number;
}

export interface Acl {
  /** A number ("10", "100") or a name. */
  name: string;
  type: 'standard' | 'extended';
  entries: AclEntry[];
}

export const ANY: AddressMatch = { address: '0.0.0.0', wildcard: '255.255.255.255' };

/** Well-known ports by the keyword IOS accepts and prints. */
export const PORT_NAMES: Record<string, number> = {
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  bootps: 67,
  bootpc: 68,
  tftp: 69,
  www: 80,
  pop3: 110,
  ntp: 123,
  snmp: 161,
  syslog: 514,
};
const PORT_ALIASES: Record<string, number> = { http: 80, https: 443 };
const ICMP_TYPES = ['echo', 'echo-reply', 'unreachable', 'time-exceeded'];
const ICMP_TYPE_OF: Record<string, string> = { 'echo-request': 'echo', 'echo-reply': 'echo-reply', unreachable: 'unreachable', 'time-exceeded': 'time-exceeded' };
// IOS numbers (only for display): which ports are shown by name.
const SHOWN_BY_NAME = new Set(['ftp', 'telnet', 'smtp', 'domain', 'bootps', 'bootpc', 'tftp', 'www', 'pop3', 'ntp', 'snmp', 'syslog']);

/** Standard ACLs are numbered 1-99 and 1300-1999; extended 100-199 and 2000-2699. */
export function numberedAclType(n: number): 'standard' | 'extended' {
  if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard';
  if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended';
  throw new Error(`Invalid access list number ${n}`);
}

class Words {
  i = 0;
  constructor(private readonly words: string[]) {}
  peek(): string | undefined {
    return this.words[this.i]?.toLowerCase();
  }
  next(): string {
    const w = this.words[this.i++];
    if (w === undefined) throw new Error('Incomplete command.');
    return w;
  }
  get done(): boolean {
    return this.i >= this.words.length;
  }
}

function parseAddress(w: Words, standard: boolean): AddressMatch {
  const first = w.next().toLowerCase();
  if (first === 'any') return ANY;
  if (first === 'host') {
    const host = w.next();
    if (!isValidIp(host)) throw new Error(`Invalid input detected at '^' marker.`);
    return { address: host, wildcard: '0.0.0.0' };
  }
  if (!isValidIp(first)) throw new Error(`Invalid input detected at '^' marker.`);
  const next = w.peek();
  // A standard ACL takes a bare address as a host; an extended one always needs the wildcard.
  const wildcard = next && isValidIp(next) ? w.next() : standard ? '0.0.0.0' : undefined;
  if (!wildcard) throw new Error('Incomplete command.');
  // IOS clears address bits covered by the wildcard: 192.168.1.5 0.0.0.255 becomes 192.168.1.0.
  const address = intToIp(ipToInt(first) & ~ipToInt(wildcard));
  return { address, wildcard };
}

function parsePort(word: string): number {
  const lower = word.toLowerCase();
  const n = PORT_NAMES[lower] ?? PORT_ALIASES[lower] ?? Number(word);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port ${word}`);
  return n;
}

function parsePortMatch(w: Words): PortMatch | undefined {
  const op = w.peek();
  if (op !== 'eq' && op !== 'neq' && op !== 'lt' && op !== 'gt' && op !== 'range') return undefined;
  w.next();
  const ports = [parsePort(w.next())];
  if (op === 'range') ports.push(parsePort(w.next()));
  return { op, ports };
}

/**
 * Parses the part of an ACL line after the sequence number: `permit 10.0.0.0 0.0.0.255`,
 * `deny tcp any host 10.1.1.1 eq www`, `remark Block guests`.
 */
export function parseAclEntry(type: Acl['type'], words: string[], seq: number): AclEntry {
  const w = new Words(words);
  const action = w.next().toLowerCase();
  if (action === 'remark') return { seq, action: 'remark', remark: words.slice(1).join(' '), protocol: 'ip', src: ANY, matches: 0 };
  if (action !== 'permit' && action !== 'deny') throw new Error(`Invalid input detected at '^' marker.`);
  if (type === 'standard') {
    const src = parseAddress(w, true);
    const log = w.peek() === 'log' ? (w.next(), true) : undefined;
    if (!w.done) throw new Error(`Invalid input detected at '^' marker.`);
    return { seq, action, protocol: 'ip', src, log, matches: 0 };
  }
  const protocol = w.next().toLowerCase();
  if (!['ip', 'icmp', 'tcp', 'udp', 'ospf'].includes(protocol)) throw new Error(`Invalid input detected at '^' marker.`);
  const ported = protocol === 'tcp' || protocol === 'udp';
  const entry: AclEntry = { seq, action, protocol: protocol as AclProtocol, src: parseAddress(w, false), matches: 0 };
  if (ported) entry.srcPort = parsePortMatch(w);
  entry.dst = parseAddress(w, false);
  if (ported) entry.dstPort = parsePortMatch(w);
  while (!w.done) {
    const k = w.next().toLowerCase();
    if (k === 'log') entry.log = true;
    else if (k === 'established' && protocol === 'tcp') entry.established = true;
    else if (protocol === 'icmp' && ICMP_TYPES.includes(k) && !entry.icmpType) entry.icmpType = k;
    else throw new Error(`Invalid input detected at '^' marker.`);
  }
  return entry;
}

function addressMatches(m: AddressMatch, ip: Ipv4Address): boolean {
  const care = ~ipToInt(m.wildcard) >>> 0;
  return ((ipToInt(ip) & care) >>> 0) === ((ipToInt(m.address) & care) >>> 0);
}

function portMatches(m: PortMatch | undefined, port: number | undefined): boolean {
  if (!m) return true;
  if (port === undefined) return false;
  const [a = 0, b = 0] = m.ports;
  switch (m.op) {
    case 'eq':
      return port === a;
    case 'neq':
      return port !== a;
    case 'lt':
      return port < a;
    case 'gt':
      return port > a;
    case 'range':
      return port >= a && port <= b;
  }
}

function entryMatches(e: AclEntry, p: IpPacket): boolean {
  if (!addressMatches(e.src, p.src)) return false;
  if (!e.dst) return true; // standard: source only
  if (!addressMatches(e.dst, p.dst)) return false;
  if (e.protocol !== 'ip' && e.protocol !== p.kind) return false;
  if (p.kind === 'tcp' || p.kind === 'udp') {
    if (!portMatches(e.srcPort, p.srcPort) || !portMatches(e.dstPort, p.dstPort)) return false;
    if (e.established && p.kind === 'tcp' && p.flags === 'syn') return false;
  } else if (e.srcPort || e.dstPort || e.established) {
    return false;
  }
  if (e.icmpType && (p.kind !== 'icmp' || ICMP_TYPE_OF[p.type] !== e.icmpType)) return false;
  return true;
}

/** Top-down, first match wins, with the implicit `deny any` at the end. Counts matches like IOS. */
export function evaluateAcl(acl: Acl, p: IpPacket): 'permit' | 'deny' {
  for (const e of acl.entries) {
    if (e.action === 'remark' || !entryMatches(e, p)) continue;
    e.matches++;
    return e.action;
  }
  return 'deny';
}

function formatAddress(m: AddressMatch, standard: boolean): string {
  if (m.wildcard === '255.255.255.255') return 'any';
  if (m.wildcard === '0.0.0.0') return standard ? m.address : `host ${m.address}`;
  return standard ? `${m.address}, wildcard bits ${m.wildcard}` : `${m.address} ${m.wildcard}`;
}

function formatPort(n: number): string {
  const name = Object.entries(PORT_NAMES).find(([k, v]) => v === n && SHOWN_BY_NAME.has(k));
  return name ? name[0] : String(n);
}

function formatPortMatch(m: PortMatch | undefined): string {
  return m ? ` ${m.op} ${m.ports.map(formatPort).join(' ')}` : '';
}

/** The entry as `show access-lists` prints it (without the sequence number). */
export function formatAclEntry(e: AclEntry, type: Acl['type'], forConfig = false): string {
  if (e.action === 'remark') return `remark ${e.remark}`;
  const standard = type === 'standard';
  const src = forConfig && standard && e.src.wildcard !== '0.0.0.0' && e.src.wildcard !== '255.255.255.255' ? `${e.src.address} ${e.src.wildcard}` : formatAddress(e.src, standard);
  const action = standard && !forConfig ? e.action.padEnd(6) : e.action;
  if (standard) return `${action} ${src}${e.log ? ' log' : ''}`;
  const parts = [action, e.protocol, formatAddress(e.src, false) + formatPortMatch(e.srcPort), formatAddress(e.dst!, false) + formatPortMatch(e.dstPort)];
  if (e.icmpType) parts.push(e.icmpType);
  if (e.established) parts.push('established');
  if (e.log) parts.push('log');
  return parts.join(' ');
}

export function showAccessLists(acls: Iterable<Acl>): string {
  const out: string[] = [];
  for (const acl of acls) {
    out.push(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`);
    for (const e of acl.entries) {
      if (e.action === 'remark') continue;
      out.push(`    ${e.seq} ${formatAclEntry(e, acl.type)}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''}`);
    }
  }
  return out.join('\n');
}
