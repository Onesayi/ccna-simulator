import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Server, ServerShell, Switch, Topology, dissect, parseMethods, resetMacAllocator, summarize, type Shell } from '../src';
import { ios } from './helpers';

/** PC1, the AAA server SRV and R1 on SW1; R2 behind R1. */
function office() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const pc = net.add(new Pc('PC1'));
  const srv = net.add(new Server('SRV'));
  net.connect(pc.nic, sw.iface('g0/1'));
  net.connect(srv.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/3'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/0'));
  pc.configure('192.168.1.10', 24, '192.168.1.1');
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.12.1 255.255.255.252\nno shut');
  ios(r2, 'conf t\nint g0/0\nip address 10.0.12.2 255.255.255.252\nno shut\nip route 0.0.0.0 0.0.0.0 10.0.12.1');
  const admin = new ServerShell(srv);
  admin.execute('aaa client add 192.168.1.1 S3cret');
  admin.execute('aaa client add 10.0.12.2 S3cret');
  admin.execute('aaa user add alice Wonder1 privilege 15');
  admin.execute('aaa user add bob Builder1');
  return { net, sw, r1, r2, pc, srv, admin };
}

function type(shell: Shell, ...lines: string[]): string[] {
  return lines.map((l) => shell.execute(l));
}

const VTY = 'line vty 0 4\ntransport input telnet ssh\nexit';

describe('AAA with TACACS+', () => {
  let t: ReturnType<typeof office>;
  beforeEach(() => (t = office()));

  it('logs in through the TACACS+ server and gets the level it authorizes', () => {
    ios(t.r1, `conf t\naaa new-model\ntacacs server ISE\naddress ipv4 192.168.1.100\nkey S3cret\nexit\naaa authentication login default group tacacs+ local\naaa authorization exec default group tacacs+ local\naaa accounting exec default start-stop group tacacs+\n${VTY}`);
    const pc = new PcShell(t.pc);
    // With AAA, telnet asks for a username as well as a password.
    expect(pc.execute('telnet 192.168.1.1')).toContain('User Access Verification');
    expect(pc.prompt).toBe('Username: ');
    pc.execute('alice');
    expect(pc.prompt).toBe('Password: ');
    pc.execute('Wonder1');
    expect(pc.prompt).toBe('R1#');
    expect(pc.execute('exit')).toContain('closed by foreign host');
    const log = t.srv.aaa.log.join('\n');
    expect(log).toContain('TACACS+ Passed authentication: alice from 192.168.1.1');
    expect(log).toContain('TACACS+ Passed authorization: alice shell priv-lvl=15');
    expect(log).toContain('TACACS+ accounting start for alice');
    expect(log).toContain('TACACS+ accounting stop for alice');
    // The whole TACACS+ body is encrypted; a capture shows only the header.
    const frame = t.net.trace.find((e) => e.frame.payload.kind === 'tcp' && e.frame.payload.tacacs)!.frame;
    expect(summarize(frame).protocol).toBe('TACACS+');
    expect(JSON.stringify(dissect(frame))).not.toContain('Wonder1');
    expect(JSON.stringify(dissect(frame))).toContain('entire body hidden');
  });

  it('rejects a wrong password at the server without falling back to local', () => {
    ios(t.r1, `conf t\nusername alice privilege 15 secret Local1\naaa new-model\ntacacs server ISE\naddress ipv4 192.168.1.100\nkey S3cret\nexit\naaa authentication login default group tacacs+ local\n${VTY}`);
    expect(t.r1.login('vty', 'telnet', 'alice', 'Local1')).toEqual({ ok: false, reason: '% Authentication failed' });
    // Without exec authorization, even a privilege 15 user starts at level 1.
    expect(t.r1.login('vty', 'telnet', 'alice', 'Wonder1')).toEqual({ ok: true, privilege: 1 });
  });

  it('falls back to the local database when the server does not answer', () => {
    ios(t.r1, `conf t\nusername admin privilege 15 secret Local1\naaa new-model\ntacacs server ISE\naddress ipv4 192.168.1.100\nkey WrongKey\nexit\naaa authentication login default group tacacs+ local\naaa authorization exec default group tacacs+ local\n${VTY}`);
    // A wrong key: the server drops the request, which looks like a dead server.
    expect(t.r1.login('vty', 'telnet', 'admin', 'Local1')).toEqual({ ok: true, privilege: 15 });
    expect(t.r1.login('vty', 'telnet', 'alice', 'Wonder1')).toMatchObject({ ok: false });
    expect(t.srv.aaa.log.join('\n')).toContain('shared secret mismatch');
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show tacacs')).toContain('Server address: 192.168.1.100');
    expect(cli.execute('show aaa servers')).toContain('State: current DEAD');
  });

  it('runs test aaa against each server group', () => {
    ios(t.r1, 'conf t\naaa new-model\ntacacs server ISE\naddress ipv4 192.168.1.100\nkey S3cret\nexit\naaa group server tacacs+ ADMINS\nserver name ISE');
    const cli = new CliSession(t.r1);
    cli.execute('enable');
    expect(cli.execute('test aaa group tacacs+ alice Wonder1 legacy')).toContain('User was successfully authenticated.');
    expect(cli.execute('test aaa group ADMINS alice nope legacy')).toContain('rejected by server');
    expect(cli.execute('test aaa group radius alice Wonder1 legacy')).toContain('not found or has no servers');
    t.admin.execute('aaa client delete 192.168.1.1');
    expect(cli.execute('test aaa group tacacs+ alice Wonder1 legacy')).toContain('No authoritative response');
    const cfg = cli.execute('show running-config');
    expect(cfg).toContain('aaa new-model\naaa group server tacacs+ ADMINS\n server name ISE');
    expect(cfg).toContain('tacacs server ISE\n address ipv4 192.168.1.100\n key S3cret');
  });
});

describe('AAA with RADIUS', () => {
  let t: ReturnType<typeof office>;
  beforeEach(() => (t = office()));

  it('authenticates SSH from a remote router and authorizes with the attributes in the accept', () => {
    ios(t.r2, `conf t\nip domain-name lab\ncrypto key generate rsa modulus 2048\naaa new-model\nradius server ISE\naddress ipv4 192.168.1.100 auth-port 1812 acct-port 1813\nkey S3cret\nexit\naaa authentication login VTY group radius local\naaa authorization exec VTY group radius local\nline vty 0 4\nlogin authentication VTY\nauthorization exec VTY\ntransport input ssh`);
    const pc = new PcShell(t.pc);
    pc.execute('ssh -l alice 10.0.12.2');
    pc.execute('Wonder1');
    expect(pc.prompt).toBe('R2#');
    pc.execute('exit');
    pc.execute('ssh -l bob 10.0.12.2');
    pc.execute('Builder1');
    expect(pc.prompt).toBe('R2>');
    pc.execute('exit');
    expect(pc.execute('ssh -l bob 10.0.12.2')).toBe('');
    expect(pc.execute('wrong')).toContain('% Authentication failed.');
    const radius = t.net.trace.find((e) => e.frame.payload.kind === 'udp' && e.frame.payload.radius?.code === 'access-request')!.frame;
    // RADIUS hides only the password: the user name is readable in a capture.
    const detail = JSON.stringify(dissect(radius));
    expect(detail).toContain('alice');
    expect(detail).not.toContain('Wonder1');
    const cfg = new CliSession(t.r2);
    cfg.execute('enable');
    const run = cfg.execute('show running-config');
    expect(run).toContain('radius server ISE\n address ipv4 192.168.1.100 auth-port 1812 acct-port 1813\n key S3cret');
    expect(run).toContain(' authorization exec VTY\n login authentication VTY');
  });

  it('uses legacy server commands, global keys and the default 1645 ports', () => {
    t.admin.execute('aaa client add 192.168.1.1 Global1');
    ios(t.r1, `conf t\naaa new-model\nradius-server host 192.168.1.100\nradius-server key Global1\naaa authentication login default group radius\n${VTY}`);
    expect(t.r1.aaa.servers.get('192.168.1.100')?.authPort).toBe(1645);
    expect(t.r1.login('vty', 'telnet', 'alice', 'Wonder1').ok).toBe(true);
    ios(t.r1, 'conf t\nno radius-server host 192.168.1.100\nradius-server host 192.168.1.100 auth-port 1812 acct-port 1813 key Global1');
    expect(t.r1.login('vty', 'telnet', 'alice', 'Wonder1').ok).toBe(true);
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show running-config')).toContain('radius-server host 192.168.1.100 auth-port 1812 acct-port 1813 key Global1');
    expect(cli.execute('show aaa servers')).toContain('RADIUS: id 1, priority 1, host 192.168.1.100, auth-port 1812, acct-port 1813');
    expect(cli.execute('show aaa method-lists all')).toContain('name=default valid=TRUE');
  });

  it('protects the console with the default list, and console logins start at level 1', () => {
    ios(t.r1, 'conf t\nusername admin privilege 15 secret Local1\naaa new-model\naaa authentication login default local\naaa authorization exec default local');
    const cli = new CliSession(t.r1);
    expect(cli.prompt).toBe('Username: ');
    cli.execute('admin');
    expect(cli.execute('bad')).toBe('% Authentication failed');
    expect(cli.prompt).toBe('Username: ');
    cli.execute('admin');
    cli.execute('Local1');
    expect(cli.prompt).toBe('R1>');
    expect(cli.execute('exit')).toContain('R1 con0 is now available');
    expect(cli.prompt).toBe('Username: ');
    // `aaa authorization console` applies the user's level on the console too.
    t.r1.aaa.authorizeConsole = true;
    cli.execute('admin');
    cli.execute('Local1');
    expect(cli.prompt).toBe('R1#');
  });

  it('protects the console with a line password or local users without AAA', () => {
    ios(t.r1, 'conf t\nusername admin privilege 15 secret Local1\nline con 0\npassword Con1\nlogin');
    const cli = new CliSession(t.r1);
    expect(cli.prompt).toBe('Password: ');
    expect(cli.execute('nope')).toBe('% Login invalid');
    cli.execute('Con1');
    expect(cli.prompt).toBe('R1>');
    ios2(t.r1, 'Con1', 'conf t\nline con 0\nlogin local');
    const local = new CliSession(t.r1);
    expect(local.prompt).toBe('Username: ');
    local.execute('admin');
    local.execute('Local1');
    expect(local.prompt).toBe('R1#');
  });

  it('parses method lists and rejects bad ones', () => {
    expect(parseMethods(['group', 'tacacs+', 'local', 'none'])).toEqual([{ kind: 'group', group: 'tacacs+' }, { kind: 'local' }, { kind: 'none' }]);
    expect(() => parseMethods(['bogus'])).toThrow();
    expect(() => parseMethods(['group'])).toThrow();
    const cli = new CliSession(t.r1);
    type(cli, 'enable', 'conf t');
    expect(cli.execute('aaa authentication login default local')).toContain('% Invalid input');
    cli.execute('aaa new-model');
    expect(cli.execute('aaa accounting exec default sometimes group radius')).toContain('% Invalid input');
    expect(cli.execute('radius-server host 10.1.1.1 frobnicate')).toContain('% Invalid input');
    cli.execute('tacacs server T1');
    expect(cli.prompt).toBe('R1(config-server-tacacs)#');
    expect(cli.execute('radius server T1')).toContain('already a TACACS+ server');
  });
});

/** Logs into a console that has a password, then runs config. */
function ios2(device: Router, password: string, commands: string): void {
  const cli = new CliSession(device);
  cli.execute(password);
  cli.execute('enable');
  for (const line of commands.split('\n')) cli.execute(line);
}
