import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, classify, parseStormLevel, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** PC1 (the noisy one), PC2 and PC3 on one switch, and R1 as the IPv6 router. */
function lan() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const [pc1, pc2, pc3] = ['PC1', 'PC2', 'PC3'].map((n) => net.add(new Pc(n)));
  net.connect(pc1!.nic, sw.iface('g0/1'));
  net.connect(pc2!.nic, sw.iface('g0/2'));
  net.connect(pc3!.nic, sw.iface('g0/3'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  pc1!.configure('192.168.1.11', 24);
  pc2!.configure('192.168.1.12', 24);
  pc3!.configure('192.168.1.13', 24);
  net.converge();
  return { net, sw, r1, pc1: pc1!, pc2: pc2!, pc3: pc3! };
}

function received(pc: Pc, send: () => void): number {
  const before = pc.nic.counters.in;
  send();
  pc.network!.run();
  return pc.nic.counters.in - before;
}

describe('storm control', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('floods everything without it', () => {
    expect(received(t.pc2, () => t.pc1.flood('broadcast', 500))).toBe(500);
  });

  it('drops broadcasts over the threshold and recovers when the storm ends', () => {
    ios(t.sw, 'conf t\nint g0/1\nstorm-control broadcast level 1.00 0.50');
    const shell = new PcShell(t.pc1);
    const got = received(t.pc2, () => expect(shell.execute('flood broadcast -n 500')).toBe('Sent 500 broadcast frames in 1 second (500 pps).'));
    expect(got).toBeLessThanOrEqual(25);
    expect(t.sw.log.join('\n')).toContain('%STORM_CONTROL-3-FILTERED: A broadcast storm detected on Gi0/1. A packet filter action has been applied on the interface.');
    const show = ios(t.sw, 'show storm-control');
    expect(show).toMatch(/Gi0\/1\s+Blocking\s+1\.00%\s+0\.50%/);
    // Multicast is not limited, and a quiet second lets broadcasts through again.
    expect(received(t.pc2, () => t.pc1.flood('multicast', 100))).toBe(100);
    expect(received(t.pc2, () => t.pc1.flood('broadcast', 5))).toBe(5);
    expect(ios(t.sw, 'show storm-control g0/1 broadcast')).toMatch(/Gi0\/1\s+Forwarding/);
    expect(t.sw.storm.dropped(t.sw.iface('g0/1'))).toBeGreaterThan(400);
  });

  it('counts packets per second with the pps form, and per class', () => {
    ios(t.sw, 'conf t\nint g0/1\nstorm-control multicast level pps 50\nstorm-control unicast level pps 1k');
    expect(received(t.pc2, () => t.pc1.flood('multicast', 200))).toBeLessThanOrEqual(100);
    expect(ios(t.sw, 'show storm-control multicast')).toMatch(/Gi0\/1\s+Blocking\s+50 pps\s+50 pps/);
    expect(received(t.pc2, () => t.pc1.flood('unicast', 200))).toBe(200);
    expect(ios(t.sw, 'show storm-control unicast')).toMatch(/1000 pps/);
    expect(classify({ src: 'a', dst: '0100.5e00.0001', payload: { kind: 'arp' } as never })).toBe('multicast');
  });

  it('err-disables the port with action shutdown, and recovers on a timer', () => {
    ios(t.sw, 'conf t\nint g0/1\nstorm-control broadcast level 5\nstorm-control action shutdown\nexit\nerrdisable recovery cause storm-control\nerrdisable recovery interval 30');
    t.pc1.flood('broadcast', 300);
    t.net.run();
    expect(t.sw.iface('g0/1').errDisabled).toBe('storm-control');
    expect(t.sw.log.join('\n')).toContain('%STORM_CONTROL-3-SHUTDOWN: A packet storm was detected on Gi0/1. The interface has been disabled.');
    expect(ios(t.sw, 'show storm-control')).toMatch(/Gi0\/1\s+Link Down/);
    expect(ios(t.sw, 'show running-config')).toContain(' storm-control broadcast level 5.00\n storm-control action shutdown');
    // Let the virtual clock run past the recovery interval.
    t.pc2.ping('192.168.1.13', 20, 2000);
    t.net.run();
    t.net.scheduler.schedule(31_000, 'wait', () => {});
    t.net.run();
    t.net.converge();
    expect(t.sw.iface('g0/1').errDisabled).toBeUndefined();
  });

  it('sends a trap with action trap and can be removed', () => {
    ios(t.sw, 'conf t\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut\nexit\nsnmp-server community public ro\nsnmp-server enable traps\nsnmp-server host 192.168.1.12 version 2c public\nint g0/1\nstorm-control broadcast level pps 10\nstorm-control action trap');
    t.pc1.flood('broadcast', 100);
    t.net.run();
    expect(t.sw.snmp.stats.traps).toBeGreaterThan(0);
    ios(t.sw, 'conf t\nint g0/1\nno storm-control action\nno storm-control broadcast level');
    expect(t.sw.iface('g0/1').stormControl).toBeUndefined();
    expect(received(t.pc2, () => t.pc1.flood('broadcast', 50))).toBe(50);
  });

  it('validates levels', () => {
    expect(parseStormLevel(['pps', '2k', '1k'])).toEqual({ unit: 'pps', rising: 2000, falling: 1000 });
    expect(parseStormLevel(['pps', '1m'])).toMatchObject({ rising: 1_000_000 });
    const cli = new CliSession(t.sw);
    for (const l of ['enable', 'conf t', 'int g0/1']) cli.execute(l);
    expect(cli.execute('storm-control broadcast level 101')).toContain('% Invalid input');
    expect(cli.execute('storm-control broadcast level 1 2')).toBe('% Falling threshold cannot be greater than rising threshold');
    expect(cli.execute('storm-control broadcast level abc')).toContain('% Invalid input');
    expect(cli.execute('storm-control broadcast level')).toContain('% Invalid input');
    expect(cli.execute('storm-control broadcast level 1 1 1')).toContain('% Invalid input');
    expect(cli.execute('storm-control everything level 1')).toContain('% Invalid input');
    expect(cli.execute('storm-control action reboot')).toContain('% Invalid input');
    expect(cli.execute('no storm-control broadcast level')).toBe('');
    cli.execute('exit');
    cli.execute('int vlan 1');
    expect(cli.execute('storm-control broadcast level 1')).toContain('% Invalid input');
    const r = new CliSession(t.r1);
    for (const l of ['enable', 'conf t', 'int g0/0']) r.execute(l);
    expect(r.execute('storm-control broadcast level 1')).toContain('% Invalid input');
  });
});

describe('RA guard', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => {
    t = lan();
    ios(t.r1, 'conf t\nipv6 unicast-routing\nint g0/0\nipv6 address 2001:db8:1::1/64\nno shut');
    t.pc2.autoconfigureIpv6();
    t.net.converge();
  });

  const rogue = (pc: Pc) => pc.ipv6.globals(pc.nic).some((a) => a.address.startsWith('2001:db8:bad:'));

  it('lets a rogue router advertisement through without it', () => {
    expect(t.pc2.ipv6.globals(t.pc2.nic)[0]!.address).toMatch(/^2001:db8:1:/);
    expect(new PcShell(t.pc1).execute('fake_router6 2001:db8:bad::/64')).toContain('Starting to advertise router FE80::');
    expect(rogue(t.pc2)).toBe(true);
  });

  it('drops RAs on host ports and keeps them on the router port', () => {
    ios(t.sw, 'conf t\nipv6 nd raguard policy HOSTS\ndevice-role host\nexit\nipv6 nd raguard policy ROUTER\ndevice-role router\nint range g0/1 - 3\nipv6 nd raguard attach-policy HOSTS\nint g0/8\nipv6 nd raguard attach-policy ROUTER');
    t.pc1.rogueRouterAdvert('2001:db8:bad::', 64);
    t.net.converge();
    expect(rogue(t.pc2)).toBe(false);
    expect(t.sw.raGuardPolicies.get('HOSTS')!.dropped).toBe(1);
    // The real router still advertises.
    t.pc3.autoconfigureIpv6();
    t.net.converge();
    expect(t.pc3.ipv6.globals(t.pc3.nic)[0]!.address).toMatch(/^2001:db8:1:/);
    const show = ios(t.sw, 'show ipv6 nd raguard policy HOSTS');
    expect(show).toContain('device-role host');
    expect(show).toMatch(/Gi0\/1\s+PORT  HOSTS\s+RA guard       vlan all/);
    expect(ios(t.sw, 'show ipv6 nd raguard policy')).toContain('Policy ROUTER configuration');
    const cfg = ios(t.sw, 'show running-config');
    expect(cfg).toContain('ipv6 nd raguard policy HOSTS\n device-role host\n!');
    expect(cfg).toContain(' ipv6 nd raguard attach-policy HOSTS');
  });

  it('attaches the default host policy and refuses unknown or busy policies', () => {
    ios(t.sw, 'conf t\nint g0/1\nipv6 nd raguard attach-policy');
    t.pc1.rogueRouterAdvert('2001:db8:bad::', 64);
    t.net.run();
    expect(rogue(t.pc2)).toBe(false);
    expect(ios(t.sw, 'show running-config')).toContain(' ipv6 nd raguard attach-policy\n');
    const cli = new CliSession(t.sw);
    for (const l of ['enable', 'conf t']) cli.execute(l);
    expect(cli.execute('ipv6 nd raguard policy P1')).toBe('');
    expect(cli.prompt).toBe('SW1(config-ra-guard)#');
    expect(cli.execute('device-role switch')).toContain('% Invalid input');
    cli.execute('int g0/2');
    expect(cli.execute('ipv6 nd raguard attach-policy NOPE')).toBe('% Policy NOPE not found');
    cli.execute('ipv6 nd raguard attach-policy P1');
    expect(cli.execute('no ipv6 nd raguard policy P1')).toBe('% Policy P1 is in use; detach it first');
    cli.execute('int g0/2');
    cli.execute('no ipv6 nd raguard attach-policy P1');
    expect(cli.execute('no ipv6 nd raguard policy P1')).toBe('');
    cli.execute('int g0/1');
    cli.execute('no ipv6 nd raguard attach-policy');
    expect(t.sw.iface('g0/1').raGuard).toBeUndefined();
    cli.execute('end');
    expect(cli.execute('show ipv6 nd raguard policy P1')).toBe('% Policy P1 not found');
  });

  it('PC tools check their arguments', () => {
    const shell = new PcShell(t.pc1);
    expect(shell.execute('fake_router6 nonsense')).toBe('Usage: fake_router6 <prefix>/64');
    expect(shell.execute('flood storm')).toBe('Usage: flood broadcast|multicast|unicast [-n count]');
    expect(shell.execute('flood broadcast -n 0')).toBe('Bad value for option -n (1-5000).');
    t.pc1.nic.adminUp = false;
    expect(shell.execute('flood broadcast')).toBe('Ethernet0 is not connected.');
    expect(shell.execute('fake_router6 2001:db8::/64')).toBe('Ethernet0 is not connected.');
  });
});
