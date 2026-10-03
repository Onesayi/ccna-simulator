import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, Switch, Topology, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** SW1 with PC1 on Gi0/1, a server on Gi0/8, and a spare laptop not yet cabled. */
function office() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const srv = net.add(new Pc('SRV'));
  const laptop = net.add(new Pc('LAPTOP'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(srv.nic, sw.iface('g0/8'));
  pc1.configure('10.0.0.1', 24);
  srv.configure('10.0.0.100', 24);
  laptop.configure('10.0.0.1', 24); // the intruder borrows PC1's address
  net.converge();
  return { net, sw, pc1, srv, laptop };
}

function ping(from: Pc, to: string) {
  const results = from.ping(to, 3);
  from.network!.run();
  return results.every((r) => r.success);
}

/** Unplugs PC1 and plugs the laptop into the same port. */
function swap(t: ReturnType<typeof office>) {
  t.net.disconnect(t.sw.iface('g0/1').link!);
  t.net.connect(t.laptop.nic, t.sw.iface('g0/1'));
  t.net.converge();
}

describe('port security', () => {
  let t: ReturnType<typeof office>;
  beforeEach(() => (t = office()));

  it('learns the first address and err-disables the port when a second one appears', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport mode access\nswitchport port-security');
    expect(ping(t.pc1, '10.0.0.100')).toBe(true);
    expect(t.sw.iface('g0/1').portSecurity!.addresses).toEqual([{ mac: t.pc1.nic.mac, vlan: 1, type: 'dynamic' }]);
    expect(ios(t.sw, 'show port-security interface g0/1')).toMatch(/Port Status\s+: Secure-up/);

    swap(t);
    expect(ping(t.laptop, '10.0.0.100')).toBe(false);
    const port = t.sw.iface('g0/1');
    expect(port.errDisabled).toBe('psecure-violation');
    expect(port.portSecurity!.violations).toBe(1);
    const log = t.sw.log.join('\n');
    expect(log).toContain(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${t.laptop.nic.mac} on port GigabitEthernet0/1.`);
    expect(log).toContain('%PM-4-ERR_DISABLE: psecure-violation error detected on Gi0/1, putting Gi0/1 in err-disable state');
    const show = ios(t.sw, 'show port-security interface g0/1');
    expect(show).toMatch(/Port Status\s+: Secure-shutdown/);
    expect(show).toContain(`Last Source Address:Vlan   : ${t.laptop.nic.mac}:1`);
    expect(show).toMatch(/Security Violation Count\s+: 1/);
    expect(ios(t.sw, 'show port-security')).toMatch(/Gi0\/1\s+1\s+0\s+1\s+Shutdown/);
  });

  it('forgets dynamic addresses when the port goes down, so shut/no shut recovers it', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security');
    ping(t.pc1, '10.0.0.100');
    swap(t);
    ping(t.laptop, '10.0.0.100');
    ios(t.sw, 'conf t\nint g0/1\nshutdown\nno shutdown');
    expect(t.sw.iface('g0/1').isUp).toBe(true);
    expect(ping(t.laptop, '10.0.0.100')).toBe(true);
  });

  it('keeps sticky addresses in the running config', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security\nswitchport port-security mac-address sticky');
    ping(t.pc1, '10.0.0.100');
    const sticky = t.sw.iface('g0/1').portSecurity!.addresses[0]!;
    expect(sticky.type).toBe('sticky');
    expect(ios(t.sw, 'show running-config')).toContain(` switchport port-security mac-address sticky ${t.pc1.nic.mac}`);
    expect(ios(t.sw, 'show port-security address')).toMatch(new RegExp(`1\\s+${t.pc1.nic.mac.replace(/\./g, '\\.')}\\s+SecureSticky\\s+Gi0/1`));
    // Sticky addresses survive the port going down.
    ios(t.sw, 'conf t\nint g0/1\nshutdown\nno shutdown');
    expect(t.sw.iface('g0/1').portSecurity!.addresses).toHaveLength(1);
    ios(t.sw, 'conf t\nint g0/1\nno switchport port-security mac-address sticky');
    expect(t.sw.iface('g0/1').portSecurity!.addresses[0]!.type).toBe('dynamic');
  });

  it('drops and counts with restrict, and drops silently with protect', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security\nswitchport port-security violation restrict');
    ping(t.pc1, '10.0.0.100');
    swap(t);
    expect(ping(t.laptop, '10.0.0.100')).toBe(false);
    const port = t.sw.iface('g0/1');
    expect(port.errDisabled).toBeUndefined();
    expect(port.portSecurity!.violations).toBeGreaterThan(0);
    expect(t.sw.log.join('\n')).toContain('PSECURE_VIOLATION');
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security violation protect');
    const before = port.portSecurity!.violations;
    expect(ping(t.laptop, '10.0.0.100')).toBe(false);
    expect(port.portSecurity!.violations).toBe(before);
    expect(ios(t.sw, 'show running-config')).toContain(' switchport port-security violation protect');
    ios(t.sw, 'conf t\nint g0/1\nno switchport port-security violation');
    expect(port.portSecurity!.violation).toBe('shutdown');
  });

  it('allows more hosts with a higher maximum', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security\nswitchport port-security maximum 2');
    ping(t.pc1, '10.0.0.100');
    swap(t);
    expect(ping(t.laptop, '10.0.0.100')).toBe(true);
    expect(ios(t.sw, 'show running-config')).toContain(' switchport port-security maximum 2');
    expect(() => ios(t.sw, 'conf t\nint g0/1\nswitchport port-security maximum 1')).toThrow(/less than/);
    ios(t.sw, 'conf t\nint g0/1\nno switchport port-security\nswitchport port-security\nno switchport port-security maximum');
    expect(t.sw.iface('g0/1').portSecurity!.maximum).toBe(1);
  });

  it('only admits a configured static address', () => {
    ios(t.sw, 'conf t\nint g0/1\nswitchport port-security\nswitchport port-security mac-address 0050.7966.6801');
    expect(ping(t.pc1, '10.0.0.100')).toBe(false);
    expect(t.sw.iface('g0/1').errDisabled).toBe('psecure-violation');
    expect(ios(t.sw, 'show running-config')).toContain(' switchport port-security mac-address 0050.7966.6801');
    expect(() => ios(t.sw, 'conf t\nint g0/1\nswitchport port-security mac-address 0050.7966.6802')).toThrow(/maximum limit/);
    expect(() => ios(t.sw, 'conf t\nint g0/1\nswitchport port-security mac-address nonsense')).toThrow();
    ios(t.sw, `conf t\nint g0/1\nno switchport port-security mac-address 0050.7966.6801\nswitchport port-security mac-address sticky ${t.pc1.nic.mac}\nshutdown\nno shutdown`);
    expect(ping(t.pc1, '10.0.0.100')).toBe(true);
  });

  it('refuses trunk ports and shows a disabled port', () => {
    expect(() => ios(t.sw, 'conf t\nint g0/2\nswitchport mode trunk\nswitchport port-security')).toThrow(/trunk port/);
    expect(new CliSession(t.sw).execute('show port-security interface g0/3')).toMatch(/Port Security\s+: Disabled/);
    expect(() => ios(t.sw, 'conf t\nint g0/1\nswitchport port-security violation ignore')).toThrow();
  });
});
