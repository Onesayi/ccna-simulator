import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, resetMacAllocator, type Device } from '../src';
import { ios } from './helpers';

/** R1 Gi0/0 to SW1 Gi0/1, SW1 Gi0/2 to SW2 Gi0/2 as a trunk, and a PC on SW2. */
function lab() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const sw1 = net.add(new Switch('SW1'));
  const sw2 = net.add(new Switch('SW2'));
  const pc = net.add(new Pc('PC1'));
  net.connect(r1.iface('g0/0'), sw1.iface('g0/1'));
  net.connect(sw1.iface('g0/2'), sw2.iface('g0/2'));
  net.connect(pc.nic, sw2.iface('g0/3'));
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut');
  ios(sw1, 'conf t\nint g0/2\nswitchport mode trunk\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut');
  ios(sw2, 'conf t\nint g0/2\nswitchport mode trunk');
  return { net, r1, sw1, sw2, pc };
}

/** One EXEC command, returning its output even when it is an error. */
function exec(d: Device, cmd: string): string {
  const cli = new CliSession(d);
  cli.execute('enable');
  return cli.execute(cmd);
}

describe('CDP and LLDP', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => (t = lab()));

  it('discovers directly connected routers and switches with CDP by default', () => {
    const show = ios(t.sw1, 'show cdp neighbors');
    expect(show).toMatch(/R1\s+Gig 0\/1\s+\d+\s+R B S I\s+ISR4331\s+Gig 0\/0/);
    expect(show).toMatch(/SW2\s+Gig 0\/2\s+\d+\s+S I\s+WS-C2960-\s+Gig 0\/2/);
    expect(show).toContain('Total cdp entries displayed : 2');
    // PCs do not run CDP, and CDP never crosses a switch.
    expect(ios(t.sw2, 'show cdp neighbors')).not.toContain('R1');
    const detail = ios(t.r1, 'show cdp neighbors detail');
    expect(detail).toContain('Device ID: SW1');
    expect(detail).toContain('  IP address: 192.168.1.2');
    expect(detail).toContain('Platform: cisco WS-C2960-24TT-L,  Capabilities: Switch IGMP ');
    expect(detail).toContain('Interface: GigabitEthernet0/0,  Port ID (outgoing port): GigabitEthernet0/1');
    expect(detail).toContain('Native VLAN: 1');
    expect(ios(t.r1, 'show cdp')).toContain('Sending a holdtime value of 180 seconds');
    expect(exec(t.sw1, 'show lldp neighbors')).toBe('% LLDP is not enabled');
  });

  it('runs LLDP once enabled on both ends', () => {
    ios(t.r1, 'conf t\nlldp run');
    expect(ios(t.r1, 'show lldp neighbors')).toContain('Total entries displayed: 0');
    ios(t.sw1, 'conf t\nlldp run');
    expect(ios(t.r1, 'show lldp neighbors')).toMatch(/SW1\s+Gi0\/0\s+\d+\s+B\s+Gi0\/1/);
    expect(ios(t.sw1, 'show lldp neighbors')).toMatch(/R1\s+Gi0\/1\s+\d+\s+R\s+Gi0\/0/);
    const detail = ios(t.sw1, 'show lldp neighbors detail');
    expect(detail).toContain('System Name: R1');
    expect(detail).toContain('    IP: 192.168.1.1');
    expect(detail).toContain(`Chassis id: ${t.r1.interfaces[0]!.mac}`);
    expect(ios(t.sw1, 'show lldp')).toContain('Status: ACTIVE');
    ios(t.sw1, 'conf t\nint g0/1\nno lldp receive');
    expect(ios(t.sw1, 'show lldp neighbors')).toContain('Total entries displayed: 0');
    ios(t.sw1, 'conf t\nint g0/1\nlldp receive\nno lldp transmit');
    expect(ios(t.r1, 'show lldp neighbors')).toContain('Total entries displayed: 0');
    expect(ios(t.sw1, 'show running-config')).toContain('lldp run');
    expect(ios(t.sw1, 'show running-config')).toContain(' no lldp transmit');
    ios(t.sw1, 'conf t\nint g0/1\nlldp transmit\nexit\nno lldp run');
    expect(exec(t.sw1, 'show lldp')).toBe('% LLDP is not enabled');
    expect(exec(t.sw1, 'show lldp neighbors detail')).toBe('% LLDP is not enabled');
  });

  it('stops advertising on a port with no cdp enable, and everywhere with no cdp run', () => {
    ios(t.r1, 'conf t\nint g0/0\nno cdp enable');
    expect(ios(t.sw1, 'show cdp neighbors')).not.toContain('R1');
    expect(ios(t.r1, 'show running-config')).toContain(' no cdp enable');
    ios(t.r1, 'conf t\nint g0/0\ncdp enable');
    expect(ios(t.sw1, 'show cdp neighbors')).toContain('R1');
    ios(t.sw1, 'conf t\nno cdp run');
    expect(exec(t.sw1, 'show cdp neighbors')).toBe('% CDP is not enabled');
    expect(exec(t.sw1, 'show cdp neighbors detail')).toBe('% CDP is not enabled');
    expect(exec(t.sw1, 'show cdp')).toBe('% CDP is not enabled');
    expect(ios(t.r1, 'show cdp neighbors')).toContain('Total cdp entries displayed : 0');
    expect(ios(t.sw1, 'show running-config')).toContain('no cdp run');
    ios(t.sw1, 'conf t\ncdp run');
    expect(ios(t.r1, 'show cdp neighbors detail')).toContain('Total cdp entries displayed : 1');
  });

  it('adds the domain name to the device ID and wraps long names', () => {
    ios(t.r1, 'conf t\nhostname BRANCH-EDGE-ROUTER\nip domain-name ccna.lab');
    expect(ios(t.sw1, 'show cdp neighbors')).toContain('BRANCH-EDGE-ROUTER.ccna.lab\n');
  });

  it('reports a native VLAN mismatch once', () => {
    ios(t.sw2, 'conf t\nint g0/2\nswitchport trunk native vlan 99');
    const mismatch = '%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on GigabitEthernet0/2 (1), with SW2 GigabitEthernet0/2 (99).';
    expect(t.sw1.log.filter((l) => l === mismatch)).toHaveLength(1);
    ios(t.sw1, 'show cdp neighbors');
    expect(t.sw1.log.filter((l) => l === mismatch)).toHaveLength(1);
    ios(t.sw2, 'conf t\nint g0/2\nno shutdown');
    ios(t.sw1, 'conf t\nint g0/2\nswitchport trunk native vlan 99');
    expect(t.sw1.log.filter((l) => l.includes('NATIVE_VLAN_MISMATCH'))).toHaveLength(1);
  });

  it('only runs on physical ports', () => {
    expect(ios(t.r1, 'conf t\ninterface loopback 0\nip address 1.1.1.1 255.255.255.255\nexit\nint g0/0').length).toBe(0);
    const out = (() => {
      try {
        return ios(t.r1, 'conf t\ninterface loopback 0\nno cdp enable');
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(out).toContain('% Invalid input');
  });
});
