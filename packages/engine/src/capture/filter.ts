import type { Frame } from '../core/frames';
import { protocolOf } from './dissect';

export type FramePredicate = (frame: Frame) => boolean;

/** Words a filter accepts on their own, like Wireshark's protocol filters. */
const PROTOCOLS = ['arp', 'icmp', 'tcp', 'udp', 'dhcp', 'hsrp', 'ntp', 'ospf', 'icmpv6', 'stp', 'lacp', 'pagp', 'cdp', 'lldp', 'radius', 'tacacs', 'snmp', 'capwap', 'eapol', 'wlan'];

const FIELDS = ['ip.addr', 'ip.src', 'ip.dst', 'eth.addr', 'eth.src', 'eth.dst', 'vlan', 'vlan.id', 'tcp.port', 'udp.port'];

function protocolMatch(word: string): FramePredicate {
  if (word === 'eth') return () => true;
  if (word === 'ip') return (f) => ['icmp', 'tcp', 'udp', 'ospf'].includes(f.payload.kind);
  if (word === 'ipv6') return (f) => f.payload.kind === 'icmpv6';
  if (word === 'vlan') return (f) => f.vlan !== undefined;
  if (word === 'tacacs') return (f) => f.payload.kind === 'tcp' && f.payload.tacacs !== undefined;
  if (word === 'capwap') return (f) => f.payload.kind === 'udp' && f.payload.capwap !== undefined;
  if (word === 'wlan') return (f) => f.payload.kind === 'dot11';
  return (f) => protocolOf(f.payload).toLowerCase() === word;
}

/** IP addresses in a frame: from the IP header, or the ARP sender and target. */
function addresses(f: Frame, which: 'src' | 'dst' | 'any'): string[] {
  const p = f.payload;
  if (p.kind === 'arp') return which === 'src' ? [p.senderIp] : which === 'dst' ? [p.targetIp] : [p.senderIp, p.targetIp];
  if ('src' in p && 'dst' in p) return which === 'src' ? [p.src] : which === 'dst' ? [p.dst] : [p.src, p.dst];
  return [];
}

function fieldMatch(field: string, value: string): FramePredicate {
  const v = value.toLowerCase();
  switch (field) {
    case 'ip.addr':
      return (f) => addresses(f, 'any').includes(v);
    case 'ip.src':
      return (f) => addresses(f, 'src').includes(v);
    case 'ip.dst':
      return (f) => addresses(f, 'dst').includes(v);
    case 'eth.addr':
      return (f) => f.src === v || f.dst === v;
    case 'eth.src':
      return (f) => f.src === v;
    case 'eth.dst':
      return (f) => f.dst === v;
    case 'vlan':
    case 'vlan.id':
      return (f) => f.vlan === Number(v);
    default: {
      const kind = field.slice(0, 3);
      return (f) => f.payload.kind === kind && 'srcPort' in f.payload && (f.payload.srcPort === Number(v) || f.payload.dstPort === Number(v));
    }
  }
}

/**
 * Compiles a Wireshark-style display filter: protocol words (`arp`, `icmp`, `dhcp`, `stp`...),
 * comparisons (`ip.addr == 10.0.0.1`, `eth.src == aabb.cc00.0101`, `vlan == 10`, `tcp.port == 22`),
 * joined with `&&`, `||`, `!` (or `and`, `or`, `not`) and parentheses. An empty filter matches
 * everything. Throws on anything it cannot parse.
 */
export function compileFilter(text: string): FramePredicate {
  const tokens = text.match(/\(|\)|==|!=|&&|\|\||!|[^\s()!=&|]+/g) ?? [];
  let k = 0;
  const peek = () => tokens[k]?.toLowerCase();
  const fail = (): never => {
    throw new Error(`Invalid filter near "${tokens[k] ?? 'end'}"`);
  };

  const primary = (): FramePredicate => {
    const t = peek();
    if (t === undefined) return fail();
    if (t === '(') {
      k++;
      const inner = or();
      if (peek() !== ')') fail();
      k++;
      return inner;
    }
    k++;
    if (peek() === '==' || peek() === '!=') {
      const negate = peek() === '!=';
      k++;
      const value = peek();
      if (!FIELDS.includes(t) || value === undefined || ['(', ')', '&&', '||', '!'].includes(value)) return fail();
      k++;
      const match = fieldMatch(t, value);
      return negate ? (f) => !match(f) : match;
    }
    if (!PROTOCOLS.includes(t) && !['eth', 'ip', 'ipv6', 'vlan'].includes(t)) {
      k--;
      return fail();
    }
    return protocolMatch(t);
  };
  const not = (): FramePredicate => {
    if (peek() === '!' || peek() === 'not') {
      k++;
      const inner = not();
      return (f) => !inner(f);
    }
    return primary();
  };
  const and = (): FramePredicate => {
    let left = not();
    while (peek() === '&&' || peek() === 'and') {
      k++;
      const l = left;
      const r = not();
      left = (f) => l(f) && r(f);
    }
    return left;
  };
  const or = (): FramePredicate => {
    let left = and();
    while (peek() === '||' || peek() === 'or') {
      k++;
      const l = left;
      const r = and();
      left = (f) => l(f) || r(f);
    }
    return left;
  };

  if (!tokens.length) return () => true;
  const result = or();
  if (k !== tokens.length) fail();
  return result;
}

/** Periodic control-plane chatter the capture panel hides by default. */
export function isKeepalive(f: Frame): boolean {
  const p = f.payload;
  if (p.kind === 'bpdu' || p.kind === 'lacp' || p.kind === 'pagp' || p.kind === 'cdp' || p.kind === 'lldp') return true;
  if (p.kind === 'ospf') return p.ospf.type === 'hello';
  if (p.kind === 'udp' && p.capwap) return p.capwap.type === 'echo-request' || p.capwap.type === 'echo-response';
  return p.kind === 'udp' && (p.hsrp !== undefined || p.ntp !== undefined);
}
