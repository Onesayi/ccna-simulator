import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, compileFilter, dissect, dscpName, parseDscp, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** PC1 (a softphone) on SW1, then R1 and a WAN link to R2 with the server behind it. */
function wan() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const pc = net.add(new Pc('PC1'));
  const srv = net.add(new Pc('SRV'));
  net.connect(pc.nic, sw.iface('g0/1'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(srv.nic, r2.iface('g0/0'));
  pc.configure('192.168.1.10', 24, '192.168.1.1');
  srv.configure('172.16.0.10', 24, '172.16.0.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.0.1 255.255.255.252\nbandwidth 10000\nno shut\nip route 0.0.0.0 0.0.0.0 10.0.0.2');
  ios(r2, 'conf t\nint g0/0\nip address 172.16.0.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.0.2 255.255.255.252\nno shut\nip route 192.168.1.0 255.255.255.0 10.0.0.1');
  return { net, sw, r1, r2, pc, srv };
}

/** The DSCP of the last echo request that reached `dst`. */
function arrived(net: Topology, dst: string): number | undefined {
  const e = [...net.trace].reverse().find((x) => x.frame.payload.kind === 'icmp' && x.frame.payload.type === 'echo-request' && x.frame.payload.dst === dst);
  const p = e?.frame.payload;
  return p && 'ttl' in p ? (p.dscp ?? 0) : undefined;
}

describe('QoS marking and trust', () => {
  let t: ReturnType<typeof wan>;
  beforeEach(() => (t = wan()));

  it('names DSCP values', () => {
    expect(parseDscp('EF')).toBe(46);
    expect(parseDscp('af41')).toBe(34);
    expect(parseDscp('cs5')).toBe(40);
    expect(parseDscp('18')).toBe(18);
    expect(() => parseDscp('64')).toThrow();
    expect(dscpName(26)).toBe('af31');
    expect(dscpName(5)).toBe('5');
  });

  it('carries a host marking end to end while the switch has QoS off', () => {
    t.pc.marking = 46;
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(46);
    const frame = [...t.net.trace].reverse().find((x) => x.frame.payload.kind === 'icmp')!.frame;
    expect(dissect(frame)[1]!.fields[0]).toEqual(['Differentiated Services Field', '0xb8 (DSCP: EF, ECN: Not-ECT)']);
    expect(compileFilter('ip.dsfield.dscp == 46')(frame)).toBe(true);
    // Windows ping -v sets the ToS byte directly: 104 is DSCP 26 (AF31).
    t.pc.marking = undefined;
    new PcShell(t.pc).execute('ping -v 104 172.16.0.10');
    expect(arrived(t.net, '172.16.0.10')).toBe(26);
    expect(new PcShell(t.pc).execute('ping -v 300 172.16.0.10')).toBe('Bad value for option -v, valid range is from 0 to 255.');
  });

  it('resets markings at an untrusted port once mls qos is on', () => {
    t.pc.marking = 46;
    ios(t.sw, 'conf t\nmls qos');
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(0);
    expect(ios(t.sw, 'show mls qos')).toContain('QoS is enabled');
    expect(ios(t.sw, 'show mls qos interface g0/1')).toContain('trust state: not trusted');
    // Trusting CoS on an access port does not help: untagged frames carry no CoS.
    ios(t.sw, 'conf t\nint g0/1\nmls qos trust cos');
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(0);
    ios(t.sw, 'conf t\nint g0/1\nmls qos trust dscp');
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(46);
    expect(ios(t.sw, 'show running-config')).toMatch(/mls qos\n!/);
    expect(ios(t.sw, 'show running-config')).toContain(' mls qos trust dscp');
    expect(ios(t.sw, 'show mls qos interface')).toContain('trust state: trust dscp');
    ios(t.sw, 'conf t\nint g0/1\nno mls qos trust\nexit\nno mls qos');
    expect(ios(t.sw, 'show mls qos')).toContain('QoS is disabled');
  });

  it('classifies and marks with a policy map on the way in', () => {
    ios(t.r1, `conf t
      ip access-list extended WEB
      permit tcp any any eq 80
      exit
      class-map match-any VOICE
      match dscp ef
      class-map match-any PINGS
      match protocol icmp
      class-map WEB
      match access-group name WEB
      policy-map MARK-IN
      class VOICE
      set dscp ef
      class PINGS
      set dscp af21
      class WEB
      set ip precedence 3
      class class-default
      set dscp default
      int g0/0
      service-policy input MARK-IN`);
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(18);
    t.pc.marking = 46;
    t.pc.ping('172.16.0.10', 3);
    t.net.run();
    expect(arrived(t.net, '172.16.0.10')).toBe(46);
    const stats = ios(t.r1, 'show policy-map interface g0/0');
    expect(stats).toContain('Service-policy input: MARK-IN');
    expect(stats).toMatch(/Class-map: VOICE \(match-any\)\n\s+3 packets, 300 bytes/);
    expect(stats).toMatch(/Class-map: PINGS \(match-any\)\n\s+3 packets/);
    expect(stats).toContain('Match: dscp ef (46)');
    expect(stats).toContain('dscp af21');
    expect(ios(t.r1, 'show class-map')).toContain(' Class Map match-any VOICE (id 1)\n   Match dscp ef (46)');
    expect(ios(t.r1, 'show policy-map MARK-IN')).toContain('    Class WEB\n      set dscp cs3');
    const cfg = ios(t.r1, 'show running-config');
    expect(cfg).toContain('class-map match-any VOICE\n match dscp ef\n!');
    expect(cfg).toContain('class-map match-all WEB\n match access-group name WEB\n!');
    expect(cfg).toContain('policy-map MARK-IN\n class VOICE\n  set dscp ef\n class PINGS\n  set dscp af21');
    expect(cfg).toContain(' service-policy input MARK-IN');
    expect(t.r1.qos.policyMaps.get('MARK-IN')!.classes.at(-1)!.name).toBe('class-default');
  });

  it('checks queuing against the interface bandwidth on the way out', () => {
    const cli = new CliSession(t.r1);
    for (const l of ['enable', 'conf t', 'class-map match-any VOICE', 'match ip dscp ef', 'class-map match-any VIDEO', 'match dscp af41 af42', 'policy-map WAN', 'class VOICE', 'priority percent 30', 'class VIDEO', 'bandwidth 4000', 'class class-default', 'fair-queue', 'exit', 'exit', 'int g0/1']) cli.execute(l);
    expect(cli.execute('service-policy output WAN')).toBe('');
    expect(cli.execute('service-policy input WAN')).toContain('Queueing (priority, bandwidth, fair-queue, shape) is not supported in the input direction');
    expect(cli.execute('service-policy output NOPE')).toBe('% policy map NOPE not configured');
    for (const l of ['policy-map WAN', 'class VIDEO']) cli.execute(l);
    expect(cli.prompt).toBe('R1(config-pmap-c)#');
    expect(cli.execute('bandwidth 8000')).toBe('% I/f GigabitEthernet0/1 class VIDEO requested bandwidth 8000 (kbps), available only 7000 (kbps)');
    expect(t.r1.qos.policyMaps.get('WAN')!.classes[1]!.bandwidth).toEqual({ kbps: 4000 });
    expect(cli.execute('priority 100')).toBe('% Cannot configure priority and bandwidth in the same class');
    cli.execute('exit');
    expect(cli.prompt).toBe('R1(config-pmap)#');
    cli.execute('class VOICE');
    expect(cli.execute('bandwidth percent 5')).toBe('% Cannot configure priority and bandwidth in the same class');
    cli.execute('end');
    const show = cli.execute('show policy-map interface');
    expect(show).toContain('Service-policy output: WAN');
    expect(show).toContain('Priority: 30% (3000 kbps)');
    expect(show).toContain('bandwidth 4000 (4000 kbps)');
    expect(show).toContain('Flow Based Fair Queueing');
    t.pc.marking = 34;
    t.pc.ping('172.16.0.10', 2);
    t.net.run();
    expect(cli.execute('show policy-map interface g0/1')).toMatch(/Class-map: VIDEO \(match-any\)\n\s+2 packets/);
    expect(cli.execute('show policy-map')).toContain('      priority percent 30');
  });

  it('polices a class and drops or re-marks the excess', () => {
    ios(t.r1, 'conf t\nclass-map match-all ICMP\nmatch protocol icmp\npolicy-map LIMIT\nclass ICMP\npolice 8000 conform-action transmit exceed-action drop\nint g0/1\nservice-policy output LIMIT');
    const out = ios(t.r1, 'ping 172.16.0.10 repeat 50');
    expect(out).toMatch(/Success rate is \d+ percent/);
    // The router's own pings are not policed on output; the PC's forwarded ones are.
    const results = t.pc.ping('172.16.0.10', 40, 500);
    t.net.run();
    expect(results.some((r) => !r.success)).toBe(true);
    const show = ios(t.r1, 'show policy-map interface g0/1');
    expect(show).toContain('cir 8000 bps, bc 1500 bytes');
    expect(show).toMatch(/exceeded [1-9]\d* packets/);
    ios(t.r1, 'conf t\npolicy-map LIMIT\nclass ICMP\npolice cir 8000 exceed-action set-dscp-transmit cs1');
    const again = t.pc.ping('172.16.0.10', 40, 500);
    t.net.run();
    expect(again.every((r) => r.success)).toBe(true);
    // The excess arrives re-marked CS1 instead of being dropped.
    expect(t.net.trace.some((x) => x.frame.payload.kind === 'icmp' && x.frame.payload.type === 'echo-request' && x.frame.payload.dst === '172.16.0.10' && x.frame.payload.dscp === 8)).toBe(true);
    expect(ios(t.r1, 'show running-config')).toContain('  police 8000 conform-action transmit exceed-action set-dscp-transmit cs1');
  });

  it('validates the MQC commands', () => {
    const cli = new CliSession(t.r1);
    for (const l of ['enable', 'conf t']) cli.execute(l);
    expect(cli.execute('class-map class-default')).toBe('% class-default is predefined and cannot be changed');
    cli.execute('class-map match-all C1');
    expect(cli.prompt).toBe('R1(config-cmap)#');
    expect(cli.execute('match dscp 99')).toContain('% Invalid input');
    expect(cli.execute('match ip precedence 9')).toContain('% Invalid input');
    expect(cli.execute('match protocol bittorrent')).toContain('% Invalid input');
    expect(cli.execute('match whatever')).toContain('% Invalid input');
    cli.execute('match any');
    cli.execute('match any');
    cli.execute('match access-group 101');
    cli.execute('match ip precedence 5');
    expect(t.r1.qos.classMaps.get('C1')!.matches).toHaveLength(3);
    cli.execute('no match any');
    expect(t.r1.qos.classMaps.get('C1')!.matches).toHaveLength(2);
    cli.execute('exit');
    cli.execute('class-map match-any C1');
    expect(t.r1.qos.classMaps.get('C1')!.matchAll).toBe(false);
    cli.execute('policy-map P');
    expect(cli.execute('class NOPE')).toBe('% class-map NOPE not configured');
    cli.execute('class class-default');
    cli.execute('class C1');
    expect(t.r1.qos.policyMaps.get('P')!.classes.map((c) => c.name)).toEqual(['C1', 'class-default']);
    for (const l of ['set ip dscp af11', 'shape average 64000', 'police 9000 conform-action transmit exceed-action transmit', 'bandwidth remaining percent 20']) expect(cli.execute(l)).toBe('');
    expect(cli.execute('police 9000 exceed-action explode')).toContain('% Invalid input');
    expect(cli.execute('police 9000 bogus')).toContain('% Invalid input');
    expect(cli.execute('bandwidth percent')).toContain('% Invalid input');
    expect(cli.execute('priority remaining percent 5')).toContain('% Invalid input');
    expect(ios(t.r1, 'show policy-map P')).toContain('      bandwidth remaining percent 20\n      shape average 64000\n      police 9000 conform-action transmit exceed-action transmit\n      set dscp af11');
    for (const l of ['no set dscp', 'no shape average 64000', 'no police', 'no bandwidth', 'no fair-queue', 'no priority']) expect(cli.execute(l)).toBe('');
    expect(t.r1.qos.policyMaps.get('P')!.classes[0]).toEqual({ name: 'C1' });
    cli.execute('police 8000');
    cli.execute('no police 8000');
    cli.execute('no class C1');
    expect(cli.prompt).toBe('R1(config-pmap)#');
    cli.execute('exit');
    cli.execute('policy-map P');
    cli.execute('class C1');
    cli.execute('exit');
    expect(cli.execute('no class-map C1')).toBe('% Class-map C1 is being used by policy-map P');
    cli.execute('int g0/0');
    cli.execute('service-policy output P');
    expect(cli.execute('no policy-map P')).toBe('% Policy map P is in use; remove the service-policy first');
    // A global command from interface mode drops back to global config, as on IOS.
    cli.execute('int g0/0');
    expect(cli.execute('service-policy sideways P')).toContain('% Invalid input');
    expect(cli.execute('no service-policy sideways P')).toContain('% Invalid input');
    cli.execute('no service-policy output P');
    expect(cli.execute('no policy-map P')).toBe('');
    expect(cli.execute('no class-map C1')).toBe('');
    expect(cli.execute('do show policy-map NOPE')).toBe('% Policy map NOPE not configured');
    const sw = new CliSession(t.sw);
    for (const l of ['enable', 'conf t']) sw.execute(l);
    expect(sw.execute('policy-map X')).toContain('% Invalid input');
    sw.execute('int g0/1');
    expect(sw.execute('mls qos trust ip-precedence')).toContain('% Invalid input');
    expect(new CliSession(t.r1).execute('show mls qos')).toContain('% Invalid input');
    expect((t.r2 as Router).qos.policyMaps.size).toBe(0);
  });
});
