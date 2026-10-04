import type { SnmpMessage, SnmpVarbind } from '../core/frames';

/**
 * SNMP: an agent on routers and switches (v1, v2c communities and v3 users, a small MIB-II, and
 * linkUp/linkDown traps), plus the name table and value formatting the manager tools share.
 */

export type SnmpLevel = 'noauth' | 'auth' | 'priv';
export type WireLevel = NonNullable<SnmpMessage['level']>;

export interface SnmpCommunity {
  name: string;
  access: 'ro' | 'rw';
  /** A standard ACL (name or number) that limits which managers may use the community. */
  acl?: string;
}

export interface SnmpGroup {
  name: string;
  level: SnmpLevel;
  read?: string;
  write?: string;
}

export interface SnmpUser {
  name: string;
  group: string;
  auth?: { alg: 'md5' | 'sha'; password: string };
  priv?: { alg: 'des' | 'aes'; bits?: number; password: string };
}

export interface TrapHost {
  address: string;
  version: '1' | '2c' | '3';
  level?: SnmpLevel;
  /** The community (v1, v2c) or user (v3) the traps are sent with. */
  name: string;
}

/** One object the agent can read, and set if `set` is given. */
export interface MibEntry {
  oid: string;
  type: NonNullable<SnmpVarbind['type']>;
  value: string | number;
  /** Applies a set. Returns an error status, or undefined on success. */
  set?: (v: string | number) => SnmpMessage['error'] | undefined;
}

// ---------------------------------------------------------------- OIDs and names

const MIB2 = '1.3.6.1.2.1';

/** Object names the manager tools accept and print, with their MIB module. */
export const SNMP_NAMES: [name: string, oid: string, module: string][] = [
  ['system', `${MIB2}.1`, 'SNMPv2-MIB'],
  ['sysDescr', `${MIB2}.1.1`, 'SNMPv2-MIB'],
  ['sysObjectID', `${MIB2}.1.2`, 'SNMPv2-MIB'],
  ['sysUpTime', `${MIB2}.1.3`, 'DISMAN-EVENT-MIB'],
  ['sysContact', `${MIB2}.1.4`, 'SNMPv2-MIB'],
  ['sysName', `${MIB2}.1.5`, 'SNMPv2-MIB'],
  ['sysLocation', `${MIB2}.1.6`, 'SNMPv2-MIB'],
  ['sysServices', `${MIB2}.1.7`, 'SNMPv2-MIB'],
  ['interfaces', `${MIB2}.2`, 'IF-MIB'],
  ['ifNumber', `${MIB2}.2.1`, 'IF-MIB'],
  ['ifTable', `${MIB2}.2.2`, 'IF-MIB'],
  ['ifEntry', `${MIB2}.2.2.1`, 'IF-MIB'],
  ['ifIndex', `${MIB2}.2.2.1.1`, 'IF-MIB'],
  ['ifDescr', `${MIB2}.2.2.1.2`, 'IF-MIB'],
  ['ifType', `${MIB2}.2.2.1.3`, 'IF-MIB'],
  ['ifMtu', `${MIB2}.2.2.1.4`, 'IF-MIB'],
  ['ifSpeed', `${MIB2}.2.2.1.5`, 'IF-MIB'],
  ['ifPhysAddress', `${MIB2}.2.2.1.6`, 'IF-MIB'],
  ['ifAdminStatus', `${MIB2}.2.2.1.7`, 'IF-MIB'],
  ['ifOperStatus', `${MIB2}.2.2.1.8`, 'IF-MIB'],
  ['ifInUcastPkts', `${MIB2}.2.2.1.11`, 'IF-MIB'],
  ['ifOutUcastPkts', `${MIB2}.2.2.1.17`, 'IF-MIB'],
  ['ip', `${MIB2}.4`, 'IP-MIB'],
  ['ipAddrTable', `${MIB2}.4.20`, 'IP-MIB'],
  ['ipAddrEntry', `${MIB2}.4.20.1`, 'IP-MIB'],
  ['ipAdEntAddr', `${MIB2}.4.20.1.1`, 'IP-MIB'],
  ['ipAdEntIfIndex', `${MIB2}.4.20.1.2`, 'IP-MIB'],
  ['ipAdEntNetMask', `${MIB2}.4.20.1.3`, 'IP-MIB'],
  ['ifXTable', `${MIB2}.31.1.1`, 'IF-MIB'],
  ['ifName', `${MIB2}.31.1.1.1.1`, 'IF-MIB'],
  ['ifAlias', `${MIB2}.31.1.1.1.18`, 'IF-MIB'],
  ['snmpTrapOID', '1.3.6.1.6.3.1.1.4.1', 'SNMPv2-MIB'],
  ['coldStart', '1.3.6.1.6.3.1.1.5.1', 'SNMPv2-MIB'],
  ['linkDown', '1.3.6.1.6.3.1.1.5.3', 'IF-MIB'],
  ['linkUp', '1.3.6.1.6.3.1.1.5.4', 'IF-MIB'],
];

/** The walk starts at `.1.3.6.1.2.1` (mib-2) when no OID is given, like Net-SNMP. */
export const MIB2_ROOT = MIB2;

/**
 * Resolves what a user types to a numeric OID: `1.3.6.1.2.1.1.5.0`, `.1.3.6...`, `sysName.0`,
 * `SNMPv2-MIB::sysName.0`, `iso.3.6.1...`. Returns undefined for unknown names.
 */
export function resolveOid(text: string): string | undefined {
  let t = text.trim().replace(/^\./, '').replace(/^iso\./, '1.');
  t = t.replace(/^[\w-]+::/, '');
  if (/^\d+(\.\d+)*$/.test(t)) return t;
  const m = /^([A-Za-z]\w*)((?:\.\d+)*)$/.exec(t);
  if (!m) return undefined;
  const hit = SNMP_NAMES.find(([n]) => n.toLowerCase() === m[1]!.toLowerCase());
  return hit ? `${hit[1]}${m[2]}` : undefined;
}

/** Net-SNMP style: the longest known prefix as `MODULE::name`, then the remaining index. */
export function translateOid(oid: string): string {
  if (oid === `${MIB2}.1.3.0`) return 'DISMAN-EVENT-MIB::sysUpTimeInstance';
  let best: (typeof SNMP_NAMES)[number] | undefined;
  for (const entry of SNMP_NAMES) {
    if ((oid === entry[1] || oid.startsWith(`${entry[1]}.`)) && (!best || entry[1].length > best[1].length)) best = entry;
  }
  if (!best) return oid.startsWith('1.3.6.1.4.1.') ? `SNMPv2-SMI::enterprises.${oid.slice(12)}` : `iso.${oid.slice(2)}`;
  return `${best[2]}::${best[0]}${oid.slice(best[1].length)}`;
}

export function compareOid(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    if (x[k] === undefined) return -1;
    if (y[k] === undefined) return 1;
    if (x[k] !== y[k]) return x[k]! - y[k]!;
  }
  return 0;
}

const IF_STATUS: Record<number, string> = { 1: 'up', 2: 'down', 3: 'testing' };
const IF_TYPES: Record<number, string> = { 6: 'ethernetCsmacd', 24: 'softwareLoopback', 53: 'propVirtual', 135: 'l2vlan', 161: 'ieee8023adLag' };

/** A varbind as `snmpget` prints it: `SNMPv2-MIB::sysName.0 = STRING: R1`. */
export function formatVarbind(v: SnmpVarbind): string {
  const name = translateOid(v.oid);
  if (v.type === 'noSuchObject') return `${name} = No Such Object available on this agent at this OID`;
  if (v.type === 'endOfMibView') return `${name} = No more variables left in this MIB View (It is past the end of the MIB tree)`;
  let value = String(v.value);
  if (v.type === 'INTEGER' && /ifAdminStatus|ifOperStatus/.test(name)) value = `${IF_STATUS[Number(v.value)] ?? 'unknown'}(${v.value})`;
  else if (v.type === 'INTEGER' && /ifType/.test(name)) value = `${IF_TYPES[Number(v.value)] ?? 'other'}(${v.value})`;
  else if (v.type === 'Timeticks') value = `(${v.value}) ${timeticks(Number(v.value))}`;
  else if (v.type === 'OID') value = translateOid(String(v.value));
  return `${name} = ${v.type}: ${value}`;
}

function timeticks(t: number): string {
  const s = Math.floor(t / 100);
  const days = Math.floor(s / 86400);
  const hh = Math.floor(s / 3600) % 24;
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const cs = String(t % 100).padStart(2, '0');
  return `${days ? `${days} day${days > 1 ? 's' : ''}, ` : ''}${hh}:${mm}:${ss}.${cs}`;
}

// ---------------------------------------------------------------- the agent

const LEVEL_RANK: Record<WireLevel, number> = { noAuthNoPriv: 0, authNoPriv: 1, authPriv: 2 };
const GROUP_RANK: Record<SnmpLevel, number> = { noauth: 0, auth: 1, priv: 2 };

export interface SnmpAgentHooks {
  /** The MIB as it is right now, sorted by OID. */
  mib(): MibEntry[];
  /** Standard ACL check for a community's ACL. Undefined when the ACL does not exist (no filtering). */
  aclPermits(acl: string, src: string): boolean | undefined;
}

export class SnmpAgent {
  readonly communities = new Map<string, SnmpCommunity>();
  readonly groups = new Map<string, SnmpGroup>();
  readonly users = new Map<string, SnmpUser>();
  readonly hosts: TrapHost[] = [];
  location?: string;
  contact?: string;
  /** `snmp-server enable traps`: send linkUp and linkDown to the trap hosts. */
  trapsEnabled = false;
  readonly stats = { inPkts: 0, outPkts: 0, badCommunity: 0, unknownUser: 0, wrongDigest: 0, traps: 0 };

  constructor(private readonly hooks: SnmpAgentHooks) {}

  /** The agent answers only once a community or user exists. */
  get enabled(): boolean {
    return this.communities.size > 0 || this.users.size > 0;
  }

  /** Answers a request from `src`, or returns undefined to drop it (bad community, ACL, wrong privacy key). */
  handle(msg: SnmpMessage, src: string): SnmpMessage | undefined {
    if (!this.enabled || msg.pdu === 'response' || msg.pdu === 'trap' || msg.pdu === 'report') return undefined;
    this.stats.inPkts++;
    const reply = (fields: Partial<SnmpMessage>): SnmpMessage => {
      this.stats.outPkts++;
      return { version: msg.version, community: msg.community, user: msg.user, level: msg.level, authKey: msg.authKey, privKey: msg.privKey, requestId: msg.requestId, pdu: 'response', varbinds: msg.varbinds, error: 'noError', ...fields };
    };
    let canWrite: boolean;
    if (msg.version === '3') {
      const u = msg.user !== undefined ? this.users.get(msg.user) : undefined;
      if (!u) {
        this.stats.unknownUser++;
        return reply({ pdu: 'report', report: 'unknownUserName', varbinds: [] });
      }
      const g = this.groups.get(u.group);
      const level = msg.level ?? 'noAuthNoPriv';
      const userRank = u.priv ? 2 : u.auth ? 1 : 0;
      if (!g || LEVEL_RANK[level] < GROUP_RANK[g.level] || LEVEL_RANK[level] > userRank) return reply({ pdu: 'report', report: 'unsupportedSecLevel', varbinds: [] });
      if (LEVEL_RANK[level] >= 1 && u.auth?.password !== msg.authKey) {
        this.stats.wrongDigest++;
        return reply({ pdu: 'report', report: 'wrongDigest', varbinds: [] });
      }
      // A wrong privacy key cannot decrypt the PDU, so the agent cannot even answer.
      if (LEVEL_RANK[level] === 2 && u.priv?.password !== msg.privKey) return undefined;
      canWrite = g.write !== undefined;
    } else {
      const c = msg.community !== undefined ? this.communities.get(msg.community) : undefined;
      if (!c) {
        this.stats.badCommunity++;
        return undefined;
      }
      if (c.acl && this.hooks.aclPermits(c.acl, src) === false) return undefined;
      canWrite = c.access === 'rw';
    }

    const mib = this.hooks.mib();
    if (msg.pdu === 'get') {
      const varbinds = msg.varbinds.map((v): SnmpVarbind => {
        const e = mib.find((x) => x.oid === v.oid);
        return e ? { oid: e.oid, type: e.type, value: e.value } : { oid: v.oid, type: 'noSuchObject' };
      });
      if (msg.version === '1' && varbinds.some((v) => v.type === 'noSuchObject')) return reply({ error: 'noSuchName' });
      return reply({ varbinds });
    }
    if (msg.pdu === 'getnext') {
      const varbinds = msg.varbinds.map((v): SnmpVarbind => {
        const e = mib.find((x) => compareOid(x.oid, v.oid) > 0);
        return e ? { oid: e.oid, type: e.type, value: e.value } : { oid: v.oid, type: 'endOfMibView' };
      });
      return reply({ varbinds });
    }
    // set
    if (!canWrite) return reply({ error: 'noAccess' });
    for (const v of msg.varbinds) {
      const e = mib.find((x) => x.oid === v.oid);
      if (!e?.set) return reply({ error: 'notWritable' });
      const err = e.set(v.value ?? '');
      if (err) return reply({ error: err });
    }
    return reply({});
  }

  /** The keys a v3 user signs and encrypts with, for traps. */
  userKeys(name: string): { level: WireLevel; authKey?: string; privKey?: string } | undefined {
    const u = this.users.get(name);
    if (!u) return undefined;
    return { level: u.priv ? 'authPriv' : u.auth ? 'authNoPriv' : 'noAuthNoPriv', authKey: u.auth?.password, privKey: u.priv?.password };
  }

  config(): string[] {
    const out: string[] = [];
    for (const g of this.groups.values()) out.push(`snmp-server group ${g.name} v3 ${g.level}${g.read ? ` read ${g.read}` : ''}${g.write ? ` write ${g.write}` : ''}`);
    for (const c of this.communities.values()) out.push(`snmp-server community ${c.name} ${c.access.toUpperCase()}${c.acl ? ` ${c.acl}` : ''}`);
    if (this.location) out.push(`snmp-server location ${this.location}`);
    if (this.contact) out.push(`snmp-server contact ${this.contact}`);
    if (this.trapsEnabled) out.push('snmp-server enable traps snmp linkdown linkup');
    for (const h of this.hosts) out.push(`snmp-server host ${h.address} version ${h.version}${h.version === '3' ? ` ${h.level ?? 'noauth'}` : ''} ${h.name}`);
    return out;
  }
}

/** `snmp-server user` lines are not shown in the running configuration, as on IOS. */
export function showSnmpUser(agent: SnmpAgent): string {
  if (!agent.users.size) return '';
  return [...agent.users.values()]
    .map((u) =>
      [
        '',
        `User name: ${u.name}`,
        'Engine ID: 800000090300AABBCC000100',
        'storage-type: nonvolatile        active',
        `Authentication Protocol: ${u.auth ? u.auth.alg.toUpperCase() : 'None'}`,
        `Privacy Protocol: ${u.priv ? (u.priv.alg === 'aes' ? `AES${u.priv.bits ?? 128}` : 'DES') : 'None'}`,
        `Group-name: ${u.group}`,
      ].join('\n'),
    )
    .join('\n');
}

export function showSnmpGroup(agent: SnmpAgent): string {
  return [...agent.groups.values()]
    .map((g) =>
      [`groupname: ${g.name}                             security model:v3 ${g.level}`, `readview : ${g.read ?? 'v1default'}                        writeview: ${g.write ?? '<no writeview specified>'}`, 'notifyview: <no notifyview specified>', 'row status: active', ''].join('\n'),
    )
    .join('\n');
}

export function showSnmp(agent: SnmpAgent): string {
  if (!agent.enabled) return '%SNMP agent not enabled';
  const s = agent.stats;
  return [
    `Chassis: ${'FTX1234ABCD'}`,
    ...(agent.contact ? [`Contact: ${agent.contact}`] : []),
    ...(agent.location ? [`Location: ${agent.location}`] : []),
    `${s.inPkts} SNMP packets input`,
    `    0 Bad SNMP version errors`,
    `    ${s.badCommunity} Unknown community name`,
    `    0 Illegal operation for community name supplied`,
    `${s.outPkts} SNMP packets output`,
    `    ${s.traps} Trap PDUs`,
    'SNMP logging: ' + (agent.hosts.length ? 'enabled' : 'disabled'),
    ...agent.hosts.map((h) => `    Logging to ${h.address}.162, 0/10, ${s.traps} sent, 0 dropped.`),
  ].join('\n');
}
