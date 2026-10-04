import { showSnmp, showSnmpGroup, showSnmpUser, type SnmpLevel, type TrapHost } from '../services/snmp';
import { EXEC, INVALID, abbrev, int, ip, requireIos, type Command, type Session } from './common';

/** The SNMP agent: communities, v3 groups and users, location and contact, and trap hosts. */

function agent(s: Session) {
  return requireIos(s).snmp;
}

function level(word: string | undefined): SnmpLevel {
  if (abbrev(word, 'noauth')) return 'noauth';
  if (abbrev(word, 'auth')) return 'auth';
  if (abbrev(word, 'priv')) return 'priv';
  throw new Error(INVALID);
}

/** `snmp-server community <name> [RO|RW] [acl]`. */
function community(s: Session, name: string, rest: string): void {
  const w = rest.split(/\s+/).filter(Boolean);
  let access: 'ro' | 'rw' = 'ro';
  if (w[0] && (abbrev(w[0], 'ro') || abbrev(w[0], 'rw'))) access = w.shift()!.toLowerCase().startsWith('rw') ? 'rw' : 'ro';
  if (w.length > 1) throw new Error(INVALID);
  agent(s).communities.set(name, { name, access, acl: w[0] });
}

/** `snmp-server group <name> v3 <level> [read <view>] [write <view>]`. */
function group(s: Session, name: string, lvl: string, rest: string): void {
  const w = rest.split(/\s+/).filter(Boolean);
  const g = { name, level: level(lvl), read: undefined as string | undefined, write: undefined as string | undefined };
  for (let k = 0; k < w.length; k += 2) {
    if (abbrev(w[k], 'read')) g.read = w[k + 1];
    else if (abbrev(w[k], 'write')) g.write = w[k + 1];
    else if (abbrev(w[k], 'access')) continue;
    else throw new Error(INVALID);
    if (!w[k + 1]) throw new Error(INVALID);
  }
  agent(s).groups.set(name, g);
}

/** `snmp-server user <name> <group> v3 [auth md5|sha <pw> [priv des|aes [128|192|256] <pw>]]`. */
function user(s: Session, name: string, groupName: string, rest: string): string | void {
  const a = agent(s);
  const w = rest.split(/\s+/).filter(Boolean);
  const u: Parameters<typeof a.users.set>[1] = { name, group: groupName };
  let k = 0;
  if (w[k] !== undefined) {
    if (!abbrev(w[k], 'auth')) throw new Error(INVALID);
    const alg = w[k + 1]?.toLowerCase();
    if (alg !== 'md5' && alg !== 'sha') throw new Error(INVALID);
    if (!w[k + 2]) throw new Error(INVALID);
    u.auth = { alg, password: w[k + 2]! };
    k += 3;
  }
  if (w[k] !== undefined) {
    if (!abbrev(w[k], 'priv')) throw new Error(INVALID);
    const alg = w[k + 1]?.toLowerCase();
    if (alg !== 'des' && alg !== 'aes') throw new Error(INVALID);
    k += 2;
    let bits: number | undefined;
    if (alg === 'aes') {
      bits = int(w[k], 128, 256);
      if (![128, 192, 256].includes(bits)) throw new Error(INVALID);
      k++;
    }
    if (!w[k]) throw new Error(INVALID);
    u.priv = { alg, bits, password: w[k]! };
    k++;
  }
  if (k < w.length) throw new Error(INVALID);
  a.users.set(name, u);
  if (!a.groups.has(groupName)) return `% Warning: group ${groupName} does not exist yet; the user cannot be used until it does.`;
}

/** `snmp-server host <ip> [traps] [version 1|2c|3 [noauth|auth|priv]] <community|user>`. */
function host(s: Session, address: string, rest: string): void {
  ip(address);
  const w = rest.split(/\s+/).filter(Boolean);
  let k = 0;
  if (abbrev(w[k], 'traps') || abbrev(w[k], 'informs')) k++;
  let version: TrapHost['version'] = '1';
  let lvl: SnmpLevel | undefined;
  if (abbrev(w[k], 'version')) {
    const v = w[k + 1];
    if (v !== '1' && v !== '2c' && v !== '3') throw new Error(INVALID);
    version = v;
    k += 2;
    if (version === '3') lvl = level(w[k++]);
  }
  const name = w[k];
  if (!name || k + 1 < w.length) throw new Error(INVALID);
  const hosts = agent(s).hosts;
  const existing = hosts.findIndex((h) => h.address === address);
  const entry: TrapHost = { address, version, level: lvl, name };
  if (existing >= 0) hosts[existing] = entry;
  else hosts.push(entry);
}

export const SNMP_COMMANDS: Command[] = [
  { syntax: 'snmp-server community <name>', modes: ['config'], help: 'Read-only community string (v1/v2c)', run: (s, [name]) => community(s, name!, '') },
  { syntax: 'snmp-server community <name> <access...>', modes: ['config'], help: 'RO|RW [acl]: community string and what it may do', run: (s, [name, rest]) => community(s, name!, rest!) },
  { syntax: 'no snmp-server community <name>', modes: ['config'], help: 'Delete a community', run: (s, [name]) => void agent(s).communities.delete(name!) },
  { syntax: 'snmp-server location <text...>', modes: ['config'], help: 'sysLocation', run: (s, [t]) => void (agent(s).location = t) },
  { syntax: 'no snmp-server location', modes: ['config'], help: 'Clear sysLocation', run: (s) => void (agent(s).location = undefined) },
  { syntax: 'snmp-server contact <text...>', modes: ['config'], help: 'sysContact', run: (s, [t]) => void (agent(s).contact = t) },
  { syntax: 'no snmp-server contact', modes: ['config'], help: 'Clear sysContact', run: (s) => void (agent(s).contact = undefined) },
  { syntax: 'snmp-server group <name> v3 <level>', modes: ['config'], help: 'SNMPv3 group: noauth | auth | priv', run: (s, [name, lvl]) => group(s, name!, lvl!, '') },
  { syntax: 'snmp-server group <name> v3 <level> <views...>', modes: ['config'], help: '[read <view>] [write <view>]', run: (s, [name, lvl, rest]) => group(s, name!, lvl!, rest!) },
  { syntax: 'no snmp-server group <name> v3', modes: ['config'], help: 'Delete a v3 group', run: (s, [name]) => void agent(s).groups.delete(name!) },
  { syntax: 'snmp-server user <name> <group> v3', modes: ['config'], help: 'SNMPv3 user without authentication', run: (s, [name, g]) => user(s, name!, g!, '') },
  { syntax: 'snmp-server user <name> <group> v3 <security...>', modes: ['config'], help: 'auth md5|sha <password> [priv des|aes 128 <password>]', run: (s, [name, g, rest]) => user(s, name!, g!, rest!) },
  { syntax: 'no snmp-server user <name> <group> v3', modes: ['config'], help: 'Delete a v3 user', run: (s, [name]) => void agent(s).users.delete(name!) },
  { syntax: 'snmp-server host <ip> <options...>', modes: ['config'], help: '[traps] [version 1|2c|3 noauth|auth|priv] <community|user>', run: (s, [addr, rest]) => host(s, addr!, rest!) },
  { syntax: 'no snmp-server host <ip>', modes: ['config'], help: 'Stop sending traps to this host', run: (s, [addr]) => {
    const hosts = agent(s).hosts;
    const k = hosts.findIndex((h) => h.address === addr);
    if (k >= 0) hosts.splice(k, 1);
  } },
  { syntax: 'no snmp-server host <ip> <options...>', modes: ['config'], help: 'Stop sending traps to this host', run: (s, [addr]) => {
    const hosts = agent(s).hosts;
    const k = hosts.findIndex((h) => h.address === addr);
    if (k >= 0) hosts.splice(k, 1);
  } },
  { syntax: 'snmp-server enable traps', modes: ['config'], help: 'Send traps (linkUp and linkDown) to the trap hosts', run: (s) => void (agent(s).trapsEnabled = true) },
  { syntax: 'snmp-server enable traps <types...>', modes: ['config'], help: 'snmp linkdown linkup ...', run: (s) => void (agent(s).trapsEnabled = true) },
  { syntax: 'no snmp-server enable traps', modes: ['config'], help: 'Stop sending traps', run: (s) => void (agent(s).trapsEnabled = false) },
  { syntax: 'no snmp-server', modes: ['config'], help: 'Turn the SNMP agent off and clear its settings', run: (s) => {
    const a = agent(s);
    a.communities.clear();
    a.groups.clear();
    a.users.clear();
    a.hosts.length = 0;
    a.trapsEnabled = false;
  } },
  { syntax: 'show snmp', modes: EXEC, help: 'SNMP agent counters', run: (s) => showSnmp(agent(s)) },
  { syntax: 'show snmp community', modes: EXEC, help: 'Communities and their access', run: (s) =>
    [...agent(s).communities.values()].map((c) => `\nCommunity name: ${c.name}\nCommunity Index: ${c.name}\nCommunity SecurityName: ${c.name}\nstorage-type: nonvolatile        active${c.acl ? `\naccess-list: ${c.acl}` : ''}\naccess: ${c.access === 'rw' ? 'read-write' : 'read-only'}`).join('\n') },
  { syntax: 'show snmp user', modes: EXEC, help: 'SNMPv3 users', run: (s) => showSnmpUser(agent(s)) },
  { syntax: 'show snmp group', modes: EXEC, help: 'SNMPv3 groups', run: (s) => showSnmpGroup(agent(s)) },
  { syntax: 'show snmp host', modes: EXEC, help: 'Where traps are sent', run: (s) =>
    agent(s).hosts.map((h) => `Notification host: ${h.address}\tudp-port: 162\ttype: trap\nuser: ${h.name}\tsecurity model: ${h.version === '3' ? `v3 ${h.level}` : h.version === '2c' ? 'v2c' : 'v1'}\n`).join('\n') },
];
