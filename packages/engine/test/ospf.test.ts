import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, resetMacAllocator } from '../src';
import { ios, warmUp } from './helpers';

/** PC1 - R1 - R2 - R3 - PC3 in a line, each link a /30, loopbacks 1.1.1.1, 2.2.2.2, 3.3.3.3. */
function line() {
  resetMacAllocator();
  const net = new Topology();
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((h) => net.add(new Router(h)));
  const pc1 = net.add(new Pc('PC1'));
  const pc3 = net.add(new Pc('PC3'));
  net.connect(pc1.nic, r1!.iface('g0/0'));
  net.connect(r1!.iface('g0/1'), r2!.iface('g0/1'));
  net.connect(r2!.iface('g0/2'), r3!.iface('g0/1'));
  net.connect(pc3.nic, r3!.iface('g0/0'));
  pc1.configure('192.168.1.10', 24, '192.168.1.1');
  pc3.configure('192.168.3.10', 24, '192.168.3.1');
  ios(r1!, `conf t
    int lo0
    ip address 1.1.1.1 255.255.255.255
    int g0/0
    ip address 192.168.1.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.1 255.255.255.252
    no shut`);
  ios(r2!, `conf t
    int lo0
    ip address 2.2.2.2 255.255.255.255
    int g0/1
    ip address 10.0.12.2 255.255.255.252
    no shut
    int g0/2
    ip address 10.0.23.1 255.255.255.252
    no shut`);
  ios(r3!, `conf t
    int lo0
    ip address 3.3.3.3 255.255.255.255
    int g0/0
    ip address 192.168.3.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.23.2 255.255.255.252
    no shut`);
  return { net, r1: r1!, r2: r2!, r3: r3!, pc1, pc3 };
}

const enable = (r: Router) => ios(r, 'conf t\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');

describe('OSPF', () => {
  beforeEach(() => resetMacAllocator());

  it('forms full adjacencies and learns every network', () => {
    const { r1, r2, r3, pc1 } = line();
    enable(r1);
    enable(r2);
    const out = enable(r3);
    expect(out).toContain('%OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/1 from LOADING to FULL, Loading Done');
    const nbrs = ios(r2, 'show ip ospf neighbor');
    expect(nbrs).toMatch(/1\.1\.1\.1\s+1\s+FULL\/(DR|BDR)\s+00:00:36\s+10\.0\.12\.1\s+GigabitEthernet0\/1/);
    expect(nbrs).toMatch(/3\.3\.3\.3\s+1\s+FULL\//);
    const route = ios(r1, 'show ip route');
    expect(route).toMatch(/O\s+192\.168\.3\.0\/24 \[110\/3\] via 10\.0\.12\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/1/);
    expect(route).toMatch(/O\s+3\.3\.3\.3 \[110\/3\] via 10\.0\.12\.2/);
    warmUp(pc1, '192.168.3.10');
    const results = pc1.ping('192.168.3.10', 3);
    r1.network!.run();
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('picks the router ID from the highest loopback and reports it', () => {
    const { r1 } = line();
    enable(r1);
    expect(ios(r1, 'show ip ospf')).toContain('Routing Process "ospf 1" with ID 1.1.1.1');
    expect(ios(r1, 'show ip protocols')).toContain('Router ID 1.1.1.1');
  });

  it('needs clear ip ospf process before a new router ID takes effect', () => {
    const { r1, r2 } = line();
    enable(r1);
    enable(r2);
    const cli = new CliSession(r1);
    ['en', 'conf t', 'router ospf 1'].forEach((c) => cli.execute(c));
    const msg = cli.execute('router-id 11.11.11.11');
    expect(msg).toContain('clear ip ospf process');
    expect(r1.ospf.get(1)!.routerId).toBe('1.1.1.1');
    ios(r1, 'clear ip ospf process');
    expect(r1.ospf.get(1)!.routerId).toBe('11.11.11.11');
    expect(ios(r2, 'show ip ospf neighbor')).toContain('11.11.11.11');
  });

  it('does not form an adjacency across mismatched hello timers or areas', () => {
    const { r1, r2 } = line();
    enable(r1);
    enable(r2);
    ios(r1, 'conf t\nint g0/1\nip ospf hello-interval 5');
    expect(ios(r2, 'show ip ospf neighbor')).not.toContain('1.1.1.1');
    ios(r1, 'conf t\nint g0/1\nno ip ospf hello-interval');
    expect(ios(r2, 'show ip ospf neighbor')).toContain('1.1.1.1');
    const out = ios(r1, 'conf t\nrouter ospf 1\nnetwork 10.0.12.0 0.0.0.3 area 1');
    expect(out).toContain('');
    expect(ios(r2, 'show ip ospf neighbor')).not.toContain('1.1.1.1');
    expect(ios(r2, 'show logging')).toContain('mismatched area ID from area 1 from 10.0.12.1');
  });

  it('stops hellos on a passive interface but still advertises it', () => {
    const { r1, r2 } = line();
    enable(r1);
    enable(r2);
    ios(r1, 'conf t\nrouter ospf 1\npassive-interface g0/0');
    expect(ios(r1, 'show ip ospf interface g0/0')).toContain('No Hellos (Passive interface)');
    expect(ios(r2, 'show ip route')).toMatch(/O\s+192\.168\.1\.0\/24/);
    ios(r1, 'conf t\nrouter ospf 1\npassive-interface g0/1');
    expect(ios(r2, 'show ip ospf neighbor')).not.toContain('1.1.1.1');
    expect(r2.log.some((l) => /Nbr 1\.1\.1\.1 .* FULL to DOWN, Neighbor Down: Dead timer expired/.test(l))).toBe(true);
  });

  it('runs a point-to-point link with no DR', () => {
    const { r1, r2 } = line();
    ios(r1, 'conf t\nint g0/1\nip ospf network point-to-point');
    ios(r2, 'conf t\nint g0/1\nip ospf network point-to-point');
    enable(r1);
    enable(r2);
    expect(ios(r1, 'show ip ospf neighbor')).toMatch(/2\.2\.2\.2\s+0\s+FULL\/  -/);
    expect(ios(r1, 'show ip ospf interface brief')).toMatch(/Gi0\/1\s+1\s+0\s+10\.0\.12\.1\/30\s+1\s+P2P\s+1\/1/);
    expect(ios(r1, 'show ip route')).toMatch(/O\s+2\.2\.2\.2 \[110\/2\]/);
  });

  it('enables OSPF per interface and uses cost and bandwidth', () => {
    const { r1, r2 } = line();
    for (const r of [r1, r2]) ios(r, 'conf t\nint g0/1\nip ospf 1 area 0\nint lo0\nip ospf 1 area 0');
    ios(r1, 'conf t\nint g0/1\nbandwidth 10000');
    expect(ios(r1, 'show ip route ospf')).toMatch(/O\s+2\.2\.2\.2 \[110\/11\]/);
    ios(r1, 'conf t\nint g0/1\nip ospf cost 50');
    expect(ios(r1, 'show ip route ospf')).toMatch(/O\s+2\.2\.2\.2 \[110\/51\]/);
    expect(ios(r1, 'show running-config')).toContain(' bandwidth 10000\n ip ospf 1 area 0\n ip ospf cost 50');
  });

  it('withdraws routes when a link fails and uses the other path', () => {
    resetMacAllocator();
    const net = new Topology();
    const [a, b, c] = ['A', 'B', 'C'].map((h) => net.add(new Router(h)));
    net.connect(a!.iface('g0/0'), b!.iface('g0/0'));
    net.connect(b!.iface('g0/1'), c!.iface('g0/1'));
    net.connect(c!.iface('g0/0'), a!.iface('g0/1'));
    const cfg = (r: Router, n: number, ifs: [string, string][]) =>
      ios(r, `conf t\nint lo0\nip address ${n}.${n}.${n}.${n} 255.255.255.255\n${ifs.map(([i, addr]) => `int ${i}\nip address ${addr} 255.255.255.0\nno shut`).join('\n')}\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0`);
    cfg(a!, 1, [['g0/0', '10.0.1.1'], ['g0/1', '10.0.3.1']]);
    cfg(b!, 2, [['g0/0', '10.0.1.2'], ['g0/1', '10.0.2.2']]);
    cfg(c!, 3, [['g0/1', '10.0.2.3'], ['g0/0', '10.0.3.3']]);
    // Two equal-cost paths from A to B's far link.
    expect(ios(a!, 'show ip route')).toMatch(/O\s+10\.0\.2\.0\/24 \[110\/2\] via 10\.0\.1\.2, .*\n\s+\[110\/2\] via 10\.0\.3\.3/);
    ios(b!, 'conf t\nint g0/0\nshutdown');
    expect(ios(a!, 'show ip route')).toMatch(/O\s+2\.2\.2\.2 \[110\/3\] via 10\.0\.3\.3/);
    expect(ios(a!, 'show ip ospf neighbor')).not.toContain('2.2.2.2');
  });

  it('elects a DR and BDR on a LAN without preemption', () => {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW1'));
    const routers = [1, 2, 3, 4].map((n) => net.add(new Router(`R${n}`)));
    routers.forEach((r, k) => net.connect(r.iface('g0/0'), sw.iface(`g0/${k + 1}`)));
    routers.forEach((r, k) =>
      ios(r, `conf t\nint lo0\nip address ${k + 1}.${k + 1}.${k + 1}.${k + 1} 255.255.255.255\nint g0/0\nip address 10.0.0.${k + 1} 255.255.255.0\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0`),
    );
    const state = (r: Router) => r.ospf.get(1)!.interfaceState(r.ospf.get(1)!.ifaces.get(r.iface('g0/0'))!);
    // R1 came up first and alone, so it is DR; R2 joined next and took BDR. Later, higher IDs do not preempt.
    expect(routers.map(state)).toEqual(['DR', 'BDR', 'DROTHER', 'DROTHER']);
    expect(ios(routers[2]!, 'show ip ospf neighbor')).toMatch(/4\.4\.4\.4\s+1\s+2WAY\/DROTHER/);
    expect(ios(routers[2]!, 'show ip ospf neighbor')).toMatch(/1\.1\.1\.1\s+1\s+FULL\/DR/);
    ios(routers[3]!, 'conf t\nint g0/0\nip ospf priority 200');
    expect(state(routers[3]!)).toBe('DROTHER');
    ios(routers[0]!, 'clear ip ospf process');
    // The BDR is promoted and R4, with the highest priority, becomes BDR.
    expect(routers.map(state)).toEqual(['DROTHER', 'DR', 'DROTHER', 'BDR']);
    expect(ios(routers[3]!, 'show ip ospf interface g0/0')).toContain('Designated Router (ID) 2.2.2.2, Interface address 10.0.0.2');
    expect(ios(routers[0]!, 'show ip route')).toMatch(/O\s+4\.4\.4\.4 \[110\/2\] via 10\.0\.0\.4/);
    expect(ios(routers[0]!, 'show ip ospf database')).toMatch(/Net Link States[\s\S]*10\.0\.0\.2\s+2\.2\.2\.2/);
  });

  it('advertises a default route with default-information originate', () => {
    const { r1, r2, r3 } = line();
    enable(r1);
    enable(r2);
    enable(r3);
    ios(r3, 'conf t\nrouter ospf 1\ndefault-information originate');
    expect(ios(r1, 'show ip route')).not.toContain('O*E2');
    ios(r3, 'conf t\nip route 0.0.0.0 0.0.0.0 Null0'.replace('Null0', '192.168.3.10'));
    const route = ios(r1, 'show ip route');
    expect(route).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
    expect(route).toMatch(/O\*E2\s+0\.0\.0\.0\/0 \[110\/1\] via 10\.0\.12\.2/);
    ios(r3, 'conf t\nno ip route 0.0.0.0 0.0.0.0 192.168.3.10');
    expect(ios(r1, 'show ip route')).not.toContain('O*E2');
  });

  it('logs a duplicate router ID', () => {
    const { r1, r2 } = line();
    ios(r1, 'conf t\nrouter ospf 1\nrouter-id 9.9.9.9\nnetwork 10.0.12.0 0.0.0.3 area 0');
    ios(r2, 'conf t\nrouter ospf 1\nrouter-id 9.9.9.9\nnetwork 10.0.12.0 0.0.0.3 area 0');
    expect(r2.log.join('\n')).toContain('%OSPF-4-DUPID: OSPF detected duplicate router-id 9.9.9.9 from 10.0.12.1');
    expect(ios(r2, 'show ip ospf neighbor')).not.toContain('9.9.9.9');
  });

  it('prints running-config for the process', () => {
    const { r1 } = line();
    ios(r1, 'conf t\nrouter ospf 1\nrouter-id 1.1.1.1\npassive-interface g0/0\nnetwork 10.0.12.0 0.0.0.3 area 0\ndefault-information originate');
    expect(ios(r1, 'show running-config')).toContain('router ospf 1\n router-id 1.1.1.1\n passive-interface GigabitEthernet0/0\n network 10.0.12.0 0.0.0.3 area 0\n default-information originate\n!');
    const cli = new CliSession(r1);
    ['en', 'conf t', 'router ospf 1'].forEach((c) => cli.execute(c));
    expect(cli.prompt).toBe('R1(config-router)#');
  });

  it('recovers when an inbound ACL that blocked hellos is fixed', () => {
    const { r1, r2 } = line();
    enable(r1);
    enable(r2);
    // R2 stops hearing R1 but R1 still hears R2: a one-way neighbor on R1, R1's old LSAs stuck on R2.
    ios(r2, 'conf t\nip access-list extended WAN\npermit icmp any any\nint g0/1\nip access-group WAN in');
    expect(ios(r2, 'show ip ospf neighbor')).not.toContain('1.1.1.1');
    ios(r2, 'conf t\nip access-list extended WAN\npermit ospf any any');
    expect(ios(r1, 'show ip ospf neighbor')).toMatch(/2\.2\.2\.2\s+1\s+FULL/);
    expect(ios(r2, 'show ip ospf neighbor')).toMatch(/1\.1\.1\.1\s+1\s+FULL/);
    expect(ios(r2, 'show ip route ospf')).toContain('192.168.1.0/24');
    // Every network LSA left on R2 belongs to the current DR.
    const nets = r2.ospf.get(1)!.lsdb;
    expect([...nets.values()].filter((l) => l.lsType === 'network')).toHaveLength(1);
  });
});
