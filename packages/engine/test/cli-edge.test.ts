import { describe, expect, it } from 'vitest';
import { CliSession, Pc, Router, Switch, Topology, resetMacAllocator } from '../src';

function on<T extends Router | Switch>(device: T) {
  resetMacAllocator();
  const net = new Topology();
  net.add(device);
  const cli = new CliSession(device);
  const run = (...lines: string[]) => lines.map((l) => cli.execute(l)).at(-1)!;
  return { net, cli, run, device };
}

describe('IOS CLI edge cases', () => {
  it('ignores blank lines and flags ambiguous abbreviations', () => {
    const { run } = on(new Router('R1'));
    expect(run('   ')).toBe('');
    expect(run('e')).toMatch(/% Ambiguous command:\s+"e"/);
    expect(run('bogus')).toMatch(/Invalid input/);
  });

  it('answers ? with only the commands this device supports', () => {
    const r = on(new Router('R1'));
    r.run('enable', 'configure terminal');
    expect(r.run('?')).toMatch(/ip route/);
    expect(r.run('?')).not.toMatch(/ip routing/);
    expect(r.run('zzz?')).toBe('% Unrecognized command');
    const s = on(new Switch('SW1'));
    s.run('enable', 'configure terminal', 'interface g0/1');
    expect(s.run('switchport ?')).toMatch(/switchport mode/);
  });

  it('steps back through modes with exit and disable', () => {
    const { cli, run } = on(new Switch('SW1'));
    run('enable', 'configure terminal', 'vlan 10', 'exit');
    expect(cli.prompt).toBe('SW1(config)#');
    run('exit');
    expect(cli.prompt).toBe('SW1#');
    run('disable');
    expect(cli.prompt).toBe('SW1>');
    run('enable', 'exit');
    expect(cli.prompt).toBe('SW1>');
  });

  it('saves the configuration', () => {
    const { run } = on(new Router('R1'));
    run('enable');
    expect(run('copy running-config startup-config')).toBe('');
    expect(run('')).toMatch(/\[OK\]/);
    expect(run('write memory')).toMatch(/\[OK\]/);
  });

  it('refuses a hostname another device already uses', () => {
    const { net, run } = on(new Router('R1'));
    net.add(new Router('R2'));
    expect(run('enable', 'conf t', 'hostname R2')).toMatch(/already used by another device/);
  });

  it('validates ping and traceroute arguments', () => {
    const { run } = on(new Router('R1'));
    run('enable');
    expect(run('ping 1.2.3')).toMatch(/Invalid input/);
    expect(run('ping 10.0.0.1 repeat 0')).toBe('% Invalid repeat count');
    expect(run('ping 10.0.0.1 repeat 2')).toMatch(/Success rate is 0 percent \(0\/2\)/);
    expect(run('traceroute 10.0.0.1')).toMatch(/Tracing the route to 10\.0\.0\.1/);
  });

  it('validates static routes and removes them', () => {
    const { device, run } = on(new Router('R1'));
    run('enable', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shut', 'exit');
    expect(run('ip route 192.168.1.1 255.255.255.0 10.0.0.2')).toMatch(/Inconsistent address and mask/);
    expect(run('ip route 192.168.1.0 255.255.255.0 10.0.0.2 300')).toMatch(/Invalid distance/);
    expect(run('ip route 192.168.1.0 255.255.255.0 10.0.0.2')).toBe('');
    // Gi0/0 has no cable, so the route is configured but not installed in the routing table.
    expect(run('do show running-config')).toMatch(/ip route 192\.168\.1\.0 255\.255\.255\.0 10\.0\.0\.2/);
    run('no ip route 192.168.1.0 255.255.255.0 10.0.0.2');
    expect(run('do show running-config')).not.toMatch(/ip route 192\.168\.1\.0/);
    expect(device.kind).toBe('router');
  });

  it('keeps switch-only commands off routers', () => {
    const { run } = on(new Router('R1'));
    run('enable', 'conf t');
    expect(run('ip routing')).toMatch(/Invalid input/);
    expect(run('vlan 10')).toMatch(/Invalid input/);
    expect(run('do show vlan brief')).toMatch(/Invalid input/);
  });

  it('turns routing and the default gateway on and off on a switch', () => {
    const { device, run } = on(new Switch('SW1'));
    run('enable', 'conf t', 'ip routing');
    expect(device.ipRouting).toBe(true);
    run('no ip routing', 'ip default-gateway 10.0.0.1');
    expect(device.ipRouting).toBe(false);
    expect(device.defaultGateway).toBe('10.0.0.1');
    run('no ip default-gateway');
    expect(device.defaultGateway).toBeUndefined();
  });

  it('creates, deletes and protects VLANs', () => {
    const { device, run } = on(new Switch('SW1'));
    run('enable', 'conf t');
    expect(run('vlan 5000')).toBe('% Bad VLAN list');
    run('vlan 30', 'exit');
    expect(device.vlans.get(30)).toBe('VLAN0030');
    expect(run('no vlan 1')).toMatch(/may not be deleted/);
    run('no vlan 30');
    expect(device.vlans.has(30)).toBe(false);
  });

  it('sets and clears interface descriptions and addresses', () => {
    const { device, run } = on(new Router('R1'));
    run('enable', 'conf t', 'int g0/1', 'description Link to ISP', 'ip address 203.0.113.1 255.255.255.252');
    expect(device.iface('Gi0/1').description).toBe('Link to ISP');
    run('no description', 'no ip address');
    expect(device.iface('Gi0/1').description).toBeUndefined();
    expect(device.iface('Gi0/1').ip).toBeUndefined();
  });

  it('needs an encapsulation before a sub-interface takes an address', () => {
    const { device, cli, run } = on(new Router('R1'));
    run('enable', 'conf t', 'int g0/0.99');
    expect(cli.prompt).toBe('R1(config-subif)#');
    expect(run('ip address 10.99.0.1 255.255.255.0')).toMatch(/802\.1Q/);
    run('encapsulation dot1q 99 native', 'ip address 10.99.0.1 255.255.255.0');
    const sub = device.iface('Gi0/0.99');
    expect(sub.encapVlan).toBe(99);
    expect(sub.encapNative).toBe(true);
  });

  it('points switches at an SVI for addressing', () => {
    const { run } = on(new Switch('SW1'));
    expect(run('enable', 'conf t', 'int g0/1', 'ip address 10.0.0.2 255.255.255.0')).toMatch(/use an SVI/);
  });

  it('edits the trunk allowed list', () => {
    const { device, run } = on(new Switch('SW1'));
    run('enable', 'conf t', 'int g0/1', 'switchport mode trunk');
    expect(run('switchport mode dynamic')).toMatch(/Invalid input/);
    run('switchport trunk allowed vlan remove 2-4094');
    expect([...(device.iface('Gi0/1').allowedVlans as Set<number>)]).toEqual([1]);
    run('switchport trunk allowed vlan add 10,20');
    expect([...(device.iface('Gi0/1').allowedVlans as Set<number>)].sort((a, b) => a - b)).toEqual([1, 10, 20]);
    run('switchport trunk allowed vlan none');
    expect((device.iface('Gi0/1').allowedVlans as Set<number>).size).toBe(0);
    run('switchport trunk allowed vlan all');
    expect(device.iface('Gi0/1').allowedVlans).toBe('all');
  });

  it('shows the ARP table, MAC table and console log', () => {
    resetMacAllocator();
    const net = new Topology();
    const sw = net.add(new Switch('SW1'));
    const r1 = net.add(new Router('R1'));
    const pc = net.add(new Pc('PC1'));
    net.connect(r1.iface('Gi0/0'), sw.iface('Gi0/1'));
    net.connect(pc.nic, sw.iface('Gi0/2'));
    pc.configure('10.0.0.10', 24, '10.0.0.1');
    const r = new CliSession(r1);
    ['enable', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end', 'ping 10.0.0.10'].forEach((c) => r.execute(c));
    expect(r.execute('show arp')).toMatch(/10\.0\.0\.10/);
    expect(r.execute('show logging')).toMatch(/changed state to up/);
    const s = new CliSession(sw);
    expect(s.execute('show mac address-table')).toMatch(new RegExp(pc.nic.mac.replace(/\./g, '\\.')));
  });
});
