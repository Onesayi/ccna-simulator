import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Server, ServerShell, Switch, Topology, formatRate, parseFlow, portSpeedMbps, resetMacAllocator, runTraffic, wredThreshold, type FlowResult } from '../src';
import { ios } from './helpers';

/** PHONE (marks EF) and PC2 on SW1, R1, a WAN link to R2 at `speed`, and SRV behind R2. */
function wan(speed = '10') {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const phone = net.add(new Pc('PHONE'));
  const pc = net.add(new Pc('PC2'));
  const srv = net.add(new Pc('SRV'));
  net.connect(phone.nic, sw.iface('g0/1'));
  net.connect(pc.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(srv.nic, r2.iface('g0/0'));
  phone.configure('192.168.1.10', 24, '192.168.1.1');
  pc.configure('192.168.1.20', 24, '192.168.1.1');
  srv.configure('172.16.0.10', 24, '172.16.0.1');
  phone.marking = 46;
  ios(r1, `conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.0.1 255.255.255.252\nspeed ${speed}\nno shut\nip route 0.0.0.0 0.0.0.0 10.0.0.2`);
  ios(r2, `conf t\nint g0/0\nip address 172.16.0.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.0.2 255.255.255.252\nspeed ${speed}\nno shut\nip route 192.168.1.0 255.255.255.0 10.0.0.1`);
  return { net, sw, r1, r2, phone, pc, srv, ph: new PcShell(phone), p2: new PcShell(pc) };
}

function flow(results: FlowResult[], name: string): FlowResult {
  return results.find((r) => r.flow.name === name)!;
}

const WAN_QOS = 'conf t\nclass-map match-any VOICE\nmatch dscp ef\nclass-map match-any CRM\nmatch dscp af21\npolicy-map WAN\nclass VOICE\npriority 1000\nclass CRM\nbandwidth 3000\nclass class-default\nfair-queue\nint g0/1\nservice-policy output WAN';

describe('traffic generator', () => {
  let t: ReturnType<typeof wan>;
  beforeEach(() => {
    t = wan();
    t.ph.execute('traffic add VOICE 172.16.0.10 rate 240 udp 16384 size 200');
    t.p2.execute('traffic add CRM 172.16.0.10 rate 2000 dscp af21 tcp 443');
    t.p2.execute('traffic add BACKUP 172.16.0.10 rate 12000 tcp 445');
  });

  it('manages flows on a host', () => {
    expect(t.p2.execute('traffic')).toContain('CRM          to 172.16.0.10      2.00 Mbps   TCP 443    1500 bytes  DSCP af21');
    expect(t.ph.execute('traffic show')).toContain('DSCP ef');
    expect(t.p2.execute('traffic add CRM 172.16.0.10 rate 1500 dscp af21 tcp 443')).toContain('Flow CRM updated');
    expect(t.pc.flows).toHaveLength(2);
    expect(t.p2.execute('traffic add X 172.16.0.10 rate 100 burst 50 150')).toContain('bursts 50 ms on / 150 ms off');
    expect(t.p2.execute('traffic delete x')).toBe('Flow x deleted.');
    expect(t.p2.execute('traffic delete nope')).toBe('No flow named nope.');
    expect(t.p2.execute('traffic add Y')).toContain('Usage:');
    expect(t.p2.execute('traffic add Y 1.2.3')).toBe('Bad destination 1.2.3: give an IPv4 address.');
    expect(t.p2.execute('traffic add Y 1.2.3.4')).toBe('A flow needs a rate: rate <kbps>.');
    expect(t.p2.execute('traffic add Y 1.2.3.4 rate 0')).toBe('Bad value for rate in kbps (1-1000000).');
    expect(t.p2.execute('traffic add Y 1.2.3.4 rate 5 dscp purple')).toContain('Bad value for dscp');
    expect(t.p2.execute('traffic add Y 1.2.3.4 rate 5 size 9000')).toBe('Bad value for size in bytes (64-1500).');
    expect(t.p2.execute('traffic add Y 1.2.3.4 rate 5 colour red')).toBe('Unknown option colour.');
    expect(t.p2.execute('traffic run 99')).toBe('Bad value for seconds (1-60).');
    expect(t.p2.execute('traffic bogus')).toContain('traffic run [seconds]');
    expect(t.p2.execute('help')).toContain('traffic run [seconds]');
    expect(parseFlow('Z', '10.0.0.1', ['rate', '64', 'dscp', '34', 'udp', '5004'])).toMatchObject({ dscp: 34, port: 5004, protocol: 'udp', size: 1500 });
    expect(t.srv.flows).toHaveLength(0);
    expect(new PcShell(t.srv).execute('traffic')).toContain('No flows on SRV.');
    expect(t.p2.execute('traffic clear')).toBe('All flows on PC2 deleted.');
  });

  it('shares a congested FIFO link equally, then protects voice and CRM with LLQ and CBWFQ', () => {
    const before = t.ph.execute('traffic run');
    expect(before).toContain('Running 3 flows for 10 seconds...');
    expect(before).toContain('R1 Gi0/1 output (10.0 Mbps link, FIFO): offered 14.2 Mbps');
    expect(before).toContain('Voice quality for VOICE: poor');
    const fifo = runTraffic(t.net, { record: false }).flows;
    expect(flow(fifo, 'VOICE').lossPct).toBeCloseTo(flow(fifo, 'BACKUP').lossPct, 0);
    expect(flow(fifo, 'VOICE').lossPct).toBeGreaterThan(25);
    // The FIFO hold queue is 40 packets, and every flow waits behind it.
    expect(flow(fifo, 'VOICE').delayMs).toBeGreaterThan(20);
    const shown = ios(t.r1, 'show interfaces g0/1');
    expect(shown).toContain('txload 255/255');
    expect(shown).toMatch(/Total output drops: [1-9]\d+/);
    expect(shown).toContain('Queueing strategy: fifo');
    expect(shown).toContain('Output queue: 31/40 (size/max)');
    expect(shown).toContain('Full Duplex, 10Mbps, link type is force-up');
    expect(ios(t.r1, 'show interfaces GigabitEthernet 0/1')).toContain('BW 10000 Kbit/sec');

    ios(t.r1, 'clear counters');
    expect(ios(t.r1, 'show interfaces g0/1')).toContain('Total output drops: 0');
    ios(t.r1, WAN_QOS);
    const after = runTraffic(t.net).flows;
    expect(flow(after, 'VOICE').lossPct).toBe(0);
    expect(flow(after, 'VOICE').delayMs).toBeLessThan(1);
    expect(flow(after, 'CRM').lossPct).toBe(0);
    expect(flow(after, 'BACKUP').deliveredBps).toBeGreaterThan(7_500_000);
    expect(flow(after, 'BACKUP').lossPct).toBeGreaterThan(30);
    expect(flow(after, 'VOICE').path).toEqual(['R1 Gi0/1 out', 'R2 Gi0/0 out']);

    const pm = ios(t.r1, 'show policy-map interface g0/1');
    expect(pm).toContain('Class-map: VOICE (match-any)\n      1500 packets, 300000 bytes\n      30 second offered rate 240000 bps, drop rate 0 bps');
    expect(pm).toContain('Priority: Strict, b/w exceed drops: 0');
    expect(pm).toContain('(pkts output/bytes output) 1500/300000');
    expect(pm).toMatch(/Class-map: class-default \(match-any\)\n {6}10000 packets, 15000000 bytes\n {6}30 second offered rate 12000000 bps, drop rate 4\d{6} bps/);
    expect(pm).toMatch(/\(queue depth\/total drops\/no-buffer drops\) \d+\/3\d{3}\/0/);
    expect(pm).toContain('Flow Based Fair Queueing');
    expect(ios(t.r1, 'show interfaces g0/1')).toContain('Queueing strategy: Class-based queueing');
    expect(t.ph.execute('traffic run 5')).toContain('Voice quality for VOICE: good');
  });

  it('polices the priority queue to its rate when the link is congested', () => {
    ios(t.r1, WAN_QOS.replace('priority 1000', 'priority 128'));
    const r = runTraffic(t.net).flows;
    expect(flow(r, 'VOICE').deliveredBps).toBeCloseTo(128_000, -3);
    expect(ios(t.r1, 'show policy-map interface g0/1')).toMatch(/b\/w exceed drops: [1-9]/);
    // With the link idle, the priority class may use more than its rate.
    t.p2.execute('traffic clear');
    expect(flow(runTraffic(t.net).flows, 'VOICE').lossPct).toBe(0);
  });

  it('serves a congested FIFO class in arrival order, and fair-queue evens the flows out', () => {
    t.p2.execute('traffic clear');
    t.p2.execute('traffic add A 172.16.0.10 rate 4000');
    t.p2.execute('traffic add B 172.16.0.10 rate 12000');
    ios(t.r1, 'conf t\npolicy-map PLAIN\nclass class-default\nqueue-limit 100 packets\nint g0/1\nservice-policy output PLAIN');
    const fifo = runTraffic(t.net).flows;
    expect(flow(fifo, 'A').lossPct).toBeCloseTo(flow(fifo, 'B').lossPct, 0);
    expect(ios(t.r1, 'show policy-map interface')).toContain('queue limit 100 packets');
    ios(t.r1, 'conf t\npolicy-map PLAIN\nclass class-default\nqueue-limit 80\nno queue-limit 80 packets\nrandom-detect precedence-based\nno random-detect\nfair-queue\nno queue-limit');
    const fair = runTraffic(t.net).flows;
    expect(flow(fair, 'A').lossPct).toBe(0);
    expect(flow(fair, 'B').deliveredBps).toBeGreaterThan(5_500_000);
  });

  it('drops early with WRED, more for higher drop precedence', () => {
    t.ph.execute('traffic clear');
    t.p2.execute('traffic clear');
    t.p2.execute('traffic add LOW 172.16.0.10 rate 6000 dscp af11');
    t.p2.execute('traffic add HIGH 172.16.0.10 rate 6000 dscp af13');
    ios(t.r1, 'conf t\npolicy-map RED\nclass class-default\nrandom-detect dscp-based\nint g0/1\nservice-policy output RED');
    const r = runTraffic(t.net).flows;
    expect(flow(r, 'HIGH').lossPct).toBeGreaterThan(flow(r, 'LOW').lossPct);
    const shown = ios(t.r1, 'show policy-map interface g0/1');
    expect(shown).toContain('Mean queue depth:');
    expect(shown).toMatch(/af11 +\d+\/\d+ +\d+\/\d+ +\d+\/\d+ +32 +40 +1\/10/);
    expect(shown).toMatch(/af13 +\d+\/\d+ +\d+\/\d+ +\d+\/\d+ +24 +40 +1\/10/);
    // Custom thresholds and precedence-based WRED.
    ios(t.r1, 'conf t\npolicy-map RED\nclass class-default\nrandom-detect dscp af13 10 20\nrandom-detect dscp af11 30 40 5');
    expect(ios(t.r1, 'show running-config')).toContain('  random-detect dscp af11 30 40 5\n  random-detect dscp af13 10 20 10');
    runTraffic(t.net);
    ios(t.r1, 'conf t\npolicy-map RED\nclass class-default\nrandom-detect\nrandom-detect precedence 1 25 35 4');
    expect(ios(t.r1, 'show running-config')).toContain('  random-detect\n  random-detect precedence 1 25 35 4');
    runTraffic(t.net);
    expect(ios(t.r1, 'show policy-map interface g0/1')).toMatch(/\n +1 +\d+\/\d+ +\d+\/\d+ +\d+\/\d+ +25 +35 +1\/4/);
    const cli = new CliSession(t.r1, { loggedIn: true });
    for (const l of ['enable', 'conf t', 'policy-map RED', 'class class-default']) cli.execute(l);
    expect(cli.execute('random-detect precedence 1 30 20')).toContain('Maximum threshold must be greater than the minimum threshold');
    expect(cli.execute('random-detect dscp af11 30 40')).toContain('Enable random-detect dscp-based first');
    cli.execute('no random-detect');
    expect(cli.execute('random-detect dscp af11 30 40')).toBe('');
    cli.execute('exit');
    cli.execute('class-map V');
    cli.execute('policy-map RED');
    cli.execute('class V');
    cli.execute('priority 100');
    expect(cli.execute('random-detect')).toContain('random-detect is not allowed in a priority class');
  });

  it('knows the default WRED thresholds', () => {
    const dscp = { dscpBased: true, thresholds: {} };
    expect(wredThreshold(dscp, 46).min).toBe(36);
    expect(wredThreshold(dscp, 10).min).toBe(32);
    expect(wredThreshold(dscp, 20).min).toBe(28);
    expect(wredThreshold(dscp, 38).min).toBe(24);
    expect(wredThreshold(dscp, 24).min).toBe(26);
    expect(wredThreshold(dscp, 0).min).toBe(20);
    expect(wredThreshold({ dscpBased: false, thresholds: {} }, 46).min).toBe(30);
  });

  it('shapes bursts instead of losing them to a provider policer', () => {
    t = wan('auto');
    t.ph.execute('traffic add VOICE 172.16.0.10 rate 160 udp 16384 size 200');
    t.p2.execute('traffic add DATA 172.16.0.10 rate 8000 tcp 445 burst 100 100');
    ios(t.r2, 'conf t\npolicy-map ISP\nclass class-default\npolice 5000000\nint g0/1\nservice-policy input ISP');
    const policed = runTraffic(t.net).flows;
    expect(flow(policed, 'VOICE').lossPct).toBeGreaterThan(5);
    expect(flow(policed, 'DATA').offeredBps).toBe(4_000_000);
    expect(t.ph.execute('traffic run')).toContain('R2 Gi0/1 input (service-policy ISP)');
    expect(ios(t.r2, 'show policy-map interface g0/1')).toMatch(/exceeded [1-9]\d* packets; actions:\n {10}drop/);

    ios(t.r1, 'conf t\nclass-map match-any VOICE\nmatch dscp ef\npolicy-map CHILD\nclass VOICE\npriority 512\npolicy-map SHAPE\nclass class-default\nshape average 5000000\nservice-policy CHILD\nint g0/1\nservice-policy output SHAPE');
    const shaped = runTraffic(t.net).flows;
    expect(flow(shaped, 'VOICE').lossPct).toBe(0);
    expect(flow(shaped, 'DATA').lossPct).toBe(0);
    expect(flow(shaped, 'DATA').delayMs).toBeGreaterThan(5);
    expect(flow(shaped, 'DATA').jitterMs).toBeGreaterThan(1);
    const shown = ios(t.r1, 'show policy-map interface g0/1');
    expect(shown).toContain('shape (average) cir 5000000, bc 20000, be 20000');
    expect(shown).toContain('      Service-policy : CHILD');
    expect(shown).toContain('        Class-map: VOICE (match-any)\n          1000 packets, 200000 bytes');
    expect(ios(t.r1, 'show running-config')).toContain(' class class-default\n  shape average 5000000\n  service-policy CHILD');
  });

  it('checks child policies against the parent shaper and refuses loops', () => {
    const cli = new CliSession(t.r1, { loggedIn: true });
    const run = (lines: string) => lines.split('\n').map((l) => cli.execute(l)).at(-1)!;
    run('enable\nconf t\nclass-map V\nmatch dscp ef\npolicy-map C\nclass V\npriority 3000\npolicy-map P\nclass class-default\nshape average 2000000');
    expect(run('service-policy NOPE')).toContain('policy map NOPE not configured');
    expect(run('service-policy P')).toContain('cannot be a child of itself');
    expect(run('service-policy C')).toBe('');
    expect(run('exit\nexit\ninterface g0/1\nservice-policy output P')).toContain('requested bandwidth 3000 (kbps), available only 2000 (kbps)');
    run('exit\npolicy-map C\nclass V\npriority 1000\nexit\nexit\ninterface g0/1');
    expect(run('service-policy output P')).toBe('');
    // Growing the child past the shaper is refused while the parent is attached.
    expect(run('exit\npolicy-map C\nclass V\npriority 2500')).toContain('available only 2000');
    expect(run('exit\nexit\nno policy-map C')).toContain('is in use as a child of policy-map P');
    run('policy-map GRAND\nclass class-default\nservice-policy C\nexit\nexit\npolicy-map TOP\nclass class-default');
    expect(run('service-policy GRAND')).toContain('Only two levels of hierarchy are supported');
    run('exit\nexit\ninterface g0/0');
    expect(run('service-policy input GRAND')).toContain('not supported in the input direction');
    run('exit\npolicy-map P\nclass class-default\nno service-policy C');
    expect(ios(t.r1, 'show running-config')).not.toContain('shape average 2000000\n  service-policy C');
  });

  it('re-marks policed traffic and follows the new marking downstream', () => {
    t.ph.execute('traffic clear');
    t.p2.execute('traffic clear');
    t.p2.execute('traffic add APP 172.16.0.10 rate 4000 dscp af11');
    t.p2.execute('traffic add BULK 172.16.0.10 rate 9000');
    ios(t.r1, 'conf t\nclass-map APP\nmatch dscp af11\npolicy-map IN\nclass APP\npolice 2000000 conform-action transmit exceed-action set-dscp-transmit af13\nint g0/0\nservice-policy input IN');
    ios(t.r1, 'conf t\nclass-map HIGHDROP\nmatch dscp af13\npolicy-map OUT\nclass APP\nbandwidth 2500\nclass HIGHDROP\nbandwidth 100\nclass class-default\nint g0/1\nservice-policy output OUT');
    const r = runTraffic(t.net).flows;
    expect(flow(r, 'APP').path).toEqual(['R1 Gi0/0 in', 'R1 Gi0/1 out', 'R2 Gi0/0 out']);
    const shown = ios(t.r1, 'show policy-map interface');
    expect(shown).toMatch(/Class-map: HIGHDROP \(match-all\)\n {6}[1-9]\d* packets/);
    expect(shown).toMatch(/exceeded [1-9]\d* packets; actions:\n {10}set-dscp-transmit af13/);
    // The in-contract half keeps its guarantee; the re-marked half competes with bulk traffic.
    expect(flow(r, 'APP').deliveredBps).toBeGreaterThan(2_000_000);
    expect(flow(r, 'APP').lossPct).toBeGreaterThan(0);
  });

  it('marks on input and polices with transmit or drop', () => {
    t.p2.execute('traffic clear');
    ios(t.r1, 'conf t\nclass-map ANY\nmatch any\npolicy-map MARK\nclass ANY\nset dscp af31\npolice 100000 conform-action transmit exceed-action transmit\nint g0/0\nservice-policy input MARK');
    const r = runTraffic(t.net).flows;
    expect(flow(r, 'VOICE').lossPct).toBe(0);
    expect(ios(t.r1, 'show policy-map interface g0/0')).toContain('Packets marked 1500');
  });

  it('reports flows that cannot get through', () => {
    t.ph.execute('traffic add NOWHERE 10.99.0.1 rate 100');
    t.srv.configure('172.16.0.10', 24);
    const srvShell = new PcShell(t.srv);
    srvShell.execute('traffic add HOME 192.168.1.10 rate 100');
    ios(t.r1, 'conf t\nip access-list extended NO-BACKUP\ndeny tcp any any eq 445\npermit ip any any\nint g0/0\nip access-group NO-BACKUP in');
    const report = runTraffic(t.net, { record: false });
    expect(flow(report.flows, 'NOWHERE').unreachable).toBe('destination unreachable');
    expect(flow(report.flows, 'HOME').unreachable).toBe('no route');
    expect(flow(report.flows, 'BACKUP').unreachable).toBe('destination unreachable');
    const text = t.ph.execute('traffic run 2');
    expect(text).toMatch(/BACKUP +PC2 +172\.16\.0\.10 +default +12\.0 Mbps +destination unreachable/);
    expect(text).toContain('No drops: every interface on the way had room for the traffic.');
    // Probes never show up in the packet capture.
    expect(t.net.trace.some((e) => 'flow' in e.frame.payload && e.frame.payload.flow !== undefined)).toBe(false);
  });

  it('runs from a server prompt too', () => {
    resetMacAllocator();
    const net = new Topology();
    const srv = net.add(new Server('LINUX'));
    const pc = net.add(new Pc('PC1'));
    net.connect(srv.nic, pc.nic);
    srv.configure('10.0.0.1', 24);
    pc.configure('10.0.0.2', 24);
    const sh = new ServerShell(srv);
    sh.execute('traffic add IPERF 10.0.0.2 rate 50000');
    expect(sh.execute('traffic run 1')).toMatch(/IPERF +LINUX +10\.0\.0\.2 +default +50\.0 Mbps +50\.0 Mbps +0\.0%/);
    expect(new PcShell(new Pc('LONELY')).execute('traffic run')).toBe('This host is not part of a network.');
    sh.execute('traffic clear');
    expect(sh.execute('traffic run')).toContain('No traffic flows are defined');
  });
});

describe('interface speed', () => {
  it('sets the speed of router ports and feeds the default bandwidth', () => {
    const t = wan('100');
    expect(portSpeedMbps(t.r1.iface('g0/1'))).toBe(100);
    expect(ios(t.r1, 'show running-config')).toContain(' speed 100');
    ios(t.r1, 'conf t\nint g0/1\nno speed');
    expect(t.r1.iface('g0/1').speed).toBeUndefined();
    ios(t.r1, 'conf t\nint g0/1\nspeed 10\nspeed auto');
    expect(t.r1.iface('g0/1').speed).toBeUndefined();
    const cli = new CliSession(t.r1, { loggedIn: true });
    for (const l of ['enable', 'conf t', 'int g0/1']) cli.execute(l);
    expect(cli.execute('speed 50')).toContain('Invalid input');
    cli.execute('int lo0');
    expect(cli.execute('speed 10')).toContain('Invalid input');
    expect(ios(t.r1, 'show interfaces lo0')).toContain('Loopback0 is up');
    ios(t.r1, 'conf t\nint g0/2\nshutdown\ndescription spare');
    const spare = ios(t.r1, 'show interfaces g0/2');
    expect(spare).toContain('GigabitEthernet0/2 is administratively down, line protocol is down');
    expect(spare).toContain('Description: spare');
    expect(spare).toContain('1000Mbps, link type is auto');
  });

  it('names port speeds', () => {
    const r = new Router('R');
    const fake = (name: string) => ({ ...r.iface('g0/0'), name, parent: undefined, speed: undefined });
    expect(portSpeedMbps(fake('FastEthernet0/0'))).toBe(100);
    expect(portSpeedMbps(fake('Serial0/0/0'))).toBe(1.544);
    expect(portSpeedMbps(fake('Ethernet0'))).toBe(10);
    expect(portSpeedMbps(fake('TenGigabitEthernet1/1'))).toBe(10_000);
    expect(formatRate(1_544_000)).toBe('1.54 Mbps');
    expect(formatRate(64_000)).toBe('64 kbps');
  });
});
