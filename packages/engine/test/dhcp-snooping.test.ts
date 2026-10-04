import { beforeEach, describe, expect, it } from 'vitest';
import { Pc, Router, Switch, Topology, resetMacAllocator } from '../src';
import { ios } from './helpers';

/**
 * PC1 on SW1. The real DHCP server (R2) sits behind R1, which relays for the LAN. A rogue router
 * plugged straight into SW1 answers first and hands out itself as the gateway.
 */
function lan() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const rogue = net.add(new Router('ROGUE'));
  const pc = net.add(new Pc('PC1'));
  net.connect(pc.nic, sw.iface('g0/1'));
  net.connect(rogue.iface('g0/0'), sw.iface('g0/5'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/0'));
  ios(r1, 'conf t\nint g0/0\nip address 192.168.10.1 255.255.255.0\nip helper-address 10.0.0.2\nno shut\nint g0/1\nip address 10.0.0.1 255.255.255.252\nno shut');
  ios(r2, 'conf t\nint g0/0\nip address 10.0.0.2 255.255.255.252\nno shut\nip route 192.168.10.0 255.255.255.0 10.0.0.1\nip dhcp excluded-address 192.168.10.1 192.168.10.99\nip dhcp pool LAN\nnetwork 192.168.10.0 255.255.255.0\ndefault-router 192.168.10.1');
  ios(rogue, 'conf t\nint g0/0\nip address 192.168.10.66 255.255.255.0\nno shut\nip dhcp excluded-address 192.168.10.66\nip dhcp pool EVIL\nnetwork 192.168.10.0 255.255.255.0\ndefault-router 192.168.10.66');
  return { net, sw, r1, r2, rogue, pc };
}

function renew(pc: Pc) {
  pc.renew();
  pc.network!.run();
  return { address: pc.nic.ip?.address, gateway: pc.defaultGateway, bound: pc.dhcpState === 'bound' };
}

describe('DHCP snooping', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('lets a rogue server win the race when snooping is off', () => {
    expect(renew(t.pc)).toEqual({ address: '192.168.10.1', gateway: '192.168.10.66', bound: true });
  });

  it('drops server messages on untrusted ports, and the relay then drops option 82', () => {
    // A rogue that is not an IOS router does not care about option 82.
    ios(t.rogue, 'conf t\nip dhcp relay information trust-all');
    ios(t.sw, 'conf t\nip dhcp snooping\nip dhcp snooping vlan 1\nint g0/8\nip dhcp snooping trust');
    const r = renew(t.pc);
    expect(r.bound).toBe(false);
    expect(t.pc.apipa).toBe(true);
    expect(t.sw.log.join('\n')).toMatch(/%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT: DHCP_SNOOPING drop message on untrusted port, message type: DHCPOFFER, MAC sa: /);
    expect(t.r2.dhcpServer.bindings.size).toBe(0);
  });

  it('works once the switch stops inserting option 82, and builds the binding table', () => {
    ios(t.sw, 'conf t\nip dhcp snooping\nip dhcp snooping vlan 1\nno ip dhcp snooping information option\nint g0/8\nip dhcp snooping trust');
    expect(renew(t.pc)).toEqual({ address: '192.168.10.100', gateway: '192.168.10.1', bound: true });
    expect(t.sw.snooping.bindings).toEqual([{ mac: t.pc.nic.mac, ip: '192.168.10.100', vlan: 1, port: t.sw.iface('g0/1'), leaseSeconds: 86400 }]);
    const table = ios(t.sw, 'show ip dhcp snooping binding');
    expect(table).toMatch(/AA:BB:CC:00:\S+\s+192\.168\.10\.100\s+86400\s+dhcp-snooping\s+1\s+GigabitEthernet0\/1/);
    expect(table).toContain('Total number of bindings: 1');
    const show = ios(t.sw, 'show ip dhcp snooping');
    expect(show).toContain('Switch DHCP snooping is enabled');
    expect(show).toContain('Insertion of option 82 is disabled');
    expect(show).toMatch(/GigabitEthernet0\/8\s+yes\s+yes\s+unlimited/);

    t.pc.ping('192.168.10.1', 1);
    t.net.run();
    t.pc.release();
    t.net.run();
    expect(t.sw.snooping.bindings).toEqual([]);
  });

  it('works when the relay trusts option 82 instead', () => {
    ios(t.sw, 'conf t\nip dhcp snooping\nip dhcp snooping vlan 1\nint g0/8\nip dhcp snooping trust');
    ios(t.r1, 'conf t\nint g0/0\nip dhcp relay information trusted');
    expect(renew(t.pc).gateway).toBe('192.168.10.1');
    ios(t.r1, 'conf t\nint g0/0\nno ip dhcp relay information trusted\nexit\nip dhcp relay information trust-all');
    t.pc.release();
    t.net.run();
    expect(renew(t.pc).gateway).toBe('192.168.10.1');
    expect(ios(t.r1, 'show running-config')).toContain('ip dhcp relay information trust-all');
  });

  it('only snoops in the configured VLANs', () => {
    ios(t.sw, 'conf t\nip dhcp snooping\nip dhcp snooping vlan 10');
    expect(renew(t.pc).gateway).toBe('192.168.10.66');
    expect(ios(t.sw, 'show ip dhcp snooping')).toMatch(/configured on following VLANs:\n10\nDHCP snooping is operational on following VLANs:\nnone/);
  });

  it('drops client messages whose hardware address does not match the frame', () => {
    ios(t.sw, 'conf t\nip dhcp snooping\nip dhcp snooping vlan 1');
    t.sw.receive(t.sw.iface('g0/1'), {
      src: t.pc.nic.mac,
      dst: 'ffff.ffff.ffff',
      payload: { kind: 'udp', src: '0.0.0.0', dst: '255.255.255.255', ttl: 128, srcPort: 68, dstPort: 67, dhcp: { op: 'discover', xid: 1, chaddr: '0000.1111.2222' } },
    });
    expect(t.sw.log.join('\n')).toContain('DHCP_SNOOPING_MATCH_MAC_FAIL');
  });

  it('round-trips through the running config', () => {
    ios(t.sw, 'conf t\nip dhcp snooping vlan 1,10\nip dhcp snooping\nno ip dhcp snooping information option\nint g0/8\nip dhcp snooping trust\nint g0/1\nip dhcp snooping limit rate 10');
    const cfg = ios(t.sw, 'show running-config');
    expect(cfg).toContain('ip dhcp snooping vlan 1,10\nno ip dhcp snooping information option\nip dhcp snooping\n');
    expect(cfg).toContain(' ip dhcp snooping limit rate 10');
    expect(cfg).toContain(' ip dhcp snooping trust');
    ios(t.sw, 'conf t\nno ip dhcp snooping vlan 10\nip dhcp snooping information option\nno ip dhcp snooping\nint g0/8\nno ip dhcp snooping trust\nint g0/1\nno ip dhcp snooping limit rate');
    expect(t.sw.snooping).toMatchObject({ enabled: false, option82: true, vlans: new Set([1]) });
    expect(t.sw.iface('g0/8').dhcpSnooping).toEqual({});
  });
});
