import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, createShell, resetMacAllocator } from '../src';
import { ios } from './helpers';

function lab() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(pc1.nic, sw.iface('Gi0/1'));
  net.connect(pc2.nic, sw.iface('Gi0/2'));
  net.connect(r1.iface('Gi0/0'), sw.iface('Gi0/3'));
  ios(r1, 'conf t\nint g0/0\nip address 192.168.10.1 255.255.255.0\nno shut\nend');
  return { net, sw, r1, pc1, pc2, shell: new PcShell(pc1) };
}

describe('PC command prompt', () => {
  let l: ReturnType<typeof lab>;
  beforeEach(() => (l = lab()));

  it('shows a Windows-style prompt and help', () => {
    expect(l.shell.prompt).toBe('C:\\>');
    expect(l.shell.execute('')).toBe('');
    expect(l.shell.execute('?')).toMatch(/ipconfig <ip>/);
    expect(l.shell.execute('help')).toMatch(/tracert <ip\|ipv6>/);
    expect(l.shell.execute('format c:')).toBe('Invalid Command.');
  });

  it('sets an address with a dotted mask and a gateway', () => {
    expect(l.shell.execute('ipconfig 192.168.10.11 255.255.255.0 192.168.10.1')).toBe('');
    const out = l.shell.execute('ipconfig');
    expect(out).toMatch(/IPv4 Address\.+: 192\.168\.10\.11/);
    expect(out).toMatch(/Subnet Mask\.+: 255\.255\.255\.0/);
    expect(out).toMatch(/Default Gateway\.+: 192\.168\.10\.1/);
  });

  it('sets an address in CIDR form', () => {
    l.shell.execute('ipconfig 192.168.10.11/24 192.168.10.1');
    expect(l.pc1.nic.ip).toEqual({ address: '192.168.10.11', prefix: 24 });
    expect(l.pc1.gateway).toBe('192.168.10.1');
  });

  it('shows 0.0.0.0 before an address is set', () => {
    expect(l.shell.execute('ipconfig')).toMatch(/IPv4 Address\.+: 0\.0\.0\.0/);
  });

  it('rejects bad addresses', () => {
    expect(l.shell.execute('ipconfig 300.1.1.1 255.255.255.0')).toBe('Invalid Command.');
    expect(l.shell.execute('ipconfig 192.168.10.11')).toBe('Invalid Command.');
    expect(l.shell.execute('ipconfig 192.168.10.11 255.255.255.0 bogus')).toBe('Invalid gateway address.');
  });

  it('pings a neighbour with Windows output and statistics', () => {
    l.pc1.configure('192.168.10.11', 24);
    l.pc2.configure('192.168.10.12', 24);
    const out = l.shell.execute('ping 192.168.10.12');
    expect(out).toMatch(/Pinging 192\.168\.10\.12 with 32 bytes of data/);
    expect(out).toMatch(/Reply from 192\.168\.10\.12: bytes=32 time.*TTL=128/);
    expect(out).toMatch(/Sent = 4, Received = 4, Lost = 0 \(0% loss\)/);
    expect(out).toMatch(/Minimum = \d+ms, Maximum = \d+ms, Average = \d+ms/);
  });

  it('honours -n and validates it', () => {
    l.pc1.configure('192.168.10.11', 24);
    l.pc2.configure('192.168.10.12', 24);
    expect(l.shell.execute('ping -n 2 192.168.10.12')).toMatch(/Sent = 2, Received = 2/);
    expect(l.shell.execute('ping -n 0 192.168.10.12')).toBe('Bad value for option -n.');
    expect(l.shell.execute('ping -n many 192.168.10.12')).toBe('Bad value for option -n.');
  });

  it('reports bad targets and an unconfigured stack', () => {
    expect(l.shell.execute('ping')).toMatch(/could not find host/);
    expect(l.shell.execute('ping nowhere')).toMatch(/could not find host nowhere/);
    expect(l.shell.execute('tracert')).toMatch(/Unable to resolve target system name/);
    l.pc1.configure('192.168.10.11', 24);
    expect(l.shell.execute('ping 10.9.9.9')).toMatch(/General failure/);
  });

  it('times out when the far host is silent', () => {
    l.pc1.configure('192.168.10.11', 24);
    const out = l.shell.execute('ping -n 1 192.168.10.99');
    expect(out).toMatch(/Request timed out\./);
    expect(out).toMatch(/Lost = 1 \(100% loss\)/);
    expect(out).not.toMatch(/Approximate round trip/);
  });

  it('traces a route through the default gateway', () => {
    resetMacAllocator();
    const net = new Topology();
    const r1 = net.add(new Router('R1'));
    const pc1 = net.add(new Pc('PC1'));
    const pc2 = net.add(new Pc('PC2'));
    net.connect(pc1.nic, r1.iface('Gi0/0'));
    net.connect(pc2.nic, r1.iface('Gi0/1'));
    ios(r1, 'conf t\nint g0/0\nip address 10.1.1.1 255.255.255.0\nno shut\nint g0/1\nip address 10.2.2.1 255.255.255.0\nno shut\nend');
    pc1.configure('10.1.1.10', 24, '10.1.1.1');
    pc2.configure('10.2.2.10', 24, '10.2.2.1');
    const out = new PcShell(pc1).execute('tracert 10.2.2.10');
    expect(out).toMatch(/Tracing route to 10\.2\.2\.10/);
    expect(out).toMatch(/^\s+1\s.*10\.1\.1\.1$/m);
    expect(out).toMatch(/^\s+2\s.*10\.2\.2\.10$/m);
    expect(out).toMatch(/Trace complete\./);
  });

  it('shows and clears the ARP cache', () => {
    l.pc1.configure('192.168.10.11', 24);
    l.pc2.configure('192.168.10.12', 24);
    expect(l.shell.execute('arp -a')).toBe('No ARP Entries Found');
    l.shell.execute('ping -n 1 192.168.10.12');
    expect(l.shell.execute('arp -a')).toMatch(new RegExp(`192\\.168\\.10\\.12\\s+${l.pc2.nic.mac}\\s+dynamic`));
    expect(l.shell.execute('arp -d')).toBe('');
    expect(l.shell.execute('arp -a')).toBe('No ARP Entries Found');
    expect(l.shell.execute('arp')).toMatch(/Available commands/);
  });

  it('picks the right shell for each device', () => {
    expect(createShell(l.pc1)).toBeInstanceOf(PcShell);
    expect(createShell(l.r1)).toBeInstanceOf(CliSession);
    expect(createShell(l.sw)).toBeInstanceOf(CliSession);
  });
});
