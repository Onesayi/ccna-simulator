/**
 * Device access: local users, enable passwords, the console and VTY lines, and the SSH server
 * (RSA keys and version). Telnet and SSH listen on the VTY lines according to `transport input`.
 */

export type Transport = 'ssh' | 'telnet';

export interface LineConfig {
  /** `login` checks the line password, `login local` the local user database, `no login` nothing. */
  login: 'none' | 'line' | 'local';
  password?: string;
  /** `transport input`: what may connect to the line. Ignored on the console. */
  transport: Set<Transport>;
  execTimeout?: [number, number];
  loggingSynchronous?: boolean;
  /** `login authentication <list>`: an AAA method list instead of the default one. */
  authList?: string;
  /** `authorization exec <list>`. */
  authorList?: string;
}

export interface LocalUser {
  name: string;
  privilege: number;
  password: string;
  /** `secret` (hashed, type 5) rather than `password` (clear text, or type 7 with password encryption). */
  secret: boolean;
}

export type LoginResult = { ok: true; privilege: number } | { ok: false; reason: string };

export class Management {
  domainName?: string;
  /** Set by `crypto key generate rsa`: the SSH server runs while keys exist. */
  rsaModulus?: number;
  /** `ip ssh version 2`; unset means 1.99 (both versions). */
  sshVersion?: 1 | 2;
  readonly users = new Map<string, LocalUser>();
  enableSecret?: string;
  enablePassword?: string;
  passwordEncryption = false;
  readonly console: LineConfig = { login: 'none', transport: new Set() };
  /** IOS defaults: `login` with no password (so telnet is refused a session), and both transports. */
  readonly vty: LineConfig = { login: 'line', transport: new Set(['telnet', 'ssh']) };
  /** The highest VTY line number configured (`line vty 0 4` or `line vty 0 15`). */
  vtyLast = 4;

  get sshEnabled(): boolean {
    return this.rsaModulus !== undefined;
  }

  /** The version `show ip ssh` reports. */
  get sshVersionLabel(): string {
    return this.sshVersion === 2 ? '2.0' : this.sshVersion === 1 ? '1.5' : '1.99';
  }

  /** TCP ports with a listener: 22 while SSH runs, 23 for telnet, each only if the VTY lines accept it. */
  listeningPorts(): number[] {
    const out: number[] = [];
    if (this.sshEnabled && this.vty.transport.has('ssh')) out.push(22);
    if (this.vty.transport.has('telnet')) out.push(23);
    return out;
  }

  /** What a VTY login asks for, in order. Empty means the session opens straight away. */
  prompts(protocol: Transport): ('username' | 'password')[] {
    if (protocol === 'ssh') return ['password'];
    if (this.vty.login === 'local') return ['username', 'password'];
    if (this.vty.login === 'line') return ['password'];
    return [];
  }

  /**
   * Checks VTY credentials. SSH always authenticates a user, so it needs `login local`; telnet
   * follows the line's `login` setting.
   */
  authenticate(protocol: Transport, username: string | undefined, password: string | undefined): LoginResult {
    const local = (): LoginResult => {
      const u = username ? this.users.get(username) : undefined;
      return u && u.password === password ? { ok: true, privilege: u.privilege } : { ok: false, reason: protocol === 'ssh' ? '% Authentication failed.' : '% Login invalid' };
    };
    if (protocol === 'ssh') {
      if (this.vty.login !== 'local') return { ok: false, reason: '% Authentication failed.' };
      return local();
    }
    if (this.vty.login === 'none') return { ok: true, privilege: 1 };
    if (this.vty.login === 'local') return local();
    if (this.vty.password === undefined) return { ok: false, reason: 'Password required, but none set' };
    return this.vty.password === password ? { ok: true, privilege: 1 } : { ok: false, reason: '% Login invalid' };
  }

  /** Checks a console login without AAA: the line password, the local users, or nothing. */
  authenticateConsole(username: string | undefined, password: string | undefined): LoginResult {
    const c = this.console;
    if (c.login === 'local') {
      const u = username ? this.users.get(username) : undefined;
      return u && u.password === password ? { ok: true, privilege: u.privilege } : { ok: false, reason: '% Login invalid' };
    }
    if (c.login === 'line' && c.password !== undefined) return c.password === password ? { ok: true, privilege: 1 } : { ok: false, reason: '% Login invalid' };
    return { ok: true, privilege: 1 };
  }

  /** The password `enable` asks for, if any: the secret wins over the plain password. */
  get enableRequired(): string | undefined {
    return this.enableSecret ?? this.enablePassword;
  }

  /** Running-config lines for the global part (before the interfaces). */
  globalConfig(): string[] {
    const out: string[] = [];
    if (this.passwordEncryption) out.push('service password-encryption');
    if (this.enableSecret !== undefined) out.push(`enable secret 5 ${md5Crypt(this.enableSecret)}`);
    if (this.enablePassword !== undefined) out.push(`enable password ${this.shown(this.enablePassword)}`);
    for (const u of this.users.values()) {
      const prio = u.privilege !== 1 ? ` privilege ${u.privilege}` : '';
      out.push(`username ${u.name}${prio} ${u.secret ? `secret 5 ${md5Crypt(u.password)}` : `password ${this.shown(u.password)}`}`);
    }
    if (this.domainName) out.push(`ip domain-name ${this.domainName}`);
    if (this.sshVersion) out.push(`ip ssh version ${this.sshVersion}`);
    return out;
  }

  /** Running-config lines for `line con 0` and `line vty`. */
  lineConfig(): string[] {
    const block = (name: string, l: LineConfig, vty: boolean): string[] => {
      const out = [name];
      if (l.execTimeout) out.push(` exec-timeout ${l.execTimeout[0]} ${l.execTimeout[1]}`);
      if (l.password !== undefined) out.push(` password ${this.shown(l.password)}`);
      if (l.loggingSynchronous) out.push(' logging synchronous');
      if (l.login === 'line' && (vty || l.password !== undefined)) out.push(' login');
      if (l.login === 'local') out.push(' login local');
      if (l.authorList) out.push(` authorization exec ${l.authorList}`);
      if (l.authList) out.push(` login authentication ${l.authList}`);
      if (vty && !(l.transport.size === 2)) out.push(` transport input ${l.transport.size === 0 ? 'none' : [...l.transport].join(' ')}`);
      return out;
    };
    return [...block('line con 0', this.console, false), '!', ...block(`line vty 0 ${this.vtyLast}`, this.vty, true)];
  }

  /** How a clear-text password appears: as typed, or type 7 once `service password-encryption` is on. */
  private shown(pw: string): string {
    return this.passwordEncryption ? `7 ${type7(pw)}` : pw;
  }
}

const TYPE7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

/** Cisco type 7 "encryption": a XOR with a public key, reversible by anyone. */
export function type7(pw: string): string {
  const seed = pw.length % 16;
  let out = String(seed).padStart(2, '0');
  for (let i = 0; i < pw.length; i++) out += (pw.charCodeAt(i) ^ TYPE7_KEY.charCodeAt((seed + i) % TYPE7_KEY.length)).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

export function decodeType7(hex: string): string {
  const seed = Number(hex.slice(0, 2));
  let out = '';
  for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ TYPE7_KEY.charCodeAt((seed + (i - 2) / 2) % TYPE7_KEY.length));
  return out;
}

const CRYPT_CHARS = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Stands in for an MD5-crypt (type 5) hash: same shape (`$1$salt$hash`), one-way enough to show
 * that the secret is not stored as typed. It is not real MD5.
 */
export function md5Crypt(pw: string): string {
  let h = 0x811c9dc5;
  const chars: string[] = [];
  for (let round = 0; round < 22; round++) {
    for (let i = 0; i < pw.length; i++) h = Math.imul(h ^ pw.charCodeAt(i) ^ round, 0x01000193) >>> 0;
    chars.push(CRYPT_CHARS[h % 64]!);
  }
  return `$1$mERr$${chars.join('')}`;
}
