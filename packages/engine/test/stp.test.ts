import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Switch, Topology, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** SW1, SW2 and SW3 in a triangle, with a PC on SW2 and one on SW3. */
function triangle() {
  resetMacAllocator();
  const net = new Topology();
  const sw1 = net.add(new Switch('SW1'));
  const sw2 = net.add(new Switch('SW2'));
  const sw3 = net.add(new Switch('SW3'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(sw1.iface('g0/1'), sw2.iface('g0/1'));
  net.connect(sw1.iface('g0/2'), sw3.iface('g0/1'));
  net.connect(sw2.iface('g0/2'), sw3.iface('g0/2'));
  net.connect(pc1.nic, sw2.iface('g0/5'));
  net.connect(pc2.nic, sw3.iface('g0/5'));
  pc1.configure('10.0.0.1', 24);
  pc2.configure('10.0.0.2', 24);
  net.converge();
  return { net, sw1, sw2, sw3, pc1, pc2 };
}

const role = (sw: Switch, port: string, vlan = 1) => sw.stp.vlans.get(vlan)?.ports.get(sw.iface(port))?.role;

describe('spanning tree', () => {
  let t: ReturnType<typeof triangle>;
  beforeEach(() => (t = triangle()));

  it('elects the lowest bridge ID as root and blocks one port of the loop', () => {
    expect(t.sw1.stp.isRoot(1)).toBe(true);
    expect(role(t.sw1, 'g0/1')).toBe('designated');
    expect(role(t.sw2, 'g0/1')).toBe('root');
    expect(role(t.sw3, 'g0/1')).toBe('root');
    // SW2 has the lower bridge ID, so it wins the SW2-SW3 segment and SW3 blocks.
    expect(role(t.sw2, 'g0/2')).toBe('designated');
    expect(role(t.sw3, 'g0/2')).toBe('alternate');
    expect(t.sw3.stp.forwarding(t.sw3.iface('g0/2'), 1)).toBe(false);
    expect(t.sw3.stp.blocking(t.sw3.iface('g0/2'))).toBe(true);
  });

  it('forwards across the loop without a broadcast storm', () => {
    const results = t.pc1.ping('10.0.0.2');
    const events = t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    expect(events).toBeLessThan(200);
  });

  it('storms when spanning tree is turned off', () => {
    for (const sw of [t.sw1, t.sw2, t.sw3]) ios(sw, 'conf t\nno spanning-tree vlan 1');
    t.pc1.ping('10.0.0.2', 1);
    expect(t.net.scheduler.runUntilIdle(5_000)).toBe(5_000);
  });

  it('moves the root with a lower priority and reroutes around the old path', () => {
    ios(t.sw3, 'conf t\nspanning-tree vlan 1 priority 4096');
    expect(t.sw3.stp.isRoot(1)).toBe(true);
    expect(t.sw1.stp.isRoot(1)).toBe(false);
    // SW1 and SW2 now both reach the root directly; the SW1-SW2 link is the one that blocks.
    expect(role(t.sw2, 'g0/1')).toBe('alternate');
    const out = ios(t.sw2, 'show spanning-tree vlan 1');
    expect(out).toMatch(/Root ID\s+Priority\s+4097/);
    expect(out).toMatch(/Gi0\/1\s+Altn BLK 4\s+128\.1\s+P2p/);
    const results = t.pc1.ping('10.0.0.2');
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('rejects priorities that are not a multiple of 4096', () => {
    expect(() => ios(t.sw2, 'conf t\nspanning-tree vlan 1 priority 1000')).toThrow(/increments of 4096/);
  });

  it('uses the root primary and secondary macros', () => {
    ios(t.sw2, 'conf t\nspanning-tree vlan 1 root primary');
    expect(t.sw2.stp.priorities.get(1)).toBe(24576);
    expect(t.sw2.stp.isRoot(1)).toBe(true);
    ios(t.sw3, 'conf t\nspanning-tree vlan 1 root primary');
    expect(t.sw3.stp.priorities.get(1)).toBe(20480);
    expect(t.sw3.stp.isRoot(1)).toBe(true);
    ios(t.sw1, 'conf t\nspanning-tree vlan 1 root secondary');
    expect(t.sw1.stp.priorities.get(1)).toBe(28672);
    ios(t.sw1, 'conf t\nno spanning-tree vlan 1 priority');
    expect(t.sw1.stp.priorities.has(1)).toBe(false);
    expect(ios(t.sw3, 'show running-config')).toContain('spanning-tree vlan 1 priority 20480');
  });

  it('shows the root bridge, mode and port table', () => {
    ios(t.sw1, 'conf t\nspanning-tree mode rapid-pvst');
    const out = ios(t.sw1, 'show spanning-tree');
    expect(out).toContain('VLAN0001');
    expect(out).toContain('Spanning tree enabled protocol rstp');
    expect(out).toContain('This bridge is the root');
    expect(out).toMatch(/Bridge ID\s+Priority\s+32769\s+\(priority 32768 sys-id-ext 1\)/);
    const sw2 = ios(t.sw2, 'show spanning-tree');
    expect(sw2).toContain('protocol ieee');
    expect(sw2).toMatch(/Port\s+1 \(GigabitEthernet0\/1\)/);
    const summary = ios(t.sw1, 'show spanning-tree summary');
    expect(summary).toContain('Switch is in rapid-pvst mode');
    expect(summary).toContain('Root bridge for: VLAN0001');
    expect(ios(t.sw1, 'show running-config')).toContain('spanning-tree mode rapid-pvst');
    expect(ios(t.sw1, 'show spanning-tree vlan 99')).toContain('does not exist');
    ios(t.sw1, 'conf t\nspanning-tree mode pvst');
    expect(t.sw1.stp.mode).toBe('pvst');
    expect(() => ios(t.sw1, 'conf t\nspanning-tree mode mst')).toThrow(/MST/);
  });

  it('runs one instance per VLAN, with its own root', () => {
    for (const sw of [t.sw1, t.sw2, t.sw3]) ios(sw, 'conf t\nvlan 10\nint range g0/1 - 2\nswitchport mode trunk');
    ios(t.sw2, 'conf t\nspanning-tree vlan 10 priority 4096');
    expect(t.sw1.stp.isRoot(1)).toBe(true);
    expect(t.sw2.stp.isRoot(10)).toBe(true);
    expect(role(t.sw1, 'g0/1', 10)).toBe('root');
    expect(ios(t.sw2, 'show spanning-tree summary')).toContain('Root bridge for: VLAN0010');
  });

  it('follows port cost and port priority', () => {
    ios(t.sw3, 'conf t\nint g0/1\nspanning-tree cost 100');
    // SW3 now reaches the root more cheaply through SW2.
    expect(role(t.sw3, 'g0/2')).toBe('root');
    expect(role(t.sw3, 'g0/1')).toBe('alternate');
    ios(t.sw3, 'conf t\nint g0/1\nno spanning-tree cost\nspanning-tree port-priority 64');
    expect(role(t.sw3, 'g0/1')).toBe('root');
    expect(() => ios(t.sw3, 'conf t\nint g0/1\nspanning-tree port-priority 10')).toThrow(/increments of 16/);
    ios(t.sw3, 'conf t\nint g0/1\nno spanning-tree port-priority');
    expect(t.sw3.iface('g0/1').stp?.priority).toBeUndefined();
  });

  it('elects a new root when the old one disappears', () => {
    t.net.remove(t.sw1);
    t.net.converge();
    expect(t.sw2.stp.isRoot(1)).toBe(true);
    expect(role(t.sw3, 'g0/2')).toBe('root');
  });

  it('makes PortFast ports edge ports that forward straight away', () => {
    ios(t.sw2, 'conf t\nint g0/5\nspanning-tree portfast');
    expect(t.sw2.stp.vlans.get(1)!.ports.get(t.sw2.iface('g0/5'))!.edge).toBe(true);
    expect(ios(t.sw2, 'show spanning-tree')).toMatch(/Gi0\/5\s+Desg FWD 4\s+128\.5\s+P2p Edge/);
    // A new host on an edge port can talk before the next round; on a normal port it waits.
    const pc3 = t.net.add(new Pc('PC3'));
    pc3.configure('10.0.0.3', 24);
    t.net.connect(pc3.nic, t.sw2.iface('g0/6'));
    expect(t.sw2.stp.forwarding(t.sw2.iface('g0/6'), 1)).toBe(false);
    ios(t.sw2, 'conf t\nint g0/7\nspanning-tree portfast edge');
    expect(t.sw2.stp.forwarding(t.sw2.iface('g0/7'), 1)).toBe(true);
    ios(t.sw2, 'conf t\nint g0/7\nno spanning-tree portfast');
    expect(t.sw2.stp.portfast(t.sw2.iface('g0/7'))).toBe(false);
  });

  it('applies PortFast and BPDU guard defaults to access ports', () => {
    const out = ios(t.sw2, 'conf t\nspanning-tree portfast default');
    expect(out).toContain('enables portfast by default');
    ios(t.sw2, 'conf t\nspanning-tree portfast bpduguard default');
    expect(t.sw2.stp.portfast(t.sw2.iface('g0/5'))).toBe(true);
    expect(t.sw2.stp.bpduGuard(t.sw2.iface('g0/5'))).toBe(true);
    ios(t.sw2, 'conf t\nint g0/5\nspanning-tree portfast disable');
    expect(t.sw2.stp.portfast(t.sw2.iface('g0/5'))).toBe(false);
    const run = ios(t.sw2, 'show running-config');
    expect(run).toContain('spanning-tree portfast default');
    expect(run).toContain('spanning-tree portfast bpduguard default');
    expect(run).toContain(' spanning-tree portfast disable');
    ios(t.sw2, 'conf t\nno spanning-tree portfast default\nno spanning-tree portfast bpduguard default');
    expect(t.sw2.stp.portfastDefault || t.sw2.stp.bpduGuardDefault).toBe(false);
  });

  it('err-disables a BPDU guard port that hears a BPDU, until shut and re-enabled', () => {
    // SW2 Gi0/1 faces the root, whose designated port keeps sending BPDUs.
    ios(t.sw2, 'conf t\nint g0/1\nspanning-tree bpduguard enable');
    const port = t.sw2.iface('g0/1');
    expect(port.errDisabled).toBe('bpduguard');
    expect(port.isUp).toBe(false);
    expect(t.sw1.iface('g0/1').isUp).toBe(false);
    expect(t.sw2.log.join('\n')).toContain('%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port GigabitEthernet0/1 with BPDU Guard enabled. Disabling port.');
    expect(ios(t.sw2, 'show interfaces status')).toMatch(/Gi0\/1\s+err-disabled/);
    expect(ios(t.sw2, 'show interfaces status err-disabled')).toMatch(/Gi0\/1\s+err-disabled bpduguard/);
    expect(ios(t.sw2, 'show ip interface brief')).toMatch(/GigabitEthernet0\/1\s+unassigned\s+YES unset\s+down\s+down/);
    // SW2 now reaches the root through SW3.
    expect(role(t.sw2, 'g0/2')).toBe('root');
    ios(t.sw2, 'conf t\nint g0/1\nshutdown\nspanning-tree bpduguard disable\nno shutdown');
    expect(port.errDisabled).toBeUndefined();
    expect(port.isUp).toBe(true);
    ios(t.sw2, 'conf t\nint g0/1\nno spanning-tree bpduguard');
    expect(port.stp?.bpduGuard).toBeUndefined();
  });

  it('blocks a root guard port that hears a superior BPDU', () => {
    // SW1 is the root. Root guard on SW2's port towards SW1, then SW1 is the better bridge on it.
    ios(t.sw2, 'conf t\nint g0/1\nspanning-tree guard root');
    const info = t.sw2.stp.vlans.get(1)!.ports.get(t.sw2.iface('g0/1'))!;
    expect(info.rootInconsistent).toBe(true);
    expect(t.sw2.stp.forwarding(t.sw2.iface('g0/1'), 1)).toBe(false);
    expect(t.sw2.log.join('\n')).toContain('%SPANTREE-2-ROOTGUARD_BLOCK: Root guard blocking port GigabitEthernet0/1 on VLAN0001.');
    expect(ios(t.sw2, 'show spanning-tree')).toMatch(/Gi0\/1\s+Desg BKN\*4\s+128\.1\s+P2p \*ROOT_Inc/);
    // Traffic still flows, the long way round through SW3.
    const results = t.pc1.ping('10.0.0.2');
    t.net.run();
    expect(results.every((r) => r.success)).toBe(true);
    ios(t.sw2, 'conf t\nint g0/1\nspanning-tree guard none');
    expect(t.sw2.log.join('\n')).toContain('ROOTGUARD_UNBLOCK');
    ios(t.sw2, 'conf t\nint g0/1\nspanning-tree guard root\nno spanning-tree guard');
    expect(t.sw2.iface('g0/1').stp?.guardRoot).toBeUndefined();
    expect(() => ios(t.sw2, 'conf t\nint g0/1\nspanning-tree guard loop')).toThrow(/Loop guard/);
  });

  it('lists nothing before any port carries a VLAN', () => {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW9'));
    net.converge();
    expect(new CliSession(sw).execute('show spanning-tree')).toBe('No spanning tree instance exists.');
  });
});
