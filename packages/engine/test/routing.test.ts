import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, resetMacAllocator } from '../src';
import { ios, warmUp } from './helpers';

/** PC1 --- R1 --- R2 --- PC2, the classic two-router static routing lab. */
function twoRouters() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(pc1.nic, r1.iface('g0/0'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(pc2.nic, r2.iface('g0/0'));
  pc1.configure('192.168.1.10', 24, '192.168.1.1');
  pc2.configure('192.168.2.10', 24, '192.168.2.1');
  ios(r1, `conf t
    int g0/0
    ip address 192.168.1.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.1 255.255.255.252
    no shut
    end`);
  ios(r2, `conf t
    int g0/0
    ip address 192.168.2.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.2 255.255.255.252
    no shut
    end`);
  return { net, r1, r2, pc1, pc2 };
}

describe('router basics', () => {
  it('starts with every port administratively down', () => {
    const r = new Router('R1');
    const out = new CliSession(r).execute('show ip interface brief');
    expect(out).toMatch(/GigabitEthernet0\/0\s+unassigned\s+YES unset\s+administratively down down/);
  });

  it('answers pings on any of its interfaces', () => {
    const { net, r1, pc1 } = twoRouters();
    const results = pc1.ping('10.0.12.1', 4);
    net.run();
    // PC1 holds the first echo while it ARPs for its gateway, so nothing is lost.
    expect(results.every((r) => r.success && r.ttl === 255)).toBe(true);
    expect(r1.arpTable.get('192.168.1.10')?.mac).toBe(pc1.nic.mac);
  });

  it('drops the packet that triggers ARP on each router along the path', () => {
    const { net, r1, r2, pc1 } = twoRouters();
    ios(r1, 'conf t\nip route 192.168.2.0 255.255.255.0 10.0.12.2');
    ios(r2, 'conf t\nip route 192.168.1.0 255.255.255.0 10.0.12.1');
    const results = pc1.ping('192.168.2.10', 4);
    net.run();
    // R1 drops seq 0 while it ARPs for R2, R2 drops seq 1 while it ARPs for PC2. Packet Tracer shows the same.
    expect(results.map((r) => r.status)).toEqual(['timeout', 'timeout', 'success', 'success']);
    expect(results[2]!.ttl).toBe(126);
  });

  it('lists connected and local routes', () => {
    const { r1 } = twoRouters();
    const out = ios(r1, 'show ip route');
    expect(out).toContain('Gateway of last resort is not set');
    expect(out).toContain('      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks');
    expect(out).toContain('C        10.0.12.0/30 is directly connected, GigabitEthernet0/1');
    expect(out).toContain('L        10.0.12.1/32 is directly connected, GigabitEthernet0/1');
    expect(out).toContain('      192.168.1.0/24 is variably subnetted, 2 subnets, 2 masks\nC        192.168.1.0/24 is directly connected, GigabitEthernet0/0');
  });

  it('refuses overlapping addresses', () => {
    const { r1 } = twoRouters();
    const cli = new CliSession(r1);
    ['en', 'conf t', 'int g0/2'].forEach((c) => cli.execute(c));
    expect(cli.execute('ip address 192.168.1.5 255.255.255.0')).toMatch(/overlaps with GigabitEthernet0\/0/);
  });
});

describe('static routing', () => {
  let l: ReturnType<typeof twoRouters>;
  beforeEach(() => (l = twoRouters()));

  it('reports destination unreachable without a route', () => {
    const results = l.pc1.ping('192.168.2.10', 2);
    l.net.run();
    expect(results.every((r) => r.status === 'unreachable' && r.from === '192.168.1.1')).toBe(true);
  });

  it('pings end to end once both routers have static routes', () => {
    ios(l.r1, 'conf t\nip route 192.168.2.0 255.255.255.0 10.0.12.2');
    ios(l.r2, 'conf t\nip route 192.168.1.0 255.255.255.0 10.0.12.1');
    warmUp(l.pc1, '192.168.2.10');
    const results = l.pc1.ping('192.168.2.10', 4);
    l.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    expect(results[0]!.ttl).toBe(126);
    expect(ios(l.r1, 'show ip route')).toContain('S     192.168.2.0/24 [1/0] via 10.0.12.2');
  });

  it('works with a default route and shows the gateway of last resort', () => {
    ios(l.r1, 'conf t\nip route 0.0.0.0 0.0.0.0 10.0.12.2');
    ios(l.r2, 'conf t\nip route 0.0.0.0 0.0.0.0 g0/1');
    const out = ios(l.r1, 'show ip route');
    expect(out).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
    expect(out).toContain('S*    0.0.0.0/0 [1/0] via 10.0.12.2');
    warmUp(l.pc1, '192.168.2.10');
    const results = l.pc1.ping('192.168.2.10', 3);
    l.net.run();
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('traces the path hop by hop', () => {
    ios(l.r1, 'conf t\nip route 192.168.2.0 255.255.255.0 10.0.12.2');
    ios(l.r2, 'conf t\nip route 192.168.1.0 255.255.255.0 10.0.12.1');
    warmUp(l.pc1, '192.168.2.10');
    const trace = l.pc1.traceroute('192.168.2.10');
    l.net.run();
    expect(trace.reached).toBe(true);
    expect(trace.hops.map((h) => h.probes.find((p) => p.from)?.from)).toEqual(['192.168.1.1', '10.0.12.2', '192.168.2.10']);
  });

  it('uses a floating static route only when the primary path fails', () => {
    // Second link between the routers on g0/2, used as a backup with AD 5.
    l.net.connect(l.r1.iface('g0/2'), l.r2.iface('g0/2'));
    ios(l.r1, 'conf t\nint g0/2\nip address 10.0.21.1 255.255.255.252\nno shut\nexit\nip route 192.168.2.0 255.255.255.0 10.0.12.2\nip route 192.168.2.0 255.255.255.0 10.0.21.2 5');
    ios(l.r2, 'conf t\nint g0/2\nip address 10.0.21.2 255.255.255.252\nno shut');
    expect(l.r1.lookup('192.168.2.10')?.route.nextHop).toBe('10.0.12.2');
    ios(l.r1, 'conf t\nint g0/1\nshutdown');
    expect(l.r1.lookup('192.168.2.10')?.route.nextHop).toBe('10.0.21.2');
    expect(ios(l.r1, 'show ip route')).toContain('S     192.168.2.0/24 [5/0] via 10.0.21.2');
  });

  it('expires packets caught in a routing loop', () => {
    ios(l.r1, 'conf t\nip route 0.0.0.0 0.0.0.0 10.0.12.2');
    ios(l.r2, 'conf t\nip route 0.0.0.0 0.0.0.0 10.0.12.1');
    l.pc1.ping('8.8.8.8', 1);
    l.net.run();
    const results = l.pc1.ping('8.8.8.8', 1);
    l.net.run();
    expect(results[0]!.status).toBe('ttl-exceeded');
  });
});

describe('IOS ping and traceroute', () => {
  it('prints the classic .!!!! on the first ping from a router', () => {
    const { r1 } = twoRouters();
    const out = ios(r1, 'ping 10.0.12.2');
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 10.0.12.2, timeout is 2 seconds:');
    expect(out).toContain('\n.!!!!\n');
    expect(out).toMatch(/Success rate is 80 percent \(4\/5\)/);
    expect(ios(r1, 'ping 10.0.12.2')).toContain('!!!!!');
  });

  it('marks unreachable replies with U', () => {
    const { r1 } = twoRouters();
    expect(ios(r1, 'ping 172.16.0.1')).toContain('Success rate is 0 percent (0/5)');
  });

  it('traceroutes from the router CLI', () => {
    const l = twoRouters();
    ios(l.r1, 'conf t\nip route 192.168.2.0 255.255.255.0 10.0.12.2');
    ios(l.r2, 'conf t\nip route 192.168.1.0 255.255.255.0 10.0.12.1');
    ios(l.r1, 'ping 192.168.2.10');
    const out = ios(l.r1, 'traceroute 192.168.2.10');
    expect(out).toMatch(/ {2}1 10\.0\.12\.2 \d+ msec/);
    expect(out).toMatch(/ {2}2 192\.168\.2\.10 \d+ msec/);
  });
});

describe('inter-VLAN routing', () => {
  function vlanLab() {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW1'));
    const pc1 = net.add(new Pc('PC1'));
    const pc2 = net.add(new Pc('PC2'));
    net.connect(pc1.nic, sw.iface('g0/1'));
    net.connect(pc2.nic, sw.iface('g0/2'));
    pc1.configure('192.168.10.10', 24, '192.168.10.1');
    pc2.configure('192.168.20.10', 24, '192.168.20.1');
    ios(sw, `conf t
      vlan 10
      vlan 20
      int g0/1
      switchport mode access
      switchport access vlan 10
      int g0/2
      switchport mode access
      switchport access vlan 20`);
    return { net, sw, pc1, pc2 };
  }

  it('routes between VLANs with router-on-a-stick', () => {
    const { net, sw, pc1 } = vlanLab();
    const r1 = net.add(new Router('R1'));
    net.connect(sw.iface('g0/8'), r1.iface('g0/0'));
    ios(sw, 'conf t\nint g0/8\nswitchport mode trunk');
    ios(r1, `conf t
      int g0/0
      no shut
      int g0/0.10
      encapsulation dot1q 10
      ip address 192.168.10.1 255.255.255.0
      int g0/0.20
      encapsulation dot1q 20
      ip address 192.168.20.1 255.255.255.0`);
    warmUp(pc1, '192.168.20.10');
    const results = pc1.ping('192.168.20.10', 4);
    net.run();
    expect(results.every((r) => r.success)).toBe(true);
    // The same frame crosses the trunk twice: up tagged 10, back down tagged 20.
    expect(net.trace.some((t) => t.from === 'SW1 Gi0/8' && t.frame.vlan === 10)).toBe(true);
    expect(net.trace.some((t) => t.from === 'R1 Gi0/0' && t.frame.vlan === 20)).toBe(true);
    expect(ios(r1, 'show ip route')).toContain('C        192.168.20.0/24 is directly connected, GigabitEthernet0/0.20\nL        192.168.20.1/32');
  });

  it('needs encapsulation before a sub-interface takes an address', () => {
    const r1 = new Router('R1');
    const cli = new CliSession(r1);
    ['en', 'conf t', 'int g0/0.10'].forEach((c) => cli.execute(c));
    expect(cli.prompt).toBe('R1(config-subif)#');
    expect(cli.execute('ip address 10.0.0.1 255.255.255.0')).toMatch(/802.1Q/);
  });

  it('routes between SVIs on a Layer 3 switch', () => {
    const { net, sw, pc1 } = vlanLab();
    ios(sw, `conf t
      ip routing
      int vlan 10
      ip address 192.168.10.1 255.255.255.0
      no shut
      int vlan 20
      ip address 192.168.20.1 255.255.255.0
      no shut`);
    warmUp(pc1, '192.168.20.10');
    const results = pc1.ping('192.168.20.10', 4);
    net.run();
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('does not route between SVIs until ip routing is enabled', () => {
    const { net, sw, pc1 } = vlanLab();
    ios(sw, 'conf t\nint vlan 10\nip address 192.168.10.1 255.255.255.0\nno shut\nint vlan 20\nip address 192.168.20.1 255.255.255.0\nno shut');
    const toGateway = pc1.ping('192.168.10.1', 2);
    const across = pc1.ping('192.168.20.10', 2);
    net.run();
    expect(toGateway.every((r) => r.success)).toBe(true);
    expect(across.some((r) => r.success)).toBe(false);
  });

  it('keeps an SVI down while no port in its VLAN is up (autostate)', () => {
    const { sw } = vlanLab();
    ios(sw, 'conf t\nvlan 30\nint vlan 30\nip address 10.30.0.1 255.255.255.0\nno shut');
    expect(sw.iface('Vlan30').isUp).toBe(false);
    expect(ios(sw, 'show ip interface brief')).toMatch(/Vlan30\s+10\.30\.0\.1\s+YES manual up\s+down/);
  });
});

describe('switch management', () => {
  it('answers pings on its management SVI and uses ip default-gateway', () => {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW1'));
    const pc = net.add(new Pc('PC1'));
    net.connect(pc.nic, sw.iface('g0/1'));
    pc.configure('192.168.1.10', 24, '192.168.1.1');
    ios(sw, 'conf t\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut\nexit\nip default-gateway 192.168.1.1');
    const results = pc.ping('192.168.1.2', 2);
    net.run();
    expect(results.every((r) => r.success)).toBe(true);
    expect(sw.lookup('8.8.8.8')?.arpTarget).toBe('192.168.1.1');
    expect(ios(sw, 'show running-config')).toContain('ip default-gateway 192.168.1.1');
  });
});
