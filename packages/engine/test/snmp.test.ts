import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Router, Server, ServerShell, Switch, Topology, compareOid, dissect, resetMacAllocator, resolveOid, summarize, translateOid } from '../src';
import { ios } from './helpers';

/** The NMS server and R1 on SW1; R2 hangs off R1 G0/1 so a link can flap. */
function lab() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const srv = net.add(new Server('NMS'));
  net.connect(srv.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/3'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/0'));
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nint g0/1\nno shut');
  ios(r2, 'conf t\nint g0/0\nno shut');
  return { net, r1, r2, srv, nms: new ServerShell(srv) };
}

const V3 = '-v 3 -l authPriv -u nms -a SHA -A AuthPass1 -x AES -X PrivPass1';

describe('SNMP agent and manager', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => (t = lab()));

  it('does not answer until a community is configured, then reads with v2c', () => {
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysName.0')).toBe('Timeout: No Response from 192.168.1.1.');
    ios(t.r1, 'conf t\nsnmp-server community public RO\nsnmp-server location Lab\nsnmp-server contact noc@lab');
    const out = t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysName.0 sysLocation.0 sysUpTime.0');
    expect(out).toContain('SNMPv2-MIB::sysName.0 = STRING: R1');
    expect(out).toContain('SNMPv2-MIB::sysLocation.0 = STRING: Lab');
    expect(out).toContain('DISMAN-EVENT-MIB::sysUpTimeInstance = Timeticks:');
    // A wrong community is silently dropped.
    expect(t.nms.execute('snmpget -v 2c -c wrong 192.168.1.1 sysName.0')).toContain('Timeout');
    expect(t.nms.execute('snmpwalk -v 2c -c public 192.168.1.1 system')).toContain('SNMPv2-MIB::sysContact.0 = STRING: noc@lab');
    expect(t.nms.execute('snmpwalk -v 2c -c public 192.168.1.1 ifDescr').split('\n')).toEqual([
      'IF-MIB::ifDescr.1 = STRING: GigabitEthernet0/0',
      'IF-MIB::ifDescr.2 = STRING: GigabitEthernet0/1',
      'IF-MIB::ifDescr.3 = STRING: GigabitEthernet0/2',
    ]);
    expect(t.nms.execute('snmpgetnext -v 2c -c public 192.168.1.1 ifDescr')).toBe('IF-MIB::ifDescr.1 = STRING: GigabitEthernet0/0');
    expect(t.nms.execute('snmpget -v 2c -c public -On 192.168.1.1 sysName.0')).toContain('.1.3.6.1.2.1.1.5.0 = STRING: R1');
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysFoo.0')).toContain('Unknown Object Identifier');
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 1.3.6.1.2.1.1.9.0')).toContain('No Such Object');
    // The community string crosses the wire in clear text.
    const frame = t.net.trace.find((e) => e.frame.payload.kind === 'udp' && e.frame.payload.snmp)!.frame;
    expect(summarize(frame).protocol).toBe('SNMP');
    expect(JSON.stringify(dissect(frame))).toContain('public');
  });

  it('only lets an RW community write, and writes change the device', () => {
    ios(t.r1, 'conf t\nsnmp-server community public RO\nsnmp-server community private RW');
    expect(t.nms.execute('snmpset -v 2c -c public 192.168.1.1 sysName.0 s Core1')).toContain('Reason: noAccess');
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1 sysName.0 s Core1')).toBe('SNMPv2-MIB::sysName.0 = STRING: Core1');
    expect(t.r1.hostname).toBe('Core1');
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1 ifAdminStatus.2 i 2')).toBe('IF-MIB::ifAdminStatus.2 = INTEGER: down(2)');
    expect(t.r1.iface('g0/1').adminUp).toBe(false);
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1 ifAlias.1 s Uplink')).toContain('Uplink');
    expect(t.r1.iface('g0/0').description).toBe('Uplink');
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1 sysDescr.0 s x')).toContain('Reason:');
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1 sysName.0 q x')).toContain('Bad variable type');
    expect(t.nms.execute('snmpset -v 2c -c private 192.168.1.1')).toContain('Missing object name');
  });

  it('restricts a community with a standard ACL', () => {
    ios(t.r1, 'conf t\naccess-list 10 permit host 192.168.1.50\nsnmp-server community public RO 10');
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysName.0')).toContain('Timeout');
    ios(t.r1, 'conf t\naccess-list 10 permit host 192.168.1.100');
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysName.0')).toContain('STRING: R1');
  });

  it('authenticates and encrypts with v3 users', () => {
    ios(t.r1, 'conf t\nsnmp-server group ADMINS v3 priv\nsnmp-server user nms ADMINS v3 auth sha AuthPass1 priv aes 128 PrivPass1');
    expect(t.nms.execute(`snmpget ${V3} 192.168.1.1 sysName.0`)).toBe('SNMPv2-MIB::sysName.0 = STRING: R1');
    expect(t.nms.execute(`snmpget ${V3.replace('-A AuthPass1', '-A wrong')} 192.168.1.1 sysName.0`)).toContain('Authentication failure');
    expect(t.nms.execute('snmpget -v 3 -l authNoPriv -u nms -a SHA -A AuthPass1 192.168.1.1 sysName.0')).toContain('Unsupported security level');
    expect(t.nms.execute(`snmpget ${V3.replace('-u nms', '-u bob')} 192.168.1.1 sysName.0`)).toContain('Unknown user name');
    // A wrong privacy key cannot decrypt, so the agent cannot even answer.
    expect(t.nms.execute(`snmpget ${V3.replace('-X PrivPass1', '-X nope')} 192.168.1.1 sysName.0`)).toContain('Timeout');
    // With authPriv, a capture shows the user but not the data.
    const frame = t.net.trace.filter((e) => e.frame.payload.kind === 'udp' && e.frame.payload.snmp?.version === '3')[0]!.frame;
    const detail = JSON.stringify(dissect(frame));
    expect(detail).toContain('nms');
    expect(detail).not.toContain('AuthPass1');
    // A read-only group cannot write.
    expect(t.nms.execute(`snmpset ${V3} 192.168.1.1 sysName.0 s X`)).toContain('Reason:');
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show snmp user')).toContain('Privacy Protocol: AES128');
    expect(cli.execute('show snmp group')).toContain('groupname: ADMINS');
    expect(cli.execute('show running-config')).toContain('snmp-server group ADMINS v3 priv');
    expect(cli.execute('show running-config')).not.toContain('PrivPass1');
  });

  it('validates manager options', () => {
    expect(t.nms.execute('snmpget -v 4 -c x 192.168.1.1 sysName.0')).toContain('Invalid version');
    expect(t.nms.execute('snmpget -v 2c 192.168.1.1 sysName.0')).toContain('No community name');
    expect(t.nms.execute('snmpget 192.168.1.1 sysName.0')).toContain('No securityName');
    expect(t.nms.execute('snmpget -v 3 -u a -l authNoPriv 192.168.1.1 sysName.0')).toContain('No authentication passphrase');
    expect(t.nms.execute('snmpget -v 3 -u a -l authPriv -A x 192.168.1.1 sysName.0')).toContain('No privacy passphrase');
    expect(t.nms.execute('snmpget -v 2c -c x nowhere sysName.0')).toContain('No hostname');
    expect(t.nms.execute('snmpget -v 2c -c x 192.168.1.1')).toContain('Missing object name');
  });

  it('sends linkDown and linkUp traps to the trap host', () => {
    ios(t.r1, 'conf t\nsnmp-server community public RO\nsnmp-server host 192.168.1.100 version 2c public\nsnmp-server enable traps');
    t.net.converge();
    ios(t.r2, 'conf t\nint g0/0\nshutdown');
    ios(t.r2, 'conf t\nint g0/0\nno shutdown');
    const log = t.nms.execute('cat /var/log/snmptrapd.log');
    expect(log).toContain('linkDown');
    expect(log).toContain('linkUp');
    expect(log).toContain('GigabitEthernet0/1');
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show snmp')).toMatch(/[1-9]\d* Trap PDUs/);
    expect(cli.execute('show snmp host')).toContain('Notification host: 192.168.1.100');
    expect(cli.execute('show snmp community')).toContain('access: read-only');
    ios(t.r1, 'conf t\nno snmp-server');
    expect(t.nms.execute('snmpget -v 2c -c public 192.168.1.1 sysName.0')).toContain('Timeout');
  });

  it('names and orders OIDs like net-snmp', () => {
    expect(resolveOid('sysName.0')).toBe('1.3.6.1.2.1.1.5.0');
    expect(resolveOid('.1.3.6.1.2.1.1.5.0')).toBe('1.3.6.1.2.1.1.5.0');
    expect(resolveOid('nope')).toBeUndefined();
    expect(translateOid('1.3.6.1.2.1.2.2.1.2.3')).toBe('IF-MIB::ifDescr.3');
    expect(compareOid('1.3.6.1.2.1.2', '1.3.6.1.2.1.10')).toBeLessThan(0);
    expect(compareOid('1.3.6', '1.3.6.1')).toBeLessThan(0);
  });
});
