import { beforeEach, describe, expect, it } from 'vitest';
import { BOOT_TIME, CliSession, Pc, PcShell, Router, Switch, Topology, decodeType7, md5Crypt, parseClockSet, resetMacAllocator, type Shell } from '../src';
import { ios } from './helpers';

/** PC1 and R1 on SW1 (managed on Vlan1), and R2 behind R1. */
function office() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const pc = net.add(new Pc('PC1'));
  net.connect(pc.nic, sw.iface('g0/1'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/2'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/0'));
  pc.configure('192.168.1.10', 24, '192.168.1.1');
  ios(sw, 'conf t\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut\nexit\nip default-gateway 192.168.1.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nint g0/1\nip address 10.0.12.1 255.255.255.252\nno shut');
  ios(r2, 'conf t\nint g0/0\nip address 10.0.12.2 255.255.255.252\nno shut\nip route 0.0.0.0 0.0.0.0 10.0.12.1');
  return { net, sw, r1, r2, pc };
}

/** Types lines into a shell and returns every output, in order. */
function type(shell: Shell, ...lines: string[]): string[] {
  return lines.map((l) => shell.execute(l));
}

const SSH_SETUP = 'conf t\nip domain-name ccna.lab\nusername admin privilege 15 secret Cisco123\nline vty 0 15\nlogin local\ntransport input ssh\nexit\ncrypto key generate rsa modulus 2048\nip ssh version 2';

describe('SSH and VTY lines', () => {
  let t: ReturnType<typeof office>;
  beforeEach(() => (t = office()));

  it('needs a hostname and a domain name before it will generate keys', () => {
    const fresh = t.net.add(new Router('Router'));
    const cli = new CliSession(fresh);
    type(cli, 'enable', 'conf t');
    expect(cli.execute('crypto key generate rsa modulus 1024')).toBe('% Please define a hostname other than Router.');
    const r1 = new CliSession(t.r1);
    type(r1, 'enable', 'conf t');
    expect(r1.execute('crypto key generate rsa modulus 1024')).toBe('% Please define a domain-name first.');
    expect(r1.execute('ip ssh version 2')).toBe('% Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
    r1.execute('ip domain name ccna.lab');
    const out = r1.execute('crypto key generate rsa modulus 2048');
    expect(out).toContain('The name for the keys will be: R1.ccna.lab');
    expect(out).toContain('% Generating 2048 bit RSA keys, keys will be non-exportable...');
    expect(out).toContain('%SSH-5-ENABLED: SSH 1.99 has been enabled');
    expect(r1.execute('do show ip ssh')).toContain('SSH Enabled - version 1.99');
    r1.execute('ip ssh version 2');
    expect(r1.execute('do show ip ssh')).toContain('SSH Enabled - version 2.0');
  });

  it('asks for the modulus when none is given', () => {
    const cli = new CliSession(t.r1);
    type(cli, 'enable', 'conf t', 'ip domain-name ccna.lab');
    expect(cli.execute('crypto key generate rsa')).toContain('Choose the size of the key modulus');
    expect(cli.prompt).toBe('How many bits in the modulus [512]: ');
    expect(cli.instantHelp).toBe(false);
    expect(cli.execute('99')).toBe('% Invalid modulus');
    cli.execute('crypto key generate rsa');
    expect(cli.execute('')).toContain('Generating 512 bit RSA keys');
    expect(cli.execute('ip ssh version 2')).toContain('atleast 768 bits');
    cli.execute('crypto key zeroize rsa');
    expect(t.r1.mgmt.sshEnabled).toBe(false);
    expect(cli.execute('crypto key zeroize rsa')).toBe('% No Signature RSA Keys found in configuration.');
    expect(cli.execute('do show ip ssh')).toContain('SSH Disabled - version 1.99');
  });

  it('logs a PC into the switch over SSH and back out', () => {
    ios(t.sw, SSH_SETUP);
    const pc = new PcShell(t.pc);
    expect(pc.execute('ssh -l admin 192.168.1.2')).toBe('');
    expect(pc.prompt).toBe('Password: ');
    expect(pc.masked).toBe(true);
    expect(pc.execute('Cisco123')).toBe('');
    // Privilege 15 lands in privileged EXEC.
    expect(pc.prompt).toBe('SW1#');
    expect(pc.instantHelp).toBe(true);
    expect(pc.execute('show ip ssh')).toContain('version 2.0');
    pc.execute('conf t');
    pc.execute('hostname CORE-SW');
    expect(pc.prompt).toBe('CORE-SW(config)#');
    pc.execute('end');
    expect(pc.execute('exit')).toBe('\n[Connection to 192.168.1.2 closed by foreign host]');
    expect(pc.prompt).toBe('C:\\>');
    expect(t.sw.hostname).toBe('CORE-SW');
  });

  it('refuses telnet once only SSH is allowed, and rejects bad credentials', () => {
    ios(t.sw, SSH_SETUP);
    const pc = new PcShell(t.pc);
    expect(pc.execute('telnet 192.168.1.2')).toContain('% Connection refused by remote host');
    pc.execute('ssh -l admin 192.168.1.2');
    expect(pc.execute('wrong')).toBe('% Authentication failed.\n\n[Connection to 192.168.1.2 closed by foreign host]');
    expect(pc.execute('ssh 192.168.1.2')).toBe('Usage: ssh -l <username> <ip>');
    expect(pc.execute('ssh -l admin 192.168.1.99')).toContain('timed out');
    expect(new PcShell(t.pc).execute('ssh -l admin 192.168.1.1')).toBe('% Connection refused by remote host');
  });

  it('needs login local for SSH', () => {
    ios(t.r1, 'conf t\nip domain-name ccna.lab\ncrypto key generate rsa modulus 1024\nusername admin secret pw');
    const pc = new PcShell(t.pc);
    pc.execute('ssh -l admin 192.168.1.1');
    expect(pc.execute('pw')).toContain('% Authentication failed.');
  });

  it('runs telnet logins against the line password or the local users', () => {
    const pc = new PcShell(t.pc);
    expect(pc.execute('telnet 192.168.1.1')).toBe('Trying 192.168.1.1 ...Open\n\nPassword required, but none set\n\n[Connection to 192.168.1.1 closed by foreign host]');

    const cli = new CliSession(t.r1);
    type(cli, 'enable', 'conf t', 'line vty 0 4');
    expect(cli.execute('login')).toBe("% Login disabled on line, until 'password' is set");
    cli.execute('password letmein');
    expect(pc.execute('telnet 192.168.1.1')).toBe('Trying 192.168.1.1 ...Open\n\nUser Access Verification\n');
    expect(pc.execute('nope')).toBe('% Login invalid\n\n[Connection to 192.168.1.1 closed by foreign host]');
    pc.execute('telnet 192.168.1.1');
    pc.execute('letmein');
    expect(pc.prompt).toBe('R1>');
    // No enable password yet, so a remote session cannot reach privileged EXEC.
    expect(pc.execute('enable')).toBe('% No password set');
    pc.execute('logout');
    expect(pc.prompt).toBe('C:\\>');

    type(cli, 'login local', 'exit', 'username bob password builder', 'enable secret topsecret');
    pc.execute('telnet 192.168.1.1');
    expect(pc.prompt).toBe('Username: ');
    pc.execute('bob');
    expect(pc.prompt).toBe('Password: ');
    pc.execute('builder');
    expect(pc.prompt).toBe('R1>');
    pc.execute('enable');
    expect(pc.execute('wrong')).toBe('% Bad secrets');
    pc.execute('enable');
    pc.execute('topsecret');
    expect(pc.prompt).toBe('R1#');
    pc.execute('exit');

    type(cli, 'line vty 0 4', 'no login');
    const s = pc.execute('telnet 192.168.1.1');
    expect(s).toBe('Trying 192.168.1.1 ...Open\n\n');
    expect(pc.prompt).toBe('R1>');
  });

  it('chains sessions from router to router, and asks for enable secret on the console', () => {
    ios(t.r2, 'conf t\nline vty 0 4\nno login\nexit\nenable secret s3cret');
    const cli = new CliSession(t.r1);
    cli.execute('enable');
    expect(cli.execute('telnet 10.0.12.2')).toBe('Trying 10.0.12.2 ... Open\n\n');
    expect(cli.prompt).toBe('R2>');
    expect(cli.execute('show ip interface brief')).toContain('10.0.12.2');
    cli.execute('exit');
    expect(cli.prompt).toBe('R1#');

    const console = new CliSession(t.r2);
    console.execute('enable');
    expect(console.prompt).toBe('Password: ');
    console.execute('s3cret');
    expect(console.prompt).toBe('R2#');
  });

  it('opens SSH sessions from IOS too', () => {
    ios(t.r2, SSH_SETUP.replace('transport input ssh', 'transport input all'));
    const cli = new CliSession(t.r1);
    cli.execute('enable');
    expect(cli.execute('ssh -l admin -v 2 10.0.12.2')).toBe('');
    cli.execute('Cisco123');
    expect(cli.prompt).toBe('R2#');
    cli.execute('exit');
    expect(cli.execute('ssh 10.0.12.2')).toBe('% No user specified');
    expect(cli.execute('ssh -l admin 10.0.12.9')).toContain('% Destination unreachable');
    expect(cli.execute('ssh -l admin 192.168.1.10')).toBe('% Connection refused by remote host');
    ios(t.r2, 'conf t\nline vty 0 4\ntransport input none');
    expect(cli.execute('ssh -l admin 10.0.12.2')).toBe('% Connection refused by remote host');
    expect(cli.execute('ssh -l admin bogus')).toContain('% Invalid input');
  });

  it('hides passwords in the running config', () => {
    // One console session throughout: after `enable secret`, a new one would be asked for it.
    const cli = new CliSession(t.r1);
    const run = (lines: string) => lines.split('\n').map((l) => cli.execute(l)).pop()!;
    cli.execute('enable');
    run('conf t\nenable secret topsecret\nenable password plain\nusername bob password builder\nusername amy privilege 15 secret 0 x\nline con 0\npassword con1\nlogin\nlogging synchronous\nexec-timeout 5 30\nline vty 0 15\npassword vty1\ntransport input telnet\nend');
    let cfg = run('show running-config');
    expect(cfg).toContain(`enable secret 5 ${md5Crypt('topsecret')}`);
    expect(cfg).toContain('enable password plain');
    expect(cfg).toContain('username bob password builder');
    expect(cfg).toContain(`username amy privilege 15 secret 5 ${md5Crypt('x')}`);
    expect(cfg).toContain('line con 0\n exec-timeout 5 30\n password con1\n logging synchronous\n login\n!\nline vty 0 15\n password vty1\n login\n transport input telnet');
    run('conf t\nservice password-encryption\nend');
    cfg = run('show running-config');
    expect(cfg).toContain('service password-encryption');
    const type7 = /enable password 7 (\w+)/.exec(cfg)![1]!;
    expect(decodeType7(type7)).toBe('plain');
    expect(cfg).not.toContain('password con1');
    expect(run('conf t\nenable password topsecret')).toContain('same as your enable secret');
    run('no enable password\nno enable secret\nno username bob\nno service password-encryption\nline vty 0 4\nno password\nexec-timeout 10\nno logging synchronous\nno ip domain-name');
    expect(t.r1.mgmt.users.has('bob')).toBe(false);
    expect(t.r1.mgmt.enableRequired).toBeUndefined();
  });

  it('rejects bad access commands', () => {
    const cli = new CliSession(t.r1);
    type(cli, 'enable', 'conf t');
    expect(cli.execute('username x privilege 15 hash y')).toContain('% Invalid input');
    expect(cli.execute('enable secret a b c')).toContain('% Invalid input');
    expect(cli.execute('line console 1')).toContain('% Invalid input');
    cli.execute('line vty 0 4');
    expect(cli.execute('transport input carrier-pigeon')).toContain('% Invalid input');
    cli.execute('transport input telnet ssh');
    expect(t.r1.mgmt.vty.transport).toEqual(new Set(['telnet', 'ssh']));
    cli.execute('exit');
    cli.execute('ip domain-name lab');
    expect(cli.execute('crypto key generate rsa modulus 100')).toContain('% Invalid input');
    cli.execute('crypto key generate rsa general-keys modulus 1024');
    cli.execute('ip ssh version 1');
    cli.execute('no ip ssh version');
    expect(t.r1.mgmt.sshVersion).toBeUndefined();
  });
});

describe('Clock and NTP', () => {
  let t: ReturnType<typeof office>;
  beforeEach(() => (t = office()));

  it('starts unsynchronized in 1993', () => {
    expect(ios(t.r1, 'show clock')).toMatch(/^\*00:00:\d\d\.\d{3} UTC Mon Mar 1 1993$/);
    expect(ios(t.r1, 'show clock detail')).toContain('No time source');
    expect(ios(t.r1, 'show ntp status')).toBe('%NTP is not enabled.');
    expect(ios(t.r1, 'show ntp associations')).toBe('%NTP is not enabled.');
  });

  it('serves a set clock to clients down the hierarchy', () => {
    ios(t.r1, 'clock set 10:00:00 3 Oct 2026\nconf t\nntp master 3');
    expect(ios(t.r1, 'show clock')).toMatch(/^10:00:0\d\.\d{3} UTC Sat Oct 3 2026$/);
    expect(ios(t.r1, 'show ntp status')).toContain('Clock is synchronized, stratum 3, reference is 127.127.1.1');
    ios(t.r2, 'conf t\nntp server 10.0.12.1\nclock timezone CAT 2');
    expect(t.r2.ntp.sync).toMatchObject({ server: '10.0.12.1', stratum: 4 });
    expect(t.r2.log).toContain('%NTP-5-PEERSYNC: NTP synced to peer 10.0.12.1');
    expect(ios(t.r2, 'show clock')).toMatch(/^12:00:\d\d\.\d{3} CAT Sat Oct 3 2026$/);
    expect(ios(t.r2, 'show clock detail')).toContain('Time source is NTP');
    expect(ios(t.r2, 'show ntp status')).toContain('Clock is synchronized, stratum 4, reference is 10.0.12.1');
    expect(ios(t.r2, 'show ntp associations')).toMatch(/\*~10\.0\.12\.1\s+127\.127\.1\.1\s+3/);
    // The switch syncs from R2, two routers away: one stratum further down.
    ios(t.sw, 'conf t\nntp server 10.0.12.2');
    expect(t.sw.ntp.sync).toMatchObject({ server: '10.0.12.2', stratum: 5 });
    expect(ios(t.r1, 'show ntp associations')).toContain('*~127.127.1.1');
    expect(ios(t.r2, 'show running-config')).toContain('clock timezone CAT 2 0');
    expect(ios(t.r2, 'show running-config')).toMatch(/ntp server 10\.0\.12\.1\n!\nend$/);
  });

  it('stays unsynchronized while the server is unreachable or has no time', () => {
    ios(t.r2, 'conf t\nntp server 10.0.12.1');
    expect(t.r2.ntp.synchronized).toBe(false);
    expect(ios(t.r2, 'show ntp status')).toContain('Clock is unsynchronized, stratum 16');
    expect(ios(t.r2, 'show ntp associations')).toContain(' ~10.0.12.1       .INIT.          16');
    ios(t.r1, 'conf t\nntp master');
    expect(t.r2.ntp.sync?.stratum).toBe(9);
    ios(t.r1, 'conf t\nint g0/1\nshutdown');
    expect(t.r2.ntp.synchronized).toBe(false);
    expect(t.r2.log).toContain('%NTP-4-PEERUNREACH: Peer 10.0.12.1 is unreachable');
    ios(t.r1, 'conf t\nint g0/1\nno shutdown');
    expect(t.r2.ntp.synchronized).toBe(true);
    ios(t.r2, 'conf t\nno ntp server 10.0.12.1\nno clock timezone');
    expect(t.r2.ntp.synchronized).toBe(false);
    ios(t.r1, 'conf t\nno ntp master');
    expect(t.r1.ntp.configured).toBe(false);
  });

  it('parses clock set in either order and rejects nonsense', () => {
    const utc = { name: 'UTC', hours: 0, minutes: 0 };
    expect(parseClockSet('10:00:00', 'Oct', '3', '2026', utc)).toBe(Date.UTC(2026, 9, 3, 10));
    expect(parseClockSet('10:00:00', '3', 'october', '2026', { name: 'CAT', hours: 2, minutes: 0 })).toBe(Date.UTC(2026, 9, 3, 8));
    expect(() => parseClockSet('25:00:00', '3', 'Oct', '2026', utc)).toThrow();
    expect(() => parseClockSet('10:00', '3', 'Oct', '2026', utc)).toThrow();
    expect(() => parseClockSet('10:00:00', '3', 'Foo', '2026', utc)).toThrow();
    expect(BOOT_TIME).toBe(Date.UTC(1993, 2, 1));
  });
});
