import { isValidIp } from '../core/addressing';
import { showCdp, showCdpNeighbors, showLldp, showLldpNeighbors } from '../services/discovery';
import type { Transport } from '../services/management';
import { parseClockSet } from '../services/ntp';
import { EXEC, INVALID, abbrev, iface, int, ip, requireIos, requireIp, type Command, type Session } from './common';
import { beginLogin, parseSsh } from './remote';

/** CDP and LLDP, device access (users, passwords, lines, SSH) and the clock and NTP. */

const PORT_MODES: Session['mode'][] = ['config-if', 'config-if-range'];

function physical(s: Session) {
  const i = iface(s);
  if (i.kind !== 'physical') throw new Error(INVALID);
  return i;
}

function line(s: Session) {
  return s.currentLine!;
}

function now(s: Session): number {
  return s.device.network?.scheduler.now ?? 0;
}

/** `enable secret 0 cisco` and `enable secret cisco` mean the same. */
function password(rest: string): string {
  const w = rest.trim().split(/\s+/);
  if (w.length === 2 && w[0] === '0') return w[1]!;
  if (w.length !== 1 || !w[0]) throw new Error(INVALID);
  return w[0];
}

function parseUsername(s: Session, name: string, rest: string): void {
  const mgmt = requireIos(s).mgmt;
  const w = rest.split(/\s+/);
  let privilege = 1;
  let k = 0;
  if (abbrev(w[k], 'privilege')) {
    privilege = int(w[k + 1], 0, 15);
    k += 2;
  }
  const kind = w[k];
  const secret = abbrev(kind, 'secret');
  if (!secret && !abbrev(kind, 'password')) throw new Error(INVALID);
  const pw = password(w.slice(k + 1).join(' '));
  mgmt.users.set(name, { name, privilege, password: pw, secret });
}

function transports(list: string): Set<Transport> {
  const out = new Set<Transport>();
  for (const w of list.split(/\s+/)) {
    if (abbrev(w, 'all')) return new Set(['telnet', 'ssh']);
    if (abbrev(w, 'none')) return new Set();
    if (abbrev(w, 'ssh')) out.add('ssh');
    else if (abbrev(w, 'telnet')) out.add('telnet');
    else throw new Error(INVALID);
  }
  return out;
}

const DEFAULT_HOSTNAMES = /^(Router|Switch)$/;

function generateKeys(s: Session, modulus: number): string {
  const d = requireIos(s);
  const mgmt = d.mgmt;
  if (modulus < 360 || modulus > 4096) throw new Error(INVALID);
  const wasEnabled = mgmt.sshEnabled;
  mgmt.rsaModulus = modulus;
  if (!wasEnabled) d.log.push(`%SSH-5-ENABLED: SSH ${mgmt.sshVersionLabel} has been enabled`);
  return [
    `% The key modulus size is ${modulus} bits`,
    `% Generating ${modulus} bit RSA keys, keys will be non-exportable...`,
    '[OK] (elapsed time was 1 seconds)',
  ].join('\n');
}

/** Checks the prerequisites for RSA keys and returns the key name, as IOS prints it. */
function keyName(s: Session): string {
  const d = requireIos(s);
  if (DEFAULT_HOSTNAMES.test(d.hostname)) throw new Error(`Please define a hostname other than ${d.hostname}.`);
  if (!d.mgmt.domainName) throw new Error('Please define a domain-name first.');
  return `The name for the keys will be: ${d.hostname}.${d.mgmt.domainName}`;
}

function showIpSsh(s: Session): string {
  const mgmt = requireIos(s).mgmt;
  if (!mgmt.sshEnabled) {
    return [`SSH Disabled - version ${mgmt.sshVersionLabel}`, '%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).', 'Authentication timeout: 120 secs; Authentication retries: 3'].join('\n');
  }
  return [
    `SSH Enabled - version ${mgmt.sshVersionLabel}`,
    'Authentication methods:publickey,keyboard-interactive,password',
    'Authentication timeout: 120 secs; Authentication retries: 3',
    'Minimum expected Diffie Hellman key size : 1024 bits',
    `IOS Keys in SECSH format(ssh-rsa, base64 encoded): ${mgmt.rsaModulus}-bit key`,
  ].join('\n');
}

export const MANAGEMENT_COMMANDS: Command[] = [
  // CDP and LLDP
  { syntax: 'cdp run', modes: ['config'], help: 'Enable CDP (on by default)', run: (s) => void (requireIos(s).discovery.cdpEnabled = true) },
  { syntax: 'no cdp run', modes: ['config'], help: 'Disable CDP on the whole device', run: (s) => void (requireIos(s).discovery.cdpEnabled = false) },
  { syntax: 'lldp run', modes: ['config'], help: 'Enable LLDP (off by default)', run: (s) => void (requireIos(s).discovery.lldpEnabled = true) },
  { syntax: 'no lldp run', modes: ['config'], help: 'Disable LLDP', run: (s) => void (requireIos(s).discovery.lldpEnabled = false) },
  { syntax: 'cdp enable', modes: PORT_MODES, help: 'Run CDP on this port', run: (s) => void delete physical(s).cdp },
  { syntax: 'no cdp enable', modes: PORT_MODES, help: 'Stop CDP on this port', run: (s) => void (physical(s).cdp = false) },
  { syntax: 'lldp transmit', modes: PORT_MODES, help: 'Send LLDP on this port', run: (s) => {
    const i = physical(s);
    if (i.lldp) delete i.lldp.transmit;
  } },
  { syntax: 'no lldp transmit', modes: PORT_MODES, help: 'Stop sending LLDP on this port', run: (s) => void ((physical(s).lldp ??= {}).transmit = false) },
  { syntax: 'lldp receive', modes: PORT_MODES, help: 'Accept LLDP on this port', run: (s) => {
    const i = physical(s);
    if (i.lldp) delete i.lldp.receive;
  } },
  { syntax: 'no lldp receive', modes: PORT_MODES, help: 'Ignore LLDP on this port', run: (s) => void ((physical(s).lldp ??= {}).receive = false) },
  { syntax: 'show cdp', modes: EXEC, help: 'CDP timers and state', run: (s) => showCdp(requireIos(s).discovery) },
  { syntax: 'show cdp neighbors', modes: EXEC, help: 'Directly connected Cisco devices', run: (s) => showCdpNeighbors(requireIos(s).discovery, now(s)) },
  { syntax: 'show cdp neighbors detail', modes: EXEC, help: 'Neighbors with addresses, platform and version', run: (s) => showCdpNeighbors(requireIos(s).discovery, now(s), true) },
  { syntax: 'show lldp', modes: EXEC, help: 'LLDP timers and state', run: (s) => showLldp(requireIos(s).discovery) },
  { syntax: 'show lldp neighbors', modes: EXEC, help: 'Directly connected LLDP devices', run: (s) => showLldpNeighbors(requireIos(s).discovery, now(s)) },
  { syntax: 'show lldp neighbors detail', modes: EXEC, help: 'LLDP neighbors with addresses and capabilities', run: (s) => showLldpNeighbors(requireIos(s).discovery, now(s), true) },

  // Passwords and local users
  { syntax: 'enable secret <password...>', modes: ['config'], help: 'Hashed password for privileged EXEC', run: (s, [pw]) => void (requireIos(s).mgmt.enableSecret = password(pw!)) },
  { syntax: 'no enable secret', modes: ['config'], help: 'Remove the enable secret', run: (s) => void (requireIos(s).mgmt.enableSecret = undefined) },
  { syntax: 'enable password <password...>', modes: ['config'], help: 'Clear-text password for privileged EXEC', run: (s, [pw]) => {
    const mgmt = requireIos(s).mgmt;
    mgmt.enablePassword = password(pw!);
    if (mgmt.enableSecret !== undefined && mgmt.enableSecret === mgmt.enablePassword) {
      return 'The enable password you have chosen is the same as your enable secret.\nThis is not recommended.  Re-enter the enable password.';
    }
  } },
  { syntax: 'no enable password', modes: ['config'], help: 'Remove the enable password', run: (s) => void (requireIos(s).mgmt.enablePassword = undefined) },
  { syntax: 'service password-encryption', modes: ['config'], help: 'Hide clear-text passwords (type 7)', run: (s) => void (requireIos(s).mgmt.passwordEncryption = true) },
  { syntax: 'no service password-encryption', modes: ['config'], help: 'Stop encrypting new passwords', run: (s) => void (requireIos(s).mgmt.passwordEncryption = false) },
  { syntax: 'username <name> <rest...>', modes: ['config'], help: '<name> [privilege <0-15>] secret|password <password>', run: (s, [name, rest]) => parseUsername(s, name!, rest!) },
  { syntax: 'no username <name>', modes: ['config'], help: 'Delete a local user', run: (s, [name]) => void requireIos(s).mgmt.users.delete(name!) },

  // Lines
  { syntax: 'line vty <first> <last>', modes: ['config', 'config-line'], help: 'Virtual terminal lines (telnet and SSH)', run: (s, [first, last]) => {
    const mgmt = requireIos(s).mgmt;
    int(first, 0, 15);
    mgmt.vtyLast = Math.max(mgmt.vtyLast, int(last, 0, 15));
    s.currentLine = mgmt.vty;
    s.mode = 'config-line';
  } },
  { syntax: 'line console <n>', modes: ['config', 'config-line'], help: 'The console port', run: (s, [n]) => {
    int(n, 0, 0);
    s.currentLine = requireIos(s).mgmt.console;
    s.mode = 'config-line';
  } },
  { syntax: 'password <password...>', modes: ['config-line'], help: 'Line password (used by `login`)', run: (s, [pw]) => void (line(s).password = password(pw!)) },
  { syntax: 'no password', modes: ['config-line'], help: 'Remove the line password', run: (s) => void (line(s).password = undefined) },
  { syntax: 'login', modes: ['config-line'], help: 'Ask for the line password', run: (s) => {
    const l = line(s);
    l.login = 'line';
    if (l.password === undefined) return '% Login disabled on line, until \'password\' is set';
  } },
  { syntax: 'login local', modes: ['config-line'], help: 'Ask for a username and password from the local user database', run: (s) => void (line(s).login = 'local') },
  { syntax: 'no login', modes: ['config-line'], help: 'No login at all (anyone gets in)', run: (s) => void (line(s).login = 'none') },
  { syntax: 'transport input <list...>', modes: ['config-line'], help: 'ssh | telnet | all | none', run: (s, [list]) => void (line(s).transport = transports(list!)) },
  { syntax: 'exec-timeout <minutes>', modes: ['config-line'], help: 'Log idle sessions out', run: (s, [m]) => void (line(s).execTimeout = [int(m, 0, 35791), 0]) },
  { syntax: 'exec-timeout <minutes> <seconds>', modes: ['config-line'], help: 'Log idle sessions out', run: (s, [m, sec]) => void (line(s).execTimeout = [int(m, 0, 35791), int(sec, 0, 2147483)]) },
  { syntax: 'logging synchronous', modes: ['config-line'], help: 'Do not let log messages break up typing', run: (s) => void (line(s).loggingSynchronous = true) },
  { syntax: 'no logging synchronous', modes: ['config-line'], help: 'Print log messages at once', run: (s) => void (line(s).loggingSynchronous = false) },

  // SSH server and client
  { syntax: 'ip domain-name <name>', modes: ['config'], help: 'Default domain name (needed for RSA keys)', run: (s, [name]) => void (requireIos(s).mgmt.domainName = name) },
  { syntax: 'ip domain name <name>', modes: ['config'], help: 'Default domain name (needed for RSA keys)', run: (s, [name]) => void (requireIos(s).mgmt.domainName = name) },
  { syntax: 'no ip domain-name', modes: ['config'], help: 'Remove the domain name', run: (s) => void (requireIos(s).mgmt.domainName = undefined) },
  { syntax: 'no ip domain name', modes: ['config'], help: 'Remove the domain name', run: (s) => void (requireIos(s).mgmt.domainName = undefined) },
  { syntax: 'crypto key generate rsa', modes: ['config'], help: 'Generate RSA keys (turns on SSH)', run: (s) => {
    const name = keyName(s);
    s.io.ask('How many bits in the modulus [512]: ', (answer) => {
      const bits = answer === '' ? 512 : Number(answer);
      if (!Number.isInteger(bits) || bits < 360 || bits > 4096) return '% Invalid modulus';
      return generateKeys(s, bits);
    });
    return `${name}\nChoose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n`;
  } },
  { syntax: 'crypto key generate rsa modulus <bits>', modes: ['config'], help: 'Generate RSA keys of this size', run: (s, [bits]) => `${keyName(s)}\n\n${generateKeys(s, Number(bits))}` },
  { syntax: 'crypto key generate rsa general-keys modulus <bits>', modes: ['config'], help: 'Generate RSA keys of this size', run: (s, [bits]) => `${keyName(s)}\n\n${generateKeys(s, Number(bits))}` },
  { syntax: 'crypto key zeroize rsa', modes: ['config'], help: 'Delete the RSA keys (turns off SSH)', run: (s) => {
    const d = requireIos(s);
    if (!d.mgmt.sshEnabled) return '% No Signature RSA Keys found in configuration.';
    d.mgmt.rsaModulus = undefined;
    d.log.push(`%SSH-5-DISABLED: SSH ${d.mgmt.sshVersionLabel} has been disabled`);
  } },
  { syntax: 'ip ssh version <n>', modes: ['config'], help: '1 | 2', run: (s, [n]) => {
    const mgmt = requireIos(s).mgmt;
    const v = int(n, 1, 2) as 1 | 2;
    if (v === 2 && (mgmt.rsaModulus ?? 0) < 768) throw new Error('Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
    mgmt.sshVersion = v;
  } },
  { syntax: 'no ip ssh version', modes: ['config'], help: 'Accept both SSH versions (1.99)', run: (s) => void (requireIos(s).mgmt.sshVersion = undefined) },
  { syntax: 'show ip ssh', modes: EXEC, help: 'SSH server state and version', run: (s) => showIpSsh(s) },
  { syntax: 'ssh <args...>', modes: EXEC, help: '-l <user> <ip>: open an SSH session', run: (s, [rest]) => {
    const { user, host } = parseSsh(rest!.split(/\s+/));
    if (!host || !isValidIp(host)) throw new Error(INVALID);
    if (!user) throw new Error('No user specified');
    const d = requireIp(s);
    const r = d.connect(host, 22);
    d.network?.run();
    if (r.status === 'open') return beginLogin(s.io, d, host, 'ssh', user, (dev, prio) => s.spawn(dev, prio));
    if (r.status === 'refused') return '% Connection refused by remote host';
    if (r.status === 'timeout') return '% Connection timed out; remote host not responding';
    return '% Destination unreachable; gateway or host down';
  } },

  // Log timestamps
  { syntax: 'service timestamps log <args...>', modes: ['config'], help: 'uptime | datetime [msec] [localtime] [show-timezone]', run: (s, [rest]) => {
    const w = rest!.split(/\s+/);
    const d = requireIos(s);
    if (abbrev(w[0], 'uptime') && w.length === 1) return void (d.logTimestamps = { kind: 'uptime', msec: false, localtime: false, showTimezone: false });
    if (!abbrev(w[0], 'datetime')) throw new Error(INVALID);
    const flags = w.slice(1);
    const known = ['msec', 'localtime', 'show-timezone'];
    if (flags.some((f) => !known.some((k) => abbrev(f, k)))) throw new Error(INVALID);
    const has = (k: string) => flags.some((f) => abbrev(f, k));
    d.logTimestamps = { kind: 'datetime', msec: has('msec'), localtime: has('localtime'), showTimezone: has('show-timezone') };
  } },
  { syntax: 'no service timestamps log', modes: ['config'], help: 'Log messages without timestamps', run: (s) => void (requireIos(s).logTimestamps = undefined) },

  // Clock and NTP
  { syntax: 'clock set <time> <day> <month> <year>', modes: ['privileged'], help: 'hh:mm:ss day month year (local time)', run: (s, [t, a, b, y]) => {
    const ntp = requireIos(s).ntp;
    ntp.set(parseClockSet(t!, a!, b!, y!, ntp.timezone));
  } },
  { syntax: 'clock timezone <name> <hours>', modes: ['config'], help: 'Time zone name and offset from UTC', run: (s, [name, h]) => void (requireIos(s).ntp.timezone = { name: name!, hours: int(h, -23, 23), minutes: 0 }) },
  { syntax: 'clock timezone <name> <hours> <minutes>', modes: ['config'], help: 'Time zone name and offset from UTC', run: (s, [name, h, m]) => void (requireIos(s).ntp.timezone = { name: name!, hours: int(h, -23, 23), minutes: int(m, 0, 59) }) },
  { syntax: 'no clock timezone', modes: ['config'], help: 'Back to UTC', run: (s) => void (requireIos(s).ntp.timezone = { name: 'UTC', hours: 0, minutes: 0 }) },
  { syntax: 'ntp server <ip>', modes: ['config'], help: 'Synchronize the clock from this server', run: (s, [server]) => {
    const ntp = requireIos(s).ntp;
    if (!ntp.servers.includes(ip(server))) ntp.servers.push(server!);
  } },
  { syntax: 'no ntp server <ip>', modes: ['config'], help: 'Stop using this server', run: (s, [server]) => {
    const ntp = requireIos(s).ntp;
    const k = ntp.servers.indexOf(server!);
    if (k >= 0) ntp.servers.splice(k, 1);
    if (ntp.sync?.server === server) ntp.sync = undefined;
  } },
  { syntax: 'ntp master', modes: ['config'], help: 'Serve this clock as the reference (stratum 8)', run: (s) => void (requireIos(s).ntp.master = 8) },
  { syntax: 'ntp master <stratum>', modes: ['config'], help: 'Serve this clock as the reference at this stratum', run: (s, [n]) => void (requireIos(s).ntp.master = int(n, 1, 15)) },
  { syntax: 'no ntp master', modes: ['config'], help: 'Stop being an NTP master', run: (s) => void (requireIos(s).ntp.master = undefined) },
  { syntax: 'show clock', modes: EXEC, help: 'The time on this device', run: (s) => requireIos(s).ntp.showClock() },
  { syntax: 'show clock detail', modes: EXEC, help: 'The time and where it came from', run: (s) => requireIos(s).ntp.showClock(true) },
  { syntax: 'show ntp status', modes: EXEC, help: 'NTP synchronization and stratum', run: (s) => requireIos(s).ntp.showStatus() },
  { syntax: 'show ntp associations', modes: EXEC, help: 'NTP servers and their state', run: (s) => requireIos(s).ntp.showAssociations() },
];
