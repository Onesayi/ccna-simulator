import { beforeEach, describe, expect, it } from 'vitest';
import { Pc, Switch, Topology, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** Two switches joined by Gi0/1 and Gi0/2, with a PC on each. */
function pair() {
  resetMacAllocator();
  const net = new Topology();
  const sw1 = net.add(new Switch('SW1'));
  const sw2 = net.add(new Switch('SW2'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(sw1.iface('g0/1'), sw2.iface('g0/1'));
  net.connect(sw1.iface('g0/2'), sw2.iface('g0/2'));
  net.connect(pc1.nic, sw1.iface('g0/5'));
  net.connect(pc2.nic, sw2.iface('g0/5'));
  pc1.configure('10.0.0.1', 24);
  pc2.configure('10.0.0.2', 24);
  net.converge();
  return { net, sw1, sw2, pc1, pc2 };
}

const bundle = (sw: Switch, mode: string) => ios(sw, `conf t\nint range g0/1 - 2\nchannel-group 1 mode ${mode}`);

describe('EtherChannel', () => {
  let t: ReturnType<typeof pair>;
  beforeEach(() => (t = pair()));

  it('blocks one of two parallel links without a bundle', () => {
    const blocked = [t.sw2.iface('g0/1'), t.sw2.iface('g0/2')].filter((p) => !t.sw2.stp.forwarding(p, 1));
    expect(blocked).toHaveLength(1);
  });

  it('bundles with LACP active and passive, and spanning tree sees one port', () => {
    const created = bundle(t.sw1, 'active');
    expect(created).toContain('Creating a port-channel interface Port-channel 1');
    bundle(t.sw2, 'passive');
    const po = t.sw1.portChannel(1)!;
    expect(po.isUp).toBe(true);
    expect(t.sw1.bundledMembers(po)).toHaveLength(2);
    expect(t.sw2.stp.vlans.get(1)!.ports.get(t.sw2.portChannel(1)!)!.role).toBe('root');
    expect(t.sw2.stp.vlans.get(1)!.ports.get(t.sw2.portChannel(1)!)!.cost).toBe(3);
    const summary = ios(t.sw1, 'show etherchannel summary');
    expect(summary).toMatch(/1\s+Po1\(SU\)\s+LACP\s+Gi0\/1\(P\)\s+Gi0\/2\(P\)/);
    expect(ios(t.sw1, 'show spanning-tree')).toMatch(/Po1\s+Desg FWD 3\s+128\.65/);
    expect(t.sw1.log.join('\n')).toContain('Line protocol on Interface Port-channel1, changed state to up');
    const results = t.pc1.ping('10.0.0.2');
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    expect(t.sw1.macLookup(1, t.pc2.nic.mac)?.port).toBe(po);
    expect(ios(t.sw1, 'show mac address-table')).toMatch(/Po1/);
    expect(ios(t.sw1, 'show running-config')).toContain(' channel-group 1 mode active');
    expect(ios(t.sw1, 'show ip interface brief')).toMatch(/Port-channel1\s+unassigned\s+YES unset\s+up\s+up/);
  });

  it('does not bundle two passive (LACP) or two auto (PAgP) ends', () => {
    bundle(t.sw1, 'passive');
    bundle(t.sw2, 'passive');
    expect(t.sw1.portChannel(1)!.isUp).toBe(false);
    expect(ios(t.sw1, 'show etherchannel summary')).toMatch(/Po1\(SD\)\s+LACP\s+Gi0\/1\(I\)\s+Gi0\/2\(I\)/);
    // The stand-alone ports still work, with one of them blocked by spanning tree.
    const results = t.pc1.ping('10.0.0.2');
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    ios(t.sw1, 'conf t\nint range g0/1 - 2\nno channel-group\nchannel-group 2 mode auto');
    ios(t.sw2, 'conf t\nint range g0/1 - 2\nno channel-group\nchannel-group 2 mode auto');
    expect(t.sw1.portChannel(2)!.isUp).toBe(false);
  });

  it('bundles with PAgP desirable and auto', () => {
    bundle(t.sw1, 'desirable');
    bundle(t.sw2, 'auto');
    expect(t.sw2.portChannel(1)!.isUp).toBe(true);
    expect(ios(t.sw2, 'show etherchannel summary')).toContain('PAgP');
  });

  it('bundles static mode on without negotiating', () => {
    bundle(t.sw1, 'on');
    bundle(t.sw2, 'on');
    expect(t.sw1.portChannel(1)!.isUp).toBe(true);
    expect(ios(t.sw1, 'show etherchannel summary')).toMatch(/Po1\(SU\)\s+-\s+Gi0\/1\(P\)/);
  });

  it('never bundles LACP with PAgP', () => {
    bundle(t.sw1, 'active');
    bundle(t.sw2, 'desirable');
    expect(t.sw1.portChannel(1)!.isUp).toBe(false);
    expect(t.sw2.portChannel(1)!.isUp).toBe(false);
  });

  it('rejects mixing protocols inside one channel group', () => {
    ios(t.sw1, 'conf t\nint g0/1\nchannel-group 1 mode active');
    expect(() => ios(t.sw1, 'conf t\nint g0/2\nchannel-group 1 mode desirable')).toThrow(/protocol mismatch/);
  });

  it('copies port-channel settings to members, and suspends a member that differs', () => {
    bundle(t.sw1, 'active');
    bundle(t.sw2, 'active');
    ios(t.sw1, 'conf t\nvlan 10\nint po1\nswitchport mode trunk\nswitchport trunk allowed vlan 1,10');
    ios(t.sw2, 'conf t\nvlan 10\nint po1\nswitchport mode trunk\nswitchport trunk allowed vlan 1,10');
    expect(t.sw1.iface('g0/1').mode).toBe('trunk');
    expect(t.sw1.portChannel(1)!.isUp).toBe(true);
    expect(ios(t.sw1, 'show interfaces trunk')).toMatch(/Po1\s+on\s+802\.1q\s+trunking/);
    ios(t.sw1, 'conf t\nint g0/2\nswitchport trunk native vlan 10');
    expect(t.sw1.bundledMembers(t.sw1.portChannel(1)!)).toHaveLength(1);
    expect(ios(t.sw1, 'show etherchannel summary')).toContain('Gi0/2(s)');
    // A port that joins an existing channel takes its settings.
    ios(t.sw1, 'conf t\nint g0/2\nno channel-group\nswitchport mode access\nchannel-group 1 mode active');
    expect(t.sw1.iface('g0/2').mode).toBe('trunk');
    expect(t.sw1.bundledMembers(t.sw1.portChannel(1)!)).toHaveLength(2);
    ios(t.sw1, 'conf t\nint po1\nswitchport trunk native vlan 10\nswitchport trunk allowed vlan add 20\nswitchport trunk allowed vlan remove 20');
    expect(t.sw1.iface('g0/1').nativeVlan).toBe(10);
  });

  it('keeps forwarding over the surviving member when one link fails', () => {
    bundle(t.sw1, 'active');
    bundle(t.sw2, 'active');
    ios(t.sw1, 'conf t\nint g0/1\nshutdown');
    const po = t.sw1.portChannel(1)!;
    expect(po.isUp).toBe(true);
    expect(t.sw1.bundledMembers(po)).toHaveLength(1);
    expect(ios(t.sw1, 'show etherchannel summary')).toContain('Gi0/1(D)');
    const results = t.pc1.ping('10.0.0.2');
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    ios(t.sw1, 'conf t\nint g0/2\nshutdown');
    expect(po.isUp).toBe(false);
    expect(t.sw1.log.join('\n')).toContain('Line protocol on Interface Port-channel1, changed state to down');
  });

  it('does not bundle ports that lead to different switches', () => {
    resetMacAllocator();
    const net = new Topology();
    const a = net.add(new Switch('A'));
    const b = net.add(new Switch('B'));
    const c = net.add(new Switch('C'));
    net.connect(a.iface('g0/1'), b.iface('g0/1'));
    net.connect(a.iface('g0/2'), c.iface('g0/1'));
    ios(a, 'conf t\nint range g0/1 - 2\nchannel-group 1 mode active');
    ios(b, 'conf t\nint g0/1\nchannel-group 1 mode active');
    ios(c, 'conf t\nint g0/1\nchannel-group 1 mode active');
    expect(a.bundledMembers(a.portChannel(1)!)).toHaveLength(1);
    expect(ios(a, 'show etherchannel summary')).toMatch(/\(s\)/);
  });

  it('validates the command', () => {
    expect(() => ios(t.sw1, 'conf t\nint g0/1\nchannel-group 1 mode sometimes')).toThrow();
    expect(() => ios(t.sw1, 'conf t\ninterface port-channel 99')).toThrow(/port-channel number/);
    expect(() => ios(t.sw1, 'conf t\ninterface vlan 1\nchannel-group 1 mode on')).toThrow();
    expect(() => t.sw1.joinChannel(t.sw1.iface('vlan1'), 1, 'on')).toThrow();
    expect(ios(t.sw1, 'show etherchannel summary')).toContain('Number of channel-groups in use: 0');
  });
});
