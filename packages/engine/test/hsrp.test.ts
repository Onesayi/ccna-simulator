import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, hsrpVirtualMac, resetMacAllocator } from '../src';
import { ios } from './helpers';

/**
 * PC1 on a LAN with two gateways, R1 and R2, both uplinked to R3 which has a server behind it.
 * OSPF runs between the routers so traffic back to the LAN follows whichever router is still up.
 */
function campus() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const r3 = net.add(new Router('R3'));
  const pc = net.add(new Pc('PC1'));
  const srv = net.add(new Pc('SRV'));
  net.connect(pc.nic, sw.iface('g0/1'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/2'));
  net.connect(r2.iface('g0/0'), sw.iface('g0/3'));
  net.connect(r1.iface('g0/1'), r3.iface('g0/0'));
  net.connect(r2.iface('g0/1'), r3.iface('g0/1'));
  net.connect(srv.nic, r3.iface('g0/2'));
  pc.configure('192.168.1.10', 24, '192.168.1.254');
  srv.configure('172.16.0.10', 24, '172.16.0.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.2 255.255.255.0\nno shut\nint g0/1\nip address 10.0.13.1 255.255.255.252\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  ios(r2, 'conf t\nint g0/0\nip address 192.168.1.3 255.255.255.0\nno shut\nint g0/1\nip address 10.0.23.1 255.255.255.252\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  ios(r3, 'conf t\nint g0/0\nip address 10.0.13.2 255.255.255.252\nno shut\nint g0/1\nip address 10.0.23.2 255.255.255.252\nno shut\nint g0/2\nip address 172.16.0.1 255.255.255.0\nno shut\nrouter ospf 1\nnetwork 0.0.0.0 255.255.255.255 area 0');
  return { net, sw, r1, r2, r3, pc, srv };
}

function reaches(pc: Pc, dst: string): boolean {
  pc.ping(dst, 3, 1000);
  pc.network!.run();
  const r = pc.ping(dst, 2, 1000);
  pc.network!.run();
  return r.every((x) => x.success);
}

function state(r: Router, group = 1) {
  return r.hsrp.groups().find((g) => g.config.group === group)?.state;
}

describe('HSRP', () => {
  let t: ReturnType<typeof campus>;
  beforeEach(() => {
    t = campus();
    ios(t.r1, 'conf t\nint g0/0\nstandby 1 ip 192.168.1.254\nstandby 1 priority 110\nstandby 1 preempt');
    ios(t.r2, 'conf t\nint g0/0\nstandby 1 ip 192.168.1.254');
  });

  it('elects an active and a standby router and answers for the virtual IP', () => {
    expect(state(t.r1)).toBe('Active');
    expect(state(t.r2)).toBe('Standby');
    expect(reaches(t.pc, '172.16.0.10')).toBe(true);
    expect(t.pc.arpCache.get('192.168.1.254')).toBe('0000.0c07.ac01');
    expect(reaches(t.pc, '192.168.1.254')).toBe(true);

    const brief = ios(t.r1, 'show standby brief');
    expect(brief).toMatch(/Gi0\/0\s+1\s+110 P Active\s+local\s+192\.168\.1\.3\s+192\.168\.1\.254/);
    expect(ios(t.r2, 'show standby brief')).toMatch(/Gi0\/0\s+1\s+100\s+Standby\s+192\.168\.1\.2\s+local\s+192\.168\.1\.254/);
    const detail = ios(t.r1, 'show standby');
    expect(detail).toContain('State is Active');
    expect(detail).toContain('Active virtual MAC address is 0000.0c07.ac01 (MAC In Use)');
    expect(detail).toContain('Preemption enabled');
    expect(detail).toContain('Standby router is 192.168.1.3, priority 100');
    expect(t.r1.log).toContain('%HSRP-5-STATECHANGE: GigabitEthernet0/0 Grp 1 state Standby -> Active');
    expect(t.r2.log).toContain('%HSRP-5-STATECHANGE: GigabitEthernet0/0 Grp 1 state Speak -> Standby');
  });

  it('fails over to the standby router and preempts back', () => {
    reaches(t.pc, '172.16.0.10');
    ios(t.r1, 'conf t\nint g0/0\nshutdown');
    expect(state(t.r1)).toBe('Init');
    expect(state(t.r2)).toBe('Active');
    expect(t.r2.log).toContain('%HSRP-5-STATECHANGE: GigabitEthernet0/0 Grp 1 state Standby -> Active');
    expect(reaches(t.pc, '172.16.0.10')).toBe(true);
    // The PC never re-ARPs: the virtual MAC moved with the role.
    expect(t.pc.arpCache.get('192.168.1.254')).toBe('0000.0c07.ac01');

    ios(t.r1, 'conf t\nint g0/0\nno shutdown');
    expect(state(t.r1)).toBe('Active');
    expect(state(t.r2)).toBe('Standby');
    expect(reaches(t.pc, '172.16.0.10')).toBe(true);
  });

  it('does not take over without preempt', () => {
    ios(t.r1, 'conf t\nint g0/0\nno standby 1 preempt\nshutdown');
    ios(t.r1, 'conf t\nint g0/0\nno shutdown');
    expect(state(t.r2)).toBe('Active');
    expect(state(t.r1)).toBe('Standby');
    expect(ios(t.r1, 'show standby')).toContain('Preemption disabled');
  });

  it('lowers the priority when a tracked interface goes down', () => {
    ios(t.r1, 'conf t\nint g0/0\nstandby 1 track g0/1 decrement 20');
    ios(t.r2, 'conf t\nint g0/0\nstandby 1 preempt');
    expect(state(t.r1)).toBe('Active');
    ios(t.r1, 'conf t\nint g0/1\nshutdown');
    expect(t.r1.hsrp.priority(t.r1.hsrp.groups()[0]!)).toBe(90);
    expect(state(t.r2)).toBe('Active');
    expect(ios(t.r1, 'show standby')).toContain('Track interface GigabitEthernet0/1 state Down decrement 20');
    expect(reaches(t.pc, '172.16.0.10')).toBe(true);
    ios(t.r1, 'conf t\nint g0/1\nno shutdown');
    expect(state(t.r1)).toBe('Active');
  });

  it('breaks a priority tie on the higher interface address', () => {
    ios(t.r1, 'conf t\nint g0/0\nno standby 1 priority');
    ios(t.r2, 'conf t\nint g0/0\nstandby 1 preempt');
    expect(state(t.r2)).toBe('Active');
  });

  it('learns the virtual IP from the active router and warns about a different one', () => {
    ios(t.r2, 'conf t\nint g0/0\nno standby 1\nstandby 1 ip');
    expect(state(t.r2)).toBe('Standby');
    expect(t.r2.hsrp.vip(t.r2.hsrp.groups()[0]!)).toBe('192.168.1.254');
    ios(t.r2, 'conf t\nint g0/0\nstandby 1 ip 192.168.1.253');
    expect(t.r2.log.join('\n')).toContain('%HSRP-4-DIFFVIP1: GigabitEthernet0/0 Grp 1 active routers virtual IP address 192.168.1.254 is different to the locally configured address 192.168.1.253');
  });

  it('uses the version 2 virtual MAC and needs matching versions', () => {
    expect(hsrpVirtualMac(2, 1)).toBe('0000.0c9f.f001');
    ios(t.r1, 'conf t\nint g0/0\nstandby version 2');
    // Version 1 and 2 hellos go to different groups, so both routers think they are alone.
    expect(state(t.r1)).toBe('Active');
    expect(state(t.r2)).toBe('Active');
    ios(t.r2, 'conf t\nint g0/0\nstandby version 2');
    expect(state(t.r2)).toBe('Standby');
    expect(ios(t.r1, 'show standby')).toContain('Local virtual MAC address is 0000.0c9f.f001 (v2 default)');
    expect(reaches(t.pc, '172.16.0.10')).toBe(true);
  });

  it('shows up in the running config', () => {
    ios(t.r1, 'conf t\nint g0/0\nstandby 1 track g0/1 30');
    const cfg = ios(t.r1, 'show running-config');
    expect(cfg).toContain(' standby 1 ip 192.168.1.254\n standby 1 priority 110\n standby 1 preempt\n standby 1 track GigabitEthernet0/1 30');
    ios(t.r2, 'conf t\nint g0/0\nstandby version 2\nstandby ip 192.168.1.254');
    expect(ios(t.r2, 'show running-config')).toContain(' standby version 2\n standby ip 192.168.1.254\n standby 1 ip 192.168.1.254');
  });

  it('rejects bad virtual addresses and settings', () => {
    const cli = new CliSession(t.r1);
    for (const l of ['enable', 'conf t', 'int g0/0']) cli.execute(l);
    expect(cli.execute('standby 2 ip 10.9.9.9')).toBe('% Address 10.9.9.9 in group 2 not within a subnet on this interface');
    expect(cli.execute('standby 2 ip 192.168.1.2')).toBe('% address cannot equal interface IP address');
    expect(cli.execute('standby 300 ip 192.168.1.250')).toContain('% Invalid input');
    expect(cli.execute('standby 1 timers 1 3')).toContain('% Invalid input');
    expect(cli.execute('no standby 1 bogus')).toContain('% Invalid input');
    cli.execute('standby version 2');
    cli.execute('standby 300 ip 192.168.1.250');
    expect(cli.execute('standby version 1')).toBe('% Group numbers above 255 need HSRP version 2');
    cli.execute('no standby 300');
    cli.execute('no standby version');
    expect(t.r1.iface('g0/0').hsrp!.version).toBe(1);
    cli.execute('standby 1 track g0/1');
    cli.execute('no standby 1 track g0/1');
    cli.execute('standby 1 track g0/1 5');
    cli.execute('no standby 1 track');
    expect(t.r1.iface('g0/0').hsrp!.groups[0]!.tracks).toEqual([]);
    cli.execute('no standby 1 ip');
    expect(state(t.r1)).toBe('Listen');
    expect(cli.execute('no standby 9 preempt')).toBe('');
    cli.execute('end');
    expect(cli.execute('show standby brief')).toContain('Listen');
  });
});
