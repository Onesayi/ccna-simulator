import type { IosDevice } from '../devices/ios-device';
import type { TransferProtocol, TransferResult } from '../devices/ip-device';
import { EXEC, INVALID, abbrev, requireIos, type Command, type Session } from './common';
import { runningConfig } from './show';

/**
 * Files on IOS: the startup config, flash, and `copy` to and from TFTP, FTP, SCP and SFTP
 * servers. A copy into the running config merges the file line by line, as IOS does.
 */

type Location =
  | { kind: 'running' | 'startup' }
  | { kind: 'flash'; file?: string }
  | { kind: 'remote'; protocol: TransferProtocol; host?: string; file?: string; username?: string; password?: string };

/** A question `copy` asks; an empty answer takes the default shown in brackets. */
interface Question {
  prompt: string;
  def?: string;
  masked?: boolean;
}

/** The IOS image every device boots, as `dir flash:` lists it: name, size, and flash size. */
function image(d: IosDevice): { name: string; size: number; total: number } {
  return d.kind === 'switch'
    ? { name: 'c2960-lanbasek9-mz.150-2.SE4.bin', size: 4670455, total: 64016384 }
    : { name: 'c2900-universalk9-mz.SPA.157-3.M3.bin', size: 33591768, total: 255744000 };
}

function parseLocation(word: string): Location {
  const w = word.toLowerCase();
  if (w === 'system:running-config' || (w.length >= 3 && abbrev(w, 'running-config'))) return { kind: 'running' };
  if (w === 'nvram:startup-config' || (w.length >= 3 && abbrev(w, 'startup-config'))) return { kind: 'startup' };
  const flash = /^flash\d?:\/?(.*)$/i.exec(word);
  if (flash) return { kind: 'flash', file: flash[1] || undefined };
  const remote = /^(tftp|ftp|scp|sftp)(?::(.*))?$/i.exec(word);
  if (!remote) throw new Error(INVALID);
  const protocol = remote[1]!.toLowerCase() as TransferProtocol;
  const rest = remote[2] ?? '';
  if (!rest) return { kind: 'remote', protocol };
  // tftp://host/file, ftp://user:password@host/file, scp://user@host/file
  const url = /^\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)(?:\/(.*))?$/.exec(rest);
  if (!url) throw new Error(INVALID);
  return { kind: 'remote', protocol, username: url[1], password: url[2], host: url[3], file: url[4] || undefined };
}

/** The configuration as it is saved to a file: no "Building configuration..." banner. */
function configFile(d: IosDevice): string {
  const text = runningConfig(d);
  return `${text.slice(text.indexOf('!'))}\n`;
}

/** Applies a configuration file line by line in global configuration mode, as `copy ... running-config` does. */
function merge(s: Session, d: IosDevice, text: string): string[] {
  const shell = s.spawn(d, 15);
  shell.execute('configure terminal');
  const errors: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t === 'end' || t.startsWith('version ')) continue;
    const out = shell.execute(line);
    if (out.startsWith('%')) errors.push(out);
  }
  return errors;
}

/** Asks each question in turn; an empty answer takes the default in brackets. */
function askAll(s: Session, questions: Question[], done: (answers: string[]) => string): void {
  const answers: string[] = [];
  const next = (): void => {
    const q = questions[answers.length];
    if (!q) return;
    const prompt = q.masked ? 'Password: ' : `${q.prompt} [${q.def ?? ''}]? `;
    s.io.ask(prompt, (line) => {
      answers.push(line || q.def || '');
      if (answers.length < questions.length) {
        next();
        return '';
      }
      return done(answers);
    }, q.masked);
  };
  next();
}

function copied(bytes: number): string {
  return `${bytes} bytes copied in 0.040 secs (${Math.round(bytes / 0.04)} bytes/sec)`;
}

function url(protocol: TransferProtocol, host: string, file: string, username?: string): string {
  return `${protocol}://${protocol === 'scp' || protocol === 'sftp' ? `${username}@` : ''}${host}/${file}`;
}

const FAILURES: Record<Exclude<TransferResult['status'], 'ok'>, (p: TransferProtocol) => string> = {
  timeout: () => 'Timed out',
  'no-route': () => 'No route to host',
  refused: () => 'Connection refused by remote host',
  'not-found': () => 'No such file or directory',
  'login-failed': (p) => (p === 'ftp' ? 'Incorrect Login/Password' : 'Authentication failed'),
};

/** The contents of a local source, or an error. */
function readLocal(d: IosDevice, src: Location): { data: string; name?: string } | string {
  if (src.kind === 'running') return { data: configFile(d) };
  if (src.kind === 'startup') return d.startupConfig === undefined ? '%Error opening nvram:/startup-config (No such file or directory)' : { data: d.startupConfig };
  if (src.kind !== 'flash' || !src.file) return `%Error opening flash:/ (Is a directory)`;
  if (src.file === image(d).name) return { data: `<IOS image ${src.file}>`, name: src.file };
  const data = d.flash.get(src.file);
  return data === undefined ? `%Error opening flash:/${src.file} (No such file or directory)` : { data, name: src.file };
}

/** Saves `data` to a local destination; the text IOS prints afterwards. */
function writeLocal(s: Session, d: IosDevice, dst: Location, file: string, data: string, from: string): string {
  if (dst.kind === 'running') {
    const errors = merge(s, d, data);
    d.log.push(`%SYS-5-CONFIG_I: Configured from ${from} by console`);
    return errors.join('\n');
  }
  if (dst.kind === 'startup') d.startupConfig = data;
  else d.flash.set(file, data);
  return '';
}

function defaultConfigName(d: IosDevice): string {
  return `${d.hostname.toLowerCase()}-confg`;
}

/** `copy <source> <destination>`. */
function copy(s: Session, srcWord: string, dstWord: string): string {
  const d = requireIos(s);
  const src = parseLocation(srcWord);
  const dst = parseLocation(dstWord);
  if (src.kind === 'remote' && dst.kind === 'remote') throw new Error(INVALID);

  if (src.kind !== 'remote' && dst.kind !== 'remote') {
    const local = readLocal(d, src);
    if (typeof local === 'string') return local;
    const def = dst.kind === 'flash' ? (dst.file ?? local.name ?? defaultConfigName(d)) : dst.kind === 'running' ? 'running-config' : 'startup-config';
    askAll(s, [{ prompt: 'Destination filename', def }], ([file]) => {
      if (src.kind === 'running' && dst.kind === 'startup') {
        d.startupConfig = local.data;
        return 'Building configuration...\n[OK]';
      }
      const out = writeLocal(s, d, dst, file!, local.data, srcWord);
      return [copied(local.data.length), out].filter(Boolean).join('\n');
    });
    return '';
  }

  const secure = (p: TransferProtocol) => p === 'scp' || p === 'sftp';
  if (dst.kind === 'remote') {
    // Upload: a local file to the server.
    const local = readLocal(d, src);
    if (typeof local === 'string') return local;
    const questions: Question[] = [{ prompt: 'Address or name of remote host', def: dst.host }];
    if (secure(dst.protocol)) questions.push({ prompt: 'Destination username', def: dst.username ?? d.hostname });
    questions.push({ prompt: 'Destination filename', def: dst.file ?? local.name ?? defaultConfigName(d) });
    if (secure(dst.protocol) && dst.password === undefined) questions.push({ prompt: 'Password', masked: true });
    askAll(s, questions, (answers) => {
      const host = answers[0]!;
      const username = secure(dst.protocol) ? answers[1] : (dst.username ?? d.ftpLogin.username ?? 'anonymous');
      const file = answers[secure(dst.protocol) ? 2 : 1]!;
      const password = secure(dst.protocol) ? (dst.password ?? answers[3]) : (dst.password ?? d.ftpLogin.password);
      if (!host || !file) return '%Error parsing filename (Bad file name)';
      const where = url(dst.protocol, host, file, username);
      const r = d.transfer(host, { protocol: dst.protocol, op: 'put', file, data: local.data, username, password });
      if (r.status !== 'ok') return `%Error opening ${where} (${FAILURES[r.status](dst.protocol)})`;
      const progress = dst.protocol === 'tftp' ? '!!' : `Writing ${file} !`;
      return `${progress}\n${copied(local.data.length)}`;
    });
    return '';
  }

  // Download: a file from the server into running-config, startup-config or flash.
  if (src.kind !== 'remote') throw new Error(INVALID);
  const questions: Question[] = [{ prompt: 'Address or name of remote host', def: src.host }];
  if (secure(src.protocol)) questions.push({ prompt: 'Source username', def: src.username ?? d.hostname });
  questions.push({ prompt: 'Source filename', def: src.file });
  questions.push({ prompt: 'Destination filename', def: dst.kind === 'flash' ? (dst.file ?? src.file) : dst.kind === 'running' ? 'running-config' : 'startup-config' });
  if (secure(src.protocol) && src.password === undefined) questions.push({ prompt: 'Password', masked: true });
  askAll(s, questions, (answers) => {
    const off = secure(src.protocol) ? 1 : 0;
    const host = answers[0]!;
    const username = secure(src.protocol) ? answers[1] : (src.username ?? d.ftpLogin.username ?? 'anonymous');
    const file = answers[1 + off]!;
    const target = answers[2 + off] || file;
    const password = secure(src.protocol) ? (src.password ?? answers[3 + off]) : (src.password ?? d.ftpLogin.password);
    if (!host || !file) return '%Error parsing filename (Bad file name)';
    const where = url(src.protocol, host, file, username);
    const r = d.transfer(host, { protocol: src.protocol, op: 'get', file, username, password });
    if (r.status !== 'ok') return `%Error opening ${where} (${FAILURES[r.status](src.protocol)})`;
    const data = r.data ?? '';
    const via = d.lookup(host)?.iface.name;
    const out = writeLocal(s, d, dst, target, data, where);
    return [`Accessing ${where}...`, `Loading ${file} from ${host} (via ${via}): !`, `[OK - ${data.length} bytes]`, '', copied(data.length), out].filter((l, k) => l || k === 3).join('\n');
  });
  return '';
}

function dir(d: IosDevice): string {
  const img = image(d);
  const files = [[img.name, img.size] as const, ...[...d.flash].map(([n, data]) => [n, data.length] as const)];
  const used = files.reduce((sum, [, size]) => sum + size, 0);
  return [
    'Directory of flash:/',
    '',
    ...files.map(([name, size], k) => `${String(k + 1).padStart(5)}  -rw-  ${String(size).padStart(10)}  <no date>  ${name}`),
    '',
    `${img.total} bytes total (${img.total - used} bytes free)`,
  ].join('\n');
}

function flashFile(word: string | undefined): string {
  const m = /^flash\d?:\/?(.+)$/i.exec(word ?? '');
  if (!m) throw new Error(INVALID);
  return m[1]!;
}

export const FILE_COMMANDS: Command[] = [
  { syntax: 'copy <source> <destination>', modes: ['privileged'], help: 'running-config | startup-config | flash:[file] | tftp: | ftp: | scp: | sftp:  (URLs such as tftp://10.0.0.100/r1-confg work too)', run: (s, [src, dst]) => copy(s, src!, dst!) },
  { syntax: 'write memory', modes: ['privileged'], help: 'Save the configuration', run: (s) => {
    const d = requireIos(s);
    d.startupConfig = configFile(d);
    return 'Building configuration...\n[OK]';
  } },
  { syntax: 'write erase', modes: ['privileged'], help: 'Erase the startup configuration', run: (s) => void (requireIos(s).startupConfig = undefined) },
  { syntax: 'erase startup-config', modes: ['privileged'], help: 'Erase the startup configuration', run: (s) => {
    requireIos(s).startupConfig = undefined;
    return 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete';
  } },
  { syntax: 'show startup-config', modes: ['privileged'], help: 'The saved configuration', run: (s) => {
    const saved = requireIos(s).startupConfig;
    return saved === undefined ? 'startup-config is not present' : `Using ${saved.length} out of 262136 bytes\n${saved.trimEnd()}`;
  } },
  { syntax: 'dir', modes: EXEC, help: 'Files in flash', run: (s) => dir(requireIos(s)) },
  { syntax: 'dir <filesystem>', modes: EXEC, help: 'flash:', run: (s, [fs]) => {
    if (!/^flash\d?:\/?$/i.test(fs!)) throw new Error(INVALID);
    return dir(requireIos(s));
  } },
  { syntax: 'show flash:', modes: EXEC, help: 'Files in flash', run: (s) => dir(requireIos(s)) },
  { syntax: 'show flash', modes: EXEC, help: 'Files in flash', run: (s) => dir(requireIos(s)) },
  { syntax: 'more <file>', modes: ['privileged'], help: 'flash:<file>: show a file', run: (s, [file]) => {
    const d = requireIos(s);
    const name = flashFile(file);
    const data = d.flash.get(name);
    if (data === undefined) return `%Error opening flash:${name} (No such file or directory)`;
    return data.trimEnd();
  } },
  { syntax: 'delete <file>', modes: ['privileged'], help: 'flash:<file>: delete a file', run: (s, [file]) => {
    const d = requireIos(s);
    const name = flashFile(file);
    if (name === image(d).name) return `%Error deleting flash:${name} (Permission denied)`;
    if (!d.flash.delete(name)) return `%Error deleting flash:${name} (No such file or directory)`;
  } },

  // FTP client login for copy
  { syntax: 'ip ftp username <name>', modes: ['config'], help: 'User name for FTP copies', run: (s, [name]) => void (requireIos(s).ftpLogin.username = name) },
  { syntax: 'ip ftp password <password>', modes: ['config'], help: 'Password for FTP copies', run: (s, [pw]) => void (requireIos(s).ftpLogin.password = pw) },
  { syntax: 'no ip ftp username', modes: ['config'], help: 'Use anonymous FTP', run: (s) => void (requireIos(s).ftpLogin.username = undefined) },
  { syntax: 'no ip ftp password', modes: ['config'], help: 'Remove the FTP password', run: (s) => void (requireIos(s).ftpLogin.password = undefined) },
];
