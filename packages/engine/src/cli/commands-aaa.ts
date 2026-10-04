import { formatMethods, parseMethods, type AaaProtocol, type AaaServer } from '../services/aaa';
import { EXEC, INVALID, abbrev, int, ip, requireIos, type Command, type Mode, type Session } from './common';

/** AAA (`aaa new-model`, method lists, RADIUS and TACACS+ servers) and the HTTP server behind RESTCONF. */

const SERVER_MODES: Mode[] = ['config-radius-server', 'config-server-tacacs'];
const GROUP_MODES: Mode[] = ['config-sg-radius', 'config-sg-tacacs+'];

/** Method lists only exist under `aaa new-model`, as on IOS. */
function aaaOn(s: Session) {
  const aaa = requireIos(s).aaa;
  if (!aaa.newModel) throw new Error(INVALID);
  return aaa;
}

function server(s: Session): AaaServer {
  return s.currentAaaServer!;
}

/** `key cisco`, `key 0 cisco`. */
function secret(rest: string): string {
  const w = rest.trim().split(/\s+/);
  if (w.length === 2 && w[0] === '0') return w[1]!;
  if (w.length !== 1 || !w[0]) throw new Error(INVALID);
  return w[0];
}

/** `radius-server host <ip> [auth-port n] [acct-port n] [key k]` and the TACACS+ equivalent. */
function legacyHost(s: Session, protocol: AaaProtocol, address: string, rest: string): void {
  const aaa = requireIos(s).aaa;
  ip(address);
  const srv = aaa.server(address, protocol);
  Object.assign(srv, { address, legacy: true });
  const w = rest.split(/\s+/).filter(Boolean);
  for (let k = 0; k < w.length; k++) {
    if (protocol === 'radius' && abbrev(w[k], 'auth-port')) srv.authPort = int(w[++k], 0, 65535);
    else if (protocol === 'radius' && abbrev(w[k], 'acct-port')) srv.acctPort = int(w[++k], 0, 65535);
    else if (abbrev(w[k], 'key')) {
      srv.key = secret(w.slice(k + 1).join(' '));
      break;
    } else throw new Error(INVALID);
  }
}

function showAaaServers(s: Session): string {
  const aaa = requireIos(s).aaa;
  if (!aaa.servers.size) return '';
  let id = 0;
  return [...aaa.servers.values()]
    .map((srv) => {
      const t = srv.stats;
      const head = srv.protocol === 'radius' ? `RADIUS: id ${++id}, priority ${id}, host ${srv.address ?? 'unknown'}, auth-port ${srv.authPort}, acct-port ${srv.acctPort}` : `TACACS+: id ${++id}, priority ${id}, host ${srv.address ?? 'unknown'}, port 49`;
      const dead = t.requests > 0 && t.timeouts === t.requests;
      return [
        head,
        `     State: current ${dead ? 'DEAD' : 'UP'}, duration 0s, previous duration 0s`,
        `     Dead: total time 0s, count ${dead ? 1 : 0}`,
        `     Authen: request ${t.requests}, timeouts ${t.timeouts}, failover ${t.timeouts}, retransmission 0`,
        `             Response: accept ${t.accepts}, reject ${t.rejects}, challenge 0`,
        `             Response: unexpected 0, server error 0, incorrect 0, time 0ms`,
      ].join('\n');
    })
    .join('\n');
}

function showMethodLists(s: Session): string {
  const aaa = requireIos(s).aaa;
  const out = ['authen queue=AAA_ML_AUTHEN_LOGIN'];
  let n = 0;
  for (const [name, m] of aaa.login) out.push(`  name=${name} valid=TRUE id=${(++n).toString(16).padStart(8, '0')} :state=ALIVE : ${formatMethods(m).toUpperCase()}`);
  out.push('author queue=AAA_ML_AUTHOR_EXEC');
  for (const [name, m] of aaa.authorization) out.push(`  name=${name} valid=TRUE id=${(++n).toString(16).padStart(8, '0')} :state=ALIVE : ${formatMethods(m).toUpperCase()}`);
  out.push('acct queue=AAA_ML_ACCT_EXEC');
  for (const [name, a] of aaa.accounting) out.push(`  name=${name} valid=TRUE id=${(++n).toString(16).padStart(8, '0')} :state=ALIVE : ${a.mode.toUpperCase()}: ${formatMethods(a.methods).toUpperCase()}`);
  return out.join('\n');
}

function showTacacs(s: Session): string {
  const aaa = requireIos(s).aaa;
  return [...aaa.servers.values()]
    .filter((srv) => srv.protocol === 'tacacs+')
    .map((srv) =>
      [
        '',
        'Tacacs+ Server - public  :',
        `               Server name: ${srv.legacy ? '' : srv.name}`,
        `            Server address: ${srv.address ?? ''}`,
        '               Server port: 49',
        `              Socket opens: ${String(srv.stats.requests).padStart(10)}`,
        `             Socket closes: ${String(srv.stats.requests).padStart(10)}`,
        `             Socket aborts: ${String(0).padStart(10)}`,
        `             Socket errors: ${String(srv.stats.timeouts).padStart(10)}`,
        `           Socket Timeouts: ${String(srv.stats.timeouts).padStart(10)}`,
        `   Failed Connect Attempts: ${String(srv.stats.timeouts).padStart(10)}`,
        `        Total Packets Sent: ${String(srv.stats.requests).padStart(10)}`,
        `        Total Packets Recv: ${String(srv.stats.accepts + srv.stats.rejects).padStart(10)}`,
      ].join('\n'),
    )
    .join('\n');
}

export const AAA_COMMANDS: Command[] = [
  { syntax: 'aaa new-model', modes: ['config'], help: 'Enable AAA (method lists for login, authorization and accounting)', run: (s) => void (requireIos(s).aaa.newModel = true) },
  { syntax: 'no aaa new-model', modes: ['config'], help: 'Back to line passwords and login local', run: (s) => void (requireIos(s).aaa.newModel = false) },
  { syntax: 'aaa authentication login <list> <methods...>', modes: ['config'], help: 'default|<name> then group radius|tacacs+|<group>, local, line, enable, none', run: (s, [list, m]) => {
    aaaOn(s).login.set(list!, parseMethods(m!.split(/\s+/)));
  } },
  { syntax: 'no aaa authentication login <list>', modes: ['config'], help: 'Delete a login method list', run: (s, [list]) => void aaaOn(s).login.delete(list!) },
  { syntax: 'aaa authorization exec <list> <methods...>', modes: ['config'], help: 'Where the EXEC privilege level comes from', run: (s, [list, m]) => {
    aaaOn(s).authorization.set(list!, parseMethods(m!.split(/\s+/)));
  } },
  { syntax: 'no aaa authorization exec <list>', modes: ['config'], help: 'Delete an authorization list', run: (s, [list]) => void aaaOn(s).authorization.delete(list!) },
  { syntax: 'aaa authorization console', modes: ['config'], help: 'Apply EXEC authorization on the console too', run: (s) => void (aaaOn(s).authorizeConsole = true) },
  { syntax: 'no aaa authorization console', modes: ['config'], help: 'Console logins start at level 1', run: (s) => void (aaaOn(s).authorizeConsole = false) },
  { syntax: 'aaa accounting exec <list> <mode> <methods...>', modes: ['config'], help: 'start-stop|stop-only group <group>: record EXEC sessions', run: (s, [list, mode, m]) => {
    const kind = abbrev(mode, 'start-stop') ? 'start-stop' : abbrev(mode, 'stop-only') ? 'stop-only' : undefined;
    if (!kind) throw new Error(INVALID);
    aaaOn(s).accounting.set(list!, { mode: kind, methods: parseMethods(m!.split(/\s+/)) });
  } },
  { syntax: 'no aaa accounting exec <list>', modes: ['config'], help: 'Stop EXEC accounting', run: (s, [list]) => void aaaOn(s).accounting.delete(list!) },

  // Servers, the current way
  { syntax: 'radius server <name>', modes: ['config', ...SERVER_MODES, ...GROUP_MODES], help: 'Define a RADIUS server', run: (s, [name]) => {
    const srv = requireIos(s).aaa.server(name!, 'radius');
    if (srv.protocol !== 'radius') throw new Error(`${name} is already a TACACS+ server`);
    s.currentAaaServer = srv;
    s.mode = 'config-radius-server';
  } },
  { syntax: 'no radius server <name>', modes: ['config'], help: 'Delete a RADIUS server', run: (s, [name]) => void requireIos(s).aaa.servers.delete(name!) },
  { syntax: 'tacacs server <name>', modes: ['config', ...SERVER_MODES, ...GROUP_MODES], help: 'Define a TACACS+ server', run: (s, [name]) => {
    const srv = requireIos(s).aaa.server(name!, 'tacacs+');
    if (srv.protocol !== 'tacacs+') throw new Error(`${name} is already a RADIUS server`);
    s.currentAaaServer = srv;
    s.mode = 'config-server-tacacs';
  } },
  { syntax: 'no tacacs server <name>', modes: ['config'], help: 'Delete a TACACS+ server', run: (s, [name]) => void requireIos(s).aaa.servers.delete(name!) },
  { syntax: 'address ipv4 <ip>', modes: SERVER_MODES, help: 'The server address', run: (s, [addr]) => void (server(s).address = ip(addr)) },
  { syntax: 'address ipv4 <ip> auth-port <port> acct-port <port>', modes: ['config-radius-server'], help: 'The server address and its RADIUS ports', run: (s, [addr, a, b]) => {
    Object.assign(server(s), { address: ip(addr), authPort: int(a, 0, 65535), acctPort: int(b, 0, 65535) });
  } },
  { syntax: 'key <secret...>', modes: SERVER_MODES, help: 'Shared secret (must match the server)', run: (s, [k]) => void (server(s).key = secret(k!)) },
  { syntax: 'no key', modes: SERVER_MODES, help: 'Remove the shared secret', run: (s) => void (server(s).key = undefined) },

  // Servers, the legacy way
  { syntax: 'radius-server host <ip>', modes: ['config'], help: 'Legacy RADIUS server definition', run: (s, [addr]) => legacyHost(s, 'radius', addr!, '') },
  { syntax: 'radius-server host <ip> <options...>', modes: ['config'], help: '[auth-port n] [acct-port n] [key secret]', run: (s, [addr, rest]) => legacyHost(s, 'radius', addr!, rest!) },
  { syntax: 'no radius-server host <ip>', modes: ['config'], help: 'Delete a legacy RADIUS server', run: (s, [addr]) => void requireIos(s).aaa.servers.delete(addr!) },
  { syntax: 'tacacs-server host <ip>', modes: ['config'], help: 'Legacy TACACS+ server definition', run: (s, [addr]) => legacyHost(s, 'tacacs+', addr!, '') },
  { syntax: 'tacacs-server host <ip> <options...>', modes: ['config'], help: '[key secret]', run: (s, [addr, rest]) => legacyHost(s, 'tacacs+', addr!, rest!) },
  { syntax: 'no tacacs-server host <ip>', modes: ['config'], help: 'Delete a legacy TACACS+ server', run: (s, [addr]) => void requireIos(s).aaa.servers.delete(addr!) },
  { syntax: 'radius-server key <secret...>', modes: ['config'], help: 'Shared secret for RADIUS servers without their own', run: (s, [k]) => void (requireIos(s).aaa.globalKeys.radius = secret(k!)) },
  { syntax: 'tacacs-server key <secret...>', modes: ['config'], help: 'Shared secret for TACACS+ servers without their own', run: (s, [k]) => void (requireIos(s).aaa.globalKeys['tacacs+'] = secret(k!)) },

  // Server groups
  { syntax: 'aaa group server <protocol> <name>', modes: ['config', ...GROUP_MODES], help: 'radius|tacacs+ <name>: a named list of servers', run: (s, [proto, name]) => {
    const aaa = aaaOn(s);
    const protocol: AaaProtocol | undefined = abbrev(proto, 'radius') ? 'radius' : abbrev(proto, 'tacacs+') ? 'tacacs+' : undefined;
    if (!protocol) throw new Error(INVALID);
    let g = aaa.groups.get(name!);
    if (!g) aaa.groups.set(name!, (g = { name: name!, protocol, servers: [] }));
    s.currentAaaGroup = g;
    s.mode = protocol === 'radius' ? 'config-sg-radius' : 'config-sg-tacacs+';
  } },
  { syntax: 'no aaa group server <protocol> <name>', modes: ['config'], help: 'Delete a server group', run: (s, [, name]) => void aaaOn(s).groups.delete(name!) },
  { syntax: 'server name <name>', modes: GROUP_MODES, help: 'Add a server (by name) to this group', run: (s, [name]) => {
    const g = s.currentAaaGroup!;
    if (!g.servers.includes(name!)) g.servers.push(name!);
  } },
  { syntax: 'no server name <name>', modes: GROUP_MODES, help: 'Remove a server from this group', run: (s, [name]) => {
    const g = s.currentAaaGroup!;
    g.servers = g.servers.filter((n) => n !== name);
  } },

  // Lines
  { syntax: 'login authentication <list>', modes: ['config-line'], help: 'Use this AAA method list for logins on the line', run: (s, [list]) => {
    aaaOn(s);
    s.currentLine!.authList = list === 'default' ? undefined : list;
  } },
  { syntax: 'no login authentication', modes: ['config-line'], help: 'Back to the default method list', run: (s) => void (s.currentLine!.authList = undefined) },
  { syntax: 'authorization exec <list>', modes: ['config-line'], help: 'Use this AAA method list for EXEC authorization', run: (s, [list]) => {
    aaaOn(s);
    s.currentLine!.authorList = list === 'default' ? undefined : list;
  } },
  { syntax: 'no authorization exec', modes: ['config-line'], help: 'Back to the default authorization list', run: (s) => void (s.currentLine!.authorList = undefined) },

  // Verification
  { syntax: 'show aaa servers', modes: EXEC, help: 'RADIUS and TACACS+ servers and their counters', run: (s) => showAaaServers(s) },
  { syntax: 'show aaa method-lists all', modes: EXEC, help: 'Configured method lists', run: (s) => showMethodLists(s) },
  { syntax: 'show tacacs', modes: EXEC, help: 'TACACS+ servers and their counters', run: (s) => showTacacs(s) },
  { syntax: 'test aaa group <group> <user> <password> legacy', modes: ['privileged'], help: 'Ask the servers in a group to authenticate a user', run: (s, [group, user, pw]) => {
    const d = requireIos(s);
    const servers = d.aaa.serversOf(group!);
    if (!servers.length) return `Error: Server group ${group} not found or has no servers.`;
    const r = d.testAaa(group!, user!, pw!);
    const verdict = r === 'pass' ? 'User was successfully authenticated.' : r === 'fail' ? 'User authentication request was rejected by server.' : 'No authoritative response from any server.';
    return `Attempting authentication test to server-group ${group} using ${servers[0]!.protocol}\n${verdict}`;
  } },

  // HTTP server and RESTCONF
  { syntax: 'ip http server', modes: ['config'], help: 'Run the HTTP server (TCP 80)', run: (s) => void (requireIos(s).http.server = true) },
  { syntax: 'no ip http server', modes: ['config'], help: 'Stop the HTTP server', run: (s) => void (requireIos(s).http.server = false) },
  { syntax: 'ip http secure-server', modes: ['config'], help: 'Run the HTTPS server (TCP 443), needed for RESTCONF', run: (s) => void (requireIos(s).http.secure = true) },
  { syntax: 'no ip http secure-server', modes: ['config'], help: 'Stop the HTTPS server', run: (s) => void (requireIos(s).http.secure = false) },
  { syntax: 'ip http authentication local', modes: ['config'], help: 'Check web and API logins against the local users', run: (s) => void (requireIos(s).http.authLocal = true) },
  { syntax: 'no ip http authentication', modes: ['config'], help: 'Back to the enable password', run: (s) => void (requireIos(s).http.authLocal = false) },
  { syntax: 'restconf', modes: ['config'], help: 'Enable the RESTCONF API (needs ip http secure-server)', run: (s) => {
    const d = requireIos(s);
    if (d.kind !== 'router') throw new Error(INVALID);
    d.http.restconf = true;
  } },
  { syntax: 'no restconf', modes: ['config'], help: 'Disable RESTCONF', run: (s) => void (requireIos(s).http.restconf = false) },
  { syntax: 'show platform software yang-management process', modes: ['privileged'], help: 'State of the model-driven programmability processes', run: (s) => {
    const d = requireIos(s);
    const on = d.http.restconf;
    const state = (b: boolean) => (b ? 'Running' : 'Not Running');
    return [`confd            : ${state(on)}`, `nesd             : ${state(on)}`, `syncfd           : ${state(on)}`, `ncsshd           : Not Running`, `dmiauthd         : ${state(on)}`, `nginx            : ${state(on && d.http.secure)}`, `ndbmand          : ${state(on)}`, `pubd             : ${state(on)}`].join('\n');
  } },
];
