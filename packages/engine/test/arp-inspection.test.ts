import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, createShell, resetMacAllocator } from '../src';
import { ios, warmUp } from './helpers';

/**
 * R1 (gateway and DHCP server) on SW1 Gi0/8; PC1, PC2 and ATTACKER take DHCP leases on
 * Gi0/1, Gi0/2 and Gi0/5; SRV has a static address on Gi0/7. DHCP snooping runs for VLAN 10.
 */
function office() {
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  const attacker = net.add(new Pc('ATTACKER'));
  const srv = net.add(new Pc('SRV'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(pc2.nic, sw.iface('g0/2'));
  net.connect(attacker.nic, sw.iface('g0/5'));
  net.connect(srv.nic, sw.iface('g0/7'));
  ios(r1, `conf t
    int g0/0
    ip address 192.168.10.1 255.255.255.0
    no shut
    exit
    ip dhcp excluded-address 192.168.10.1 192.168.10.10
    ip dhcp pool OFFICE
    network 192.168.10.0 255.255.255.0
    default-router 192.168.10.1`);
  ios(sw, `conf t
    vlan 10
    exit
    interface range g0/1 - 8
    switchport mode access
    switchport access vlan 10
    exit
    ip dhcp snooping
    ip dhcp snooping vlan 10
    no ip dhcp snooping information option
    interface g0/8
    ip dhcp snooping trust`);
  srv.configure('192.168.10.100', 24, '192.168.10.1');
  net.converge();
  for (const pc of [pc1, pc2, attacker]) pc.renew();
  net.converge();
  return { net, r1, sw, pc1, pc2, attacker, srv };
}

function pings(from: Pc, dst: string): boolean {
  const r = from.ping(dst, 3);
  from.network!.run();
  return r.some((x) => x.success);
}

describe('Dynamic ARP Inspection', () => {
  beforeEach(() => resetMacAllocator());

  it('lets ARP poisoning through when it is off', () => {
    const { r1, pc1, attacker } = office();
    warmUp(pc1, '192.168.10.1');
    expect(createShell(attacker).execute('arpspoof 192.168.10.1')).toBe(`Sent 1 gratuitous ARP reply: 192.168.10.1 is-at ${attacker.nic.mac}`);
    expect(pc1.arpCache.get('192.168.10.1')).toBe(attacker.nic.mac);
    // The real gateway notices someone else claiming its address and keeps its own entry clean.
    expect(r1.log.some((l) => l.startsWith('%IP-4-DUPADDR: Duplicate address 192.168.10.1 on GigabitEthernet0/0'))).toBe(true);
    expect(r1.arpTable.has('192.168.10.1')).toBe(false);
  });

  it('drops spoofed ARP on untrusted ports and logs it', () => {
    const { sw, pc1, attacker } = office();
    const cli = new CliSession(sw);
    cli.execute('enable');
    cli.execute('conf t');
    cli.execute('ip arp inspection vlan 10');
    cli.execute('interface g0/8');
    cli.execute('ip arp inspection trust');
    warmUp(pc1, '192.168.10.1');
    const gw = pc1.arpCache.get('192.168.10.1');
    const out = createShell(attacker).execute('arpspoof 192.168.10.1');
    expect(out).toContain('Sent 1');
    expect(pc1.arpCache.get('192.168.10.1')).toBe(gw);
    expect(sw.log.some((l) => l.includes(`%SW_DAI-4-DHCP_SNOOPING_DENY: 1 Invalid ARPs (Res) on Gi0/5, vlan 10.([${attacker.nic.mac}/192.168.10.1/ffff.ffff.ffff/192.168.10.1])`))).toBe(true);
    // DHCP clients still resolve the gateway, because their bindings match.
    expect(pings(pc1, '192.168.10.1')).toBe(true);
    expect(pings(attacker, '192.168.10.1')).toBe(true);
    const show = cli.execute('do show ip arp inspection');
    expect(show).toMatch(/^\s+10\s+Enabled\s+Active$/m);
    expect(show).toContain('Source Mac Validation      : Disabled');
    const counters = /^\s+10\s+(\d+)\s+(\d+)\s+(\d+)\s+0$/m.exec(show)!;
    expect(Number(counters[2])).toBeGreaterThanOrEqual(1);
    expect(counters[2]).toBe(counters[3]);
  });

  it('cuts off the gateway when the uplink is left untrusted', () => {
    const { sw, pc1 } = office();
    ios(sw, 'conf t\nip arp inspection vlan 10');
    expect(pings(pc1, '192.168.10.1')).toBe(false);
    expect(sw.log.some((l) => l.includes('DHCP_SNOOPING_DENY') && l.includes('on Gi0/8'))).toBe(true);
  });

  it('drops static hosts until an ARP ACL permits them', () => {
    const { sw, srv, pc1 } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/8
      ip arp inspection trust`);
    expect(pings(srv, '192.168.10.1')).toBe(false);
    ios(sw, `conf t
      arp access-list SERVERS
      permit ip host 192.168.10.100 mac host ${srv.nic.mac}
      exit
      ip arp inspection filter SERVERS vlan 10`);
    expect(pings(srv, '192.168.10.1')).toBe(true);
    expect(pings(pc1, '192.168.10.100')).toBe(true);
    const cli = new CliSession(sw);
    cli.execute('enable');
    expect(cli.execute('show arp access-list')).toBe(`ARP access list SERVERS\n    permit ip host 192.168.10.100 mac host ${srv.nic.mac}`);
    expect(cli.execute('show ip arp inspection vlan 10')).toMatch(/^\s+10\s+Enabled\s+Active\s+SERVERS\s+No$/m);
    expect(cli.execute('show running-config')).toContain(`arp access-list SERVERS\n permit ip host 192.168.10.100 mac host ${srv.nic.mac}\n!\nip arp inspection filter SERVERS vlan 10\nip arp inspection vlan 10`);
  });

  it('with a static ACL, drops anything the ACL does not permit', () => {
    const { sw, srv, pc1 } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/8
      ip arp inspection trust
      exit
      arp access-list SERVERS
      permit ip host 192.168.10.100 mac host ${srv.nic.mac}
      exit
      ip arp inspection filter SERVERS vlan 10 static`);
    expect(pings(srv, '192.168.10.1')).toBe(true);
    // PC1's binding no longer counts: the static ACL's implicit deny wins.
    expect(pings(pc1, '192.168.10.1')).toBe(false);
    expect(sw.log.some((l) => l.includes('%SW_DAI-4-ACL_DENY') && l.includes('on Gi0/1'))).toBe(true);
    ios(sw, `conf t
      no ip arp inspection filter SERVERS vlan 10`);
    expect(pings(pc1, '192.168.10.1')).toBe(true);
  });

  it('matches explicit denies, wildcards and any', () => {
    const { sw, srv, pc1 } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/8
      ip arp inspection trust
      exit
      arp access-list LAN
      deny ip host 192.168.10.100 mac any
      permit ip 192.168.10.0 0.0.0.255 mac any
      exit
      ip arp inspection filter LAN vlan 10`);
    expect(pings(srv, '192.168.10.1')).toBe(false);
    expect(pings(pc1, '192.168.10.1')).toBe(true);
    ios(sw, `conf t
      arp access-list LAN
      no deny ip host 192.168.10.100 mac any`);
    expect(pings(srv, '192.168.10.1')).toBe(true);
    ios(sw, 'conf t\nno arp access-list LAN');
    expect(new CliSession(sw).execute('show arp access-list')).toBe('');
  });

  it('runs the optional validation checks, and each command replaces the last', () => {
    const { sw, pc1, attacker } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/8
      ip arp inspection trust
      exit
      ip arp inspection validate dst-mac
      ip arp inspection validate ip
      ip arp inspection validate src-mac`);
    expect([...sw.dai.validate]).toEqual(['src-mac']);
    ios(sw, 'conf t\nip arp inspection validate ip src-mac dst-mac');
    expect(new CliSession(sw).execute('show ip arp inspection')).toContain('Destination Mac Validation : Enabled');
    expect(ios(sw, 'show running-config')).toContain('ip arp inspection validate src-mac dst-mac ip');
    expect(pings(pc1, '192.168.10.1')).toBe(true);

    // An ARP whose sender MAC differs from the Ethernet source, sent by hand.
    const send = (payload: object, dst = 'ffff.ffff.ffff') => {
      (attacker as unknown as { send: (i: unknown, f: unknown) => void }).send(attacker.nic, { src: attacker.nic.mac, dst, payload });
      attacker.network!.run();
    };
    const lease = attacker.nic.ip!.address;
    send({ kind: 'arp', op: 'request', senderMac: '0000.1111.2222', senderIp: lease, targetMac: '0000.0000.0000', targetIp: '192.168.10.1' });
    send({ kind: 'arp', op: 'reply', senderMac: attacker.nic.mac, senderIp: lease, targetMac: pc1.nic.mac, targetIp: pc1.nic.ip!.address }, 'ffff.ffff.ffff');
    send({ kind: 'arp', op: 'reply', senderMac: attacker.nic.mac, senderIp: lease, targetMac: 'ffff.ffff.ffff', targetIp: '255.255.255.255' });
    send({ kind: 'arp', op: 'request', senderMac: attacker.nic.mac, senderIp: '0.0.0.0', targetMac: '0000.0000.0000', targetIp: '192.168.10.1' });
    const s = sw.dai.statsFor(10);
    expect([s.srcMacFailures, s.dstMacFailures, s.ipFailures]).toEqual([1, 1, 2]);
    expect(sw.log.some((l) => l.includes('%SW_DAI-4-INVALID_ARP: 1 Invalid ARPs (Req) on Gi0/5'))).toBe(true);
    ios(sw, 'conf t\nno ip arp inspection validate dst-mac');
    expect([...sw.dai.validate].sort()).toEqual(['ip', 'src-mac']);
    ios(sw, 'conf t\nno ip arp inspection validate');
    expect(sw.dai.validate.size).toBe(0);
    ios(sw, 'clear ip arp inspection statistics');
    expect(sw.dai.statsFor(10).dropped).toBe(0);
  });

  it('err-disables a port that floods ARP past its rate limit', () => {
    const { sw, attacker, pc1 } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/8
      ip arp inspection trust`);
    const out = createShell(attacker).execute(`arpspoof ${attacker.nic.ip!.address} -n 50`);
    expect(out).toContain('Sent 50 gratuitous ARP replies');
    expect(sw.iface('g0/5').errDisabled).toBe('arp-inspection');
    expect(sw.log).toContain('%SW_DAI-4-PACKET_RATE_EXCEEDED: 16 packets received in 1000 milliseconds on Gi0/5.');
    expect(sw.log).toContain('%PM-4-ERR_DISABLE: arp-inspection error detected on Gi0/5, putting Gi0/5 in err-disable state');
    // Legitimate ARP from other ports is unaffected.
    expect(pings(pc1, '192.168.10.1')).toBe(true);
    const cli = new CliSession(sw);
    cli.execute('enable');
    expect(cli.execute('show ip arp inspection interfaces')).toMatch(/Gi0\/5\s+Untrusted\s+15\s+1/);
    expect(cli.execute('show ip arp inspection interfaces')).toMatch(/Gi0\/8\s+Trusted\s+None\s+N\/A/);
  });

  it('takes a custom rate, a burst interval, or no limit at all', () => {
    const { sw, attacker } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      interface g0/5
      ip arp inspection limit rate 30 burst interval 2`);
    const own = attacker.nic.ip!.address;
    createShell(attacker).execute(`arpspoof ${own} -n 50`);
    expect(sw.iface('g0/5').errDisabled).toBeUndefined();
    const cli = new CliSession(sw);
    cli.execute('enable');
    expect(cli.execute('show ip arp inspection interfaces')).toMatch(/Gi0\/5\s+Untrusted\s+30\s+2/);
    expect(cli.execute('show running-config')).toContain(' ip arp inspection limit rate 30 burst interval 2');
    ios(sw, 'conf t\ninterface g0/5\nip arp inspection limit none');
    expect(cli.execute('show running-config')).toContain(' ip arp inspection limit none');
    createShell(attacker).execute(`arpspoof ${own} -n 200`);
    expect(sw.iface('g0/5').errDisabled).toBeUndefined();
    ios(sw, 'conf t\ninterface g0/5\nip arp inspection limit rate 5');
    expect(cli.execute('show running-config')).toContain(' ip arp inspection limit rate 5\n');
    ios(sw, 'conf t\ninterface g0/5\nno ip arp inspection limit');
    expect(sw.iface('g0/5').arpInspection).toEqual({ rate: undefined, burst: undefined });
  });

  it('turns off per VLAN and per port', () => {
    const { sw, pc1 } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10,20
      no ip arp inspection vlan 20
      interface g0/8
      ip arp inspection trust
      no ip arp inspection trust`);
    expect([...sw.dai.vlans]).toEqual([10]);
    expect(pings(pc1, '192.168.10.1')).toBe(false);
    ios(sw, 'conf t\nno ip arp inspection vlan 10');
    expect(pings(pc1, '192.168.10.1')).toBe(true);
    expect(new CliSession(sw).execute('show ip arp inspection vlan 30')).toMatch(/^\s+30\s+Disabled\s+Inactive$/m);
  });

  it('rejects malformed ARP ACL lines and validation keywords', () => {
    const { sw } = office();
    const cli = new CliSession(sw);
    for (const line of ['enable', 'conf t', 'arp access-list X']) cli.execute(line);
    expect(cli.prompt).toBe('SW1(config-arp-nacl)#');
    for (const bad of ['permit ip host 1.2.3 mac any', 'permit mac any', 'permit ip any mac host zz', 'permit ip any mac any extra', 'permit ip host 10.0.0.1']) {
      expect(cli.execute(bad)).toMatch(/^% Invalid input/);
    }
    cli.execute('exit');
    expect(cli.execute('ip arp inspection validate src-mac bogus')).toMatch(/^% Invalid input/);
  });
});

describe('IP Source Guard', () => {
  beforeEach(() => resetMacAllocator());

  it('only passes traffic from addresses DHCP snooping bound to the port', () => {
    const { sw, pc1, pc2 } = office();
    ios(sw, `conf t
      interface range g0/1 - 2
      ip verify source`);
    expect(pings(pc1, '192.168.10.1')).toBe(true);
    // PC2 changes to an address it was never given.
    pc2.configure('192.168.10.50', 24, '192.168.10.1');
    expect(pings(pc2, '192.168.10.1')).toBe(false);
    const cli = new CliSession(sw);
    cli.execute('enable');
    const show = cli.execute('show ip verify source');
    expect(show).toMatch(new RegExp(`Gi0/1\\s+ip\\s+active\\s+${pc1.nic.ip!.address.replace(/\./g, '\\.')}\\s+10`));
    expect(show).toMatch(/Gi0\/2\s+ip\s+active\s+\S+\s+10/);
    // DHCP still gets through, and the new lease makes PC2 legal again.
    createShell(pc2).execute('ipconfig /renew');
    expect(pings(pc2, '192.168.10.1')).toBe(true);
  });

  it('checks the MAC too with port-security, and takes static bindings', () => {
    const { sw, srv, pc1 } = office();
    ios(sw, `conf t
      interface g0/7
      ip verify source port-security`);
    expect(pings(srv, '192.168.10.1')).toBe(false);
    const cli = new CliSession(sw);
    cli.execute('enable');
    expect(cli.execute('show ip verify source')).toMatch(/Gi0\/7\s+ip-mac\s+active\s+deny-all\s+10/);
    ios(sw, `conf t\nip source binding ${srv.nic.mac} vlan 10 192.168.10.100 interface Gi0/7`);
    expect(pings(srv, '192.168.10.1')).toBe(true);
    expect(pings(pc1, '192.168.10.100')).toBe(true);
    expect(cli.execute('show ip verify source')).toContain(`192.168.10.100   ${srv.nic.mac}     10`);
    const bindings = cli.execute('show ip source binding');
    expect(bindings).toMatch(/192\.168\.10\.100\s+infinite\s+static\s+10\s+GigabitEthernet0\/7/);
    expect(bindings).toContain('dhcp-snooping');
    expect(cli.execute('show ip dhcp snooping binding')).not.toContain('static');
    expect(cli.execute('show running-config')).toContain(`ip source binding ${srv.nic.mac} vlan 10 192.168.10.100 interface Gi0/7`);
    expect(cli.execute('show running-config')).toContain(' ip verify source port-security');
    // Re-entering a binding for the same MAC replaces it; `no` removes it.
    ios(sw, `conf t\nip source binding ${srv.nic.mac} vlan 10 192.168.10.100 interface Gi0/7`);
    expect(sw.staticBindings).toHaveLength(1);
    ios(sw, `conf t\nno ip source binding ${srv.nic.mac} vlan 10 192.168.10.100 interface Gi0/7`);
    expect(sw.staticBindings).toHaveLength(0);
  });

  it('stays inactive without snooping in the VLAN or on a trusted port', () => {
    const { sw, srv } = office();
    ios(sw, `conf t
      interface g0/7
      ip verify source vlan dhcp-snooping
      interface g0/8
      ip verify source vlan dhcp-snooping port-security`);
    expect(sw.iface('g0/7').sourceGuard).toBe('ip');
    expect(sw.iface('g0/8').sourceGuard).toBe('ip-mac');
    const cli = new CliSession(sw);
    cli.execute('enable');
    expect(cli.execute('show ip verify source')).toMatch(/Gi0\/8\s+ip-mac\s+inactive-trust-port/);
    ios(sw, 'conf t\nno ip dhcp snooping vlan 10');
    expect(cli.execute('show ip verify source')).toMatch(/Gi0\/7\s+ip\s+inactive-no-snooping-vlan/);
    expect(pings(srv, '192.168.10.1')).toBe(true);
    ios(sw, 'conf t\ninterface g0/7\nno ip verify source');
    expect(sw.iface('g0/7').sourceGuard).toBeUndefined();
    expect(() => ios(sw, 'conf t\ninterface g0/7\nip verify source mac-check')).toThrow(/Invalid input/);
    expect(() => ios(sw, 'conf t\nip source binding nonsense vlan 10 1.1.1.1 interface g0/7')).toThrow(/Invalid input/);
  });
});

describe('err-disable recovery', () => {
  beforeEach(() => resetMacAllocator());

  it('shows causes and timers, and recovers once the interval has passed', () => {
    const { net, sw, attacker } = office();
    ios(sw, `conf t
      ip arp inspection vlan 10
      errdisable recovery cause arp-inspection
      errdisable recovery interval 30`);
    createShell(attacker).execute(`arpspoof ${attacker.nic.ip!.address} -n 40`);
    const port = sw.iface('g0/5');
    expect(port.errDisabled).toBe('arp-inspection');
    const cli = new CliSession(sw);
    cli.execute('enable');
    const show = cli.execute('show errdisable recovery');
    expect(show).toMatch(/^arp-inspection\s+Enabled$/m);
    expect(show).toMatch(/^bpduguard\s+Disabled$/m);
    expect(show).toContain('Timer interval: 30 seconds');
    expect(show).toMatch(/Gi0\/5\s+arp-inspection\s+30/);
    expect(cli.execute('show running-config')).toContain('errdisable recovery cause arp-inspection\nerrdisable recovery interval 30');
    // Let virtual time pass: the timer runs out and the port comes back.
    net.scheduler.schedule(31_000, 'wait', () => {});
    net.converge();
    expect(port.errDisabled).toBeUndefined();
    expect(sw.log).toContain('%PM-4-ERR_RECOVER: Attempting to recover from arp-inspection err-disable state on Gi0/5');
    ios(sw, `conf t
      errdisable recovery cause all
      no errdisable recovery cause bpduguard
      no errdisable recovery interval`);
    expect([...sw.errRecovery.causes].sort()).toEqual(['arp-inspection', 'channel-misconfig', 'dhcp-rate-limit', 'link-flap', 'psecure-violation']);
    expect(sw.errRecovery.interval).toBe(300);
    expect(() => ios(sw, 'conf t\nerrdisable recovery cause sunspots')).toThrow(/Invalid input/);
  });
});
