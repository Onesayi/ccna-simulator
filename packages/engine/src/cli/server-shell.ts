import { isValidIp } from '../core/addressing';
import type { SnmpMessage, SnmpVarbind } from '../core/frames';
import type { IosDevice } from '../devices/ios-device';
import type { Server } from '../devices/server';
import { runPlaybook, type Connector, type NetworkConnection } from '../services/ansible';
import { restconf } from '../services/restconf';
import { MIB2_ROOT, compareOid, formatVarbind, resolveOid, translateOid } from '../services/snmp';
import { PcShell } from './pc-shell';
import { deviceAt } from './remote';
import { CliSession } from './session';
import { runningConfig } from './show';

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
  ansible-playbook -i <inventory> <playbook.yml>        Run a playbook
  ls | cat <file>                                       Files on the server
  cat > <file> <<EOF ... EOF                            Write a file (or use the Files tab)`;

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

/** The Linux prompt of a server: SNMP tools, an AAA server, RESTCONF over curl, and Ansible. */
export class ServerShell extends PcShell {
  constructor(readonly server: Server) {
    super(server);
  }

  override get prompt(): string {
    return this.io.prompt ?? `root@${this.server.hostname}:~# `;
  }

  protected override run(line: string): string {
    const heredoc = /^cat\s*>\s*(\S+)(?:\s*<<\s*['"]?(\w+)['"]?)?\s*$/.exec(line.trim());
    if (heredoc) return this.writeFile(heredoc[1]!, heredoc[2] ?? 'EOF');
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
      case 'ls':
        return [...this.server.files.keys()].sort().join('  ');
      case 'cat':
        return this.cat(rest[0]);
      case 'ansible-playbook':
        return this.playbook(rest);
      case 'curl':
        return this.curl(rest);
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
  private writeFile(path: string, end: string): string {
    const name = path.replace(/^(\/root\/|\.\/)/, '');
    const lines: string[] = [];
    const next = (line: string): string => {
      if (line.trim() === end) {
        this.server.files.set(name, `${lines.join('\n')}\n`);
        return '';
      }
      lines.push(line);
      this.io.ask('> ', next, false, true);
      return '';
    };
    this.io.ask('> ', next, false, true);
    return '';
  }

  private cat(path: string | undefined): string {
    if (!path) return 'cat: missing operand';
    if (path === '/var/log/snmptrapd.log') return this.server.trapLog.join('\n');
    if (path === '/var/log/aaa.log') return this.server.aaa.log.join('\n');
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
