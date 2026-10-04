import type { Device } from '../devices/device';
import { IosDevice } from '../devices/ios-device';
import type { IpDevice } from '../devices/ip-device';
import type { Transport } from '../services/management';

/** Anything a terminal can drive: the IOS CLI, the PC command prompt, or a login prompt. */
export interface Shell {
  readonly prompt: string;
  /** True while the shell waits for a password, so the terminal does not echo keystrokes. */
  readonly masked?: boolean;
  /** True when `?` shows help at once (an IOS prompt, not a login prompt or a PC). */
  readonly instantHelp?: boolean;
  /** Set when a remote session ends with `exit`, so the shell that opened it takes over again. */
  readonly closed?: boolean;
  execute(line: string): string;
}

/** A question the shell is waiting on, such as `Password:`. The next line typed is the answer. */
export interface Pending {
  prompt: string;
  masked?: boolean;
  /** Keep leading spaces (lines of a file being typed in). */
  raw?: boolean;
  answer(line: string): string;
}

/** Opens the CLI of the device logged into, at user EXEC or (privilege 15) privileged EXEC. */
export type OpenSession = (device: IosDevice, privilege: number) => Shell;

/**
 * What a shell is in the middle of: a question it asked, or a telnet/SSH session it opened. While
 * either is active, every line typed goes here instead of to the shell itself.
 */
export class Interaction {
  pending?: Pending;
  /** A telnet or SSH session; `onClose` runs when it ends (AAA accounting stop). */
  remote?: { shell: Shell; host: string; onClose?: () => void };

  get active(): boolean {
    return this.pending !== undefined || this.remote !== undefined;
  }

  get prompt(): string | undefined {
    return this.remote ? this.remote.shell.prompt : this.pending?.prompt;
  }

  get masked(): boolean {
    return this.remote ? Boolean(this.remote.shell.masked) : Boolean(this.pending?.masked);
  }

  get instantHelp(): boolean {
    return this.remote ? Boolean(this.remote.shell.instantHelp) : !this.pending;
  }

  ask(prompt: string, answer: (line: string) => string, masked = false, raw = false): void {
    this.pending = { prompt, masked, raw, answer };
  }

  execute(line: string): string {
    if (this.remote) {
      const { shell, host } = this.remote;
      const out = shell.execute(line);
      if (!shell.closed) return out;
      this.remote.onClose?.();
      this.remote = undefined;
      return [out, `\n[Connection to ${host} closed by foreign host]`].filter(Boolean).join('\n');
    }
    const p = this.pending!;
    this.pending = undefined;
    return p.answer(p.raw ? line.replace(/\r$/, '') : line.trim());
  }
}

/** The router or switch that owns `ip`, if any. */
export function deviceAt(from: Device, ip: string): IosDevice | undefined {
  return [...(from.network?.devices.values() ?? [])].find((d): d is IosDevice => d instanceof IosDevice && d.ownsIp(ip));
}

/**
 * The login after a telnet or SSH connection opened: asks for a username and password as the far
 * end's VTY lines demand, then hands every further line to a session on that device. Returns the
 * text to print now; the prompts follow through `io`.
 */
export function beginLogin(io: Interaction, from: IpDevice, host: string, protocol: Transport, username: string | undefined, open: OpenSession): string {
  // Telnet prints the login exchange a couple of lines below "Open"; SSH goes straight to the prompt.
  const lead = protocol === 'telnet' ? '\n\n' : '';
  const target = deviceAt(from, host);
  const closed = `\n[Connection to ${host} closed by foreign host]`;
  if (!target) return `${lead}${closed.trimStart()}`;
  const mgmt = target.mgmt;
  const finish = (user: string | undefined, password: string | undefined): string => {
    const result = target.login('vty', protocol, user, password);
    if (!result.ok) return `${result.reason}\n${closed}`;
    const onClose = target.aaa.newModel ? () => target.aaa.account('stop', user) : undefined;
    io.remote = { shell: open(target, result.privilege), host, onClose };
    return '';
  };
  const steps = target.loginPrompts('vty', protocol);
  const lineOnly = !target.aaa.newModel && mgmt.vty.login === 'line';
  if (protocol === 'telnet' && lineOnly && mgmt.vty.password === undefined) return `${lead}Password required, but none set\n${closed}`;
  const askPassword = (user: string | undefined) => io.ask('Password: ', (pw) => finish(user, pw), true);
  if (!steps.length) return `${lead}${finish(username, undefined)}`;
  if (steps[0] === 'username') {
    io.ask('Username: ', (user) => {
      askPassword(user);
      return '';
    });
  } else askPassword(username);
  return protocol === 'telnet' ? `${lead}User Access Verification\n` : '';
}

/** Parses `ssh -l <user> [-v 2] <ip>`. */
export function parseSsh(args: string[]): { user?: string; host?: string } {
  let user: string | undefined;
  let host: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '-l') user = args[++k];
    else if (a === '-v' || a === '-p' || a === '-c' || a === '-m') k++;
    else host = a;
  }
  return { user, host };
}
