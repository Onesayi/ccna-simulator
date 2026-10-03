/** MAC and IPv4 helpers. Addresses are stored as normalised strings for readability in tests and the UI. */

export type MacAddress = string; // "aabb.cc00.0110" (Cisco dotted format)
export type Ipv4Address = string; // "192.168.1.1"

export const BROADCAST_MAC: MacAddress = 'ffff.ffff.ffff';

let macCounter = 0x0100;

/** Deterministic MAC allocator so topologies and tests are reproducible. */
export function nextMac(): MacAddress {
  const suffix = (macCounter++ & 0xffff).toString(16).padStart(4, '0');
  return `aabb.cc00.${suffix}`;
}

export function resetMacAllocator(): void {
  macCounter = 0x0100;
}

export function ipToInt(ip: Ipv4Address): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return parts.reduce((acc, p) => (acc << 8) + p, 0) >>> 0;
}

export function intToIp(n: number): Ipv4Address {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}

export function maskToPrefix(mask: Ipv4Address): number {
  const n = ipToInt(mask);
  const prefix = n === 0 ? 0 : 32 - Math.log2((~n >>> 0) + 1);
  if (!Number.isInteger(prefix) || prefixToMask(prefix) !== mask) {
    throw new Error(`Invalid subnet mask: ${mask}`);
  }
  return prefix;
}

export function prefixToMask(prefix: number): Ipv4Address {
  return intToIp(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
}

export function networkAddress(ip: Ipv4Address, prefix: number): Ipv4Address {
  return intToIp(ipToInt(ip) & ipToInt(prefixToMask(prefix)));
}

export function sameSubnet(a: Ipv4Address, b: Ipv4Address, prefix: number): boolean {
  return networkAddress(a, prefix) === networkAddress(b, prefix);
}

/** Accepts a dotted mask ("255.255.255.0") or a prefix length ("24" or "/24"). */
export function parsePrefix(maskOrPrefix: string): number {
  const p = maskOrPrefix.replace(/^\//, '');
  if (/^\d{1,2}$/.test(p)) {
    const n = Number(p);
    if (n > 32) throw new Error(`Invalid prefix length: ${maskOrPrefix}`);
    return n;
  }
  return maskToPrefix(p);
}

export function isValidIp(ip: string): boolean {
  try {
    ipToInt(ip);
    return true;
  } catch {
    return false;
  }
}

/** The classful network length (A=8, B=16, C=24) used by `show ip route` to group subnets. */
export function classfulPrefix(ip: Ipv4Address): number {
  const first = ipToInt(ip) >>> 24;
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}
