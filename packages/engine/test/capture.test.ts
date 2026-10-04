import { beforeEach, describe, expect, it } from 'vitest';
import { LABS, LabRun, Pc, Router, Switch, TRACE_LIMIT, Topology, compileFilter, dissect, isKeepalive, resetMacAllocator, summarize, type Frame } from '../src';
import { ios } from './helpers';

/** PC1 in VLAN 10 behind SW1, routed by R1 (router on a stick) to R2 and PC3. */
function twoSites() {
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc3 = net.add(new Pc('PC3'));
  net.connect(pc1.nic, sw.iface('g0/1'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/8'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(r2.iface('g0/0'), pc3.nic);
  ios(r1, `conf t
    int g0/0
    no shut
    int g0/0.10
    encapsulation dot1q 10
    ip address 192.168.10.1 255.255.255.0
    int g0/1
    ip address 10.0.12.1 255.255.255.252
    no shut
    exit
    ip route 192.168.30.0 255.255.255.0 10.0.12.2`);
  ios(r2, `conf t
    int g0/0
    ip address 192.168.30.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.12.2 255.255.255.252
    no shut
    exit
    ip route 192.168.10.0 255.255.255.0 10.0.12.1`);
  ios(sw, `conf t
    vlan 10
    int g0/1
    switchport mode access
    switchport access vlan 10
    int g0/8
    switchport mode trunk`);
  pc1.configure('192.168.10.10', 24, '192.168.10.1');
  pc3.configure('192.168.30.10', 24, '192.168.30.1');
  net.converge();
  return { net, r1, r2, sw, pc1, pc3 };
}

describe('packet capture', () => {
  beforeEach(() => resetMacAllocator());

  it('numbers frames and records the cable each one crossed', () => {
    const { net, pc1, r1 } = twoSites();
    const start = net.trace.length;
    pc1.ping('192.168.30.10', 2);
    net.run();
    const frames = net.trace.slice(start);
    expect(frames.map((e) => e.no)).toEqual(frames.map((_, i) => frames[0]!.no + i));
    const trunk = net.links.find((l) => l.b.device === r1 || l.a.device === r1)!;
    expect(frames.some((e) => e.link === trunk.id)).toBe(true);
  });

  it('summarises ARP and ICMP like Wireshark', () => {
    const { net, pc1 } = twoSites();
    const start = net.trace.length;
    pc1.ping('192.168.30.10', 2);
    net.run();
    const rows = net.trace.slice(start).map((e) => summarize(e.frame));
    expect(rows[0]).toEqual({ protocol: 'ARP', source: pc1.nic.mac, destination: 'Broadcast', info: 'Who has 192.168.10.1? Tell 192.168.10.10' });
    expect(rows.find((r) => r.protocol === 'ARP' && r.info.includes('is at'))?.info).toMatch(/^192\.168\.10\.1 is at /);
    const echo = rows.find((r) => r.protocol === 'ICMP')!;
    expect(echo).toMatchObject({ source: '192.168.10.10', destination: '192.168.30.10' });
    expect(echo.info).toMatch(/^Echo \(ping\) request {2}id=\d+, seq=0, ttl=128$/);
  });

  it('shows the 802.1Q tag on the trunk and the TTL dropping hop by hop', () => {
    const { net, pc1 } = twoSites();
    pc1.ping('192.168.30.10', 3);
    net.run();
    const start = net.trace.length;
    pc1.ping('192.168.30.10', 1);
    net.run();
    const requests = net.trace.slice(start).filter((e) => e.frame.payload.kind === 'icmp' && e.frame.payload.type === 'echo-request');
    expect(requests.map((e) => `${e.from}>${e.to}`)).toEqual(['PC1 Eth0>SW1 Gi0/1', 'SW1 Gi0/8>R1 Gi0/0', 'R1 Gi0/1>R2 Gi0/1', 'R2 Gi0/0>PC3 Eth0']);
    const layers = requests.map((e) => dissect(e.frame));
    expect(layers[1]!.map((l) => l.title)).toEqual([
      expect.stringMatching(/^Ethernet II/),
      '802.1Q Virtual LAN, ID: 10',
      'Internet Protocol Version 4, Src: 192.168.10.10, Dst: 192.168.30.10',
      'Internet Control Message Protocol',
    ]);
    expect(layers[0]![0]!.fields[2]).toEqual(['Type', 'IPv4 (0x0800)']);
    expect(layers[1]![0]!.fields[2]).toEqual(['Type', '802.1Q Virtual LAN (0x8100)']);
    const ttl = (l: typeof layers[number]) => l.find((x) => x.title.startsWith('Internet Protocol'))!.fields[0]![1];
    expect(layers.map(ttl)).toEqual(['128', '128', '127', '126']);
  });

  it('dissects every kind of frame the labs produce', () => {
    const kinds = new Set<string>();
    for (const lab of LABS) {
      const run = new LabRun(lab);
      run.applySolution();
      run.grade({ probes: true });
      for (const e of run.topology.trace) {
        const s = summarize(e.frame);
        expect(s.protocol).toBeTruthy();
        expect(s.info).toBeTruthy();
        const layers = dissect(e.frame);
        expect(layers.length).toBeGreaterThanOrEqual(2);
        kinds.add(s.protocol);
      }
    }
    for (const k of ['ARP', 'CDP', 'DHCP', 'HSRP', 'ICMP', 'ICMPv6', 'LACP', 'LLDP', 'NTP', 'OSPF', 'STP', 'TCP']) expect(kinds).toContain(k);
  });

  it('describes the less common payloads', () => {
    const f = (payload: Frame['payload']): Frame => ({ src: 'aabb.cc00.0001', dst: 'aabb.cc00.0002', payload });
    expect(summarize(f({ kind: 'udp', src: '1.1.1.1', dst: '2.2.2.2', ttl: 64, srcPort: 5000, dstPort: 69 })).info).toBe('5000 → 69');
    expect(summarize(f({ kind: 'tcp', src: '1.1.1.1', dst: '2.2.2.2', ttl: 64, srcPort: 80, dstPort: 5000, flags: 'rst' })).info).toBe('80 → 5000 [RST]');
    expect(summarize(f({ kind: 'tcp', src: '1.1.1.1', dst: '2.2.2.2', ttl: 64, srcPort: 80, dstPort: 5000, flags: 'syn-ack' })).info).toBe('80 → 5000 [SYN, ACK]');
    expect(summarize(f({ kind: 'arp', op: 'reply', senderMac: 'aabb.cc00.0001', senderIp: '1.1.1.1', targetMac: 'ffff.ffff.ffff', targetIp: '1.1.1.1' })).info).toBe('Gratuitous ARP for 1.1.1.1 (Reply)');
    const ospf = f({ kind: 'ospf', src: '1.1.1.1', dst: '224.0.0.5', ttl: 1, ospf: { type: 'lsu', routerId: '1.1.1.1', area: 0, lsas: [] } });
    expect(summarize(ospf).info).toBe('LS Update');
    expect(dissect(ospf)[2]!.fields).toContainEqual(['LSAs', '0']);
    const dhcp = dissect(f({ kind: 'udp', src: '0.0.0.0', dst: '255.255.255.255', ttl: 64, srcPort: 68, dstPort: 67, dhcp: { op: 'discover', xid: 255, chaddr: 'aabb.cc00.0001', option82: { circuitId: '10-Gi0/1', remoteId: 'aabb.cc00.0100' } } }));
    expect(dhcp[3]!.fields).toContainEqual(['Relay Agent Information (82)', 'circuit-id 10-Gi0/1, remote-id aabb.cc00.0100']);
    expect(dissect(f({ kind: 'icmpv6', src: 'fe80::1', dst: 'ff02::1', hopLimit: 255, type: 'ra', id: 0, seq: 0, prefixes: [{ prefix: '2001:db8::', length: 64 }] }))[2]!.fields).toContainEqual(['Prefix', '2001:db8::/64']);
  });

  it('keeps a bounded trace but keeps numbering', () => {
    const { net, pc1 } = twoSites();
    const before = net.trace.at(-1)!.no;
    for (let k = 0; k < 6; k++) {
      pc1.ping('192.168.30.10', 1000);
      net.scheduler.runUntilIdle(1_000_000);
    }
    expect(net.trace.length).toBeLessThanOrEqual(TRACE_LIMIT + 1000);
    expect(net.trace.at(-1)!.no).toBeGreaterThan(before + TRACE_LIMIT);
  });
});

describe('display filters', () => {
  beforeEach(() => resetMacAllocator());

  function frames() {
    const { net, pc1 } = twoSites();
    pc1.ping('192.168.30.10', 2);
    net.run();
    return { net, frames: net.trace.map((e) => e.frame), pc1 };
  }

  it('matches protocols, addresses, VLANs and ports', () => {
    const { frames: all, pc1 } = frames();
    const count = (f: string) => all.filter(compileFilter(f)).length;
    expect(count('')).toBe(all.length);
    expect(count('arp')).toBeGreaterThan(0);
    expect(count('arp') + count('!arp')).toBe(all.length);
    expect(count('icmp && vlan == 10')).toBeGreaterThan(0);
    expect(count('icmp and not vlan')).toBeGreaterThan(0);
    expect(count('ip.src == 192.168.10.10')).toBe(all.filter((f) => f.payload.kind === 'icmp' && f.payload.src === '192.168.10.10').length + all.filter((f) => f.payload.kind === 'arp' && f.payload.senderIp === '192.168.10.10').length);
    expect(count('ip.dst == 192.168.30.10 || ip.addr == 10.0.12.1')).toBeGreaterThan(0);
    expect(count(`eth.addr == ${pc1.nic.mac}`)).toBe(count(`eth.src == ${pc1.nic.mac} or eth.dst == ${pc1.nic.mac}`));
    expect(count('ip.addr != 192.168.10.10')).toBe(all.length - count('ip.addr == 192.168.10.10'));
    expect(count('(stp || cdp || lldp) && !ip')).toBe(all.filter(isKeepalive).filter((f) => f.payload.kind !== 'ospf').length);
    expect(count('eth')).toBe(all.length);
    expect(count('ipv6')).toBe(0);
    expect(count('vlan.id == 10')).toBe(count('vlan == 10'));
    expect(count('tcp.port == 22 || udp.port == 67 || dhcp || hsrp || ntp || ospf || icmpv6 || lacp || pagp || tcp || udp || ip')).toBeGreaterThan(0);
  });

  it('rejects filters it cannot parse', () => {
    for (const bad of ['foo', 'ip.addr ==', 'ip.addr == (', 'arp &&', '(arp', 'arp)', 'colour == red', '!']) expect(() => compileFilter(bad), bad).toThrow(/Invalid filter/);
  });
});
