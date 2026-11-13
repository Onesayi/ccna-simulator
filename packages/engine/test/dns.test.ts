import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, LabRun, Pc, PcShell, Router, Server, ServerShell, Switch, Topology, compileFilter, dissect, evaluate, findLab, resetMacAllocator, summarize, type Check } from '../src';
import { ZoneSet, addressFromReverse, checkZoneReport, loadZones, parseZone, reverseName, zoneNameFromFile } from '../src/services/dns';
import { ios } from './helpers';

export const ZONE = `$TTL 3600
@     IN SOA ns1.ccna.lab. admin.ccna.lab. (
            2026111301 ; serial
            3600 600 86400 300 )
      IN NS   ns1
      IN MX   10 mail
ns1   IN A    192.168.1.100
srv   IN A    192.168.1.100
www   IN A    192.168.1.100
www   IN AAAA 2001:db8:1::100
mail  300 IN A 192.168.1.25
shop  IN CNAME www
`;

const REVERSE = `$ORIGIN 1.168.192.in-addr.arpa.
@   IN SOA ns1.ccna.lab. admin.ccna.lab. 1 3600 600 86400 300
    IN NS  ns1.ccna.lab.
100 IN PTR srv.ccna.lab.
1   IN PTR r1.ccna.lab.
`;

/** R1 routes between the LAN (SW1, SRV, PC1 by DHCP) and PC2 on 10.0.0.0/24. */
function lan() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const sw = net.add(new Switch('SW1'));
  const srv = net.add(new Server('SRV'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/1'));
  net.connect(srv.nic, sw.iface('g0/2'));
  net.connect(pc1.nic, sw.iface('g0/3'));
  net.connect(pc2.nic, r1.iface('g0/1'));
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  srv.files.set('ccna.lab.zone', ZONE);
  srv.files.set('db.1.168.192.in-addr.arpa', REVERSE);
  pc2.configure('10.0.0.10', 24, '10.0.0.1');
  ios(
    r1,
    `conf t
    int g0/0
    ip address 192.168.1.1 255.255.255.0
    no shut
    int g0/1
    ip address 10.0.0.1 255.255.255.0
    no shut
    exit
    ip dhcp excluded-address 192.168.1.1 192.168.1.199
    ip dhcp pool LAN
    network 192.168.1.0 255.255.255.0
    default-router 192.168.1.1
    dns-server 192.168.1.100
    domain-name ccna.lab`,
  );
  pc1.renew();
  net.converge();
  net.run();
  return { net, r1, sw, srv, pc1, pc2 };
}

function cli(device: Router | Switch): (...lines: string[]) => string {
  const s = new CliSession(device, { loggedIn: true });
  s.execute('enable');
  return (...lines) => lines.map((l) => s.execute(l)).at(-1)!;
}

describe('zone files', () => {
  it('reads BIND syntax: $TTL, $ORIGIN, @, relative names, blank owners and multi-line SOA', () => {
    const z = parseZone(ZONE, 'ccna.lab');
    expect(z.loaded).toBe(true);
    expect(z.serial).toBe(2026111301);
    expect(z.records.find((r) => r.type === 'MX')).toMatchObject({ name: 'ccna.lab', preference: 10, data: 'mail.ccna.lab' });
    expect(z.records.find((r) => r.name === 'mail.ccna.lab')?.ttl).toBe(300);
    expect(z.records.find((r) => r.type === 'CNAME')).toMatchObject({ name: 'shop.ccna.lab', data: 'www.ccna.lab' });
    expect(checkZoneReport(z)).toBe('zone ccna.lab/IN: loaded serial 2026111301\nOK');
    const rev = parseZone(REVERSE, 'whatever');
    expect(rev.origin).toBe('1.168.192.in-addr.arpa');
    expect(rev.records.find((r) => r.type === 'PTR' && r.name === '100.1.168.192.in-addr.arpa')?.data).toBe('srv.ccna.lab');
  });

  it('appends the origin to names without a trailing dot, the classic CNAME mistake', () => {
    const z = parseZone(ZONE.replace('shop  IN CNAME www', 'shop  IN CNAME www.ccna.lab'), 'ccna.lab');
    expect(z.records.find((r) => r.type === 'CNAME')?.data).toBe('www.ccna.lab.ccna.lab');
    const reply = new ZoneSet([z]).answer({ id: 1, response: false, name: 'shop.ccna.lab', qtype: 'A' });
    expect(reply.rcode).toBe('NXDOMAIN');
    expect(reply.answers?.[0]?.type).toBe('CNAME');
  });

  it('reports what named-checkzone reports', () => {
    const broken = `$TTL 60
@ IN SOA ns1 admin 1 1 1 1 1
  IN NS ns1
  IN MX 10 mial
ns1 IN A 300.1.1.1
www IN CNAME ns1
www IN A 192.168.1.5
ftp IN TXT "hello"
x IN MX ten mail
$INCLUDE other
mail.example.com. IN A 192.168.1.9
`;
    const z = parseZone(broken, 'ccna.lab');
    const report = checkZoneReport(z);
    expect(report).toContain('ccna.lab.zone:5: bad dotted quad');
    expect(report).toContain("ccna.lab.zone:8: unknown RR type 'TXT'");
    expect(report).toContain('ccna.lab.zone:9: MX needs a preference');
    expect(report).toContain("ccna.lab.zone:10: unknown $ directive '$INCLUDE'");
    expect(report).toContain('www.ccna.lab: CNAME and other data');
    expect(report).toContain("ccna.lab/MX 'mial.ccna.lab' has no address records (A or AAAA)");
    expect(report).toContain("ccna.lab/NS 'ns1.ccna.lab' has no address records");
    expect(report).toContain('mail.example.com: ignoring out-of-zone data');
    expect(report).toMatch(/not loaded due to errors\.$/);
    const empty = checkZoneReport(parseZone('www IN A 192.168.1.1\nwww IN AAAA nope\n IN A 1.1.1.1\n', 'x.lab'));
    expect(empty).toContain('has no SOA record');
    expect(empty).toContain('has no NS records');
    expect(empty).toContain('bad IPv6 address');
    expect(checkZoneReport(parseZone('  IN A 1.1.1.1\nfoo IN\nbar IN MX\nbaz IN SOA ns1\n', 'x.lab'))).toMatch(/no current owner name[\s\S]*unknown RR type ''[\s\S]*unexpected end of input[\s\S]*SOA needs/);
    const cnameMx = parseZone(ZONE.replace('IN MX   10 mail', 'IN MX   10 shop'), 'ccna.lab');
    expect(checkZoneReport(cnameMx)).toContain("'shop.ccna.lab' is a CNAME (illegal)");
  });

  it('finds zone files by name and maps reverse names', () => {
    expect(zoneNameFromFile('ccna.lab.zone')).toBe('ccna.lab');
    expect(zoneNameFromFile('/etc/bind/db.Example.COM')).toBe('example.com');
    expect(zoneNameFromFile('notes.txt')).toBeUndefined();
    expect(reverseName('192.168.1.10')).toBe('10.1.168.192.in-addr.arpa');
    expect(addressFromReverse('10.1.168.192.in-addr.arpa.')).toBe('192.168.1.10');
    expect(addressFromReverse('www.ccna.lab')).toBeUndefined();
    expect(addressFromReverse('10.1.168.999.in-addr.arpa')).toBeUndefined();
  });

  it('answers authoritatively: CNAME chasing, NODATA with the SOA, additional addresses, refusals', () => {
    const zones = new ZoneSet(loadZones(new Map([['ccna.lab.zone', ZONE], ['README', 'x']])));
    const ask = (name: string, qtype: 'A' | 'MX' | 'NS' | 'AAAA') => zones.answer({ id: 7, response: false, name, qtype, rd: true });
    expect(ask('shop.ccna.lab', 'A').answers?.map((a) => a.data)).toEqual(['www.ccna.lab', '192.168.1.100']);
    expect(ask('mail.ccna.lab', 'AAAA')).toMatchObject({ rcode: 'NOERROR', answers: [], aa: true });
    expect(ask('mail.ccna.lab', 'AAAA').authority?.[0]?.type).toBe('SOA');
    expect(ask('nope.ccna.lab', 'A').rcode).toBe('NXDOMAIN');
    expect(ask('ccna.lab', 'MX').additional?.[0]?.data).toBe('192.168.1.25');
    expect(ask('ccna.lab', 'NS').additional?.[0]?.data).toBe('192.168.1.100');
    expect(ask('www.example.com', 'A')).toMatchObject({ rcode: 'REFUSED', aa: false });
    const broken = new ZoneSet([parseZone('www IN A 1.1.1.1', 'bad.lab')]);
    expect(broken.answer({ id: 1, response: false, name: 'www.bad.lab', qtype: 'A' }).rcode).toBe('SERVFAIL');
  });
});

describe('DNS clients and servers', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('gives PCs a DNS server and suffix by DHCP', () => {
    expect(t.pc1.dnsServer).toBe('192.168.1.100');
    expect(t.pc1.searchSuffix).toBe('ccna.lab');
    expect(new PcShell(t.pc1).execute('ipconfig /all')).toContain('DNS Servers.....................: 192.168.1.100');
  });

  it('nslookup names the server, then answers A, AAAA, CNAME aliases and reverse lookups', () => {
    const sh = new PcShell(t.pc1);
    expect(sh.execute('nslookup www.ccna.lab')).toBe(
      ['Server:  srv.ccna.lab', 'Address:  192.168.1.100', '', 'Name:    www.ccna.lab', 'Addresses:  2001:db8:1::100', '          192.168.1.100', ''].join('\n'),
    );
    expect(sh.execute('nslookup shop')).toContain('Name:    www.ccna.lab\nAddresses:  2001:db8:1::100\n          192.168.1.100\nAliases:  shop.ccna.lab');
    expect(sh.execute('nslookup mail')).toContain('Name:    mail.ccna.lab\nAddress:  192.168.1.25');
    expect(sh.execute('nslookup 192.168.1.100')).toContain('Name:    srv.ccna.lab\nAddress:  192.168.1.100');
    expect(sh.execute('nslookup nope.ccna.lab')).toContain("*** srv.ccna.lab can't find nope.ccna.lab: Non-existent domain");
    expect(sh.execute('nslookup www.example.com')).toContain("can't find www.example.com: Query refused");
  });

  it('nslookup -type= shows MX, NS, CNAME, PTR and SOA records the Windows way', () => {
    const sh = new PcShell(t.pc1);
    const mx = sh.execute('nslookup -type=mx ccna.lab');
    expect(mx).toContain('ccna.lab        MX preference = 10, mail exchanger = mail.ccna.lab');
    expect(mx).toContain('\n\nmail.ccna.lab   internet address = 192.168.1.25');
    expect(sh.execute('nslookup -q=NS ccna.lab')).toContain('ccna.lab        nameserver = ns1.ccna.lab');
    expect(sh.execute('nslookup -type=cname shop.ccna.lab')).toContain('shop.ccna.lab   canonical name = www.ccna.lab');
    expect(sh.execute('nslookup -type=ptr 192.168.1.1')).toContain('1.1.168.192.in-addr.arpa name = r1.ccna.lab');
    expect(sh.execute('nslookup -type=soa ccna.lab')).toContain('        primary name server = ns1.ccna.lab\n        responsible mail addr = admin.ccna.lab\n        serial  = 2026111301');
    // No MX on www: Windows shows the zone's SOA instead.
    expect(sh.execute('nslookup -type=mx www.ccna.lab')).toContain('ccna.lab\n        primary name server = ns1.ccna.lab');
    expect(sh.execute('nslookup -type=aaaa www')).toContain('Address:  2001:db8:1::100');
    expect(sh.execute('nslookup -type=txt www')).toBe('unknown query type: txt');
    expect(sh.execute('nslookup')).toMatch(/^Usage: nslookup/);
  });

  it('nslookup reports a missing or silent server, and can ask another one', () => {
    const sh = new PcShell(t.pc2);
    expect(sh.execute('nslookup www.ccna.lab')).toContain('*** Default servers are not available');
    expect(sh.execute('nslookup www.ccna.lab 192.168.1.100')).toContain('Name:    www.ccna.lab');
    expect(sh.execute('nslookup www.ccna.lab ns1')).toContain("*** Can't find address for server ns1");
    expect(sh.execute('nslookup www.ccna.lab 10.0.0.99')).toBe(
      ['DNS request timed out.', '    timeout was 2 seconds.', 'Server:  UnKnown', 'Address:  10.0.0.99', '', 'DNS request timed out.', '    timeout was 2 seconds.', '*** Request to UnKnown timed-out'].join('\n'),
    );
    // A server with no PTR record for itself is "UnKnown".
    t.srv.files.delete('db.1.168.192.in-addr.arpa');
    expect(new PcShell(t.pc1).execute('nslookup www')).toContain('Server:  UnKnown');
  });

  it('pings, traces, telnets and fetches by name', () => {
    const sh = new PcShell(t.pc1);
    const ping = sh.execute('ping www');
    expect(ping).toContain('Pinging www.ccna.lab [192.168.1.100] with 32 bytes of data:');
    expect(ping).toContain('Reply from 192.168.1.100');
    expect(sh.execute('ping nope')).toBe('Ping request could not find host nope. Please check the name and try again.');
    expect(sh.execute('tracert srv.ccna.lab')).toContain('Tracing route to srv.ccna.lab [192.168.1.100]');
    expect(sh.execute('tracert nope')).toBe('Unable to resolve target system name nope.');
    expect(sh.execute('curl http://www.ccna.lab')).toContain('It works!');
    expect(sh.execute('curl http://nope.ccna.lab')).toBe('curl: (6) Could not resolve host: nope.ccna.lab');
    expect(sh.execute('telnet nope')).toContain('Could not open connection to the host');
    expect(sh.execute('telnet www 80')).toContain('Trying 192.168.1.100 ...Open');
    expect(sh.execute('ssh -l admin nope')).toBe('ssh: Could not resolve hostname nope: No such host is known.');
    // AAAA when there is no A record.
    t.srv.files.set('ccna.lab.zone', `${ZONE}v6only IN AAAA 2001:db8:1::99\n`);
    expect(t.pc1.resolveName('v6only')).toEqual({ fqdn: 'v6only.ccna.lab', address: '2001:db8:1::99' });
    expect(t.pc1.resolveName('ns1.ccna.lab.').address).toBe('192.168.1.100');
    expect(t.pc1.resolveName('ccna.lab')).toEqual({ fqdn: 'ccna.lab', error: 'no-address' });
    expect(t.pc1.resolveName('www.example.com').error).toBe('REFUSED');
    t.pc1.dnsServer = '192.168.1.99';
    expect(t.pc1.resolveName('www').error).toBe('timeout');
    expect(t.pc2.resolveName('www').error).toBe('no-server');
  });

  it('sets the DNS server by hand with ipconfig or netsh', () => {
    const sh = new PcShell(t.pc2);
    expect(sh.execute('ipconfig 10.0.0.10 255.255.255.0 10.0.0.1 192.168.1.100')).toBe('');
    expect(t.pc2.dnsServer).toBe('192.168.1.100');
    expect(sh.execute('ipconfig 10.0.0.10/24 10.0.0.1 bad')).toBe('Invalid DNS server address.');
    expect(sh.execute('netsh interface ip set dns name="Ethernet0" static 192.168.1.1')).toBe('');
    expect(t.pc2.dnsServer).toBe('192.168.1.1');
    expect(sh.execute('netsh interface ip set dns Ethernet0 static nope')).toBe('The parameter is incorrect.');
    expect(sh.execute('netsh interface ip set dns Ethernet0')).toMatch(/^Usage/);
    expect(sh.execute('netsh interface ip set dns Ethernet0 dhcp')).toBe('');
    expect(t.pc2.dnsServer).toBeUndefined();
    t.pc2.dnsSuffix = 'ccna.lab';
    expect(t.pc2.searchSuffix).toBe('ccna.lab');
    expect(sh.execute('ipconfig /flushdns')).toContain('Successfully flushed the DNS Resolver Cache.');
  });

  it('logs queries on the server and checks zones with named-checkzone and rndc', () => {
    new PcShell(t.pc1).execute('ping -n 1 www');
    const sh = new ServerShell(t.srv);
    expect(sh.execute('cat /var/log/named.log')).toMatch(/^client 192\.168\.1\.200#\d+: query: www\.ccna\.lab IN A \+ \(192\.168\.1\.100\) -> NOERROR$/m);
    expect(sh.execute('named-checkzone ccna.lab ccna.lab.zone')).toBe('zone ccna.lab/IN: loaded serial 2026111301\nOK');
    expect(sh.execute('named-checkzone ccna.lab nope.zone')).toContain('file not found');
    expect(sh.execute('named-checkzone')).toMatch(/^usage/);
    expect(sh.execute('rndc reload')).toBe('server reload successful');
    expect(sh.execute('rndc status')).toContain('number of zones: 2');
    expect(sh.execute('rndc flush')).toMatch(/unknown command/);
    sh.execute('cat >> ccna.lab.zone <<EOF');
    sh.execute('broken IN A 999.1.1.1');
    sh.execute('EOF');
    expect(t.srv.files.get('ccna.lab.zone')).toMatch(/shop  IN CNAME www\nbroken IN A 999\.1\.1\.1\n$/);
    expect(sh.execute('rndc reload')).toContain('zone ccna.lab/IN: bad dotted quad');
    expect(new PcShell(t.pc1).execute('nslookup www')).toContain('Server failed');
    t.srv.files.clear();
    expect(sh.execute('rndc reload')).toMatch(/no zone files/);
    expect(sh.execute('help')).toContain('named-checkzone');
    // With no zones, nothing listens on UDP 53.
    expect(t.pc1.resolveName('www').error).toBe('timeout');
  });

  it('shows DNS in the packet capture', () => {
    const start = t.net.trace.length;
    new PcShell(t.pc1).execute('nslookup shop');
    const frames = t.net.trace.slice(start).map((e) => e.frame);
    const dns = frames.filter(compileFilter('dns'));
    expect(dns.length).toBeGreaterThanOrEqual(6);
    const rows = dns.map((f) => summarize(f));
    expect(rows[0]).toMatchObject({ protocol: 'DNS', info: expect.stringMatching(/^Standard query 0x[0-9a-f]{4} PTR 100\.1\.168\.192\.in-addr\.arpa$/) });
    expect(rows.map((r) => r.info)).toContainEqual(expect.stringMatching(/^Standard query response 0x[0-9a-f]{4} A shop\.ccna\.lab CNAME www\.ccna\.lab A 192\.168\.1\.100$/));
    const reply = dns.find((f) => f.payload.kind === 'udp' && f.payload.dns?.response && f.payload.dns.qtype === 'A')!;
    const layer = dissect(reply).find((l) => l.title.startsWith('Domain Name System'))!;
    expect(layer.title).toBe('Domain Name System (response)');
    expect(layer.fields).toContainEqual(['Flags', 'Standard query response, recursion desired, authoritative, No error']);
    expect(layer.fields).toContainEqual(['Answer', 'shop.ccna.lab: type CNAME, class IN, www.ccna.lab']);
    new PcShell(t.pc1).execute('nslookup nope');
    new PcShell(t.pc1).execute('nslookup -type=mx ccna.lab');
    const later = t.net.trace.map((e) => e.frame).filter(compileFilter('dns')).map((f) => summarize(f).info);
    expect(later).toContainEqual(expect.stringMatching(/No such name A nope\.ccna\.lab$/));
    expect(later).toContainEqual(expect.stringMatching(/MX ccna\.lab MX 10 mail\.ccna\.lab$/));
    const nx = t.net.trace.map((e) => e.frame).filter(compileFilter('dns')).find((f) => f.payload.kind === 'udp' && f.payload.dns?.rcode === 'NXDOMAIN')!;
    expect(dissect(nx).at(-1)!.fields).toContainEqual(['Authority', 'ccna.lab: type SOA, class IN, mname ns1.ccna.lab']);
  });
});

describe('IOS name resolution', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('broadcasts a lookup for a mistyped command, unless domain lookup is off', () => {
    const run = cli(t.r1);
    const start = t.net.trace.length;
    expect(run('shwo')).toBe('Translating "shwo"...domain server (255.255.255.255)\n% Unknown command or computer name, or unable to find computer address');
    const sent = t.net.trace.slice(start).map((e) => e.frame).filter(compileFilter('dns'));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((f) => f.payload.kind === 'udp' && f.payload.dst === '255.255.255.255')).toBe(true);
    // A word that starts a command is not a host name.
    expect(run('sh')).toContain('% Invalid input');
    run('conf t', 'no ip domain-lookup', 'end');
    expect(run('shwo')).toBe('Translating "shwo"\n% Unknown command or computer name, or unable to find computer address');
    expect(run('show running-config')).toContain('no ip domain lookup');
    run('conf t', 'ip domain lookup', 'end');
    expect(run('show running-config')).not.toContain('no ip domain lookup');
    run('conf t', 'no ip domain lookup', 'ip domain-lookup', 'end');
    expect(t.r1.dns.lookup).toBe(true);
  });

  it('resolves through name servers, caches the answer and appends the domain name', () => {
    const run = cli(t.r1);
    run('conf t', 'ip name-server 192.168.1.100', 'ip domain name ccna.lab', 'end');
    const ping = run('ping www');
    expect(ping).toMatch(/^Translating "www"\.\.\.domain server \(192\.168\.1\.100\) \[OK\]\nType escape sequence to abort\.\nSending 5, 100-byte ICMP Echos to 192\.168\.1\.100/);
    // The second time, the cache answers.
    expect(run('ping www.ccna.lab')).toMatch(/^Type escape sequence/);
    const hosts = run('show hosts');
    expect(hosts).toContain('Default domain is ccna.lab');
    expect(hosts).toContain('Name/address lookup uses domain service');
    expect(hosts).toContain('Name servers are 192.168.1.100');
    expect(hosts).toMatch(/www\.ccna\.lab +None {2}\(temp, OK\) {2}0 {3}IP {4}192\.168\.1\.100/);
    run('clear host *');
    expect(run('show hosts')).not.toContain('www.ccna.lab');
    expect(run('ping nope')).toBe('Translating "nope"...domain server (192.168.1.100)\n% Unrecognized host or address, or protocol not running.');
    expect(run('traceroute srv')).toMatch(/^Translating "srv"\.\.\.domain server \(192\.168\.1\.100\) \[OK\]\nType escape sequence/);
    expect(run('traceroute nope')).toContain('% Unrecognized host');
    expect(run('ping 10.1.1')).toContain('% Invalid input');
  });

  it('moves on to the next name server only when one is silent', () => {
    const run = cli(t.r1);
    run('conf t', 'ip name-server 192.168.1.99 192.168.1.100', 'ip name-server 192.168.1.100', 'end');
    expect(t.r1.dns.nameServers).toEqual(['192.168.1.99', '192.168.1.100']);
    expect(run('ping srv.ccna.lab')).toMatch(/^Translating "srv\.ccna\.lab"\.\.\.domain server \(192\.168\.1\.99\) \(192\.168\.1\.100\) \[OK\]/);
    expect(run('show running-config')).toContain('ip name-server 192.168.1.99 192.168.1.100');
    run('conf t', 'no ip name-server 192.168.1.99', 'end');
    expect(t.r1.dns.nameServers).toEqual(['192.168.1.100']);
    run('conf t', 'no ip name-server', 'end');
    expect(t.r1.dns.nameServers).toEqual([]);
    run('conf t', 'ip name-server 1.1.1.1 1.1.1.2 1.1.1.3 1.1.1.4 1.1.1.5 1.1.1.6');
    expect(run('ip name-server 1.1.1.7')).toBe('% Name server table full');
  });

  it('uses static ip host entries without asking anyone', () => {
    const run = cli(t.r1);
    run('conf t', 'ip host SRV 192.168.1.100', 'ip host PC2 10.0.0.10 10.0.0.11', 'no ip domain-lookup', 'end');
    expect(run('ping srv')).toMatch(/^Type escape sequence to abort\.\nSending 5, 100-byte ICMP Echos to 192\.168\.1\.100/);
    expect(run('show hosts')).toMatch(/SRV +None {2}\(perm, OK\)/);
    expect(run('show hosts')).toContain('Name/address lookup uses static mappings');
    expect(run('show hosts')).toContain('Default domain is not set');
    expect(run('show running-config')).toContain('ip host PC2 10.0.0.10 10.0.0.11');
    expect(run('ping nope')).toBe('Translating "nope"\n% Unrecognized host or address, or protocol not running.');
    run('conf t', 'no ip host PC2');
    expect(run('ip host 1bad 10.0.0.1')).toContain('% Invalid input');
    expect(run('ip host bad 10.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 10.0.0.6 10.0.0.7 10.0.0.8 10.0.0.9')).toContain('% Invalid input');
    run('end');
    expect(t.r1.dns.host('pc2')).toBeUndefined();
    // Static entries survive clear host.
    run('clear host srv');
    expect(t.r1.dns.host('srv')).toBeDefined();
  });

  it('telnets to a host name, typed alone or after telnet and ssh', () => {
    const run = cli(t.r1);
    ios(t.sw, `conf t
    int vlan 1
    ip address 192.168.1.2 255.255.255.0
    no shut
    line vty 0 4
    password cisco
    login`);
    run('conf t', 'ip host SW1 192.168.1.2', 'end');
    expect(run('sw1')).toBe('Trying sw1 (192.168.1.2)... Open\n\nUser Access Verification\n');
    expect(run('cisco')).toBe('');
    run('exit');
    const s = new CliSession(t.r1, { loggedIn: true });
    s.execute('enable');
    expect(s.execute('telnet sw1')).toMatch(/^Trying sw1 \(192\.168\.1\.2\)\.\.\. Open/);
    expect(s.execute('cisco')).toBe('');
    expect(s.prompt).toBe('SW1>');
    expect(run('telnet SW1 80')).toBe('Trying SW1 (192.168.1.2, 80)... \n% Connection refused by remote host');
    expect(run('telnet nope')).toContain('% Unrecognized host');
    expect(run('telnet 10.1.1')).toContain('% Invalid input');
    expect(run('ssh -l admin sw1')).toBe('% Connection refused by remote host');
  });

  it('answers DNS from the host table with ip dns server, forwarding the rest', () => {
    const run = cli(t.r1);
    run('conf t', 'ip host printer 10.0.0.50', 'ip dns server', 'end');
    const sh = new PcShell(t.pc2);
    sh.execute('ipconfig 10.0.0.10 255.255.255.0 10.0.0.1 10.0.0.1');
    expect(sh.execute('nslookup printer')).toContain('Name:    printer\nAddress:  10.0.0.50');
    expect(sh.execute('nslookup -type=ptr 10.0.0.50')).toContain('50.0.0.10.in-addr.arpa name = printer');
    // No name server yet: the router does not know.
    expect(sh.execute('nslookup www.ccna.lab')).toContain('Non-existent domain');
    run('conf t', 'ip name-server 192.168.1.100', 'end');
    const fwd = sh.execute('nslookup www.ccna.lab');
    expect(fwd).toContain('Non-authoritative answer:\nName:    www.ccna.lab');
    expect(fwd).toContain('192.168.1.100');
    // The forwarded answer lands in the router's cache.
    expect(t.r1.dns.host('www.ccna.lab')?.perm).toBe(false);
    expect(run('show running-config')).toContain('ip dns server');
    run('conf t', 'no ip dns server', 'end');
    expect(t.pc2.resolveName('printer').error).toBe('timeout');
    // A switch only resolves (no ip dns server here), and ignores broadcast queries.
    expect(t.sw.dns.server).toBe(false);
  });
});

describe('DNS grader checks', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('explains each failure', () => {
    const devices: Record<string, Router | Switch | Server | Pc> = { R1: t.r1, SW1: t.sw, SRV: t.srv, PC1: t.pc1, PC2: t.pc2 };
    const check = (c: Check) => evaluate(c, (n) => devices[n]!);
    expect(check({ type: 'nameServer', device: 'PC1', address: '192.168.1.100' }).pass).toBe(true);
    expect(check({ type: 'nameServer', device: 'PC1', address: '192.168.1.1' }).detail).toBe('PC1 asks 192.168.1.100 for names');
    expect(check({ type: 'nameServer', device: 'PC2', address: '192.168.1.1' }).detail).toBe('PC2 has no DNS server');
    expect(check({ type: 'nameServer', device: 'R1', address: '192.168.1.100' }).detail).toBe('R1 has no ip name-server');
    ios(t.r1, 'conf t\nip name-server 192.168.1.99\nip host SRV 192.168.1.100\nno ip domain lookup');
    expect(check({ type: 'nameServer', device: 'R1', address: '192.168.1.100' }).detail).toBe('R1 asks 192.168.1.99');
    expect(check({ type: 'domainLookup', device: 'R1', enabled: false }).pass).toBe(true);
    expect(check({ type: 'domainLookup', device: 'R1', enabled: true }).detail).toBe('Domain lookup is off on R1');
    expect(check({ type: 'ipHost', device: 'R1', name: 'srv', address: '192.168.1.100' }).pass).toBe(true);
    expect(check({ type: 'ipHost', device: 'R1', name: 'srv', address: '10.0.0.1' }).detail).toBe('SRV maps to 192.168.1.100');
    expect(check({ type: 'ipHost', device: 'R1', name: 'www' }).detail).toBe('R1 has no ip host entry for www');
    expect(check({ type: 'zoneLoaded', device: 'SRV', zone: 'ccna.lab' }).pass).toBe(true);
    expect(check({ type: 'zoneLoaded', device: 'SRV', zone: 'example.com' }).detail).toBe('SRV has no zone file for example.com');
    expect(() => check({ type: 'zoneLoaded', device: 'R1', zone: 'ccna.lab' })).toThrow('R1 is not a server');
    expect(check({ type: 'dnsRecord', device: 'SRV', name: 'shop.ccna.lab', rtype: 'A', value: '192.168.1.100' }).pass).toBe(true);
    expect(check({ type: 'dnsRecord', device: 'SRV', name: 'www.ccna.lab', rtype: 'A', value: '192.168.1.5' }).detail).toBe('www.ccna.lab A is 192.168.1.100');
    expect(check({ type: 'dnsRecord', device: 'SRV', name: 'www.ccna.lab', rtype: 'MX' }).detail).toBe('www.ccna.lab has no MX record');
    expect(check({ type: 'dnsRecord', device: 'SRV', name: 'nope.ccna.lab', rtype: 'A' }).detail).toBe('SRV answers nope.ccna.lab with NXDOMAIN');
    expect(check({ type: 'dnsResolve', from: 'PC1', name: 'www', expect: '192.168.1.100' }).pass).toBe(true);
    expect(check({ type: 'dnsResolve', from: 'PC1', name: 'nope', expect: 'fail' }).pass).toBe(true);
    expect(check({ type: 'dnsResolve', from: 'PC1', name: 'www', expect: 'fail' }).detail).toBe('PC1 resolved www to 192.168.1.100');
    expect(check({ type: 'dnsResolve', from: 'PC1', name: 'mail', expect: '192.168.1.100' }).detail).toBe('PC1 resolves mail to 192.168.1.25');
    expect(check({ type: 'dnsResolve', from: 'R1', name: 'www', expect: '192.168.1.100' }).detail).toBe('R1 cannot resolve www');
    ios(t.r1, 'conf t\nip domain lookup\nno ip name-server\nip name-server 192.168.1.100\nip domain name ccna.lab');
    expect(check({ type: 'dnsResolve', from: 'R1', name: 'www', expect: '192.168.1.100' }).pass).toBe(true);
    // The grader's own lookup leaves no trace in the cache.
    expect(t.r1.dns.host('www.ccna.lab')).toBeUndefined();
    t.srv.files.set('ccna.lab.zone', 'www IN A 1.1.1.1\n');
    expect(check({ type: 'zoneLoaded', device: 'SRV', zone: 'ccna.lab' }).detail).toBe('The ccna.lab zone does not load: has no SOA record');
  });

  it('gives lab PCs a static DNS server', () => {
    const run = new LabRun({ ...findLab('dns-records')!, topology: { devices: [{ hostname: 'PC9', kind: 'pc', at: [0, 0], ip: '10.0.0.9/24', dns: '10.0.0.53' }], links: [] } });
    expect((run.device('PC9') as Pc).dnsServer).toBe('10.0.0.53');
  });
});
