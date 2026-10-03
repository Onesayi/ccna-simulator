import { beforeEach, describe, expect, it } from 'vitest';
import {
  CliSession,
  Pc,
  PcShell,
  Router,
  Switch,
  Topology,
  eui64Address,
  formatIpv6,
  ipv6MulticastMac,
  ipv6Type,
  isValidIpv6,
  linkLocalFor,
  normaliseIpv6,
  parseIpv6,
  parseIpv6Prefix,
  resetMacAllocator,
  solicitedNode,
} from '../src';
import { ios } from './helpers';

describe('IPv6 addressing helpers', () => {
  it('compresses addresses the RFC 5952 way', () => {
    expect(normaliseIpv6('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normaliseIpv6('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normaliseIpv6('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(normaliseIpv6('::')).toBe('::');
    expect(normaliseIpv6('::1')).toBe('::1');
    expect(normaliseIpv6('fe80::')).toBe('fe80::');
    expect(formatIpv6(parseIpv6('1:2:3:4:5:6:7:8'))).toBe('1:2:3:4:5:6:7:8');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['2001:db8::1::2', '2001:db8:::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '2001:db8::g', '12345::', '::1:2:3:4:5:6:7:8']) {
      expect(isValidIpv6(bad)).toBe(false);
    }
    expect(() => parseIpv6Prefix('2001:db8::/129')).toThrow();
    expect(() => parseIpv6Prefix('2001:db8::')).toThrow();
    expect(parseIpv6Prefix('2001:DB8:1::1/64')).toEqual({ address: '2001:db8:1::1', prefix: 64 });
  });

  it('builds EUI-64 interface IDs by inserting FFFE and flipping the U/L bit', () => {
    expect(eui64Address('2001:db8:1::', '0050.7966.6801')).toBe('2001:db8:1:0:250:79ff:fe66:6801');
    expect(linkLocalFor('aabb.cc00.0100')).toBe('fe80::a8bb:ccff:fe00:100');
  });

  it('classifies address types', () => {
    expect(ipv6Type('fe80::1')).toBe('link-local');
    expect(ipv6Type('fd00::1')).toBe('unique local');
    expect(ipv6Type('2001:db8::1')).toBe('global unicast');
    expect(ipv6Type('ff02::1')).toBe('multicast');
    expect(ipv6Type('::1')).toBe('loopback');
    expect(ipv6Type('::')).toBe('unspecified');
  });

  it('maps solicited-node groups and multicast MACs', () => {
    expect(solicitedNode('2001:db8::abcd:1234')).toBe('ff02::1:ffcd:1234');
    expect(ipv6MulticastMac('ff02::1:ffcd:1234')).toBe('3333.ffcd.1234');
  });
});

/**
 * PC1 - SW1 - R1 - R2 - SW2 - PC2: two LANs routed over a /64 transit link.
 */
function twoSites() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const sw1 = net.add(new Switch('SW1'));
  const sw2 = net.add(new Switch('SW2'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(r1.iface('g0/0'), sw1.iface('g0/8'));
  net.connect(r2.iface('g0/0'), sw2.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(pc1.nic, sw1.iface('g0/1'));
  net.connect(pc2.nic, sw2.iface('g0/1'));
  ios(r1, `conf t
    ipv6 unicast-routing
    int g0/0
    ipv6 address 2001:db8:1::1/64
    ipv6 address fe80::1 link-local
    no shut
    int g0/1
    ipv6 address 2001:db8:12::1/64
    no shut`);
  ios(r2, `conf t
    ipv6 unicast-routing
    int g0/0
    ipv6 address 2001:db8:2::/64 eui-64
    no shut
    int g0/1
    ipv6 address 2001:db8:12::2/64
    no shut`);
  pc1.configureIpv6('2001:db8:1::10', 64, 'fe80::1');
  return { net, r1, r2, sw1, sw2, pc1, pc2 };
}

describe('IPv6 routing', () => {
  let t: ReturnType<typeof twoSites>;
  beforeEach(() => (t = twoSites()));

  it('shows link-local, global and EUI-64 addresses', () => {
    const brief = ios(t.r1, 'show ipv6 interface brief');
    expect(brief).toContain('GigabitEthernet0/0     [up/up]\n    FE80::1\n    2001:DB8:1::1');
    expect(brief).toContain('GigabitEthernet0/2     [administratively down/down]\n    unassigned');
    const eui = t.r2.ipv6.globals(t.r2.iface('g0/0'))[0]!;
    expect(eui.address).toBe(eui64Address('2001:db8:2::', t.r2.iface('g0/0').mac));
    const detail = ios(t.r2, 'show ipv6 interface g0/0');
    expect(detail).toContain(`IPv6 is enabled, link-local address is ${linkLocalFor(t.r2.iface('g0/0').mac).toUpperCase()}`);
    expect(detail).toMatch(/subnet is 2001:DB8:2::\/64 \[EUI\]/);
    expect(detail).toContain('FF02::2');
    expect(ios(t.r1, 'show ipv6 interface g0/2')).toContain('IPv6 is disabled');
    const run = ios(t.r2, 'show running-config');
    expect(run).toContain('ipv6 unicast-routing');
    expect(run).toContain(' ipv6 address 2001:DB8:2::/64 eui-64');
    expect(ios(t.r1, 'show running-config')).toContain(' ipv6 address FE80::1 link-local');
  });

  it('builds connected and local routes, and routes with statics', () => {
    expect(ios(t.r1, 'show ipv6 route')).toMatch(/C\s+2001:DB8:1::\/64 \[0\/0\]\n\s+via GigabitEthernet0\/0, directly connected/);
    expect(ios(t.r1, 'show ipv6 route')).toMatch(/L\s+2001:DB8:1::1\/128 \[0\/0\]\n\s+via GigabitEthernet0\/0, receive/);
    expect(ios(t.r1, 'show ipv6 route')).toContain('L   FF00::/8 [0/0]');
    ios(t.r1, 'conf t\nipv6 route 2001:db8:2::/64 2001:db8:12::2');
    // R2's default route points at R1's link-local address, so it needs the exit interface too.
    ios(t.r2, `conf t\nipv6 route ::/0 g0/1 ${linkLocalFor(t.r1.iface('g0/1').mac)}`);
    expect(ios(t.r1, 'show ipv6 route static')).toMatch(/S\s+2001:DB8:2::\/64 \[1\/0\]\n\s+via 2001:DB8:12::2/);
    expect(ios(t.r2, 'show ipv6 route')).toMatch(/S\s+::\/0 \[1\/0\]\n\s+via FE80::[0-9A-F:]+, GigabitEthernet0\/1/);
    expect(ios(t.r2, 'show running-config')).toMatch(/ipv6 route ::\/0 GigabitEthernet0\/1 FE80::/);

    t.pc2.autoconfigureIpv6();
    t.net.run();
    const pc2addr = t.pc2.ipv6.globals(t.pc2.nic)[0]!.address;
    const results = t.pc1.pingAny(pc2addr, 4);
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    // Windows starts at hop limit 128; two routers on the way.
    expect(results[0]!.ttl).toBe(126);
    expect(ios(t.r1, 'show ipv6 neighbors')).toMatch(/2001:DB8:1::10\s+0 aabb\.cc00\.\w+\s+REACH Gi0\/0/);
  });

  it('gives SLAAC hosts a /64 address and the router link-local as gateway', () => {
    t.pc2.autoconfigureIpv6();
    t.net.run();
    const a = t.pc2.ipv6.globals(t.pc2.nic)[0]!;
    expect(a).toMatchObject({ address: eui64Address('2001:db8:2::', t.pc2.nic.mac), prefix: 64, slaac: true });
    expect(t.pc2.gateway6).toBe(linkLocalFor(t.r2.iface('g0/0').mac));
    expect(t.pc2.gateway6IsLinkLocal).toBe(true);
    const shell = new PcShell(t.pc2);
    const cfg = shell.execute('ipconfig');
    expect(cfg).toContain(`IPv6 Address....................: ${a.address.toUpperCase()}/64`);
    expect(cfg).toContain(`Default Gateway.................: ${t.pc2.gateway6!.toUpperCase()}`);
    expect(shell.execute('ipv6config')).toContain('Automatic (SLAAC)');
  });

  it('needs ipv6 unicast-routing to forward and advertise', () => {
    ios(t.r2, 'conf t\nno ipv6 unicast-routing');
    t.pc2.autoconfigureIpv6();
    t.net.run();
    expect(t.pc2.ipv6.globals(t.pc2.nic)).toHaveLength(0);
    expect(new PcShell(t.pc2).execute('ipv6config autoconfig')).toContain('No router advertisement');
    ios(t.r1, 'conf t\nno ipv6 unicast-routing');
    const results = t.pc1.pingAny('2001:db8:12::2', 2);
    t.net.run();
    expect(results.some((r) => r.success)).toBe(false);
  });

  it('answers unreachable without a route, and time exceeded along a traceroute', () => {
    const results = t.pc1.pingAny('2001:db8:99::1', 1);
    t.net.run();
    expect(results[0]!.status).toBe('unreachable');
    expect(results[0]!.from).toBe('2001:db8:1::1');
    ios(t.r1, 'conf t\nipv6 route 2001:db8:2::/64 2001:db8:12::2');
    ios(t.r2, 'conf t\nipv6 route 2001:db8:1::/64 2001:db8:12::1');
    const trace = t.pc1.tracerouteAny('2001:db8:12::2');
    t.net.run();
    expect(trace.reached).toBe(true);
    expect(trace.hops.map((h) => h.probes.find((p) => p.from)?.from)).toEqual(['2001:db8:1::1', '2001:db8:12::2']);
    const out = new PcShell(t.pc1).execute('tracert 2001:db8:12::2');
    expect(out).toContain('2001:db8:12::2');
    const ios1 = ios(t.r1, 'traceroute 2001:db8:12::2');
    expect(ios1).toContain('Tracing the route to 2001:DB8:12::2');
  });

  it('pings from the router CLI and the PC shell', () => {
    const out = ios(t.r1, 'ping 2001:db8:12::2');
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 2001:DB8:12::2');
    expect(out).toContain('!!!!!');
    expect(ios(t.r1, 'ping ipv6 2001:db8:1::10')).toContain('Success rate is 100 percent');
    expect(new PcShell(t.pc1).execute('ping 2001:db8:1::1')).toMatch(/Reply from 2001:db8:1::1: time[<=]\d*ms\n/);
    expect(new PcShell(t.pc1).execute('ping 2001:db8:1::10')).toContain('Reply from 2001:db8:1::10');
    expect(new PcShell(t.pc1).execute('ping fe80::1')).toContain('General failure');
    expect(new CliSession(t.r1).execute('ping 2001:db8::zz')).toMatch(/Invalid input/);
  });

  it('validates addresses and routes', () => {
    expect(() => ios(t.r1, 'conf t\nint g0/2\nipv6 address 2001:db8:1::5/64')).toThrow(/overlaps/);
    expect(() => ios(t.r1, 'conf t\nint g0/2\nipv6 address fe80::5/64')).toThrow(/link-local/);
    expect(() => ios(t.r1, 'conf t\nint g0/2\nipv6 address 2001:db8:9::/96 eui-64')).toThrow(/EUI-64/);
    expect(() => ios(t.r1, 'conf t\nint g0/2\nipv6 address 2001:db8:9::1 link-local')).toThrow(/link-local/);
    expect(() => ios(t.r1, 'conf t\nint g0/2\nipv6 address autoconfig')).toThrow();
    expect(() => ios(t.r1, 'conf t\nipv6 route ::/0 fe80::2')).toThrow(/Interface has to be specified/);
    expect(() => ios(t.r1, 'conf t\nipv6 route 2001:db8:2::1/64 2001:db8:12::2')).toThrow();
    expect(() => ios(t.r1, 'conf t\nipv6 route 2001:db8:2::/64 2001:db8:12::2 300')).toThrow(/distance/);
    expect(() => ios(t.r1, 'show ipv6 route bogus')).toThrow();
    expect(() => ios(t.r1, 'conf t\nint g0/0.5\nipv6 enable')).toThrow(/encapsulation/);
  });

  it('removes addresses, routes and settings with no', () => {
    ios(t.r1, 'conf t\nipv6 route 2001:db8:2::/64 2001:db8:12::2 5\nno ipv6 route 2001:db8:2::/64 2001:db8:12::2 5');
    expect(t.r1.ipv6.statics).toHaveLength(0);
    ios(t.r2, 'conf t\nint g0/0\nno ipv6 address 2001:db8:2::/64 eui-64');
    expect(t.r2.ipv6.globals(t.r2.iface('g0/0'))).toHaveLength(0);
    ios(t.r1, 'conf t\nint g0/0\nno ipv6 address fe80::1 link-local');
    expect(t.r1.ipv6.linkLocal(t.r1.iface('g0/0'))).toBe(linkLocalFor(t.r1.iface('g0/0').mac));
    ios(t.r1, 'conf t\nint g0/0\nno ipv6 address 2001:db8:1::1/64');
    expect(t.r1.ipv6.globals(t.r1.iface('g0/0'))).toHaveLength(0);
    ios(t.r1, 'conf t\nint g0/2\nipv6 enable');
    expect(ios(t.r1, 'show running-config')).toContain(' ipv6 enable');
    ios(t.r1, 'conf t\nint g0/2\nno ipv6 enable\nint g0/1\nno ipv6 address');
    expect(t.r1.ipv6.enabled(t.r1.iface('g0/2'))).toBe(false);
    expect(t.r1.ipv6.enabled(t.r1.iface('g0/1'))).toBe(false);
  });

  it('floats a static route with a higher distance until the primary fails', () => {
    ios(t.r1, 'conf t\nipv6 route 2001:db8:2::/64 2001:db8:12::2\nipv6 route 2001:db8:2::/64 g0/2 10');
    expect(t.r1.ipv6.routingTable().filter((r) => r.code === 'S')).toHaveLength(1);
    expect(ios(t.r1, 'show running-config')).toContain('ipv6 route 2001:DB8:2::/64 GigabitEthernet0/2 10');
  });

  it('takes static PC addresses from the shell', () => {
    const shell = new PcShell(t.pc2);
    expect(shell.execute('ipv6config 2001:db8:2::20/64 fe80::1')).toBe('');
    expect(t.pc2.gateway6).toBe('fe80::1');
    expect(shell.execute('ipv6config bogus')).toBe('Invalid Command.');
    expect(shell.execute('ipv6config fe80::9/64')).toContain('link-local');
    expect(shell.execute('ipv6config 2001:db8:2::20/64 zz::')).toBe('Invalid gateway address.');
    expect(shell.execute('ipv6config')).toContain('2001:DB8:2::20/64');
    expect(shell.execute('ping 2001:db8:2::zz')).toContain('could not find host');
    expect(shell.execute('tracert zz::1')).toContain('Unable to resolve');
  });
});
