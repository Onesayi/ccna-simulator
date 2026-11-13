import { isValidIp } from '../core/addressing';
import type { SnmpMessage, SnmpVarbind } from '../core/frames';
import type { IosDevice } from '../devices/ios-device';
import type { Server } from '../devices/server';
import { runPlaybook, type Connector, type NetworkConnection } from '../services/ansible';
import { CLIENT_HELLO, EOM, NETCONF_PORT, netconfMessage, rpc, serverHello, type NetconfSession } from '../services/netconf';
import { restconf } from '../services/restconf';
import { MIB2_ROOT, compareOid, formatVarbind, resolveOid, translateOid } from '../services/snmp';
import { PcShell } from './pc-shell';
import { configFile } from './commands-files';
import { deviceAt, type Shell } from './remote';
import { CliSession } from './session';
import { runningConfig } from './show';
import { canonicalName, checkZoneReport, parseZone } from '../services/dns';

const SERVER_HELP = `Server commands (the PC commands work too: ping, traceroute, ipconfig, ssh, telnet):
  snmpget -v 2c -c <community> <ip> <oid>...            Read objects (v1, v2c)
  snmpget -v 3 -l authPriv -u <user> -a SHA -A <pw> -x AES -X <pw> <ip> <oid>
  snmpwalk -v 2c -c <community> <ip> [oid]              Walk a subtree (default: mib-2)
  snmpset -v 2c -c <community> <ip> <oid> s|i|a <value>  Change an object (needs RW)
  cat /var/log/snmptrapd.log                            Traps received from devices
  aaa user add <name> <password> [privilege <0-15>]     AAA server: add a user
  aaa client add <ip> <shared-secret>                   AAA server: allow a network device
  aaa show | aaa log                                    AAA server: settings and live log
  curl -k -u <user>:<pw> https://<ip>/restconf/data/<path>   RESTCONF GET
  curl -k -u <user>:<pw> -X PATCH -d '<json>' https://<ip>/restconf/data/<path>
  netconf-console --host <ip> -u <user> -p <pw> --hello | --get-config [-x <xpath>]
                 | --get [-x <xpath>] | --edit-config <file.xml> | --copy-running-to-startup
  ssh <user>@<ip> -p 830 -s netconf                     Raw NETCONF session (end each message with ]]>]]>)
  ansible-playbook -i <inventory> <playbook.yml>        Run a playbook
  adduser <name> <password> | deluser <name>            File server account (opens FTP 21, SCP/SFTP 22)
  cat /var/log/xferlog                                  Files sent and received (TFTP is always on)
  ls | cat <file>                                       Files on the server
  cat > <file> <<EOF ... EOF                            Write a file (or use the Files tab); >> appends
  named-checkzone <zone> <file>                         DNS server: check a zone file (<zone>.zone or db.<zone>)
  rndc reload                                           DNS server: load every zone and report
  cat /var/log/named.log                                DNS queries answered`;

/** Splits a command line on spaces, keeping 'quoted strings' and "quoted strings" together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]?.replace(/\\"/g, '"') ?? m[3]!);
  return out;
}

interface SnmpOptions {
  version: '1' | '2c' | '3';
  community?: string;
  level: NonNullable<SnmpMessage['level']>;
  user?: string;
  authKey?: string;
  privKey?: string;
  numeric: boolean;
  rest: string[];
}

function snmpOptions(args: string[]): SnmpOptions | string {
  const o: SnmpOptions = { version: '3', level: 'noAuthNoPriv', numeric: false, rest: [] };
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const val = () => args[++k];
    if (a === '-v') {
      const v = val();
      if (v !== '1' && v !== '2c' && v !== '3') return `Invalid version specified after -v flag: ${v ?? ''}`;
      o.version = v;
    } else if (a === '-c') o.community = val();
    else if (a === '-l') {
      const l = (val() ?? '').toLowerCase();
      o.level = l === 'authpriv' ? 'authPriv' : l === 'authnopriv' ? 'authNoPriv' : 'noAuthNoPriv';
    } else if (a === '-u') o.user = val();
    else if (a === '-A') o.authKey = val();
    else if (a === '-X') o.privKey = val();
    else if (a === '-a' || a === '-x' || a === '-t' || a === '-r') val();
    else if (a === '-On') o.numeric = true;
    else o.rest.push(a);
  }
  if (o.version !== '3' && o.community === undefined) return 'No community name specified.';
  if (o.version === '3' && o.user === undefined) return 'No securityName specified.';
  if (o.version === '3' && o.level !== 'noAuthNoPriv' && o.authKey === undefined) return 'No authentication passphrase specified.';
  if (o.version === '3' && o.level === 'authPriv' && o.privKey === undefined) return 'No privacy passphrase specified.';
  return o;
}

const ERRORS: Record<string, string> = {
  noSuchName: '(noSuchName) There is no such variable name in this MIB.',
  noAccess: 'noAccess',
  notWritable: 'notWritable (That object does not support modification)',
  wrongValue: 'wrongValue (The set value is illegal or unsupported in some way)',
  badValue: '(badValue) The value given has the wrong type or length.',
};

const REPORTS: Record<string, string> = {
  unknownUserName: 'Unknown user name',
  wrongDigest: 'Authentication failure (incorrect password, community or key)',
  unsupportedSecLevel: 'Unsupported security level',
};

/** The Linux prompt of a server: SNMP tools, an AAA server, RESTCONF over curl, NETCONF, and Ansible. */
export class ServerShell extends PcShell {
  constructor(readonly server: Server) {
    super(server);
  }

  override get prompt(): string {
    return this.io.prompt ?? `root@${this.server.hostname}:~# `;
  }

  protected override run(line: string): string {
    const heredoc = /^cat\s*(>>?)\s*(\S+)(?:\s*<<\s*['"]?(\w+)['"]?)?\s*$/.exec(line.trim());
    if (heredoc) return this.writeFile(heredoc[2]!, heredoc[3] ?? 'EOF', heredoc[1] === '>>');
    const args = splitArgs(line.trim());
    const [cmd = '', ...rest] = args;
    switch (cmd) {
      case 'help':
      case '?':
        return SERVER_HELP;
      case 'snmpget':
      case 'snmpgetnext':
      case 'snmpwalk':
      case 'snmpbulkwalk':
      case 'snmpset':
        return this.snmp(cmd, rest);
      case 'aaa':
        return this.aaa(rest);
      case 'adduser':
      case 'useradd': {
        const [name, password] = rest;
        if (!name || !password) return `usage: ${cmd} <name> <password>`;
        this.server.fileUsers.set(name, password);
        return `User ${name} added. FTP (21) and SSH/SCP/SFTP (22) are open.`;
      }
      case 'deluser':
      case 'userdel':
        return this.server.fileUsers.delete(rest[0] ?? '') ? `User ${rest[0]} removed.` : `${cmd}: user '${rest[0] ?? ''}' does not exist`;
      case 'ls':
        return [...this.server.files.keys()].sort().join('  ');
      case 'cat':
        return this.cat(rest[0]);
      case 'named-checkzone':
        return this.checkZone(rest);
      case 'rndc':
        return this.rndc(rest);
      case 'ansible-playbook':
        return this.playbook(rest);
      case 'curl':
        return this.curl(rest);
      case 'netconf-console':
      case 'netconf-console2':
        return this.netconfConsole(rest);
      case 'ssh':
        return isNetconfSsh(rest) ? this.netconfSsh(rest) : super.run(line);
      case 'nano':
      case 'vi':
      case 'vim':
        return `${cmd}: edit files in the Files tab of this server's panel, then run them from here.`;
      default:
        return super.run(line);
    }
  }

  // ---------------------------------------------------------------- files

  /** `cat > file <<EOF`: the lines that follow, up to the terminator, become the file. */
  private writeFile(path: string, end: string, append = false): string {
    const name = path.replace(/^(\/root\/|\.\/)/, '');
    const lines: string[] = [];
    const next = (line: string): string => {
      if (line.trim() === end) {
        const before = append ? (this.server.files.get(name) ?? '') : '';
        this.server.files.set(name, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
        return '';
      }
      lines.push(line);
      this.io.ask('> ', next, false, true);
      return '';
    };
    this.io.ask('> ', next, false, true);
    return '';
  }

  /** `named-checkzone ccna.lab ccna.lab.zone`: parses the file as that zone, as BIND would load it. */
  private checkZone(args: string[]): string {
    const [zone, path] = args;
    if (!zone || !path) return 'usage: named-checkzone <zonename> <filename>';
    const file = path.replace(/^(\/root\/|\.\/)/, '');
    const text = this.server.files.get(file);
    if (text === undefined) return `zone ${canonicalName(zone)}/IN: loading from master file ${path} failed: file not found\nzone ${canonicalName(zone)}/IN: not loaded due to errors.`;
    return checkZoneReport(parseZone(text, zone, file));
  }

  /** `rndc reload`: zones are read on every query, so this only reports what each one loads as. */
  private rndc(args: string[]): string {
    if (args[0] !== 'reload' && args[0] !== 'status') return 'rndc: unknown command; try rndc reload';
    const zones = this.server.dnsZones.zones;
    if (!zones.length) return 'rndc: no zone files (name them <zone>.zone or db.<zone>)';
    if (args[0] === 'status') return `number of zones: ${zones.length}\nserver is up and running`;
    const bad = zones.filter((z) => !z.loaded);
    if (!bad.length) return 'server reload successful';
    return ['rndc: \'reload\' failed: not loaded due to errors', ...bad.map((z) => `zone ${z.origin}/IN: ${z.problems.filter((p) => p.fatal).map((p) => p.message).join('; ')}`)].join('\n');
  }

  private cat(path: string | undefined): string {
    if (!path) return 'cat: missing operand';
    if (path === '/var/log/snmptrapd.log') return this.server.trapLog.join('\n');
    if (path === '/var/log/aaa.log') return this.server.aaa.log.join('\n');
    if (path === '/var/log/xferlog') return this.server.transferLog.join('\n');
    if (path === '/var/log/named.log') return this.server.queryLog.join('\n');
    const f = this.server.files.get(path.replace(/^(\/root\/|\.\/)/, ''));
    return f ?? `cat: ${path}: No such file or directory`;
  }

  // ---------------------------------------------------------------- SNMP manager

  private snmp(cmd: string, args: string[]): string {
    const o = snmpOptions(args);
    if (typeof o === 'string') return `${cmd}: ${o}`;
    const [agent, ...objects] = o.rest;
    if (!agent || !isValidIp(agent)) return `${cmd}: No hostname specified.`;
    const base: Omit<SnmpMessage, 'requestId' | 'pdu' | 'varbinds'> =
      o.version === '3' ? { version: '3', user: o.user, level: o.level, authKey: o.authKey, privKey: o.privKey } : { version: o.version, community: o.community };
    const show = (v: SnmpVarbind) => (o.numeric ? formatVarbind(v).replace(translateOid(v.oid), `.${v.oid}`) : formatVarbind(v));
    const ask = (pdu: SnmpMessage['pdu'], varbinds: SnmpVarbind[]): SnmpMessage | string => {
      const reply = this.server.snmpRequest(agent, { ...base, pdu, varbinds });
      if (!reply) return `Timeout: No Response from ${agent}.`;
      if (reply.pdu === 'report') return `${cmd}: ${REPORTS[reply.report ?? ''] ?? 'Unknown error'}`;
      if (reply.error && reply.error !== 'noError') {
        const failed = reply.varbinds[0];
        return `Error in packet.\nReason: ${ERRORS[reply.error] ?? reply.error}${failed ? `\nFailed object: ${translateOid(failed.oid)}` : ''}`;
      }
      return reply;
    };
    const oids: string[] = [];
    if (cmd === 'snmpset') {
      const binds: SnmpVarbind[] = [];
      for (let k = 0; k < objects.length; k += 3) {
        const oid = resolveOid(objects[k]!);
        const type = objects[k + 1];
        const value = objects[k + 2];
        if (!oid) return `${objects[k]}: Unknown Object Identifier (Sub-id not found: (top) -> ${objects[k]})`;
        if (value === undefined || !['i', 's', 'a'].includes(type ?? '')) return `${objects[k]}: Bad variable type ("${type ?? ''}")`;
        binds.push({ oid, type: type === 'i' ? 'INTEGER' : type === 'a' ? 'IpAddress' : 'STRING', value: type === 'i' ? Number(value) : value });
      }
      if (!binds.length) return `${cmd}: Missing object name`;
      const r = ask('set', binds);
      if (typeof r === 'string') return r;
      this.server.network?.converge();
      return r.varbinds.map(show).join('\n');
    }
    for (const name of objects) {
      const oid = resolveOid(name);
      if (!oid) return `${name}: Unknown Object Identifier (Sub-id not found: (top) -> ${name.replace(/\..*$/, '')})`;
      oids.push(oid);
    }
    if (cmd === 'snmpget' || cmd === 'snmpgetnext') {
      if (!oids.length) return `${cmd}: Missing object name`;
      const r = ask(cmd === 'snmpget' ? 'get' : 'getnext', oids.map((oid) => ({ oid })));
      return typeof r === 'string' ? r : r.varbinds.map(show).join('\n');
    }
    // snmpwalk: get-next until we leave the subtree.
    const root = oids[0] ?? MIB2_ROOT;
    const lines: string[] = [];
    let cursor = root;
    for (let n = 0; n < 1000; n++) {
      const r = ask('getnext', [{ oid: cursor }]);
      if (typeof r === 'string') return [...lines, r].join('\n');
      const v = r.varbinds[0]!;
      if (v.type === 'endOfMibView' || !(v.oid === root || v.oid.startsWith(`${root}.`)) || compareOid(v.oid, cursor) <= 0) break;
      lines.push(show(v));
      cursor = v.oid;
    }
    if (!lines.length) {
      const r = ask('get', [{ oid: root }]);
      if (typeof r === 'string') return r;
      return show(r.varbinds[0]!);
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- AAA server administration

  private aaa(args: string[]): string {
    const svc = this.server.aaa;
    const [what, verb, ...rest] = args;
    if (what === 'user' && verb === 'add') {
      const [name, password, kw, level] = rest;
      if (!name || !password) return 'usage: aaa user add <name> <password> [privilege <0-15>]';
      const privilege = kw === 'privilege' ? Number(level) : 1;
      if (!Number.isInteger(privilege) || privilege < 0 || privilege > 15) return 'aaa: privilege must be 0 to 15';
      svc.users.set(name, { name, password, privilege });
      return `User ${name} added (privilege ${privilege}).`;
    }
    if (what === 'user' && (verb === 'del' || verb === 'delete')) return svc.users.delete(rest[0] ?? '') ? `User ${rest[0]} deleted.` : `aaa: no user ${rest[0] ?? ''}`;
    if (what === 'client' && verb === 'add') {
      const [address, key] = rest;
      if (!address || !isValidIp(address) || !key) return 'usage: aaa client add <ip> <shared-secret>';
      svc.clients.set(address, { address, key });
      return `Network device ${address} added.`;
    }
    if (what === 'client' && (verb === 'del' || verb === 'delete')) return svc.clients.delete(rest[0] ?? '') ? `Network device ${rest[0]} deleted.` : `aaa: no network device ${rest[0] ?? ''}`;
    if (what === 'log') return svc.log.join('\n') || '(no events yet)';
    if (what === 'show') {
      const lines = [`AAA service: ${this.server.aaaRunning ? 'running (RADIUS 1812/1813 and 1645/1646, TACACS+ 49)' : 'idle (no network devices yet)'}`, '', 'Network devices:'];
      for (const c of svc.clients.values()) lines.push(`  ${c.address.padEnd(16)} secret ${c.key}`);
      lines.push('', 'Users:');
      for (const u of svc.users.values()) lines.push(`  ${u.name.padEnd(16)} privilege ${u.privilege}`);
      return lines.join('\n');
    }
    return 'usage: aaa user add|delete ..., aaa client add|delete ..., aaa show, aaa log';
  }

  // ---------------------------------------------------------------- HTTP and RESTCONF

  protected override curl(args: string[]): string {
    let method = 'GET';
    let user: string | undefined;
    let data: string | undefined;
    let insecure = false;
    let include = false;
    let url: string | undefined;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === '-X' || a === '--request') method = (args[++k] ?? 'GET').toUpperCase();
      else if (a === '-u' || a === '--user') user = args[++k];
      else if (a === '-d' || a === '--data' || a === '--data-raw') data = args[++k];
      else if (a === '-H' || a === '--header') k++;
      else if (a === '-k' || a === '--insecure') insecure = true;
      else if (a === '-i' || a === '--include') include = true;
      else if (a === '-s' || a === '--silent' || a === '-v') continue;
      else url = a;
    }
    if (data !== undefined && method === 'GET') method = 'POST';
    const m = /^(https?):\/\/([\d.]+)(?::(\d+))?(\/.*)?$/i.exec(url ?? '');
    if (!m || !isValidIp(m[2]!)) return super.curl(args);
    const [, scheme, host, portText, path = '/'] = m;
    const target = deviceAt(this.server, host!);
    // Plain web servers (PCs) keep the simple behaviour.
    if (!target) return super.curl([url!]);
    const port = portText ? Number(portText) : scheme!.toLowerCase() === 'https' ? 443 : 80;
    const r = this.connect(host!, port);
    if (r.status === 'refused') return `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused`;
    if (r.status !== 'open') return `curl: (28) Failed to connect to ${host} port ${port} after 2000 ms: Timeout was reached`;
    if (scheme!.toLowerCase() === 'https' && !insecure) return 'curl: (60) SSL certificate problem: self-signed certificate\nMore details here: https://curl.se/docs/sslcerts.html\n\n(The device uses a self-signed certificate: add -k to accept it.)';
    const head = (status: number, reason: string) => (include ? `HTTP/1.1 ${status} ${reason}\nServer: nginx\nContent-Type: application/yang-data+json\n\n` : '');
    if (!path.startsWith('/restconf') || !target.http.restconf || port !== 443) return `${head(404, 'Not Found')}<html><body><h1>404 Not Found</h1></body></html>`;
    const [name, password] = (user ?? '').split(':');
    if (!this.restconfLogin(target, name, password)) return `${head(401, 'Unauthorized')}{\n  "ietf-restconf:errors": {\n    "error": [\n      {\n        "error-type": "protocol",\n        "error-tag": "access-denied"\n      }\n    ]\n  }\n}`;
    const res = restconf(target, method, path, data);
    this.server.network?.converge();
    return `${head(res.status, res.reason)}${res.body ?? ''}`.trimEnd();
  }

  /** RESTCONF needs a privilege 15 user: from AAA when it is on, otherwise the local database. */
  private restconfLogin(d: IosDevice, user: string | undefined, password: string | undefined): boolean {
    if (!user) return false;
    if (d.aaa.newModel) {
      const r = d.login('vty', 'ssh', user, password);
      return r.ok && r.privilege >= 15;
    }
    const u = d.mgmt.users.get(user);
    return u !== undefined && u.password === password && u.privilege >= 15;
  }

  // ---------------------------------------------------------------- NETCONF

  /**
   * Opens a NETCONF session: TCP 830, then the SSH login. IOS XE checks NETCONF logins through
   * AAA, so they fail without `aaa new-model`, and the session gets the privilege EXEC
   * authorization grants (every RPC is refused below 15).
   */
  private netconfOpen(host: string | undefined, port: number, user: string | undefined, password: string | undefined, tool: string): { target: IosDevice; session: NetconfSession } | string {
    const ssh = tool === 'ssh';
    if (!host || !isValidIp(host)) return ssh ? `ssh: Could not resolve hostname ${host ?? ''}: Name or service not known` : `${tool}: error: a valid --host is required`;
    const r = this.connect(host, port);
    const target = deviceAt(this.server, host);
    if (r.status === 'refused') return ssh ? `ssh: connect to host ${host} port ${port}: Connection refused` : `${tool}: [Errno 111] Connection refused`;
    if (r.status !== 'open' || !target) return ssh ? `ssh: connect to host ${host} port ${port}: Connection timed out` : `${tool}: timed out`;
    if (!user || !target.aaa.newModel) return ssh ? `${user ?? 'root'}@${host}: Permission denied (password).` : `${tool}: Authentication failed.`;
    const login = target.login('vty', 'ssh', user, password);
    if (!login.ok) return ssh ? `${user}@${host}: Permission denied (password).` : `${tool}: Authentication failed.`;
    const sourceIp = this.server.nic.ip?.address ?? '0.0.0.0';
    return { target, session: target.netconf.open(user, sourceIp, login.privilege) };
  }

  private send(target: IosDevice, session: NetconfSession, text: string) {
    return netconfMessage(target, session, text, { save: () => void (target.startupConfig = configFile(target)) });
  }

  /** netconf-console (tail-f / netconf-console2): one session per run, one RPC per operation flag. */
  private netconfConsole(args: string[]): string {
    const tool = 'netconf-console';
    let host: string | undefined;
    let port = NETCONF_PORT;
    let user = 'admin';
    let password = 'admin';
    let db = 'running';
    let xpath: string | undefined;
    const ops: { op: string; file?: string }[] = [];
    const flat = args.flatMap((a) => (/^--[\w-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
    for (let k = 0; k < flat.length; k++) {
      const a = flat[k]!;
      const val = () => flat[++k];
      if (a === '--host') host = val();
      else if (a === '--port') port = Number(val());
      else if (a === '-u' || a === '--user') user = val() ?? '';
      else if (a === '-p' || a === '--password') password = val() ?? '';
      else if (a === '--db') db = val() ?? 'running';
      else if (a === '-x' || a === '--xpath') xpath = val();
      else if (a === '--hello' || a === '--get' || a === '--get-config' || a === '--lock' || a === '--unlock' || a === '--copy-running-to-startup') ops.push({ op: a.slice(2) });
      else if (a === '--edit-config' || a === '--rpc') ops.push({ op: a.slice(2), file: val() });
      else return `${tool}: error: unrecognized argument ${a}`;
    }
    if (!ops.length) return 'usage: netconf-console --host <ip> [--port 830] -u <user> -p <password> --hello | --get [-x xpath] | --get-config [-x xpath] | --edit-config <file> | --copy-running-to-startup | --lock | --unlock | --rpc <file>';
    const bodies: string[] = [];
    const filter = xpath ? `<filter type="xpath" select="${xpath.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>` : '';
    for (const { op, file } of ops) {
      if (op === 'hello') bodies.push('');
      else if (op === 'get') bodies.push(`<get>${filter}</get>`);
      else if (op === 'get-config') bodies.push(`<get-config><source><${db}/></source>${filter}</get-config>`);
      else if (op === 'lock' || op === 'unlock') bodies.push(`<${op}><target><${db}/></target></${op}>`);
      else if (op === 'copy-running-to-startup') bodies.push('<copy-config><target><startup/></target><source><running/></source></copy-config>');
      else {
        if (!file) return `${tool}: error: argument --${op}: expected one argument`;
        const text = this.server.files.get(file.replace(/^(\/root\/|\.\/)/, ''));
        if (text === undefined) return `${tool}: [Errno 2] No such file or directory: '${file}'`;
        const xml = text.replace(/<\?xml[^>]*\?>/, '').trim();
        bodies.push(op === 'rpc' ? xml : `<edit-config><target><${db}/></target>${/^<([\w-]+:)?config[\s>]/.test(xml) ? xml : `<config>${xml}</config>`}</edit-config>`);
      }
    }
    const opened = this.netconfOpen(host, port, user, password, tool);
    if (typeof opened === 'string') return opened;
    const { target, session } = opened;
    const out: string[] = [];
    this.send(target, session, CLIENT_HELLO);
    let id = 0;
    for (const body of bodies) {
      if (!body) {
        out.push(serverHello(session));
        continue;
      }
      const r = this.send(target, session, rpc(++id, body));
      if (r.reply) out.push(r.reply);
      if (r.close) break;
    }
    if (!session.closed) target.netconf.close(session);
    this.server.network?.converge();
    return out.join('\n');
  }

  /** `ssh admin@10.0.0.1 -p 830 -s netconf`: a raw session where you type the XML yourself. */
  private netconfSsh(args: string[]): string {
    let user: string | undefined;
    let host: string | undefined;
    let port = 22;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === '-p') port = Number(args[++k]);
      else if (a === '-l') user = args[++k];
      else if (a === '-s' || a === '-T') continue;
      else if (a === 'netconf') continue;
      else if (a.includes('@')) [user, host] = a.split('@') as [string, string];
      else host = a;
    }
    if (port !== NETCONF_PORT) return `ssh: connect to host ${host ?? ''} port ${port}: the netconf subsystem runs on port ${NETCONF_PORT}`;
    if (!host || !isValidIp(host)) return `ssh: Could not resolve hostname ${host ?? ''}: Name or service not known`;
    const r = this.connect(host, port);
    if (r.status === 'refused') return `ssh: connect to host ${host} port ${port}: Connection refused`;
    if (r.status !== 'open') return `ssh: connect to host ${host} port ${port}: Connection timed out`;
    const who = user ?? 'root';
    this.io.ask(`${who}@${host}'s password: `, (pw) => {
      const opened = this.netconfOpen(host, port, who, pw, 'ssh');
      if (typeof opened === 'string') return opened;
      const { target, session } = opened;
      this.io.remote = { shell: new NetconfShell((text) => this.send(target, session, text)), host, onClose: () => target.netconf.close(session) };
      return `${serverHello(session)}\n${EOM}`;
    }, true);
    return '';
  }

  // ---------------------------------------------------------------- Ansible

  private playbook(args: string[]): string {
    let inventory: string | undefined;
    let book: string | undefined;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === '-i' || a === '--inventory') inventory = args[++k];
      else if (a.startsWith('-')) continue;
      else book = a;
    }
    if (!book) return 'usage: ansible-playbook -i <inventory> <playbook.yml>';
    const files = this.server.files;
    const strip = (p: string) => p.replace(/^(\/root\/|\.\/)/, '');
    const text = files.get(strip(book));
    if (text === undefined) return `ERROR! the playbook: ${book} could not be found`;
    const inv = inventory === undefined ? files.get('hosts') : files.get(strip(inventory));
    if (inv === undefined) return `[WARNING]: Unable to parse ${inventory ?? '/etc/ansible/hosts'} as an inventory source\n[WARNING]: No inventory was parsed, only implicit localhost is available\nERROR! Specified inventory, host pattern and/or --limit leaves us with no hosts to target.`;
    const out = runPlaybook(text, inv, this.connector());
    this.server.network?.converge();
    return out;
  }

  /** How Ansible's network_cli reaches a device: TCP 22, an SSH login, then commands in the session. */
  private connector(): Connector {
    return (address, user, password) => {
      if (!isValidIp(address)) return { error: `ssh connection failed: ssh connect failed: [Errno -2] Name or service not known` };
      const r = this.connect(address, 22);
      if (r.status === 'refused') return { error: 'ssh connection failed: ssh connect failed: [Errno 111] Connection refused' };
      if (r.status !== 'open') return { error: 'ssh connection failed: ssh connect failed: timed out' };
      const target = deviceAt(this.server, address);
      if (!target) return { error: 'ssh connection failed: ssh connect failed: Connection reset by peer' };
      const login = target.login('vty', 'ssh', user, password);
      if (!login.ok) return { error: 'ssh connection failed: Failed to authenticate: Authentication failed.' };
      const session = new CliSession(target, { remote: true, privilege: login.privilege });
      const conn: NetworkConnection = {
        run: (c) => session.execute(c),
        runningConfig: () => runningConfig(target).replace(/Current configuration : \d+ bytes/, ''),
        facts: () => facts(target),
      };
      return { conn };
    };
  }
}

/** What `ios_facts` reports. */
function facts(d: IosDevice): Record<string, unknown> {
  const interfaces: Record<string, unknown> = {};
  for (const i of d.interfaces) {
    interfaces[i.name] = {
      description: i.description ?? null,
      ipv4: i.ip ? [{ address: i.ip.address, subnet: String(i.ip.prefix) }] : [],
      lineprotocol: i.isUp ? 'up' : 'down',
      operstatus: i.adminUp ? (i.isUp ? 'up' : 'down') : 'administratively down',
      macaddress: i.mac,
    };
  }
  return {
    ansible_net_hostname: d.hostname,
    ansible_net_model: d.platform,
    ansible_net_version: /Version ([^,]+)/.exec(d.software)?.[1] ?? '',
    ansible_net_system: 'ios',
    ansible_net_all_ipv4_addresses: d.interfaces.flatMap((i) => (i.ip ? [i.ip.address] : [])),
    ansible_net_interfaces: interfaces,
  };
}

/** `ssh -s netconf` asks for the NETCONF subsystem; port 830 on its own is enough too. */
function isNetconfSsh(args: string[]): boolean {
  const k = args.indexOf('-p');
  return args.includes('netconf') || (k >= 0 && args[k + 1] === String(NETCONF_PORT));
}

/**
 * The client end of a raw NETCONF session: lines are collected until the `]]>]]>` end-of-message
 * marker, then the whole message goes to the device and its reply is printed.
 */
export class NetconfShell implements Shell {
  readonly prompt = '';
  closed = false;
  private buffer = '';

  constructor(private readonly send: (text: string) => { reply?: string; close?: boolean }) {}

  execute(line: string): string {
    if (line.trim() === '~.') {
      this.closed = true;
      return 'Connection closed.';
    }
    this.buffer += `${line}\n`;
    const out: string[] = [];
    let at: number;
    while (!this.closed && (at = this.buffer.indexOf(EOM)) >= 0) {
      const message = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + EOM.length);
      if (!message) continue;
      const r = this.send(message);
      if (r.reply) out.push(`${r.reply}\n${EOM}`);
      if (r.close) this.closed = true;
    }
    return out.join('\n');
  }
}
