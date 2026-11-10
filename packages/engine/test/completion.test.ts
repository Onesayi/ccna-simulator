import { describe, expect, it } from 'vitest';
import { CliSession, Pc, PcShell, Router, Switch, Topology, WirelessController, WlcShell, completeLine, resetMacAllocator } from '../src';
import { ios } from './helpers';

function on<T extends Router | Switch>(device: T, ...lines: string[]) {
  resetMacAllocator();
  const net = new Topology();
  net.add(device);
  const cli = new CliSession(device);
  for (const l of lines) cli.execute(l);
  return cli;
}

describe('Tab completion', () => {
  it('completes a unique keyword and adds a space, in every word of the line', () => {
    const cli = on(new Router('R1'));
    expect(cli.complete('en')).toBe('enable ');
    cli.execute('enable');
    expect(cli.complete('sh')).toBe('show ');
    expect(cli.complete('show ip ro')).toBe('show ip route ');
    expect(cli.complete('sh ip int b')).toBe('sh ip int brief ');
    expect(cli.complete('show ip route st')).toBe('show ip route static ');
    expect(cli.complete('conf')).toBe('configure ');
    expect(cli.complete('conf t')).toBe('conf terminal ');
    expect(cli.complete('SH')).toBe('show ');
  });

  it('leaves the line unchanged when the word is ambiguous, unknown, or already finished', () => {
    const cli = on(new Router('R1'), 'enable');
    expect(cli.complete('c')).toBe('c');
    expect(cli.complete('zzz')).toBe('zzz');
    expect(cli.complete('show ')).toBe('show ');
    expect(cli.complete('s ip')).toBe('s ip');
    expect(cli.complete('ping 10')).toBe('ping 10');
  });

  it('prefers a keyword typed in full over a longer one it starts', () => {
    const cli = on(new Router('R1'), 'enable', 'configure terminal');
    expect(cli.complete('ip')).toBe('ip ');
    expect(cli.complete('ipv')).toBe('ipv6 ');
  });

  it('works in configuration sub-modes, with no, do and global commands', () => {
    const cli = on(new Switch('SW1'), 'enable', 'configure terminal', 'interface g0/1');
    expect(cli.complete('switchport mo')).toBe('switchport mode ');
    expect(cli.complete('switchport mode tr')).toBe('switchport mode trunk ');
    expect(cli.complete('no shut')).toBe('no shutdown ');
    expect(cli.complete('do sh run')).toBe('do sh running-config ');
    expect(cli.complete('hostn')).toBe('hostname ');
    cli.execute('exit');
    expect(cli.complete('vla')).toBe('vlan ');
    cli.execute('vlan 10');
    expect(cli.complete('na')).toBe('name ');
  });

  it('expands an interface type after interface', () => {
    const r = on(new Router('R1'), 'enable', 'configure terminal');
    expect(r.complete('int g')).toBe('int GigabitEthernet');
    expect(r.complete('interface lo')).toBe('interface Loopback');
    expect(r.complete('int x')).toBe('int x');
    expect(r.complete('int g0/1')).toBe('int g0/1');
    expect(r.complete('ip x')).toBe('ip x');
    const s = on(new Switch('SW1'), 'enable', 'configure terminal');
    expect(s.complete('interface range g')).toBe('interface range GigabitEthernet');
    expect(s.complete('int v')).toBe('int Vlan');
    expect(s.complete('int po')).toBe('int Port-channel');
  });

  it('completes on the far device inside telnet, and nothing at a password prompt', () => {
    resetMacAllocator();
    const net = new Topology();
    const r1 = net.add(new Router('R1'));
    const pc = net.add(new Pc('PC1'));
    net.connect(pc.nic, r1.iface('g0/0'));
    pc.configure('10.0.0.10', 24, '10.0.0.1');
    ios(r1, 'conf t\nint g0/0\nip address 10.0.0.1 255.255.255.0\nno shut\nline vty 0 4\npassword cisco\nlogin');
    const shell = new PcShell(pc);
    expect(shell.complete('ping')).toBeUndefined();
    shell.execute('telnet 10.0.0.1');
    expect(shell.complete('cis')).toBeUndefined();
    shell.execute('cisco');
    expect(shell.prompt).toBe('R1>');
    expect(shell.complete('sh')).toBe('show ');
    const console = new CliSession(r1);
    console.execute('enable');
    console.execute('telnet 10.0.0.1');
    expect(console.complete('pass')).toBeUndefined();
    console.execute('cisco');
    expect(console.complete('ena')).toBe('enable ');
  });

  it('completes WLC controller commands', () => {
    const w = new WlcShell(new WirelessController('WLC1'));
    expect(w.complete('sh wl s')).toBe('sh wl summary ');
    expect(w.complete('sh wl')).toBe('sh wlan ');
    expect(w.complete('con')).toBe('config ');
    expect(w.complete('s')).toBe('s');
  });

  it('keeps a greedy argument from completing anything after it', () => {
    const grammar = [{ syntax: 'description <text...>', help: '' }, { syntax: 'duplex <mode>', help: '' }];
    expect(completeLine(grammar, 'description hello wor')).toBeUndefined();
    expect(completeLine(grammar, 'des')).toBe('description ');
    expect(completeLine(grammar, 'd')).toBeUndefined();
  });
});

describe('? help', () => {
  it('lists the keywords a partial word can start', () => {
    const cli = on(new Router('R1'), 'enable');
    expect(cli.execute('sh?')).toBe('show');
    expect(cli.execute('c?')).toMatch(/clear {2}.*configure/);
    expect(cli.execute('show ip ro?')).toBe('route');
    expect(cli.execute('show zz?')).toBe('% Unrecognized command');
  });

  it('follows abbreviations and marks a whole command with <cr>', () => {
    const cli = on(new Router('R1'), 'enable');
    const out = cli.execute('sh ip ?');
    expect(out).toContain('show ip route');
    expect(out).not.toContain('show vlan');
    expect(cli.execute('show ip route ?')).toContain('<cr>');
    expect(cli.execute('s ?')).toMatch(/% Ambiguous command/);
    expect(cli.execute('ping 10.0.0.1 extra stuff ?')).toBe('% Unrecognized command');
  });

  it('shows do only when asked for it in config mode', () => {
    const cli = on(new Router('R1'), 'enable', 'configure terminal');
    expect(cli.execute('?')).not.toMatch(/^ {2}do /m);
    expect(cli.execute('do ?')).toMatch(/do show running-config/);
  });
});
