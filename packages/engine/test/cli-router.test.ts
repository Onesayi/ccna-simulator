import { describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, createShell, resetMacAllocator } from '../src';
import { ios } from './helpers';

describe('IOS CLI on a router', () => {
  it('prints link state messages on no shutdown', () => {
    const net = new Topology();
    const r = net.add(new Router('R1'));
    const pc = net.add(new Pc('PC1'));
    net.connect(pc.nic, r.iface('g0/0'));
    const out = ios(r, 'conf t\nint g0/0\nno shutdown');
    expect(out).toContain('%LINK-5-CHANGED: Interface GigabitEthernet0/0, changed state to up');
    expect(out).toContain('%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to up');
  });

  it('runs EXEC commands from config mode with do', () => {
    const r = new Router('R1');
    const cli = new CliSession(r);
    ['en', 'conf t', 'int g0/0', 'ip add 10.1.1.1 255.255.255.0'].forEach((c) => cli.execute(c));
    expect(cli.execute('do sh ip int br')).toMatch(/GigabitEthernet0\/0\s+10\.1\.1\.1/);
    expect(cli.prompt).toBe('R1(config-if)#');
  });

  it('accepts interface names with a space and creates loopbacks', () => {
    const r = new Router('R1');
    ios(r, 'conf t\ninterface loopback 0\nip address 1.1.1.1 255.255.255.255');
    expect(r.iface('Lo0').isUp).toBe(true);
    expect(ios(r, 'show ip route')).toContain('      1.0.0.0/32 is subnetted, 1 subnet\nC        1.1.1.1 is directly connected, Loopback0');
  });

  it('builds a running-config from engine state', () => {
    const r = new Router('R1');
    ios(r, `conf t
      hostname EDGE
      int g0/0
      description Uplink to ISP
      ip address 203.0.113.2 255.255.255.252
      no shut
      int g0/1.10
      encapsulation dot1Q 10
      ip address 10.10.0.1 255.255.255.0
      exit
      ip route 0.0.0.0 0.0.0.0 203.0.113.1`);
    const cfg = ios(r, 'show running-config');
    expect(cfg).toContain('hostname EDGE');
    expect(cfg).toContain('interface GigabitEthernet0/0\n description Uplink to ISP\n ip address 203.0.113.2 255.255.255.252\n duplex auto');
    expect(cfg).toContain('interface GigabitEthernet0/1\n no ip address\n shutdown');
    expect(cfg).toContain('interface GigabitEthernet0/1.10\n encapsulation dot1Q 10\n ip address 10.10.0.1 255.255.255.0');
    expect(cfg).toContain('ip route 0.0.0.0 0.0.0.0 203.0.113.1');
  });

  it('rejects switch commands on a router and router commands on a switch', () => {
    const r = new CliSession(new Router('R1'));
    ['en', 'conf t', 'int g0/0'].forEach((c) => r.execute(c));
    expect(r.execute('switchport mode access')).toMatch(/^% Invalid input/);
    const s = new CliSession(new Switch('SW1'));
    ['en', 'conf t', 'int g0/1'].forEach((c) => s.execute(c));
    expect(s.execute('ip address 10.0.0.1 255.255.255.0')).toMatch(/^% Invalid input/);
  });

  it('accepts a prefix length or mask on ip route and rejects host bits', () => {
    const r = new Router('R1');
    const cli = new CliSession(r);
    ['en', 'conf t'].forEach((c) => cli.execute(c));
    expect(cli.execute('ip route 10.1.1.0 255.255.255.0 192.0.2.1')).toBe('');
    expect(cli.execute('ip route 10.1.1.5 255.255.255.0 192.0.2.1')).toMatch(/Inconsistent address and mask/);
    expect(r.staticRoutes).toHaveLength(1);
    cli.execute('no ip route 10.1.1.0 255.255.255.0 192.0.2.1');
    expect(r.staticRoutes).toHaveLength(0);
  });
});

describe('switch trunk commands', () => {
  it('edits the allowed VLAN list and shows it compressed', () => {
    const sw = new Switch('SW1');
    ios(sw, `conf t
      vlan 10
      vlan 20
      vlan 30
      int g0/8
      switchport mode trunk
      switchport trunk allowed vlan 10,20
      switchport trunk allowed vlan add 30
      switchport trunk native vlan 99`);
    expect(ios(sw, 'show interfaces trunk')).toMatch(/Gi0\/8\s+10,20,30/);
    expect(ios(sw, 'show interfaces g0/8 switchport')).toContain('Trunking VLANs Enabled: 10,20,30');
    expect(ios(sw, 'show running-config')).toContain('interface GigabitEthernet0/8\n switchport trunk native vlan 99\n switchport trunk allowed vlan 10,20,30\n switchport mode trunk');
  });
});

describe('PC command prompt', () => {
  function lab() {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW1'));
    const pc1 = net.add(new Pc('PC1'));
    const pc2 = net.add(new Pc('PC2'));
    net.connect(pc1.nic, sw.iface('g0/1'));
    net.connect(pc2.nic, sw.iface('g0/2'));
    return { net, pc1, pc2 };
  }

  it('configures addressing with ipconfig and shows it back', () => {
    const { pc1 } = lab();
    const sh = new PcShell(pc1);
    expect(sh.execute('ipconfig 192.168.1.10 255.255.255.0 192.168.1.1')).toBe('');
    const out = sh.execute('ipconfig');
    expect(out).toContain('IPv4 Address....................: 192.168.1.10');
    expect(out).toContain('Default Gateway.................: 192.168.1.1');
    sh.execute('ipconfig 10.0.0.5/8');
    expect(pc1.nic.ip).toEqual({ address: '10.0.0.5', prefix: 8 });
  });

  it('pings in Windows format and fills the ARP cache', () => {
    const { pc1, pc2 } = lab();
    pc2.configure('192.168.1.11', 24);
    const sh = createShell(pc1);
    sh.execute('ipconfig 192.168.1.10 255.255.255.0');
    const out = sh.execute('ping 192.168.1.11');
    expect(out).toContain('Reply from 192.168.1.11: bytes=32 time=');
    expect(out).toContain('TTL=128');
    expect(out).toContain('Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),');
    expect(sh.execute('arp -a')).toContain('192.168.1.11');
  });

  it('reports a general failure without a gateway', () => {
    const { pc1 } = lab();
    const sh = new PcShell(pc1);
    sh.execute('ipconfig 192.168.1.10 255.255.255.0');
    expect(sh.execute('ping -n 1 10.0.0.1')).toContain('PING: transmit failed. General failure.');
  });
});
