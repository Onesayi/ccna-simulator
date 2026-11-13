import { isValidIp, type Ipv4Address } from '../core/addressing';
import type { DnsMessage, DnsRecord, DnsType } from '../core/frames';
import { isValidIpv6, normaliseIpv6 } from '../core/ipv6';

export const DNS_PORT = 53;
export const DNS_TYPES: DnsType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA'];
const DEFAULT_TTL = 3600;

/** Lower case, without a trailing dot. */
export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/** The in-addr.arpa name a reverse (PTR) lookup asks for: 192.168.1.10 becomes 10.1.168.192.in-addr.arpa. */
export function reverseName(ip: Ipv4Address): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

/** The address behind an in-addr.arpa name, if it is one. */
export function addressFromReverse(name: string): Ipv4Address | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\.in-addr\.arpa$/.exec(canonicalName(name));
  if (!m) return undefined;
  const ip = [m[4], m[3], m[2], m[1]].join('.');
  return isValidIp(ip) ? ip : undefined;
}

// ---------------------------------------------------------------- zone files

export interface ZoneProblem {
  line?: number;
  message: string;
  /** Fatal problems stop the zone from loading; warnings are only reported. */
  fatal: boolean;
}

export interface Zone {
  origin: string;
  file: string;
  records: DnsRecord[];
  problems: ZoneProblem[];
  /** True when the zone loaded (no fatal problems): the server answers for it. */
  loaded: boolean;
  serial?: number;
}

/** A file the DNS server reads as a zone: `<zone>.zone` or BIND's `db.<zone>`. Returns the zone name. */
export function zoneNameFromFile(file: string): string | undefined {
  const base = file.split('/').pop()!;
  if (base.endsWith('.zone') && base.length > 5) return canonicalName(base.slice(0, -5));
  if (base.startsWith('db.') && base.length > 3) return canonicalName(base.slice(3));
  return undefined;
}

/** Turns a name as written in a zone file into an absolute one. Without a trailing dot, the origin is appended. */
function qualify(name: string, origin: string): string {
  if (name === '@') return origin;
  if (name.endsWith('.')) return canonicalName(name);
  return canonicalName(`${name}.${origin}`);
}

/**
 * Parses a BIND master file: `$ORIGIN`, `$TTL`, `@`, relative names, blank owner fields (the
 * previous owner), an optional TTL and class, and SOA records split over lines with parentheses.
 * Names written without a trailing dot get the origin appended, just like BIND, which is where the
 * classic "www.example.com.example.com" mistake comes from.
 */
export function parseZone(text: string, zone: string, file = `${zone}.zone`): Zone {
  let origin = canonicalName(zone);
  let ttl = DEFAULT_TTL;
  let owner: string | undefined;
  const records: DnsRecord[] = [];
  const problems: ZoneProblem[] = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    let line = stripComment(lines[n]!);
    // An open parenthesis continues the record until the closing one (SOA timers).
    if (line.includes('(') && !line.includes(')')) {
      while (n + 1 < lines.length && !line.includes(')')) line += ' ' + stripComment(lines[++n]!);
    }
    line = line.replace(/[()]/g, ' ');
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const words = line.trim().split(/\s+/);
    const problem = (message: string, fatal = true) => problems.push({ line: lineNo, message, fatal });
    if (words[0]!.startsWith('$')) {
      const directive = words[0]!.toUpperCase();
      if (directive === '$ORIGIN' && words[1]) origin = qualify(words[1], origin);
      else if (directive === '$TTL' && /^\d+$/.test(words[1] ?? '')) ttl = Number(words[1]);
      else problem(`unknown $ directive '${words[0]}'`);
      continue;
    }
    if (!indented) owner = qualify(words.shift()!, origin);
    if (!owner) {
      problem('no current owner name');
      continue;
    }
    let recordTtl = ttl;
    if (/^\d+$/.test(words[0] ?? '')) recordTtl = Number(words.shift());
    if (words[0]?.toUpperCase() === 'IN') words.shift();
    if (/^\d+$/.test(words[0] ?? '')) recordTtl = Number(words.shift());
    const type = words.shift()?.toUpperCase();
    if (!type || !(DNS_TYPES as string[]).includes(type)) {
      problem(`unknown RR type '${type ?? ''}'`);
      continue;
    }
    const record = parseRdata(type as DnsType, words, owner, origin, recordTtl, problem);
    if (record) records.push(record);
  }
  return finishZone(origin, file, records, problems);
}

function stripComment(line: string): string {
  const at = line.indexOf(';');
  return at < 0 ? line : line.slice(0, at);
}

function parseRdata(type: DnsType, words: string[], name: string, origin: string, ttl: number, problem: (m: string) => void): DnsRecord | undefined {
  const [first, second] = words;
  if (!first) return void problem(`unexpected end of input`);
  switch (type) {
    case 'A':
      if (!isValidIp(first)) return void problem(`bad dotted quad`);
      return { name, type, ttl, data: first };
    case 'AAAA':
      if (!isValidIpv6(first)) return void problem(`bad IPv6 address`);
      return { name, type, ttl, data: normaliseIpv6(first) };
    case 'MX':
      if (!/^\d+$/.test(first) || !second) return void problem(`MX needs a preference and a mail exchanger`);
      return { name, type, ttl, preference: Number(first), data: qualify(second, origin) };
    case 'SOA': {
      const serial = Number(words[2]);
      if (!second || !Number.isInteger(serial)) return void problem(`SOA needs a primary server, a mailbox and a serial number`);
      return { name, type, ttl, data: qualify(first, origin), rname: qualify(second, origin), serial };
    }
    default:
      return { name, type, ttl, data: qualify(first, origin) };
  }
}

/** The checks `named-checkzone` makes once the records are read. */
function finishZone(origin: string, file: string, records: DnsRecord[], problems: ZoneProblem[]): Zone {
  const soa = records.filter((r) => r.type === 'SOA');
  if (!soa.some((r) => r.name === origin)) problems.push({ message: 'has no SOA record', fatal: true });
  if (!records.some((r) => r.type === 'NS' && r.name === origin)) problems.push({ message: 'has no NS records', fatal: true });
  const inZone = (name: string) => name === origin || name.endsWith(`.${origin}`);
  for (const r of records) {
    if (!inZone(r.name)) problems.push({ message: `${r.name}: ignoring out-of-zone data`, fatal: false });
  }
  const own = records.filter((r) => inZone(r.name));
  const hasAddress = (name: string) => own.some((r) => r.name === name && (r.type === 'A' || r.type === 'AAAA'));
  for (const r of own) {
    if (r.type === 'CNAME' && own.some((o) => o.name === r.name && o !== r)) {
      problems.push({ message: `${r.name}: CNAME and other data`, fatal: true });
    }
    // Targets inside the zone must exist; BIND rejects a zone whose in-zone NS has no address.
    if ((r.type === 'NS' || r.type === 'MX') && inZone(r.data) && !hasAddress(r.data)) {
      const cname = own.some((o) => o.name === r.data && o.type === 'CNAME');
      const what = cname ? 'is a CNAME (illegal)' : 'has no address records (A or AAAA)';
      problems.push({ message: `${r.name}/${r.type} '${r.data}' ${what}`, fatal: r.type === 'NS' });
    }
  }
  const loaded = !problems.some((p) => p.fatal);
  return { origin, file, records: own, problems, loaded, serial: soa[0]?.serial };
}

/** `named-checkzone` output for one zone. */
export function checkZoneReport(zone: Zone): string {
  const head = `zone ${zone.origin}/IN`;
  const lines = zone.problems.map((p) => (p.line !== undefined ? `${zone.file}:${p.line}: ${p.message}` : `${head}: ${p.message}`));
  if (zone.loaded) lines.push(`${head}: loaded serial ${zone.serial ?? 0}`, 'OK');
  else lines.push(`${head}: not loaded due to errors.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- authoritative answers

/**
 * The authoritative side of a DNS server: the zones it loaded, and how it answers one question.
 * A CNAME is followed inside the server's own zones, as BIND does; anything outside them is refused
 * (no recursion).
 */
export class ZoneSet {
  constructor(readonly zones: Zone[]) {}

  zoneFor(name: string): Zone | undefined {
    const n = canonicalName(name);
    return this.zones
      .filter((z) => n === z.origin || n.endsWith(`.${z.origin}`))
      .sort((a, b) => b.origin.length - a.origin.length)[0];
  }

  answer(query: DnsMessage): DnsMessage {
    const reply: DnsMessage = { id: query.id, response: true, name: query.name, qtype: query.qtype, rd: query.rd, ra: false, aa: true, rcode: 'NOERROR', answers: [], authority: [], additional: [] };
    let name = canonicalName(query.name);
    const first = this.zoneFor(name);
    if (!first) return { ...reply, aa: false, rcode: 'REFUSED' };
    if (!first.loaded) return { ...reply, aa: false, rcode: 'SERVFAIL' };
    for (let hops = 0; hops < 8; hops++) {
      const zone = this.zoneFor(name);
      if (!zone?.loaded) break;
      const owned = zone.records.filter((r) => r.name === name);
      const matches = owned.filter((r) => r.type === query.qtype);
      if (matches.length) {
        reply.answers!.push(...matches);
        break;
      }
      const cname = owned.find((r) => r.type === 'CNAME');
      if (cname) {
        reply.answers!.push(cname);
        name = cname.data;
        continue;
      }
      const soa = zone.records.filter((r) => r.type === 'SOA');
      reply.authority = soa;
      // NXDOMAIN only when the name exists nowhere, not even as the parent of other names.
      const exists = owned.length > 0 || zone.records.some((r) => r.name.endsWith(`.${name}`));
      if (!exists) reply.rcode = 'NXDOMAIN';
      break;
    }
    // Additional section: addresses for the mail exchangers and name servers we answered with.
    for (const r of reply.answers!) {
      if (r.type !== 'MX' && r.type !== 'NS') continue;
      const zone = this.zoneFor(r.data);
      if (zone?.loaded) reply.additional!.push(...zone.records.filter((a) => a.name === r.data && (a.type === 'A' || a.type === 'AAAA')));
    }
    return reply;
  }
}

/** Loads every zone file a server holds. */
export function loadZones(files: ReadonlyMap<string, string>): Zone[] {
  const zones: Zone[] = [];
  for (const [file, text] of files) {
    const name = zoneNameFromFile(file);
    if (name) zones.push(parseZone(text, name, file));
  }
  return zones;
}

// ---------------------------------------------------------------- the IOS resolver

export interface HostEntry {
  /** As typed, for `show hosts` and the running config. */
  name: string;
  addresses: string[];
  /** `ip host` entries are permanent; names learned from DNS are temporary (the cache). */
  perm: boolean;
}

/**
 * IOS name resolution settings: `ip domain lookup` (on by default), `ip name-server`, the
 * `ip host` table and the cache, and `ip dns server`.
 */
export class IosDnsConfig {
  lookup = true;
  readonly nameServers: Ipv4Address[] = [];
  /** Static `ip host` entries and cached DNS answers, by lower-case name. */
  readonly hosts = new Map<string, HostEntry>();
  /** `ip dns server`: answer queries from the host table, forwarding the rest to our name servers. */
  server = false;

  host(name: string): HostEntry | undefined {
    return this.hosts.get(canonicalName(name));
  }

  /** `clear host`: drops cached names (static entries stay). */
  clearCache(name?: string): void {
    for (const [key, e] of this.hosts) if (!e.perm && (name === undefined || name === '*' || key === canonicalName(name))) this.hosts.delete(key);
  }

  /** Running-config lines (the domain name is printed with the SSH settings). */
  config(): string[] {
    const out: string[] = [];
    if (!this.lookup) out.push('no ip domain lookup');
    for (const e of this.hosts.values()) if (e.perm) out.push(`ip host ${e.name} ${e.addresses.join(' ')}`);
    if (this.nameServers.length) out.push(`ip name-server ${this.nameServers.join(' ')}`);
    if (this.server) out.push('ip dns server');
    return out;
  }

  /** `show hosts`. */
  show(domainName: string | undefined): string {
    const lines = [
      domainName ? `Default domain is ${domainName}` : 'Default domain is not set',
      `Name/address lookup uses ${this.lookup ? 'domain service' : 'static mappings'}`,
      `Name servers are ${this.nameServers.length ? this.nameServers.join(', ') : '255.255.255.255'}`,
      '',
      'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
      '       temp - temporary, perm - permanent',
      '       NA - Not Applicable None - Not defined',
      '',
      'Host                      Port  Flags      Age Type   Address(es)',
    ];
    for (const e of this.hosts.values()) {
      lines.push(`${e.name.padEnd(26)}None  (${e.perm ? 'perm' : 'temp'}, OK)  0   IP    ${e.addresses.join('\n' + ' '.repeat(58))}`);
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- nslookup formatting

/** One record the way Windows `nslookup -type=...` prints it. */
export function formatRecord(r: DnsRecord): string {
  const name = r.name.padEnd(15);
  switch (r.type) {
    case 'A':
    case 'AAAA':
      return `${name} ${r.type === 'A' ? 'internet address' : 'AAAA IPv6 address'} = ${r.data}`;
    case 'CNAME':
      return `${name} canonical name = ${r.data}`;
    case 'MX':
      return `${name} MX preference = ${r.preference}, mail exchanger = ${r.data}`;
    case 'NS':
      return `${name} nameserver = ${r.data}`;
    case 'PTR':
      return `${name} name = ${r.data}`;
    case 'SOA':
      return soaBlock(r);
  }
}

/** Windows prints the zone's SOA when a name has no records of the type asked for. */
export function soaBlock(r: DnsRecord): string {
  return [r.name, `        primary name server = ${r.data}`, `        responsible mail addr = ${r.rname}`, `        serial  = ${r.serial}`].join('\n');
}

export const RCODE_TEXT: Record<string, string> = {
  NXDOMAIN: 'Non-existent domain',
  SERVFAIL: 'Server failed',
  REFUSED: 'Query refused',
};
