import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, LabRun, NetconfShell, Router, Server, ServerShell, Switch, Topology, findLab, parseXml, renderXml, resetMacAllocator, xpathToFilter } from '../src';
import { ios } from './helpers';

const AAA = 'aaa new-model\naaa authentication login default local\naaa authorization exec default local';

function lab(aaa = AAA) {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const srv = net.add(new Server('SRV'));
  net.connect(srv.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/3'));
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  ios(r1, `conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nexit\nusername admin privilege 15 secret Cisco123\nusername guest secret Guest1\n${aaa}`);
  return { net, r1, srv, sh: new ServerShell(srv) };
}

const NC = 'netconf-console --host 192.168.1.1 -u admin -p Cisco123';
const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IP_NS = 'urn:ietf:params:xml:ns:yang:ietf-ip';
const NATIVE = 'http://cisco.com/ns/yang/Cisco-IOS-XE-native';

const ifs = (body: string, attrs = '') => `<config><interfaces xmlns="${IF_NS}"${attrs}>${body}</interfaces></config>`;
const native = (body: string) => `<config><native xmlns="${NATIVE}">${body}</native></config>`;

describe('NETCONF-YANG', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => (t = lab()));

  /** Writes a file on the server and pushes it with --edit-config. */
  const edit = (xml: string, extra = '') => {
    t.srv.files.set('e.xml', xml);
    return t.sh.execute(`${NC} ${extra} --edit-config e.xml`.replace('  ', ' '));
  };

  it('listens on TCP 830 once netconf-yang is configured', () => {
    expect(t.sh.execute(`${NC} --hello`)).toBe('netconf-console: [Errno 111] Connection refused');
    ios(t.r1, 'conf t\nnetconf-yang');
    const hello = t.sh.execute(`${NC} --hello`);
    expect(hello).toContain('<capability>urn:ietf:params:netconf:base:1.1</capability>');
    expect(hello).toContain('module=ietf-interfaces&amp;revision=2014-05-08');
    expect(hello).toMatch(/<session-id>\d+<\/session-id>/);
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show running-config')).toMatch(/\nnetconf-yang\n/);
    expect(cli.execute('show netconf-yang status')).toContain('netconf-yang: enabled\nnetconf-yang candidate-datastore: disabled');
    expect(cli.execute('show netconf-yang status')).toContain('ssh port: 830');
    expect(cli.execute('show platform software yang-management process')).toMatch(/ncsshd +: Running/);
    expect(cli.execute('show platform software yang-management process')).toMatch(/nginx +: Not Running/);
    expect(cli.execute('show netconf-yang sessions')).toContain('Number of sessions : 0');
    ios(t.r1, 'conf t\nno netconf-yang');
    expect(cli.execute('show netconf-yang status')).toContain('netconf-yang: disabled');
    expect(t.sh.execute(`${NC} --hello`)).toContain('Connection refused');
  });

  it('is a router feature', () => {
    const sw = t.net.find('SW1')! as Switch;
    const cli = new CliSession(sw, { loggedIn: true });
    cli.execute('enable');
    cli.execute('conf t');
    expect(cli.execute('netconf-yang')).toContain('Invalid input');
  });

  it('checks logins through AAA and needs privilege 15', () => {
    const plain = lab('');
    ios(plain.r1, 'conf t\nnetconf-yang');
    expect(plain.sh.execute(`${NC} --hello`)).toBe('netconf-console: Authentication failed.');
    const noAuthz = lab('aaa new-model\naaa authentication login default local');
    ios(noAuthz.r1, 'conf t\nnetconf-yang');
    expect(noAuthz.sh.execute(`${NC} --hello`)).toContain('<hello');
    const denied = noAuthz.sh.execute(`${NC} --get-config`);
    expect(denied).toContain('<error-tag>access-denied</error-tag>');
    expect(denied).toContain('privilege level 1');
    ios(t.r1, 'conf t\nnetconf-yang');
    expect(t.sh.execute('netconf-console --host 192.168.1.1 -u admin -p wrong --get')).toBe('netconf-console: Authentication failed.');
    expect(t.sh.execute('netconf-console --host 192.168.1.1 -u guest -p Guest1 --get')).toContain('access-denied');
    expect(t.r1.netconf.history.at(-1)).toEqual({ user: 'guest', rpc: 'get', ok: false });
  });

  it('reads configuration and state with filters', () => {
    ios(t.r1, 'conf t\nnetconf-yang\nint g0/1\ndescription Uplink\nexit\nip route 0.0.0.0 0.0.0.0 192.168.1.254');
    const g00 = t.sh.execute(`${NC} --get-config -x "/interfaces/interface[name='GigabitEthernet0/0']"`);
    expect(g00).toContain('<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1">');
    expect(g00).toContain('<name>GigabitEthernet0/0</name>');
    expect(g00).not.toContain('GigabitEthernet0/1');
    expect(g00).toContain('<netmask>255.255.255.0</netmask>');
    expect(g00).toContain('ianaift:ethernetCsmacd');
    const all = t.sh.execute(`${NC} --get-config`);
    expect(all).toContain('<hostname>R1</hostname>');
    expect(all).toContain('<description>Uplink</description>');
    expect(all).toContain('<fwd>192.168.1.254</fwd>');
    expect(all).toContain('<secret>$9$fakeHash</secret>');
    expect(all).toContain('<netconf-yang/>');
    expect(all).not.toContain('interfaces-state');
    // A selection of one leaf still names each list entry.
    const oper = t.sh.execute(`${NC} --get -x /if:interfaces-state/interface/oper-status`);
    expect(oper).toMatch(/<name>GigabitEthernet0\/0<\/name>\s*<oper-status>up<\/oper-status>/);
    expect(oper).not.toContain('phys-address');
    expect(t.sh.execute(`${NC} --get -x "/interfaces-state/interface[name='GigabitEthernet0/0']"`)).toContain('<in-unicast-pkts>');
    expect(t.sh.execute(`${NC} --get-config -x /native/hostname`)).toMatch(/<native xmlns="[^"]+">\s*<hostname>R1<\/hostname>\s*<\/native>/);
    expect(t.sh.execute(`${NC} --get-config -x "/interfaces/interface[name='Nope']"`)).toContain('<data/>');
    // A subtree filter sent as a raw RPC.
    t.srv.files.set(
      'f.xml',
      `<get-config><source><running/></source><filter type="subtree"><interfaces xmlns="${IF_NS}"><interface><description>Uplink</description><name/></interface></interfaces></filter></get-config>`,
    );
    const sub = t.sh.execute(`${NC} --rpc f.xml`);
    expect(sub).toContain('<name>GigabitEthernet0/1</name>');
    expect(sub).not.toContain('<enabled>');
    t.srv.files.set('f.xml', `<get><filter><native xmlns="${NATIVE}"><username><name>admin</name></username></native></filter></get>`);
    expect(t.sh.execute(`${NC} --rpc f.xml`)).toMatch(/<name>admin<\/name>\s*<privilege>15<\/privilege>/);
    t.srv.files.set('f.xml', `<get><filter><native xmlns="urn:other"/></filter></get>`);
    expect(t.sh.execute(`${NC} --rpc f.xml`)).toContain('<data/>');
  });

  it('changes interfaces with edit-config and logs who did it', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    const xml = ifs(
      `<interface><name>Loopback0</name><description>Managed by NETCONF</description><type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:softwareLoopback</type><enabled>true</enabled><ipv4 xmlns="${IP_NS}"><address><ip>10.0.0.1</ip><netmask>255.255.255.255</netmask></address></ipv4><ipv6 xmlns="${IP_NS}"/></interface>` +
        `<interface><name>GigabitEthernet0/1</name><enabled>true</enabled><ipv4 xmlns="${IP_NS}"><address><ip>10.1.1.1</ip><prefix-length>30</prefix-length></address></ipv4></interface>`,
    );
    expect(edit(xml)).toMatch(/<rpc-reply [^>]+>\s*<ok\/>\s*<\/rpc-reply>/);
    const lo = t.r1.iface('Loopback0');
    expect(lo.ip).toEqual({ address: '10.0.0.1', prefix: 32 });
    expect(lo.description).toBe('Managed by NETCONF');
    expect(t.r1.iface('g0/1').adminUp).toBe(true);
    expect(t.r1.iface('g0/1').ip?.prefix).toBe(30);
    expect(t.r1.log.join('\n')).toMatch(/%DMI-5-CONFIG_I: R1 dmiauthd: Configured from NETCONF\/RESTCONF by admin, transaction-id \d+/);
    expect(t.r1.log.join('\n')).toContain('Interface GigabitEthernet0/1, changed state to up');
    expect(t.r1.netconf.history.some((r) => r.rpc === 'edit-config' && r.ok)).toBe(true);

    // delete and remove on leaves, then a replace.
    expect(edit(ifs(`<interface><name>Loopback0</name><description xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="delete"/></interface>`))).toContain('<ok/>');
    expect(lo.description).toBeUndefined();
    expect(edit(ifs(`<interface><name>Loopback0</name><description operation="delete"/></interface>`))).toContain('data-missing');
    expect(edit(ifs(`<interface><name>Loopback0</name><description operation="remove"/><enabled operation="remove"/></interface>`))).toContain('<ok/>');
    expect(edit(ifs(`<interface><name>GigabitEthernet0/1</name><ipv4 xmlns="${IP_NS}"><address operation="delete"/></ipv4><enabled operation="remove"/></interface>`))).toContain('<ok/>');
    expect(t.r1.iface('g0/1').ip).toBeUndefined();
    expect(t.r1.iface('g0/1').adminUp).toBe(false);
    expect(edit(ifs(`<interface><name>Loopback0</name><ipv4 xmlns="${IP_NS}" operation="remove"/></interface>`))).toContain('<ok/>');
    expect(lo.ip).toBeUndefined();
    ios(t.r1, 'conf t\nint lo0\nip address 10.0.0.1 255.255.255.255\ndescription old');
    expect(edit(ifs(`<interface operation="replace"><name>Loopback0</name><enabled>false</enabled></interface>`))).toContain('<ok/>');
    expect(lo.ip).toBeUndefined();
    expect(lo.description).toBeUndefined();
    expect(edit(ifs(`<interface><name>Loopback0</name><ipv4 xmlns="${IP_NS}"/></interface>`))).toContain('<ok/>');
    expect(edit(`<interfaces xmlns="${IF_NS}"><interface><name>Loopback1</name></interface></interfaces>`)).toContain('<ok/>');
    expect(t.r1.findIface('Loopback1')).toBeDefined();
  });

  it('rejects bad edits and rolls back the whole change', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    const before = t.r1.log.length;
    const bad = edit(ifs(`<interface><name>GigabitEthernet0/1</name><description>first</description></interface><interface><name>Loopback5</name><enabled>maybe</enabled></interface>`));
    expect(bad).toContain('<error-tag>invalid-value</error-tag>');
    expect(bad).toContain('<bad-element>enabled</bad-element>');
    expect(t.r1.iface('g0/1').description).toBeUndefined();
    expect(t.r1.findIface('Loopback5')).toBeUndefined();
    expect(t.r1.log.length).toBe(before);
    expect(t.r1.netconf.history.at(-1)).toEqual({ user: 'admin', rpc: 'edit-config', ok: false });

    const cases: [string, string][] = [
      [`<config><interfaces xmlns="urn:wrong"/></config>`, 'unknown-namespace'],
      [`<config><interfaces/></config>`, 'unknown-namespace'],
      [`<config><routing xmlns="${IF_NS}"/></config>`, 'unknown-element'],
      [ifs('<foo/>'), 'unknown-element'],
      [ifs('<interface><description>x</description></interface>'), 'missing-element'],
      [ifs('<interface><name>GigabitEthernet0/0</name><mtu>9000</mtu></interface>'), 'unknown-element'],
      [ifs('<interface operation="create"><name>GigabitEthernet0/0</name></interface>'), 'data-exists'],
      [ifs('<interface operation="delete"><name>Loopback9</name></interface>'), 'data-missing'],
      [ifs('<interface operation="delete"><name>GigabitEthernet0/0</name></interface>'), 'operation-not-supported'],
      [ifs('<interface operation="frobnicate"><name>GigabitEthernet0/0</name></interface>'), 'bad-attribute'],
      [ifs('<interface><name>Tunnel0</name></interface>'), 'invalid-value'],
      [ifs(`<interface><name>GigabitEthernet0/1</name><ipv4 xmlns="${IP_NS}"><address><ip>300.1.1.1</ip><netmask>255.0.0.0</netmask></address></ipv4></interface>`), 'invalid-value'],
      [ifs(`<interface><name>GigabitEthernet0/1</name><ipv4 xmlns="${IP_NS}"><address><ip>192.168.1.9</ip><netmask>255.255.255.0</netmask></address></ipv4></interface>`), 'overlaps with GigabitEthernet0/0'],
      [native('<hostname>9bad</hostname>'), 'invalid-value'],
      [native('<hostname>SRV</hostname>'), 'already in use'],
      [native('<banner>hi</banner>'), 'unknown-element'],
      [native('<username><privilege>15</privilege></username>'), 'missing-element'],
      [native('<username><name>bob</name><privilege>99</privilege><secret><secret>x</secret></secret></username>'), 'out of range'],
      [native('<username><name>bob</name></username>'), 'needs a &lt;secret&gt;'],
      [native('<username operation="create"><name>admin</name><secret><secret>x</secret></secret></username>'), 'data-exists'],
      [native('<username operation="delete"><name>nobody</name></username>'), 'data-missing'],
      [`<edit-config><target><running/></target></edit-config>`, 'missing-element'],
    ];
    for (const [xml, expected] of cases) {
      if (xml.startsWith('<edit-config')) {
        t.srv.files.set('r.xml', xml);
        expect(t.sh.execute(`${NC} --rpc r.xml`), xml).toContain(expected);
      } else expect(edit(xml), xml).toContain(expected);
    }
    t.srv.files.set('r.xml', `<edit-config><target><running/></target><default-operation>bogus</default-operation><config/></edit-config>`);
    expect(t.sh.execute(`${NC} --rpc r.xml`)).toContain('invalid default-operation');
    expect(t.r1.hostname).toBe('R1');
  });

  it('changes the hostname and local users', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    expect(edit(native('<version>17.9</version><hostname>HQ-R1</hostname>'))).toContain('<ok/>');
    expect(t.r1.hostname).toBe('HQ-R1');
    expect(edit(native('<hostname operation="remove"/>'))).toContain('<ok/>');
    expect(t.r1.hostname).toBe('Router');
    expect(edit(native('<username><name>bob</name><privilege>15</privilege><secret><encryption>0</encryption><secret>B0b!</secret></secret></username>'))).toContain('<ok/>');
    expect(t.r1.mgmt.users.get('bob')).toEqual({ name: 'bob', privilege: 15, password: 'B0b!', secret: true });
    expect(edit(native('<username><name>carol</name><password><password>pw</password></password></username>'))).toContain('<ok/>');
    expect(t.r1.mgmt.users.get('carol')).toMatchObject({ privilege: 1, secret: false });
    expect(edit(native('<username><name>carol</name><privilege>5</privilege></username>'))).toContain('<ok/>');
    expect(t.r1.mgmt.users.get('carol')).toMatchObject({ privilege: 5, password: 'pw', secret: false });
    expect(edit(native('<username operation="delete"><name>carol</name></username>'))).toContain('<ok/>');
    expect(t.r1.mgmt.users.has('carol')).toBe(false);
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show running-config')).toContain('username bob privilege 15 secret');
    // default-operation none still applies explicit nodes here (simplified) and replace resets an interface.
    t.srv.files.set('r.xml', `<edit-config><target><running/></target><default-operation>none</default-operation><config><native xmlns="${NATIVE}"><hostname>R1</hostname></native></config></edit-config>`);
    expect(t.sh.execute(`${NC} --rpc r.xml`)).toContain('<ok/>');
    expect(t.r1.hostname).toBe('R1');
  });

  it('saves the running config to startup', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    expect(t.r1.startupConfig).toBeUndefined();
    expect(t.sh.execute(`${NC} --copy-running-to-startup`)).toContain('<ok/>');
    expect(t.r1.startupConfig).toContain('netconf-yang');
    t.r1.startupConfig = undefined;
    t.srv.files.set('s.xml', '<save-config xmlns="http://cisco.com/yang/cisco-ia"/>');
    expect(t.sh.execute(`${NC} --rpc s.xml`)).toContain('Save running-config successful');
    expect(t.r1.startupConfig).toContain('hostname R1');
    t.srv.files.set('s.xml', '<save-config/>');
    expect(t.sh.execute(`${NC} --rpc s.xml`)).toContain('operation-not-supported');
  });

  it('answers datastore and protocol errors', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    expect(t.sh.execute(`${NC} --get-config --db candidate`)).toContain('candidate datastore is not enabled');
    expect(t.sh.execute(`${NC} --get-config --db startup`)).toContain('datastore startup is not supported');
    expect(t.sh.execute(`${NC} --edit-config nothere.xml`)).toBe("netconf-console: [Errno 2] No such file or directory: 'nothere.xml'");
    const raw = (body: string) => {
      t.srv.files.set('r.xml', body);
      return t.sh.execute(`${NC} --rpc r.xml`);
    };
    expect(raw('<get-config/>')).toContain('<bad-element>source</bad-element>');
    expect(raw('<get-config><source/></get-config>')).toContain('missing-element');
    expect(raw('<get><filter type="xpath"/></get>')).toContain('missing-attribute');
    expect(raw('<get><filter type="xpath" select="/a/b[c=1"/></get>')).toContain('Invalid XPath step');
    expect(raw('<get><filter type="regex"/></get>')).toContain('unknown filter type');
    expect(raw('<discard-changes/>')).toContain('discard-changes is not supported');
    expect(raw('<kill-session><session-id>4242</session-id></kill-session>')).toContain('no other session 4242');
    expect(raw('<unlock><target><running/></target></unlock>')).toContain('not locked by this session');
    expect(raw('<get><filter>')).toContain('malformed-message');
    expect(raw('<copy-config><target><running/></target><source><running/></source></copy-config>')).toContain('datastore running is not supported');
    expect(t.sh.execute(`${NC} --lock --edit-config r.xml`)).toContain('<ok/>');
  });

  it('runs several operations in one session, and locks the datastore', () => {
    ios(t.r1, 'conf t\nnetconf-yang');
    t.srv.files.set('d.xml', `<?xml version="1.0"?>\n${ifs('<interface><name>GigabitEthernet0/1</name><description>locked edit</description></interface>')}`);
    const out = t.sh.execute(`${NC} --lock --edit-config d.xml --unlock --get-config -x /interfaces/interface/description`);
    expect(out.match(/<ok\/>/g)).toHaveLength(3);
    expect(out).toContain('message-id="4"');
    expect(out).toContain('<description>locked edit</description>');
    expect(t.r1.netconf.lockedBy).toBeUndefined();
    expect(t.r1.netconf.sessions.size).toBe(0);
  });

  it('netconf-console checks its arguments and the path', () => {
    expect(t.sh.execute('netconf-console --host 192.168.1.1')).toContain('usage: netconf-console');
    expect(t.sh.execute('netconf-console --bogus')).toBe('netconf-console: error: unrecognized argument --bogus');
    expect(t.sh.execute('netconf-console --get')).toBe('netconf-console: error: a valid --host is required');
    expect(t.sh.execute('netconf-console --host=192.168.1.1 --edit-config')).toContain('expected one argument');
    expect(t.sh.execute('netconf-console2 --host 192.168.1.50 --port=830 --get')).toBe('netconf-console: timed out');
    expect(t.sh.execute('help')).toContain('netconf-console');
  });

  it('is filtered by an ACL like any other TCP service', () => {
    ios(t.r1, 'conf t\nnetconf-yang\nip access-list extended MGMT\ndeny tcp any any eq 830\npermit ip any any\nexit\nint g0/0\nip access-group MGMT in');
    expect(t.sh.execute(`${NC} --hello`)).toBe('netconf-console: timed out');
  });
});

describe('a raw NETCONF session over ssh', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => {
    t = lab();
    ios(t.r1, 'conf t\nnetconf-yang');
  });
  const HELLO = '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>]]>]]>';
  const open = () => {
    expect(t.sh.execute('ssh admin@192.168.1.1 -p 830 -s netconf')).toBe('');
    expect(t.sh.prompt).toBe("admin@192.168.1.1's password: ");
    expect(t.sh.masked).toBe(true);
    const hello = t.sh.execute('Cisco123');
    expect(hello).toMatch(/<\/hello>\n\]\]>\]\]>$/);
    return Number(/<session-id>(\d+)/.exec(hello)![1]);
  };

  it('exchanges hellos, then answers RPCs framed with ]]>]]>', () => {
    const id = open();
    expect(t.sh.execute(HELLO)).toBe('');
    expect(t.sh.execute('<rpc message-id="101" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">')).toBe('');
    expect(t.sh.execute('  <get-config><source><running/></source><filter><native xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-native"><hostname/></native></filter></get-config>')).toBe('');
    const reply = t.sh.execute('</rpc>]]>]]>');
    expect(reply).toContain('message-id="101"');
    expect(reply).toContain('<hostname>R1</hostname>');
    expect(reply.endsWith(']]>]]>')).toBe(true);
    // The session shows on the router, and holds the lock.
    expect(t.sh.execute('<rpc message-id="102"><lock><target><running/></target></lock></rpc>]]>]]>')).toContain('<ok/>');
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    const sessions = cli.execute('show netconf-yang sessions');
    expect(sessions).toContain('Number of sessions : 1');
    expect(sessions).toMatch(new RegExp(`${id} +netconf-ssh  admin +192.168.1.100 +R`));
    // Another client cannot edit or lock while it is held.
    expect(new ServerShell(t.srv).execute(`${NC} --lock`)).toContain('lock-denied');
    t.srv.files.set('e.xml', `<interfaces xmlns="${IF_NS}"><interface><name>GigabitEthernet0/1</name><description>x</description></interface></interfaces>`);
    expect(new ServerShell(t.srv).execute(`${NC} --edit-config e.xml`)).toContain('<error-tag>in-use</error-tag>');
    expect(t.sh.execute('<rpc message-id="103"><bogus/></rpc>]]>]]><rpc><get/></rpc>]]>]]>')).toMatch(/operation-not-supported[\s\S]*missing-attribute/);
    expect(t.sh.execute('<rpc message-id="104"/>]]>]]>')).toContain('empty &lt;rpc&gt;');
    expect(t.sh.execute('<notrpc message-id="105"/>]]>]]>')).toContain('expected &lt;rpc&gt;');
    expect(t.sh.execute('<rpc message-id="106"><close-session/></rpc>]]>]]>')).toContain('<ok/>');
    expect(t.sh.prompt).toBe('root@SRV:~# ');
    expect(t.r1.netconf.sessions.size).toBe(0);
    expect(t.r1.netconf.lockedBy).toBeUndefined();
  });

  it('drops a client that skips its hello or speaks no NETCONF version', () => {
    open();
    expect(t.sh.execute('<rpc message-id="1"><get/></rpc>]]>]]>')).toContain('closed by foreign host');
    open();
    expect(t.sh.execute('<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:x</capability></capabilities></hello>]]>]]>')).toContain('closed by foreign host');
    open();
    t.sh.execute(HELLO);
    expect(t.sh.execute('~.')).toContain('Connection closed.');
    expect(t.r1.netconf.sessions.size).toBe(0);
  });

  it('lets one session kill another, and no netconf-yang ends them all', () => {
    open();
    t.sh.execute(HELLO);
    const other = new ServerShell(t.srv);
    other.execute('ssh -l admin -p 830 192.168.1.1 -s netconf');
    const otherId = Number(/<session-id>(\d+)/.exec(other.execute('Cisco123'))![1]);
    expect(t.sh.execute(`<rpc message-id="1"><kill-session><session-id>${otherId}</session-id></kill-session></rpc>]]>]]>`)).toContain('<ok/>');
    expect(t.r1.netconf.sessions.size).toBe(1);
    ios(t.r1, 'conf t\nno netconf-yang');
    expect(t.r1.netconf.sessions.size).toBe(0);
  });

  it('reports connection and login failures like OpenSSH', () => {
    expect(t.sh.execute('ssh admin@192.168.1.1 -p 22 -s netconf')).toContain('runs on port 830');
    expect(t.sh.execute('ssh admin@nowhere -p 830 -s netconf')).toContain('Could not resolve hostname nowhere');
    expect(t.sh.execute('ssh admin@192.168.1.50 -p 830 -s netconf')).toContain('Connection timed out');
    ios(t.r1, 'conf t\nno netconf-yang');
    expect(t.sh.execute('ssh admin@192.168.1.1 -p 830 -s netconf')).toContain('Connection refused');
    ios(t.r1, 'conf t\nnetconf-yang');
    t.sh.execute('ssh 192.168.1.1 -p 830 -s netconf');
    expect(t.sh.execute('pw')).toBe('root@192.168.1.1: Permission denied (password).');
    t.sh.execute('ssh admin@192.168.1.1 -p 830 -s netconf');
    expect(t.sh.execute('nope')).toBe('admin@192.168.1.1: Permission denied (password).');
  });

  it('NetconfShell buffers lines until the end-of-message marker', () => {
    const seen: string[] = [];
    const shell = new NetconfShell((text) => {
      seen.push(text);
      return { reply: '<ok/>' };
    });
    expect(shell.execute('<a>')).toBe('');
    expect(shell.execute('</a>]]>]]>]]>]]>')).toBe('<ok/>\n]]>]]>');
    expect(seen).toEqual(['<a>\n</a>']);
  });
});

describe('the XML helpers', () => {
  it('parses namespaces, entities, comments and CDATA', () => {
    const n = parseXml('<?xml version="1.0"?><!-- c --><a xmlns="urn:a" xmlns:b="urn:b"><b:c x=\'1\'>&lt;&#65;&#x42;&amp;</b:c><d><![CDATA[<raw>]]></d></a>');
    expect(n.ns).toBe('urn:a');
    expect(n.children[0]).toMatchObject({ name: 'c', ns: 'urn:b', text: '<AB&', attrs: { x: '1' } });
    expect(n.children[1]!.text).toBe('<raw>');
    expect(renderXml(n)).toContain('<c x="1">&lt;AB&amp;</c>');
    for (const bad of ['<a>', '<a></b>', '<a/><b/>', 'text<a/>', '', '<a></a></a>', '<a><</a>']) expect(() => parseXml(bad), bad).toThrow();
  });

  it('turns an XPath into a subtree filter', () => {
    const f = xpathToFilter(`/if:interfaces/interface[name="Gi0/0"][enabled='true']/ipv4`);
    expect(renderXml(f)).toBe(
      ['<filter>', '  <interfaces>', '    <interface>', '      <name>Gi0/0</name>', '      <enabled>true</enabled>', '      <ipv4/>', '    </interface>', '  </interfaces>', '</filter>'].join('\n'),
    );
    expect(() => xpathToFilter('/a/[x]')).toThrow('Invalid XPath step');
  });
});

describe('NETCONF labs', () => {
  beforeEach(() => resetMacAllocator());

  it('the troubleshooting lab fails at each layer in turn', () => {
    const run = new LabRun(findLab('netconf-troubleshoot')!);
    const srv = new ServerShell(run.device('SRV') as Server);
    const push = () => srv.execute('netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config hostname.xml');
    expect(push()).toBe('netconf-console: timed out');
    const r1 = run.device('R1') as Router;
    ios(r1, 'conf t\nip access-list extended MGMT-IN\nno deny tcp any any eq 830');
    expect(push()).toContain('access-denied');
    ios(r1, 'conf t\naaa authorization exec default local');
    expect(push()).toContain('unknown-namespace');
    expect(r1.hostname).toBe('R1');
  });
});
