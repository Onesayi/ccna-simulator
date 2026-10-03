import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, resetMacAllocator } from '../src';
import { ios, warmUp } from './helpers';

/** PC1, PC2 on SW1 behind R1 (192.168.1.0/24); R1 - R2 over 10.0.12.0/30; R2 LAN 192.168.2.0/24 with SRV. */
function office() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  const srv = net.add(new Pc('SRV'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(pc2.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(srv.nic, r2.iface('g0/0'));
  srv.configure('192.168.2.10', 24, '192.168.2.1');
  ios(r1, `conf t
    int g0/0
    ip address 192.168.1.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.1 255.255.255.252
    no shut
    exit
    ip route 192.168.2.0 255.255.255.0 10.0.12.2`);
  ios(r2, `conf t
    int g0/0
    ip address 192.168.2.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.2 255.255.255.252
    no shut
    exit
    ip route 192.168.1.0 255.255.255.0 10.0.12.1`);
  return { net, r1, r2, sw, pc1, pc2, srv };
}

function pingOk(from: Pc | Router, to: string): boolean {
  warmUp(from, to);
  const r = from.ping(to, 3);
  from.network!.run();
  return r.every((x) => x.success);
}

describe('DHCP', () => {
  beforeEach(() => resetMacAllocator());

  it('leases addresses from a pool, skipping excluded ones', () => {
    const { r1, pc1, pc2 } = office();
    ios(r1, `conf t
      ip dhcp excluded-address 192.168.1.1 192.168.1.10
      ip dhcp pool LAN
      network 192.168.1.0 255.255.255.0
      default-router 192.168.1.1
      dns-server 8.8.8.8
      domain-name ccna.lab`);
    const shell = new PcShell(pc1);
    const out = shell.execute('ipconfig /renew');
    expect(out).toContain('IPv4 Address....................: 192.168.1.11');
    expect(out).toContain('Default Gateway.................: 192.168.1.1');
    expect(shell.execute('ipconfig /all')).toMatch(/DHCP Enabled\.+: Yes[\s\S]*DHCP Server\.+: 192\.168\.1\.1[\s\S]*DNS Servers\.+: 8\.8\.8\.8/);
    new PcShell(pc2).execute('ipconfig /renew');
    expect(pc2.nic.ip?.address).toBe('192.168.1.12');
    const binding = ios(r1, 'show ip dhcp binding');
    expect(binding).toMatch(/192\.168\.1\.11\s+01aa\.bbcc\.00/);
    expect(ios(r1, 'show ip dhcp pool')).toMatch(/Leased addresses\s+: 2[\s\S]*Excluded addresses\s+: 10/);
    expect(pingOk(pc1, '192.168.2.10')).toBe(true);
    // Renewing keeps the same address.
    shell.execute('ipconfig /renew');
    expect(pc1.nic.ip?.address).toBe('192.168.1.11');
    shell.execute('ipconfig /release');
    expect(pc1.nic.ip).toBeUndefined();
    expect(ios(r1, 'show ip dhcp binding')).not.toContain('192.168.1.11');
    expect(ios(r1, 'show running-config')).toContain('ip dhcp excluded-address 192.168.1.1 192.168.1.10\n!\nip dhcp pool LAN\n network 192.168.1.0 255.255.255.0\n default-router 192.168.1.1\n dns-server 8.8.8.8\n domain-name ccna.lab\n!');
  });

  it('falls back to APIPA when no server answers', () => {
    const { pc1 } = office();
    const out = new PcShell(pc1).execute('ipconfig /renew');
    expect(out).toContain('unable to contact your DHCP server');
    expect(out).toMatch(/Autoconfiguration IPv4 Address\.\.: 169\.254\.\d+\.\d+/);
    expect(pc1.apipa).toBe(true);
    expect(pc1.nic.ip?.prefix).toBe(16);
  });

  it('relays to a server on another subnet with ip helper-address', () => {
    const { r1, r2, pc1 } = office();
    ios(r2, `conf t
      ip dhcp excluded-address 192.168.1.1
      ip dhcp pool BRANCH
      network 192.168.1.0 255.255.255.0
      default-router 192.168.1.1`);
    const shell = new PcShell(pc1);
    expect(shell.execute('ipconfig /renew')).toContain('unable to contact');
    ios(r1, 'conf t\nint g0/0\nip helper-address 10.0.12.2');
    expect(ios(r1, 'show ip interface g0/0')).toContain('Helper addresses are 10.0.12.2');
    expect(shell.execute('ipconfig /renew')).toContain('IPv4 Address....................: 192.168.1.2');
    expect(pc1.lease?.serverId).toBe('10.0.12.2');
    expect(ios(r2, 'show ip dhcp binding')).toContain('192.168.1.2');
    ios(r1, 'conf t\nint g0/0\nno ip helper-address 10.0.12.2');
    expect(r1.iface('g0/0').helpers).toBeUndefined();
  });

  it('gives a router interface its address and a default route with ip address dhcp', () => {
    const { r1, r2 } = office();
    ios(r2, `conf t
      ip dhcp pool WAN
      network 10.0.12.0 255.255.255.252
      default-router 10.0.12.2`);
    ios(r1, 'conf t\nint g0/1\nno ip address\nip address dhcp');
    expect(r1.iface('g0/1').ip?.address).toBe('10.0.12.1');
    const route = ios(r1, 'show ip route');
    expect(route).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
    expect(route).toMatch(/S\*\s+0\.0\.0\.0\/0 \[254\/0\] via 10\.0\.12\.2/);
    expect(ios(r1, 'show running-config')).toContain('interface GigabitEthernet0/1\n ip address dhcp');
    expect(r1.log.join('\n')).toContain('%DHCP-6-ADDRESS_ASSIGN: Interface GigabitEthernet0/1 assigned DHCP address 10.0.12.1, mask 255.255.255.252');
    ios(r1, 'conf t\nint g0/1\nno ip address');
    expect(r1.iface('g0/1').ip).toBeUndefined();
  });

  it('asks again when a DHCP client interface comes up', () => {
    const { r1, r2 } = office();
    ios(r2, 'conf t\nip dhcp pool WAN\nnetwork 10.0.12.0 255.255.255.252');
    ios(r1, 'conf t\nint g0/1\nshutdown\nip address dhcp');
    expect(r1.iface('g0/1').ip).toBeUndefined();
    ios(r1, 'conf t\nint g0/1\nno shutdown');
    expect(r1.iface('g0/1').ip?.address).toBe('10.0.12.1');
  });
});

/** Inside: 192.168.1.0/24 behind R1. Outside: R1 g0/1 203.0.113.1/29 to ISP .6, ISP loopback 8.8.8.8. */
function edge() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const isp = net.add(new Router('ISP'));
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(pc2.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), isp.iface('g0/1'));
  pc1.configure('192.168.1.10', 24, '192.168.1.1');
  pc2.configure('192.168.1.20', 24, '192.168.1.1');
  ios(r1, `conf t
    int g0/0
    ip address 192.168.1.1 255.255.255.0
    ip nat inside
    no shut
    int g0/1
    ip address 203.0.113.1 255.255.255.248
    ip nat outside
    no shut
    exit
    ip route 0.0.0.0 0.0.0.0 203.0.113.6`);
  ios(isp, `conf t
    int g0/1
    ip address 203.0.113.6 255.255.255.248
    no shut
    int lo0
    ip address 8.8.8.8 255.255.255.255`);
  return { net, r1, isp, pc1, pc2 };
}

describe('NAT', () => {
  beforeEach(() => resetMacAllocator());

  it('fails without NAT because the ISP has no route to private space', () => {
    const { pc1 } = edge();
    expect(pingOk(pc1, '8.8.8.8')).toBe(false);
  });

  it('overloads many inside hosts onto the outside interface (PAT)', () => {
    const { r1, isp, pc1, pc2 } = edge();
    ios(r1, 'conf t\naccess-list 1 permit 192.168.1.0 0.0.0.255\nip nat inside source list 1 interface g0/1 overload');
    expect(pingOk(pc1, '8.8.8.8')).toBe(true);
    expect(pingOk(pc2, '8.8.8.8')).toBe(true);
    const table = ios(r1, 'show ip nat translations');
    expect(table).toMatch(/icmp 203\.0\.113\.1:\d+\s+192\.168\.1\.10:\d+\s+8\.8\.8\.8:\d+\s+8\.8\.8\.8:\d+/);
    expect(table).toMatch(/icmp 203\.0\.113\.1:\d+\s+192\.168\.1\.20:/);
    // The ISP only ever saw the public address.
    expect(isp.arpTable.has('192.168.1.10')).toBe(false);
    expect(ios(r1, 'show ip nat statistics')).toMatch(/Outside interfaces:\n  GigabitEthernet0\/1\nInside interfaces:\n  GigabitEthernet0\/0\nHits: \d+/);
    expect(ios(r1, 'show running-config')).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    expect(ios(r1, 'show ip interface g0/0')).toContain('IP NAT Inside interface');
    ios(r1, 'clear ip nat translation *');
    expect(ios(r1, 'show ip nat translations')).toContain('Total number of translations: 0');
  });

  it('publishes a server with static NAT, answering ARP for the global address', () => {
    const { r1, isp, pc1 } = edge();
    ios(r1, 'conf t\nip nat inside source static 192.168.1.10 203.0.113.3');
    warmUp(isp, '203.0.113.3');
    const r = isp.ping('203.0.113.3', 3);
    isp.network!.run();
    expect(r.every((x) => x.success)).toBe(true);
    expect(isp.connect('203.0.113.3', 80)).toBeDefined();
    const web = isp.connect('203.0.113.3', 80);
    isp.network!.run();
    expect(web.status).toBe('open');
    expect(ios(r1, 'show ip nat translations')).toContain('---  203.0.113.3           192.168.1.10          ---                   ---');
    expect(pingOk(pc1, '8.8.8.8')).toBe(true);
    expect(ios(r1, 'show running-config')).toContain('ip nat inside source static 192.168.1.10 203.0.113.3');
    ios(r1, 'conf t\nno ip nat inside source static 192.168.1.10 203.0.113.3');
    expect(r1.nat.statics).toHaveLength(0);
  });

  it('runs out of addresses in a dynamic pool without overload', () => {
    const { r1, pc1, pc2 } = edge();
    ios(r1, `conf t
      access-list 1 permit 192.168.1.0 0.0.0.255
      ip nat pool PUB 203.0.113.2 203.0.113.2 netmask 255.255.255.248
      ip nat inside source list 1 pool PUB`);
    expect(pingOk(pc1, '8.8.8.8')).toBe(true);
    expect(pingOk(pc2, '8.8.8.8')).toBe(false);
    expect(ios(r1, 'show ip nat statistics')).toMatch(/total addresses 1, allocated 1 \(100%\), misses [1-9]/);
    ios(r1, 'conf t\nip nat inside source list 1 pool PUB overload');
    expect(pingOk(pc2, '8.8.8.8')).toBe(true);
    expect(ios(r1, 'show running-config')).toContain('ip nat pool PUB 203.0.113.2 203.0.113.2 netmask 255.255.255.248\nip nat inside source list 1 pool PUB overload');
  });

  it('rejects bad NAT syntax', () => {
    const { r1 } = edge();
    const cli = new CliSession(r1);
    ['en', 'conf t'].forEach((c) => cli.execute(c));
    expect(cli.execute('ip nat inside source list 1 pool NOPE')).toContain('Pool NOPE does not exist');
    expect(cli.execute('ip nat pool X 10.0.0.1 10.0.1.1 netmask 255.255.255.0')).toContain('same subnet');
    expect(cli.execute('ip nat outside source static 1.1.1.1 2.2.2.2')).toContain('Invalid input');
  });
});

describe('ACLs', () => {
  beforeEach(() => resetMacAllocator());

  it('filters by source with a standard ACL and counts matches', () => {
    const { r2, pc1, pc2 } = office();
    pc1.configure('192.168.1.10', 24, '192.168.1.1');
    pc2.configure('192.168.1.20', 24, '192.168.1.1');
    ios(r2, `conf t
      access-list 10 deny host 192.168.1.20
      access-list 10 permit 192.168.1.0 0.0.0.255
      int g0/0
      ip access-group 10 out`);
    expect(pingOk(pc1, '192.168.2.10')).toBe(true);
    expect(pingOk(pc2, '192.168.2.10')).toBe(false);
    const r = pc2.ping('192.168.2.10', 1);
    pc2.network!.run();
    expect(r[0]!.status).toBe('unreachable');
    expect(r[0]!.from).toBe('10.0.12.2');
    const acl = ios(r2, 'show access-lists');
    expect(acl).toMatch(/Standard IP access list 10\n    10 deny   192\.168\.1\.20 \(\d+ matches\)\n    20 permit 192\.168\.1\.0, wildcard bits 0\.0\.0\.255 \(\d+ matches\)/);
    expect(ios(r2, 'show ip interface g0/0')).toContain('Outgoing access list is 10');
    expect(ios(r2, 'show running-config')).toContain('access-list 10 deny 192.168.1.20\naccess-list 10 permit 192.168.1.0 0.0.0.255');
    ios(r2, 'clear access-list counters');
    expect(ios(r2, 'show access-lists 10')).not.toContain('matches');
  });

  it('deletes a whole numbered ACL with no access-list, even with an entry typed', () => {
    const { r2 } = office();
    ios(r2, 'conf t\naccess-list 10 deny host 1.1.1.1\naccess-list 10 permit any');
    ios(r2, 'conf t\nno access-list 10 deny host 1.1.1.1');
    expect(r2.acls.has('10')).toBe(false);
  });

  it('filters by protocol and port with a named extended ACL', () => {
    const { r1, pc1, srv } = office();
    pc1.configure('192.168.1.10', 24, '192.168.1.1');
    ios(r1, `conf t
      ip access-list extended NO-WEB
      remark Guests may ping the server but not browse it
      deny tcp 192.168.1.0 0.0.0.255 host 192.168.2.10 eq www
      permit ip any any
      exit
      int g0/0
      ip access-group NO-WEB in`);
    const shell = new PcShell(pc1);
    expect(pingOk(pc1, '192.168.2.10')).toBe(true);
    expect(shell.execute('curl http://192.168.2.10')).toContain('No route to host');
    expect(shell.execute('curl https://192.168.2.10')).toContain('It works!');
    expect(shell.execute('telnet 192.168.2.10')).toContain('Connection refused');
    expect(ios(r1, 'show access-lists')).toMatch(/Extended IP access list NO-WEB\n    10 deny tcp 192\.168\.1\.0 0\.0\.0\.255 host 192\.168\.2\.10 eq www \(1 match\)\n    20 permit ip any any \(\d+ matches\)/);
    expect(ios(r1, 'show running-config')).toContain('ip access-list extended NO-WEB\n remark Guests may ping the server but not browse it\n 10 deny tcp 192.168.1.0 0.0.0.255 host 192.168.2.10 eq www\n 20 permit ip any any');
    // Insert above, then delete by sequence number.
    ios(r1, 'conf t\nip access-list extended NO-WEB\n5 deny icmp any any echo\nno 10');
    expect(pingOk(pc1, '192.168.2.10')).toBe(false);
    expect(shell.execute('curl 192.168.2.10')).toContain('It works!');
    void srv;
  });

  it('blocks OSPF with the implicit deny of an inbound ACL', () => {
    const { r1, r2 } = office();
    for (const r of [r1, r2]) ios(r, 'conf t\nrouter ospf 1\nnetwork 10.0.12.0 0.0.0.3 area 0');
    expect(ios(r1, 'show ip ospf neighbor')).toContain('FULL');
    ios(r1, 'conf t\nip access-list extended WAN-IN\npermit icmp any any\nexit\nint g0/1\nip access-group WAN-IN in');
    expect(ios(r1, 'show ip ospf neighbor')).not.toContain('FULL');
    ios(r1, 'conf t\nip access-list extended WAN-IN\npermit ospf any any');
    expect(ios(r1, 'show ip ospf neighbor')).toContain('FULL');
  });

  it('parses and rejects ACL entries like IOS', () => {
    const { r1 } = office();
    const cli = new CliSession(r1);
    ['en', 'conf t'].forEach((c) => cli.execute(c));
    expect(cli.execute('access-list 100 permit 10.0.0.0 0.0.0.255')).toContain('Invalid input');
    expect(cli.execute('access-list 5 permit tcp any any')).toContain('Invalid input');
    expect(cli.execute('access-list 3000 permit any')).toContain('Invalid access list number');
    cli.execute('access-list 101 permit udp any range 1000 2000 any gt 1023 log');
    cli.execute('access-list 101 permit tcp any any established');
    cli.execute('access-list 101 deny tcp any neq 22 host 10.0.0.1 lt 1024');
    cli.execute('access-list 7 permit 10.1.1.77 0.0.0.255');
    expect(cli.execute('do show access-lists')).toContain('permit udp any range 1000 2000 any gt 1023 log');
    expect(cli.execute('do show access-lists')).toContain('deny tcp any neq 22 host 10.0.0.1 lt 1024');
    // IOS masks host bits covered by the wildcard.
    expect(cli.execute('do show access-lists 7')).toContain('10 permit 10.1.1.0, wildcard bits 0.0.0.255');
    cli.execute('ip access-list standard GUEST');
    expect(cli.prompt).toBe('R1(config-std-nacl)#');
    cli.execute('permit host 10.0.0.1');
    cli.execute('no permit host 10.0.0.1');
    expect(r1.acls.get('GUEST')!.entries).toHaveLength(0);
    cli.execute('exit');
    expect(cli.execute('ip access-list extended GUEST')).toContain('already exists');
    expect(cli.execute('ip access-list extended 10')).toContain('Invalid input');
  });
});

describe('TCP and telnet', () => {
  beforeEach(() => resetMacAllocator());

  it('opens, refuses and times out like the real thing', () => {
    const { r1, net, pc1 } = office();
    pc1.configure('192.168.1.10', 24, '192.168.1.1');
    const cli = new CliSession(r1);
    cli.execute('enable');
    expect(cli.execute('telnet 10.0.12.2')).toContain('Open');
    expect(cli.execute('telnet 192.168.2.10 80')).toContain('Open');
    expect(cli.execute('telnet 192.168.2.10 25')).toContain('% Connection refused by remote host');
    expect(cli.execute('telnet 172.16.0.1')).toContain('% Destination unreachable');
    const shell = new PcShell(pc1);
    expect(shell.execute('telnet 192.168.1.1')).toContain('Open');
    expect(shell.execute('telnet 192.168.2.99 80')).toContain('timed out');
    expect(shell.execute('curl ftp://x')).toContain('bad/illegal');
    expect(shell.execute('telnet')).toContain('Usage');
    void net;
  });
});
