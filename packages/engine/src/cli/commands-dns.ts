import { isValidIp } from '../core/addressing';
import { IosDevice } from '../devices/ios-device';
import { canonicalName } from '../services/dns';
import { EXEC, INVALID, ip, requireIos, type Command, type Session } from './common';

/** DNS on IOS: name lookup for EXEC commands, the host table, name servers and `ip dns server`. */

export const UNRECOGNIZED_HOST = '% Unrecognized host or address, or protocol not running.';
export const UNKNOWN_COMMAND = '% Unknown command or computer name, or unable to find computer address';

const MAX_NAME_SERVERS = 6;
const MAX_HOST_ADDRESSES = 8;

/** A name ready to use, with the "Translating..." line IOS printed on the way, or the error to print instead. */
export type Resolved = { address: string; name?: string; banner: string } | { error: string };

/**
 * Turns a host argument into an IPv4 address the way IOS does. Static and cached names resolve
 * silently; anything else prints `Translating "name"...domain server (x)` while the device asks.
 */
export function resolveHost(s: Session, host: string, failure = UNRECOGNIZED_HOST): Resolved {
  if (isValidIp(host)) return { address: host, banner: '' };
  const d = s.device;
  if (!(d instanceof IosDevice)) return { error: failure };
  const r = d.resolveHost(host);
  const asked = r.servers.length ? `...domain server (${r.servers.join(') (')})` : '';
  const banner = r.lookupOff || r.servers.length ? `Translating "${host}"${asked}` : '';
  if (r.address) return { address: r.address, name: host, banner: banner ? `${banner} [OK]\n` : '' };
  return { error: [banner, failure].filter(Boolean).join('\n') };
}

/**
 * A single word that is no command is taken as a host to telnet to, as on IOS: hence the pause and
 * "Translating..." after a typo, and why labs turn `ip domain lookup` off.
 */
export function unknownWord(s: Session, word: string, telnet: (s: Session, dst: string, port: number, name?: string) => string): string {
  const r = resolveHost(s, word, UNKNOWN_COMMAND);
  if ('error' in r) return r.error;
  return r.banner + telnet(s, r.address, 23, r.name);
}

function hostName(name: string | undefined): string {
  // IOS host names start with a letter and are not addresses.
  if (!name || !/^[a-z]/i.test(name) || isValidIp(name)) throw new Error(INVALID);
  return name;
}

function addresses(list: string): string[] {
  const out = list.split(/\s+/).map((a) => ip(a));
  if (!out.length) throw new Error(INVALID);
  return out;
}

function setLookup(s: Session, on: boolean): void {
  requireIos(s).dns.lookup = on;
}

export const DNS_COMMANDS: Command[] = [
  { syntax: 'ip domain lookup', modes: ['config'], help: 'Enable DNS name lookup (on by default)', run: (s) => setLookup(s, true) },
  { syntax: 'ip domain-lookup', modes: ['config'], help: 'Enable DNS name lookup (on by default)', run: (s) => setLookup(s, true) },
  { syntax: 'no ip domain lookup', modes: ['config'], help: 'Stop typos being looked up as host names', run: (s) => setLookup(s, false) },
  { syntax: 'no ip domain-lookup', modes: ['config'], help: 'Stop typos being looked up as host names', run: (s) => setLookup(s, false) },
  { syntax: 'ip name-server <servers...>', modes: ['config'], help: 'DNS servers to ask (up to 6)', run: (s, [list]) => {
    const dns = requireIos(s).dns;
    for (const a of addresses(list!)) {
      if (dns.nameServers.includes(a)) continue;
      if (dns.nameServers.length >= MAX_NAME_SERVERS) throw new Error('Name server table full');
      dns.nameServers.push(a);
    }
  } },
  { syntax: 'no ip name-server', modes: ['config'], help: 'Remove every name server', run: (s) => void requireIos(s).dns.nameServers.splice(0) },
  { syntax: 'no ip name-server <servers...>', modes: ['config'], help: 'Remove these name servers', run: (s, [list]) => {
    const dns = requireIos(s).dns;
    for (const a of addresses(list!)) {
      const at = dns.nameServers.indexOf(a);
      if (at >= 0) dns.nameServers.splice(at, 1);
    }
  } },
  { syntax: 'ip host <name> <addresses...>', modes: ['config'], help: 'Static name-to-address mapping (up to 8 addresses)', run: (s, [name, list]) => {
    const n = hostName(name);
    const a = addresses(list!);
    if (a.length > MAX_HOST_ADDRESSES) throw new Error(INVALID);
    requireIos(s).dns.hosts.set(canonicalName(n), { name: n, addresses: a, perm: true });
  } },
  { syntax: 'no ip host <name...>', modes: ['config'], help: 'Remove a static host entry', run: (s, [rest]) => {
    const name = rest!.split(/\s+/)[0]!;
    requireIos(s).dns.hosts.delete(canonicalName(name));
  } },
  { syntax: 'ip dns server', modes: ['config'], help: 'Answer DNS queries from the host table, forwarding the rest', run: (s) => void (requireIos(s).dns.server = true) },
  { syntax: 'no ip dns server', modes: ['config'], help: 'Stop answering DNS queries', run: (s) => void (requireIos(s).dns.server = false) },
  { syntax: 'show hosts', modes: EXEC, help: 'Name lookup settings, static hosts and the DNS cache', run: (s) => {
    const d = requireIos(s);
    return d.dns.show(d.mgmt.domainName);
  } },
  { syntax: 'clear host <name>', modes: ['privileged'], help: '<name> | *: remove names from the DNS cache', run: (s, [name]) => requireIos(s).dns.clearCache(name) },
];
