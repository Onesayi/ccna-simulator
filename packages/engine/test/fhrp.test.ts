import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, dissect, glbpVirtualMac, resetMacAllocator, summarize, vrrpVirtualMac } from '../src';
import { ios } from './helpers';

/** Two gateways (R1, R2) on a LAN with two PCs; both uplink to R3, which has a server behind it. */
function campus() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const r3 = net.add(new Router('R3'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  const srv = net.add(new Pc('SRV'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(pc2.nic, sw.iface('g0/4'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/2'));
  net.connect(r2.iface('g0/0'), sw.iface('g0/3'));
  net.connect(r1.iface('g0/1'), r3.iface('g0/0'));
  net.connect(r2.iface('g0/1'), r3.iface('g0/1'));
  net.connect(srv.nic, r3.iface('g0/2'));
  pc1.configure('192.168.1.10', 24, '192.168.1.254');
  pc2.configure('192.168.1.11', 24, '192.168.1.254');
  srv.configure('172.16.0.10', 24, '172.16.0.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.2 255.255.255.0\nno shut\nint g0/1\nip address 10.0.13.1 255.255.255.252\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  ios(r2, 'conf t\nint g0/0\nip address 192.168.1.3 255.255.255.0\nno shut\nint g0/1\nip address 10.0.23.1 255.255.255.252\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  ios(r3, 'conf t\nint g0/0\nip address 10.0.13.2 255.255.255.252\nno shut\nint g0/1\nip address 10.0.23.2 255.255.255.252\nno shut\nint g0/2\nip address 172.16.0.1 255.255.255.0\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  return { net, sw, r1, r2, r3, pc1, pc2, srv };
}

function reaches(pc: Pc, dst: string): boolean {
  pc.ping(dst, 3, 1000);
  pc.network!.run();
  const r = pc.ping(dst, 2, 1000);
  pc.network!.run();
  return r.every((x) => x.success);
}

describe('VRRP', () => {
  let t: ReturnType<typeof campus>;
  const state = (r: Router) => r.vrrp.groups()[0]?.state;
  beforeEach(() => {
    t = campus();
    ios(t.r1, 'conf t\nint g0/0\nvrrp 10 ip 192.168.1.254\nvrrp 10 priority 110');
    ios(t.r2, 'conf t\nint g0/0\nvrrp 10 ip 192.168.1.254');
  });

  it('elects a master that owns the virtual MAC, with preemption on by default', () => {
    expect(state(t.r1)).toBe('Master');
    expect(state(t.r2)).toBe('Backup');
    expect(reaches(t.pc1, '172.16.0.10')).toBe(true);
    expect(t.pc1.arpCache.get('192.168.1.254')).toBe('0000.5e00.010a');
    expect(vrrpVirtualMac(10)).toBe('0000.5e00.010a');
    expect(reaches(t.pc1, '192.168.1.254')).toBe(true);
    expect(ios(t.r1, 'show vrrp brief')).toMatch(/Gi0\/0\s+10\s+110 3570\s+Y  Master  192\.168\.1\.2\s+192\.168\.1\.254/);
    expect(ios(t.r2, 'show vrrp brief')).toMatch(/Gi0\/0\s+10\s+100 3609\s+Y  Backup  192\.168\.1\.2\s+192\.168\.1\.254/);
    const detail = ios(t.r2, 'show vrrp');
    expect(detail).toContain('State is Backup');
    expect(detail).toContain('Virtual MAC address is 0000.5e00.010a');
    expect(detail).toContain('Preemption enabled');
    expect(detail).toContain('Master Router is 192.168.1.2, priority is 110');
    expect(ios(t.r1, 'show vrrp')).toContain('Master Router is 192.168.1.2 (local), priority is 110');
    expect(t.r1.log).toContain('%VRRP-6-STATECHANGE: Gi0/0 Grp 10 state Backup -> Master');
  });

  it('only the master advertises, from the virtual MAC', () => {
    const adverts = t.net.trace.filter((e) => e.frame.payload.kind === 'vrrp');
    expect(adverts.length).toBeGreaterThan(0);
    expect(adverts.every((e) => e.frame.src === '0000.5e00.010a' && e.frame.payload.kind === 'vrrp' && e.frame.payload.src === '192.168.1.2')).toBe(true);
    const frame = adverts.at(-1)!.frame;
    expect(summarize(frame)).toMatchObject({ protocol: 'VRRP', info: 'Announcement (v2), VRID 10, Prio 110, Addr 192.168.1.254' });
    expect(dissect(frame).map((l) => l.title)).toContain('Virtual Router Redundancy Protocol');
  });

  it('fails over to the backup and preempts back', () => {
    reaches(t.pc1, '172.16.0.10');
    ios(t.r1, 'conf t\nint g0/0\nshutdown');
    expect(state(t.r1)).toBe('Init');
    expect(state(t.r2)).toBe('Master');
    expect(reaches(t.pc1, '172.16.0.10')).toBe(true);
    ios(t.r1, 'conf t\nint g0/0\nno shutdown');
    expect(state(t.r1)).toBe('Master');
    expect(state(t.r2)).toBe('Backup');
  });

  it('waits without preemption, and the address owner always wins', () => {
    ios(t.r1, 'conf t\nint g0/0\nno vrrp 10 preempt\nshutdown');
    ios(t.r1, 'conf t\nint g0/0\nno shutdown');
    expect(state(t.r2)).toBe('Master');
    expect(state(t.r1)).toBe('Backup');
    expect(ios(t.r1, 'show running-config')).toContain(' vrrp 10 ip 192.168.1.254\n vrrp 10 priority 110\n no vrrp 10 preempt');
    // R2 owns the virtual address as its real one: priority 255.
    ios(t.r2, 'conf t\nint g0/0\nvrrp 10 ip 192.168.1.3');
    ios(t.r1, 'conf t\nint g0/0\nvrrp 10 ip 192.168.1.3');
    expect(t.r2.vrrp.priority(t.r2.vrrp.groups()[0]!)).toBe(255);
    expect(state(t.r2)).toBe('Master');
    expect(ios(t.r2, 'show vrrp')).toContain('Priority is 255 (IP address owner)');
  });

  it('validates its settings', () => {
    const cli = new CliSession(t.r1);
    for (const l of ['enable', 'conf t', 'int g0/0']) cli.execute(l);
    expect(cli.execute('vrrp 2 ip 10.9.9.9')).toBe('% Address 10.9.9.9 in group 2 not within a subnet on this interface');
    expect(cli.execute('vrrp 0 ip 192.168.1.250')).toContain('% Invalid input');
    expect(cli.execute('vrrp 10 priority 255')).toContain('% Invalid input');
    expect(cli.execute('vrrp 10 bogus')).toContain('% Invalid input');
    expect(cli.execute('no vrrp 10 bogus')).toContain('% Invalid input');
    cli.execute('vrrp 10 description Users');
    cli.execute('vrrp 10 preempt');
    expect(cli.execute('do show vrrp')).toContain('  Users');
    for (const kw of ['description', 'priority', 'ip']) cli.execute(`no vrrp 10 ${kw}`);
    expect(t.r1.iface('g0/0').vrrp![0]).toMatchObject({ priority: 100, vip: undefined, description: undefined });
    expect(state(t.r1)).toBe('Init');
    expect(cli.execute('no vrrp 99 preempt')).toBe('');
    cli.execute('no vrrp 10');
    expect(t.r1.iface('g0/0').vrrp).toEqual([]);
  });
});

describe('GLBP', () => {
  let t: ReturnType<typeof campus>;
  beforeEach(() => {
    t = campus();
    ios(t.r1, 'conf t\nint g0/0\nglbp 1 ip 192.168.1.254\nglbp 1 priority 110\nglbp 1 preempt');
    ios(t.r2, 'conf t\nint g0/0\nglbp 1 ip');
  });

  it('elects an AVG and gives each router a forwarder', () => {
    const [g1, g2] = [t.r1.glbp.groups()[0]!, t.r2.glbp.groups()[0]!];
    expect(g1.state).toBe('Active');
    expect(g2.state).toBe('Standby');
    expect(t.r2.glbp.vip(g2)).toBe('192.168.1.254');
    expect(g1.forwarders).toEqual([
      { number: 1, primary: '192.168.1.2', owner: '192.168.1.2' },
      { number: 2, primary: '192.168.1.3', owner: '192.168.1.3' },
    ]);
    expect(g2.forwarders).toEqual(g1.forwarders);
    expect(glbpVirtualMac(1, 2)).toBe('0007.b400.0102');
    const brief = ios(t.r1, 'show glbp brief');
    expect(brief).toMatch(/Gi0\/0\s+1\s+-\s+110 Active\s+192\.168\.1\.254\s+local\s+192\.168\.1\.3/);
    expect(brief).toMatch(/Gi0\/0\s+1\s+1\s+-\s+Active\s+0007\.b400\.0101\s+local\s+-/);
    expect(brief).toMatch(/Gi0\/0\s+1\s+2\s+-\s+Listen\s+0007\.b400\.0102\s+192\.168\.1\.3\s+-/);
    expect(t.r2.log).toContain('%GLBP-6-FWDSTATECHANGE: GigabitEthernet0/0 Grp 1 Fwd 2 state Listen -> Active');
    expect(t.r1.log).toContain('%GLBP-6-STATECHANGE: GigabitEthernet0/0 Grp 1 state Speak -> Active');
  });

  it('load-balances hosts across both gateways with round robin', () => {
    expect(reaches(t.pc1, '172.16.0.10')).toBe(true);
    expect(reaches(t.pc2, '172.16.0.10')).toBe(true);
    const macs = [t.pc1.arpCache.get('192.168.1.254'), t.pc2.arpCache.get('192.168.1.254')];
    expect(new Set(macs)).toEqual(new Set(['0007.b400.0101', '0007.b400.0102']));
    expect(reaches(t.pc2, '192.168.1.254')).toBe(true);
    const detail = ios(t.r1, 'show glbp');
    expect(detail).toContain('Load balancing: round-robin');
    expect(detail).toContain('There are 2 forwarders (1 active)');
    expect(detail).toContain('Active is 192.168.1.3');
    const hello = t.net.trace.filter((e) => e.frame.payload.kind === 'udp' && e.frame.payload.glbp).at(-1)!.frame;
    expect(summarize(hello).protocol).toBe('GLBP');
    expect(dissect(hello).map((l) => l.title)).toContain('Gateway Load Balancing Protocol');
  });

  it('takes over a failed forwarder and hands it back', () => {
    reaches(t.pc1, '172.16.0.10');
    reaches(t.pc2, '172.16.0.10');
    ios(t.r2, 'conf t\nint g0/0\nshutdown');
    const g1 = t.r1.glbp.groups()[0]!;
    expect(g1.forwarders.map((f) => f.owner)).toEqual(['192.168.1.2', '192.168.1.2']);
    expect(reaches(t.pc1, '172.16.0.10')).toBe(true);
    expect(reaches(t.pc2, '172.16.0.10')).toBe(true);
    expect(ios(t.r1, 'show glbp')).toContain('(secondary)');
    ios(t.r2, 'conf t\nint g0/0\nno shutdown');
    expect(g1.forwarders.map((f) => f.owner)).toEqual(['192.168.1.2', '192.168.1.3']);
    // The AVG fails: R2 becomes AVG and forwards for both MACs.
    ios(t.r1, 'conf t\nint g0/0\nshutdown');
    const g2 = t.r2.glbp.groups()[0]!;
    expect(g2.state).toBe('Active');
    expect(g2.forwarders.map((f) => f.owner)).toEqual(['192.168.1.3', '192.168.1.3']);
    expect(reaches(t.pc1, '172.16.0.10')).toBe(true);
    expect(reaches(t.pc2, '172.16.0.10')).toBe(true);
  });

  it('supports host-dependent and weighted load balancing', () => {
    ios(t.r1, 'conf t\nint g0/0\nglbp 1 load-balancing host-dependent');
    const g1 = t.r1.glbp.groups()[0]!;
    const a = t.r1.glbp.activeMacFor(t.r1.iface('g0/0'), '192.168.1.254', '0011.2233.4401');
    expect(t.r1.glbp.activeMacFor(t.r1.iface('g0/0'), '192.168.1.254', '0011.2233.4401')).toBe(a);
    ios(t.r1, 'conf t\nint g0/0\nglbp 1 load-balancing weighted\nglbp 1 weighting 200');
    const picks = Array.from({ length: 6 }, () => t.r1.glbp.activeMacFor(t.r1.iface('g0/0'), '192.168.1.254', '0011.2233.4401'));
    expect(picks.filter((m) => m === '0007.b400.0101').length).toBeGreaterThanOrEqual(4);
    expect(g1.config.weighting).toBe(200);
    expect(t.r1.glbp.activeMacFor(t.r1.iface('g0/0'), '192.168.1.99')).toBeUndefined();
    const cfg = ios(t.r1, 'show running-config');
    expect(cfg).toContain(' glbp 1 ip 192.168.1.254\n glbp 1 priority 110\n glbp 1 preempt\n glbp 1 weighting 200\n glbp 1 load-balancing weighted');
  });

  it('validates its settings', () => {
    const cli = new CliSession(t.r1);
    for (const l of ['enable', 'conf t', 'int g0/0']) cli.execute(l);
    expect(cli.execute('glbp 2 ip 10.9.9.9')).toBe('% Address 10.9.9.9 in group 2 not within a subnet on this interface');
    expect(cli.execute('glbp 1 load-balancing random')).toContain('% Invalid input');
    expect(cli.execute('glbp 1 bogus')).toContain('% Invalid input');
    expect(cli.execute('no glbp 1 bogus')).toContain('% Invalid input');
    for (const kw of ['priority', 'preempt', 'weighting', 'load-balancing', 'ip']) cli.execute(`no glbp 1 ${kw}`);
    expect(t.r1.iface('g0/0').glbp![0]).toMatchObject({ priority: 100, preempt: false, weighting: 100, loadBalancing: 'round-robin', vip: undefined });
    expect(cli.execute('no glbp 7 preempt')).toBe('');
    cli.execute('no glbp 1');
    expect(t.r1.iface('g0/0').glbp).toEqual([]);
    const sw = new CliSession(t.sw);
    for (const l of ['enable', 'conf t', 'int g0/1']) sw.execute(l);
    expect(sw.execute('glbp 1 ip 192.168.1.254')).toContain('% Invalid input');
  });
});
