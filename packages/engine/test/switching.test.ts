import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Switch, Topology, resetMacAllocator } from '../src';

function lab() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(pc1.nic, sw.iface('Gi0/1'));
  net.connect(pc2.nic, sw.iface('Gi0/2'));
  pc1.configure('192.168.10.11', 24);
  pc2.configure('192.168.10.12', 24);
  return { net, sw, pc1, pc2 };
}

describe('single switch', () => {
  let l: ReturnType<typeof lab>;
  beforeEach(() => (l = lab()));

  it('pings between two hosts in the same VLAN', () => {
    const results = l.pc1.ping('192.168.10.12');
    l.net.run();
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('learns both MAC addresses on the right ports', () => {
    l.pc1.ping('192.168.10.12', 1);
    l.net.run();
    expect(l.sw.macLookup(1, l.pc1.nic.mac)?.port.name).toBe('GigabitEthernet0/1');
    expect(l.sw.macLookup(1, l.pc2.nic.mac)?.port.name).toBe('GigabitEthernet0/2');
  });

  it('isolates hosts placed in different VLANs', () => {
    const cli = new CliSession(l.sw);
    for (const cmd of ['enable', 'conf t', 'vlan 10', 'name SALES', 'int g0/1', 'switchport mode access', 'switchport access vlan 10', 'end']) cli.execute(cmd);
    const results = l.pc1.ping('192.168.10.12');
    l.net.run();
    expect(results.some((r) => r.success)).toBe(false);
  });
});

describe('802.1Q trunk', () => {
  it('carries VLAN 20 between two switches', () => {
    resetMacAllocator();
    const net = new Topology();
    const sw1 = net.add(new Switch('SW1'));
    const sw2 = net.add(new Switch('SW2'));
    const a = net.add(new Pc('A'));
    const b = net.add(new Pc('B'));
    net.connect(a.nic, sw1.iface('Gi0/1'));
    net.connect(b.nic, sw2.iface('Gi0/1'));
    net.connect(sw1.iface('Gi0/8'), sw2.iface('Gi0/8'));
    for (const sw of [sw1, sw2]) {
      const cli = new CliSession(sw);
      for (const cmd of ['en', 'conf t', 'vlan 20', 'int g0/1', 'sw acc vlan 20', 'int g0/8', 'switchport mode trunk', 'end']) cli.execute(cmd);
    }
    a.configure('10.0.20.1', 24);
    b.configure('10.0.20.2', 24);
    const results = a.ping('10.0.20.2');
    net.run();
    expect(results.every((r) => r.success)).toBe(true);
    expect(net.trace.some((t) => t.from === 'SW1 Gi0/8' && t.frame.vlan === 20)).toBe(true);
  });
});
