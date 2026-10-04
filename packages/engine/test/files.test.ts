import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Router, Server, ServerShell, Switch, Topology, compileFilter, dissect, resetMacAllocator } from '../src';
import { ios } from './helpers';

/** R1 and SW1 on a LAN with a Linux server (TFTP, FTP, SCP and SFTP). */
function lan() {
  resetMacAllocator();
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const sw = net.add(new Switch('SW1'));
  const srv = net.add(new Server('SRV'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/1'));
  net.connect(srv.nic, sw.iface('g0/2'));
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut');
  ios(sw, 'conf t\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut');
  return { net, r1, sw, srv };
}

function cli(device: Router | Switch): (...lines: string[]) => string {
  const s = new CliSession(device, { loggedIn: true });
  s.execute('enable');
  return (...lines) => lines.map((l) => s.execute(l)).at(-1)!;
}

describe('copy to and from file servers', () => {
  let t: ReturnType<typeof lan>;
  beforeEach(() => (t = lan()));

  it('backs up the running config over TFTP and restores it', () => {
    const run = cli(t.r1);
    expect(run('copy running-config tftp:')).toBe('');
    expect(run('192.168.1.100')).toBe('');
    expect(run('')).toMatch(/^!!\n\d+ bytes copied in 0\.040 secs/);
    const backup = t.srv.files.get('r1-confg')!;
    expect(backup).toContain('hostname R1');
    expect(backup).toContain(' ip address 192.168.1.1 255.255.255.0');
    expect(backup.startsWith('!')).toBe(true);
    expect(t.srv.transferLog.at(-1)).toMatch(/^TFTP 192\.168\.1\.1 +i \d+ bytes \/r1-confg anonymous$/);

    // Restore into a router that lost its LAN address: copy merges, so the address comes back.
    ios(t.r1, 'conf t\nhostname BROKEN\nint g0/0\nno ip address');
    const restore = cli(t.r1);
    restore('copy tftp://192.168.1.100/r1-confg running-config');
    restore('');
    restore('');
    // The interface lost its address, so there is no route to the server until it is restored.
    expect(restore('')).toBe('%Error opening tftp://192.168.1.100/r1-confg (No route to host)');
    ios(t.r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0');
    restore('copy tftp: running-config');
    restore('192.168.1.100');
    restore('r1-confg');
    const out = restore('');
    expect(out).toMatch(/^Accessing tftp:\/\/192\.168\.1\.100\/r1-confg\.\.\.\nLoading r1-confg from 192\.168\.1\.100 \(via GigabitEthernet0\/0\): !\n\[OK - \d+ bytes\]\n\n\d+ bytes copied/);
    expect(t.r1.hostname).toBe('R1');
    expect(t.r1.log.at(-1)).toContain('%SYS-5-CONFIG_I: Configured from tftp://192.168.1.100/r1-confg by console');

    restore('copy tftp://192.168.1.100/nope.cfg flash:');
    expect(restore('', '', '')).toBe('%Error opening tftp://192.168.1.100/nope.cfg (No such file or directory)');
  });

  it('times out when the TFTP server cannot be reached', () => {
    const run = cli(t.r1);
    run('copy running-config tftp://192.168.1.99/r1.cfg');
    expect(run('', '')).toBe('%Error opening tftp://192.168.1.99/r1.cfg (Timed out)');
    run('copy running-config tftp:');
    expect(run('', '')).toBe('%Error parsing filename (Bad file name)');
  });

  it('logs in to FTP with ip ftp username, and the capture shows the password', () => {
    const shell = new ServerShell(t.srv);
    const run = cli(t.r1);
    run('copy running-config ftp://192.168.1.100/r1.cfg');
    expect(run('', '')).toBe('%Error opening ftp://192.168.1.100/r1.cfg (Connection refused by remote host)');
    expect(shell.execute('adduser backup Cisco123')).toContain('FTP (21) and SSH/SCP/SFTP (22) are open');
    run('copy running-config ftp://192.168.1.100/r1.cfg');
    expect(run('', '')).toBe('%Error opening ftp://192.168.1.100/r1.cfg (Incorrect Login/Password)');
    ios(t.r1, 'conf t\nip ftp username backup\nip ftp password Cisco123');
    run('copy running-config ftp://192.168.1.100/r1.cfg');
    expect(run('', '')).toMatch(/^Writing r1\.cfg !\n\d+ bytes copied/);
    expect(t.srv.files.get('r1.cfg')).toContain('ip ftp username backup');
    expect(shell.execute('cat /var/log/xferlog')).toMatch(/FTP +192\.168\.1\.1 +i \d+ bytes \/r1\.cfg backup/);
    expect(shell.execute('ls')).toContain('r1.cfg');
    const ftp = t.net.trace.filter((e) => compileFilter('ftp')!(e.frame));
    expect(ftp.length).toBeGreaterThan(0);
    expect(ftp.some((e) => JSON.stringify(dissect(e.frame)).includes('PASS Cisco123'))).toBe(true);
    // A URL login wins over ip ftp username; a get of a missing file fails.
    run('copy ftp://backup:Cisco123@192.168.1.100/missing.cfg flash:');
    expect(run('', '', '')).toBe('%Error opening ftp://192.168.1.100/missing.cfg (No such file or directory)');
    ios(t.r1, 'conf t\nno ip ftp username\nno ip ftp password');
    expect(ios(t.r1, 'show running-config')).not.toContain('ip ftp');
    expect(shell.execute('deluser backup')).toBe('User backup removed.');
    expect(shell.execute('deluser backup')).toBe("deluser: user 'backup' does not exist");
    expect(shell.execute('adduser x')).toBe('usage: adduser <name> <password>');
  });

  it('copies over SCP and SFTP with a username and masked password', () => {
    new ServerShell(t.srv).execute('adduser admin S3cret!');
    const s = new CliSession(t.sw, { loggedIn: true });
    s.execute('enable');
    s.execute('copy running-config scp:');
    expect(s.prompt).toBe('Address or name of remote host []? ');
    s.execute('192.168.1.100');
    expect(s.prompt).toBe('Destination username [SW1]? ');
    s.execute('admin');
    expect(s.prompt).toBe('Destination filename [sw1-confg]? ');
    s.execute('');
    expect(s.prompt).toBe('Password: ');
    expect(s.masked).toBe(true);
    expect(s.execute('wrong')).toBe('%Error opening scp://admin@192.168.1.100/sw1-confg (Authentication failed)');
    s.execute('copy running-config scp://admin:S3cret!@192.168.1.100/sw1.cfg');
    expect(s.execute('')).toBe('');
    s.execute('');
    expect(s.execute('')).toMatch(/^Writing sw1\.cfg !/);
    expect(t.srv.files.get('sw1.cfg')).toContain('hostname SW1');
    // The capture shows SSH, not the file or the password.
    const ssh = t.net.trace.filter((e) => compileFilter('ssh')!(e.frame) && e.frame.payload.kind === 'tcp' && e.frame.payload.transfer);
    expect(JSON.stringify(dissect(ssh[0]!.frame))).not.toContain('S3cret!');
    // SFTP back into flash, then show it.
    s.execute('copy sftp: flash:');
    for (const answer of ['192.168.1.100', 'admin', 'sw1.cfg', 'backup.cfg']) s.execute(answer);
    expect(s.execute('S3cret!')).toMatch(/^Accessing sftp:\/\/admin@192\.168\.1\.100\/sw1\.cfg\.\.\./);
    expect(s.execute('dir flash:')).toMatch(/c2960-lanbasek9-mz\.150-2\.SE4\.bin\n\s+2\s+-rw-\s+\d+\s+<no date>\s+backup\.cfg/);
    expect(s.execute('more flash:backup.cfg')).toContain('hostname SW1');
  });

  it('saves to startup-config and flash, and erases', () => {
    const run = cli(t.r1);
    expect(run('show startup-config')).toBe('startup-config is not present');
    run('copy startup-config tftp:');
    expect(run('copy startup-config tftp:')).toBe('%Error opening nvram:/startup-config (No such file or directory)');
    run('copy run start');
    expect(run('')).toBe('Building configuration...\n[OK]');
    expect(run('show startup-config')).toMatch(/^Using \d+ out of 262136 bytes\n!/);
    run('copy running-config flash:');
    expect(run('')).toMatch(/bytes copied/);
    expect(t.r1.flash.has('r1-confg')).toBe(true);
    run('copy flash:r1-confg startup-config');
    expect(run('')).toMatch(/bytes copied/);
    run('copy startup-config running-config');
    expect(run('')).toMatch(/bytes copied/);
    expect(run('show flash:')).toContain('c2900-universalk9-mz.SPA.157-3.M3.bin');
    expect(run('dir')).toContain('r1-confg');
    expect(run('dir nvram:')).toContain('% Invalid input');
    expect(run('copy flash: tftp:')).toBe('%Error opening flash:/ (Is a directory)');
    expect(run('copy flash:none.cfg tftp:')).toBe('%Error opening flash:/none.cfg (No such file or directory)');
    expect(run('copy tftp: ftp:')).toContain('% Invalid input');
    expect(run('copy bogus: tftp:')).toContain('% Invalid input');
    expect(run('copy tftp:bad running-config')).toContain('% Invalid input');
    run('copy flash:c2900-universalk9-mz.SPA.157-3.M3.bin tftp://192.168.1.100/');
    expect(run('', '')).toMatch(/^!!/);
    expect(t.srv.files.has('c2900-universalk9-mz.SPA.157-3.M3.bin')).toBe(true);
    expect(run('more flash:nope')).toBe('%Error opening flash:nope (No such file or directory)');
    expect(run('more nvram:x')).toContain('% Invalid input');
    expect(run('delete flash:c2900-universalk9-mz.SPA.157-3.M3.bin')).toBe('%Error deleting flash:c2900-universalk9-mz.SPA.157-3.M3.bin (Permission denied)');
    expect(run('delete flash:r1-confg')).toBe('');
    expect(run('delete flash:r1-confg')).toBe('%Error deleting flash:r1-confg (No such file or directory)');
    expect(run('erase startup-config')).toContain('Erase of nvram: complete');
    run('write memory');
    expect(t.r1.startupConfig).toBeDefined();
    run('write erase');
    expect(t.r1.startupConfig).toBeUndefined();
  });
});
