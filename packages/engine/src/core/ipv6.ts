import type { MacAddress } from './addressing';

/** IPv6 helpers. Addresses are stored in RFC 5952 form: lower case, leading zeros dropped, the longest zero run as "::". */

export type Ipv6Address = string; // "2001:db8:1::1"

const MAX = (1n << 128n) - 1n;

export function parseIpv6(text: string): bigint {
  const s = text.trim().toLowerCase();
  const bad = () => new Error(`Invalid IPv6 address: ${text}`);
  if (!/^[0-9a-f:]+$/.test(s) || s.includes(':::') || s.split('::').length > 2) throw bad();
  const [head = '', tail] = s.split('::');
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) throw bad();
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw bad();
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function formatIpv6(n: bigint): Ipv6Address {
  const groups = Array.from({ length: 8 }, (_, k) => Number((n >> BigInt(112 - k * 16)) & 0xffffn));
  // Find the longest run of two or more zero groups; the first one wins a tie.
  let best = { at: -1, len: 1 };
  for (let k = 0; k < 8; ) {
    if (groups[k] !== 0) {
      k++;
      continue;
    }
    let j = k;
    while (j < 8 && groups[j] === 0) j++;
    if (j - k > best.len) best = { at: k, len: j - k };
    k = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

export function normaliseIpv6(text: string): Ipv6Address {
  return formatIpv6(parseIpv6(text));
}

export function isValidIpv6(text: string): boolean {
  try {
    parseIpv6(text);
    return true;
  } catch {
    return false;
  }
}

function maskOf(prefix: number): bigint {
  return prefix === 0 ? 0n : (MAX << BigInt(128 - prefix)) & MAX;
}

export function ipv6Network(address: Ipv6Address, prefix: number): Ipv6Address {
  return formatIpv6(parseIpv6(address) & maskOf(prefix));
}

export function ipv6InPrefix(address: Ipv6Address, network: Ipv6Address, prefix: number): boolean {
  return ipv6Network(address, prefix) === ipv6Network(network, prefix);
}

/** Splits "2001:db8::1/64" into its address and prefix length. */
export function parseIpv6Prefix(text: string): { address: Ipv6Address; prefix: number } {
  const [addr = '', len, extra] = text.split('/');
  const prefix = Number(len);
  if (extra !== undefined || len === undefined || !/^\d{1,3}$/.test(len) || prefix > 128) throw new Error(`Invalid IPv6 prefix: ${text}`);
  return { address: normaliseIpv6(addr), prefix };
}

function macToBigInt(mac: MacAddress): bigint {
  return BigInt(`0x${mac.replace(/[.:-]/g, '')}`);
}

/**
 * Modified EUI-64 interface ID: split the MAC in half, put FFFE in the middle, and flip the
 * universal/local bit (the 7th bit of the first byte).
 */
export function eui64InterfaceId(mac: MacAddress): bigint {
  const m = macToBigInt(mac);
  const oui = m >> 24n;
  const nic = m & 0xffffffn;
  return ((oui << 40n) | (0xfffen << 24n) | nic) ^ (0x02n << 56n);
}

/** The address a /64 prefix and a MAC give with EUI-64 (`ipv6 address <prefix>/64 eui-64`, SLAAC). */
export function eui64Address(prefix: Ipv6Address, mac: MacAddress): Ipv6Address {
  return formatIpv6((parseIpv6(prefix) & maskOf(64)) | eui64InterfaceId(mac));
}

/** The link-local address IOS and the PCs derive from the MAC: FE80::/64 plus the EUI-64 interface ID. */
export function linkLocalFor(mac: MacAddress): Ipv6Address {
  return eui64Address('fe80::', mac);
}

export type Ipv6AddressType = 'unspecified' | 'loopback' | 'multicast' | 'link-local' | 'unique local' | 'global unicast';

export function ipv6Type(address: Ipv6Address): Ipv6AddressType {
  const n = parseIpv6(address);
  if (n === 0n) return 'unspecified';
  if (n === 1n) return 'loopback';
  const top = Number(n >> 112n);
  if (top >> 8 === 0xff) return 'multicast';
  if ((top & 0xffc0) === 0xfe80) return 'link-local';
  if ((top & 0xfe00) === 0xfc00) return 'unique local';
  return 'global unicast';
}

export const isLinkLocal = (a: Ipv6Address) => ipv6Type(a) === 'link-local';
export const isIpv6Multicast = (a: Ipv6Address) => ipv6Type(a) === 'multicast';

export const ALL_NODES: Ipv6Address = 'ff02::1';
export const ALL_ROUTERS: Ipv6Address = 'ff02::2';

/** Solicited-node multicast group: FF02::1:FF plus the low 24 bits of the address. NS messages go here. */
export function solicitedNode(address: Ipv6Address): Ipv6Address {
  return formatIpv6(parseIpv6('ff02::1:ff00:0') | (parseIpv6(address) & 0xffffffn));
}

/** IPv6 multicast maps to the MAC 3333 plus the low 32 bits of the group address. */
export function ipv6MulticastMac(group: Ipv6Address): MacAddress {
  const low = (parseIpv6(group) & 0xffffffffn).toString(16).padStart(8, '0');
  return `3333.${low.slice(0, 4)}.${low.slice(4)}`;
}

/** IOS prints IPv6 addresses in upper case. */
export function iosIpv6(address: Ipv6Address): string {
  return address.toUpperCase();
}

/** Sort key for IPv6 addresses. */
export function compareIpv6(a: Ipv6Address, b: Ipv6Address): number {
  const x = parseIpv6(a);
  const y = parseIpv6(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
