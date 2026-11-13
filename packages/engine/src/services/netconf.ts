import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import type { Interface } from '../devices/device';
import type { IosDevice } from '../devices/ios-device';
import type { LocalUser } from './management';

/**
 * NETCONF (RFC 6241) on IOS XE: `netconf-yang` starts an SSH subsystem on TCP 830. After both
 * sides exchange <hello> messages listing their capabilities, the client sends <rpc> requests
 * (get, get-config, edit-config, lock, copy-config...) and the device answers each with an
 * <rpc-reply>. Data is XML shaped by YANG models: `ietf-interfaces` (with `ietf-ip` addresses)
 * and the hostname and users of `Cisco-IOS-XE-native`, the same models RESTCONF serves as JSON.
 */

export const NS = {
  base: 'urn:ietf:params:xml:ns:netconf:base:1.0',
  interfaces: 'urn:ietf:params:xml:ns:yang:ietf-interfaces',
  ip: 'urn:ietf:params:xml:ns:yang:ietf-ip',
  ianaIf: 'urn:ietf:params:xml:ns:yang:iana-if-type',
  native: 'http://cisco.com/ns/yang/Cisco-IOS-XE-native',
  ia: 'http://cisco.com/yang/cisco-ia',
} as const;

/** The NETCONF 1.0 end-of-message marker that follows every message on the SSH channel. */
export const EOM = ']]>]]>';

export const NETCONF_PORT = 830;

// ---------------------------------------------------------------- a small XML reader and writer

export interface XmlNode {
  /** The local name, without any prefix. */
  name: string;
  /** The namespace the element is in, resolved from xmlns declarations. */
  ns?: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!,
  );
}

function encode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Parses one XML document into its root element. Throws on anything malformed. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: { node: XmlNode; qname: string; ns: Record<string, string> }[] = [{ node: root, qname: '', ns: {} }];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([\w.:-]+)\s*>|<([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.node.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length === 1 || m[2] !== top.qname) throw new Error(`unexpected </${m[2]}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      const ns = { ...top.ns };
      const are = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = are.exec(m[4] ?? ''))) {
        const value = decode(a[2] ?? a[3] ?? '');
        attrs[a[1]!] = value;
        if (a[1] === 'xmlns') ns[''] = value;
        else if (a[1]!.startsWith('xmlns:')) ns[a[1]!.slice(6)] = value;
      }
      const qname = m[3];
      const colon = qname.indexOf(':');
      const prefix = colon < 0 ? '' : qname.slice(0, colon);
      const node: XmlNode = { name: qname.slice(colon + 1), ns: ns[prefix], attrs, children: [], text: '' };
      if (stack.length === 1 && root.children.length) throw new Error('more than one root element');
      top.node.children.push(node);
      if (!m[5]) stack.push({ node, qname, ns });
    } else if (m[6] !== undefined) {
      if (stack.length === 1 && m[6].trim()) throw new Error('text outside the root element');
      top.node.text += decode(m[6]);
    } else if (m[7] !== undefined) throw new Error('stray <');
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1]!.qname}> is not closed`);
  if (!root.children.length) throw new Error('no root element');
  const tidy = (n: XmlNode) => {
    n.text = n.children.length ? '' : n.text.trim();
    n.children.forEach(tidy);
  };
  tidy(root.children[0]!);
  return root.children[0]!;
}

/** Pretty-prints an element, two spaces per level. */
export function renderXml(n: XmlNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${encode(v)}"`).join('');
  if (!n.children.length) return n.text ? `${pad}<${n.name}${attrs}>${encode(n.text)}</${n.name}>` : `${pad}<${n.name}${attrs}/>`;
  return [`${pad}<${n.name}${attrs}>`, ...n.children.map((c) => renderXml(c, depth + 1)), `${pad}</${n.name}>`].join('\n');
}

function el(name: string, content: (XmlNode | undefined)[] | string = [], attrs: Record<string, string> = {}): XmlNode {
  return typeof content === 'string'
    ? { name, attrs, children: [], text: content }
    : { name, attrs, children: content.filter((c): c is XmlNode => c !== undefined), text: '' };
}

/** Puts a subtree in a namespace: declares it on the top node, and sets it wherever none is set yet. */
function inNs(n: XmlNode, ns: string): XmlNode {
  n.attrs = { xmlns: ns, ...n.attrs };
  const stamp = (x: XmlNode) => {
    x.ns ??= ns;
    x.children.forEach(stamp);
  };
  stamp(n);
  return n;
}

function child(n: XmlNode, name: string): XmlNode | undefined {
  return n.children.find((c) => c.name === name);
}

function clone(n: XmlNode): XmlNode {
  return { ...n, attrs: { ...n.attrs }, children: n.children.map(clone) };
}

// ---------------------------------------------------------------- the device's data as YANG XML

const IF_TYPES: Record<string, string> = {
  physical: 'ethernetCsmacd',
  subinterface: 'l2vlan',
  svi: 'propVirtual',
  loopback: 'softwareLoopback',
  'port-channel': 'ieee8023adLag',
  radio: 'ieee80211',
};

function ifType(i: Interface): XmlNode {
  return el('type', `ianaift:${IF_TYPES[i.kind]}`, { 'xmlns:ianaift': NS.ianaIf });
}

function interfaceConfig(i: Interface): XmlNode {
  const ipv4 = inNs(el('ipv4', [i.ip ? el('address', [el('ip', i.ip.address), el('netmask', prefixToMask(i.ip.prefix))]) : undefined]), NS.ip);
  return el('interface', [
    el('name', i.name),
    i.description ? el('description', i.description) : undefined,
    ifType(i),
    el('enabled', String(i.adminUp)),
    ipv4,
    inNs(el('ipv6'), NS.ip),
  ]);
}

function interfaceState(i: Interface): XmlNode {
  const mac = i.mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1:');
  return el('interface', [
    el('name', i.name),
    ifType(i),
    el('admin-status', i.adminUp ? 'up' : 'down'),
    el('oper-status', i.isUp ? 'up' : 'down'),
    el('phys-address', mac),
    el('speed', i.kind === 'loopback' ? '8000000000' : '1000000000'),
    el('statistics', [el('in-unicast-pkts', String(i.counters.in)), el('out-unicast-pkts', String(i.counters.out))]),
  ]);
}

function nativeConfig(d: IosDevice): XmlNode {
  const users = [...d.mgmt.users.values()].map((u) =>
    el('username', [el('name', u.name), el('privilege', String(u.privilege)), u.secret ? el('secret', [el('encryption', '9'), el('secret', '$9$fakeHash')]) : el('password', [el('password', u.password)])]),
  );
  const routes = d.staticRoutes.map((r) => el('ip-route-interface-forwarding-list', [el('prefix', r.network), el('mask', prefixToMask(r.prefix)), el('fwd-list', [el('fwd', r.nextHop ?? r.exitInterface ?? '')])]));
  return inNs(
    el('native', [el('version', '17.9'), el('hostname', d.hostname), ...users, routes.length ? el('ip', [el('route', routes)]) : undefined, d.netconf.enabled ? el('netconf-yang') : undefined]),
    NS.native,
  );
}

/** What <get-config> sees: the running configuration. */
function configData(d: IosDevice): XmlNode[] {
  return [nativeConfig(d), inNs(el('interfaces', d.interfaces.map(interfaceConfig)), NS.interfaces)];
}

/** What <get> sees: configuration plus operational state. */
function allData(d: IosDevice): XmlNode[] {
  return [...configData(d), inNs(el('interfaces-state', d.interfaces.map(interfaceState)), NS.interfaces)];
}

// ---------------------------------------------------------------- filters

/** A filter node with no namespace of its own (or the NETCONF base one) matches by name alone. */
function sameNode(f: XmlNode, d: XmlNode): boolean {
  return f.name === d.name && (!f.ns || f.ns === NS.base || f.ns === d.ns);
}

/** Lists in the models served here, all keyed by `name`. */
const LIST_KEYS = new Set(['interface', 'username']);

const isContentMatch = (f: XmlNode) => !f.children.length && f.text !== '';

/**
 * RFC 6241 subtree filtering. Leaves with text are content-match nodes (all must match, and the
 * entry comes back whole when they are the only children); empty elements select a whole subtree;
 * elements with children recurse.
 */
function applyFilter(d: XmlNode, f: XmlNode): XmlNode | undefined {
  if (!f.children.length) return f.text === '' || f.text === d.text ? clone(d) : undefined;
  const matches = f.children.filter(isContentMatch);
  for (const m of matches) if (!d.children.some((c) => sameNode(m, c) && c.text === m.text)) return undefined;
  const others = f.children.filter((c) => !isContentMatch(c));
  if (!others.length) return clone(d);
  const kids: XmlNode[] = [];
  for (const c of d.children) {
    if (matches.some((m) => sameNode(m, c))) {
      kids.push(clone(c));
      continue;
    }
    for (const o of others) {
      const r = sameNode(o, c) ? applyFilter(c, o) : undefined;
      if (r) {
        kids.push(r);
        break;
      }
    }
  }
  if (kids.length <= matches.length) return undefined;
  // List entries always carry their key, so a reply can tell them apart.
  const key = LIST_KEYS.has(d.name) ? child(d, 'name') : undefined;
  if (key && !kids.some((k) => k.name === 'name')) kids.unshift(clone(key));
  return { ...d, attrs: { ...d.attrs }, children: kids };
}

function filterData(data: XmlNode[], filter: XmlNode | undefined): XmlNode[] {
  if (!filter) return data;
  const out: XmlNode[] = [];
  for (const f of filter.children) {
    for (const d of data) {
      const r = sameNode(f, d) ? applyFilter(d, f) : undefined;
      if (r) out.push(r);
    }
  }
  return out;
}

/**
 * Turns a simple XPath such as `/interfaces/interface[name='GigabitEthernet0/0']/description`
 * into the equivalent subtree filter. Prefixes (`if:interfaces`) are accepted and ignored.
 */
export function xpathToFilter(select: string): XmlNode {
  const steps: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (const ch of select.trim()) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '/' && depth === 0) {
      if (cur) steps.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) steps.push(cur);
  const filter = el('filter');
  let parent = filter;
  for (const step of steps) {
    const m = /^(?:[\w.-]+:)?([\w.-]+)((?:\[[^\]]*\])*)$/.exec(step);
    if (!m) throw new Error(`Invalid XPath step "${step}"`);
    const node = el(m[1]!);
    const pre = /\[\s*(?:[\w.-]+:)?([\w.-]+)\s*=\s*(['"])(.*?)\2\s*\]/g;
    let p: RegExpExecArray | null;
    while ((p = pre.exec(m[2] ?? ''))) node.children.push(el(p[1]!, p[3]!));
    parent.children.push(node);
    parent = node;
  }
  return filter;
}

// ---------------------------------------------------------------- sessions

export interface NetconfSession {
  id: number;
  user: string;
  source: string;
  /** The privilege EXEC authorization gave the user: NETCONF needs 15. */
  privilege: number;
  /** Set once the client's <hello> arrived. */
  hello: boolean;
  closed: boolean;
}

/** One RPC the device answered, for lab grading. */
export interface NetconfRecord {
  user: string;
  rpc: string;
  ok: boolean;
}

/** The NETCONF-YANG server of one device: on/off, open sessions, the running-datastore lock. */
export class NetconfServer {
  /** `netconf-yang`. */
  enabled = false;
  readonly sessions = new Map<number, NetconfSession>();
  lockedBy?: number;
  readonly history: NetconfRecord[] = [];
  private nextId = 24;
  private transaction = 100;

  open(user: string, source: string, privilege = 15): NetconfSession {
    const s: NetconfSession = { id: ++this.nextId, user, source, privilege, hello: false, closed: false };
    this.sessions.set(s.id, s);
    return s;
  }

  close(s: NetconfSession): void {
    s.closed = true;
    this.sessions.delete(s.id);
    if (this.lockedBy === s.id) this.lockedBy = undefined;
  }

  nextTransaction(): number {
    return ++this.transaction;
  }
}

const CAPABILITIES = [
  'urn:ietf:params:netconf:base:1.0',
  'urn:ietf:params:netconf:base:1.1',
  'urn:ietf:params:netconf:capability:writable-running:1.0',
  'urn:ietf:params:netconf:capability:rollback-on-error:1.0',
  'urn:ietf:params:netconf:capability:validate:1.0',
  'urn:ietf:params:netconf:capability:xpath:1.0',
  `${NS.interfaces}?module=ietf-interfaces&revision=2014-05-08`,
  `${NS.ip}?module=ietf-ip&revision=2014-06-16`,
  `${NS.ianaIf}?module=iana-if-type&revision=2014-05-08`,
  `${NS.native}?module=Cisco-IOS-XE-native&revision=2023-07-01`,
  `${NS.ia}?module=cisco-ia&revision=2023-03-01`,
];

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** The server's <hello>: its capabilities (the YANG models it supports) and the session id. */
export function serverHello(s: NetconfSession): string {
  return `${XML_DECL}\n${renderXml(el('hello', [el('capabilities', CAPABILITIES.map((c) => el('capability', c))), el('session-id', String(s.id))], { xmlns: NS.base }))}`;
}

/** The client side's <hello>, as netconf-console and ncclient send it. */
export const CLIENT_HELLO = `${XML_DECL}\n<hello xmlns="${NS.base}">\n  <capabilities>\n    <capability>urn:ietf:params:netconf:base:1.0</capability>\n  </capabilities>\n</hello>`;

// ---------------------------------------------------------------- RPCs

class RpcError extends Error {
  constructor(
    readonly tag: string,
    message: string,
    readonly type: 'protocol' | 'application' | 'rpc' = 'application',
    readonly info?: XmlNode,
  ) {
    super(message);
  }
}

function errorNode(e: RpcError): XmlNode {
  return el('rpc-error', [
    el('error-type', e.type),
    el('error-tag', e.tag),
    el('error-severity', 'error'),
    el('error-message', e.message, { 'xml:lang': 'en' }),
    e.info ? el('error-info', [e.info]) : undefined,
  ]);
}

/** Validates the <source> or <target> of an RPC: only the running datastore exists here (and startup for copy-config). */
function datastore(rpc: XmlNode, which: 'source' | 'target', allowed: string[] = ['running']): string {
  const holder = child(rpc, which);
  const store = holder?.children[0]?.name;
  if (!store) throw new RpcError('missing-element', `<${which}> is required`, 'protocol', el('bad-element', which));
  if (store === 'candidate') throw new RpcError('operation-not-supported', 'the candidate datastore is not enabled (netconf-yang feature candidate-datastore)', 'protocol');
  if (!allowed.includes(store)) throw new RpcError('invalid-value', `datastore ${store} is not supported here`, 'protocol');
  return store;
}

/** The `operation` attribute of an edit-config node (nc:operation or plain), inherited from the parent. */
function operationOf(n: XmlNode, inherited: string): string {
  const key = Object.keys(n.attrs).find((k) => k === 'operation' || k.endsWith(':operation'));
  const op = key ? n.attrs[key]! : inherited;
  if (!['merge', 'replace', 'create', 'delete', 'remove'].includes(op)) throw new RpcError('bad-attribute', `invalid operation "${op}"`, 'protocol', el('bad-attribute', 'operation'));
  return op;
}

interface Snapshot {
  hostname: string;
  interfaces: Interface[];
  fields: Pick<Interface, 'ip' | 'description' | 'adminUp' | 'dhcpClient'>[];
  users: LocalUser[];
  log: number;
}

function snapshot(d: IosDevice): Snapshot {
  return {
    hostname: d.hostname,
    interfaces: [...d.interfaces],
    fields: d.interfaces.map((i) => ({ ip: i.ip, description: i.description, adminUp: i.adminUp, dhcpClient: i.dhcpClient })),
    users: [...d.mgmt.users.values()].map((u) => ({ ...u })),
    log: d.log.length,
  };
}

/** rollback-on-error: puts everything an edit touched back as it was. */
function restore(d: IosDevice, s: Snapshot): void {
  d.hostname = s.hostname;
  d.interfaces.splice(0, d.interfaces.length, ...s.interfaces);
  s.interfaces.forEach((i, k) => Object.assign(i, s.fields[k]));
  d.mgmt.users.clear();
  for (const u of s.users) d.mgmt.users.set(u.name, u);
  d.log.splice(s.log);
}

function leafText(n: XmlNode, name: string): string | undefined {
  return child(n, name)?.text;
}

function editInterfaces(d: IosDevice, top: XmlNode, parentOp: string): void {
  for (const entry of top.children) {
    if (entry.name !== 'interface') throw new RpcError('unknown-element', `unknown element ${entry.name} in ietf-interfaces:interfaces`, 'application', el('bad-element', entry.name));
    const op = operationOf(entry, parentOp);
    const name = leafText(entry, 'name');
    if (!name) throw new RpcError('missing-element', 'interface entry without its key, <name>', 'application', el('bad-element', 'name'));
    let i = d.findIface(name);
    if (op === 'delete' || op === 'remove') {
      if (!i && op === 'delete') throw new RpcError('data-missing', `interface ${name} does not exist`);
      if (i) throw new RpcError('operation-not-supported', `interface ${name} cannot be deleted (delete its leaves instead)`);
      continue;
    }
    if (i && op === 'create') throw new RpcError('data-exists', `interface ${name} already exists`);
    if (!i) {
      if (!/^loopback\s*\d+$/i.test(name)) throw new RpcError('invalid-value', `interface ${name} does not exist (only loopbacks can be created)`);
      i = d.configureInterface(name);
    }
    if (op === 'replace') {
      i.description = undefined;
      i.ip = undefined;
    }
    for (const leaf of entry.children) {
      const leafOp = operationOf(leaf, op);
      const removing = leafOp === 'delete' || leafOp === 'remove';
      switch (leaf.name) {
        case 'name':
        case 'type':
          break;
        case 'description':
          if (removing && leafOp === 'delete' && !i.description) throw new RpcError('data-missing', `${i.name} has no description`);
          i.description = removing ? undefined : leaf.text || undefined;
          break;
        case 'enabled': {
          if (removing) {
            i.adminUp = i.kind !== 'physical';
            break;
          }
          if (leaf.text !== 'true' && leaf.text !== 'false') throw new RpcError('invalid-value', `"${leaf.text}" is not a valid value for enabled (true or false)`, 'application', el('bad-element', 'enabled'));
          const up = leaf.text === 'true';
          if (i.adminUp !== up) d.log.push(`%LINK-5-CHANGED: Interface ${i.name}, changed state to ${up ? 'up' : 'administratively down'}`);
          i.adminUp = up;
          break;
        }
        case 'ipv4': {
          const addrOp = (n: XmlNode | undefined) => (n ? operationOf(n, leafOp) : leafOp);
          const address = child(leaf, 'address');
          if (removing || addrOp(address) === 'delete' || addrOp(address) === 'remove') {
            i.ip = undefined;
            break;
          }
          if (!address) break;
          const ip = leafText(address, 'ip');
          const mask = leafText(address, 'netmask') ?? leafText(address, 'prefix-length');
          if (!ip || !isValidIp(ip) || !mask) throw new RpcError('invalid-value', 'ipv4 address needs a valid <ip> and <netmask>', 'application', el('bad-element', 'address'));
          let prefix: number;
          try {
            prefix = /^\d+$/.test(mask) ? Number(mask) : parsePrefix(mask);
            d.setIp(i, ip, prefix);
          } catch (err) {
            throw new RpcError('invalid-value', (err as Error).message);
          }
          break;
        }
        case 'ipv6':
          break;
        default:
          throw new RpcError('unknown-element', `${leaf.name} is not modelled here (name, description, type, enabled, ipv4)`, 'application', el('bad-element', leaf.name));
      }
    }
  }
}

function editNative(d: IosDevice, top: XmlNode, parentOp: string): void {
  for (const leaf of top.children) {
    const op = operationOf(leaf, parentOp);
    const removing = op === 'delete' || op === 'remove';
    switch (leaf.name) {
      case 'version':
        break;
      case 'hostname': {
        if (removing) {
          d.hostname = d.kind === 'router' ? 'Router' : 'Switch';
          break;
        }
        const name = leaf.text;
        if (!/^[A-Za-z][\w-]*$/.test(name)) throw new RpcError('invalid-value', `"${name}" is not a valid hostname`, 'application', el('bad-element', 'hostname'));
        const clash = d.network?.find(name);
        if (clash && clash !== d) throw new RpcError('invalid-value', `hostname ${name} is already in use`);
        d.hostname = name;
        break;
      }
      case 'username': {
        const name = leafText(leaf, 'name');
        if (!name) throw new RpcError('missing-element', 'username entry without its key, <name>', 'application', el('bad-element', 'name'));
        const existing = d.mgmt.users.get(name);
        if (removing) {
          if (!existing && op === 'delete') throw new RpcError('data-missing', `username ${name} does not exist`);
          d.mgmt.users.delete(name);
          break;
        }
        if (existing && op === 'create') throw new RpcError('data-exists', `username ${name} already exists`);
        const priv = leafText(leaf, 'privilege');
        const privilege = priv === undefined ? (existing?.privilege ?? 1) : Number(priv);
        if (!Number.isInteger(privilege) || privilege < 0 || privilege > 15) throw new RpcError('invalid-value', `privilege ${priv} is out of range (0-15)`);
        const secret = child(leaf, 'secret');
        const password = child(leaf, 'password');
        const value = secret ? (leafText(secret, 'secret') ?? secret.text) : password ? (leafText(password, 'password') ?? password.text) : existing?.password;
        if (!value) throw new RpcError('missing-element', `username ${name} needs a <secret> or <password>`, 'application', el('bad-element', 'secret'));
        d.mgmt.users.set(name, { name, privilege, password: value, secret: secret ? true : password ? false : (existing?.secret ?? true) });
        break;
      }
      default:
        throw new RpcError('unknown-element', `${leaf.name} is not modelled here (hostname, username)`, 'application', el('bad-element', leaf.name));
    }
  }
}

function editConfig(d: IosDevice, rpc: XmlNode): void {
  const config = child(rpc, 'config');
  if (!config) throw new RpcError('missing-element', '<config> is required', 'protocol', el('bad-element', 'config'));
  const defaultOp = leafText(rpc, 'default-operation') ?? 'merge';
  if (!['merge', 'replace', 'none'].includes(defaultOp)) throw new RpcError('invalid-value', `invalid default-operation ${defaultOp}`, 'protocol');
  const op = defaultOp === 'none' ? 'merge' : defaultOp;
  for (const top of config.children) {
    const known = top.ns === NS.interfaces || top.ns === NS.native;
    if (!known) throw new RpcError('unknown-namespace', `unknown namespace ${top.ns ?? '(none)'} on <${top.name}>`, 'protocol', el('bad-namespace', top.ns ?? ''));
    if (top.ns === NS.interfaces && top.name === 'interfaces') editInterfaces(d, top, operationOf(top, op));
    else if (top.ns === NS.native && top.name === 'native') editNative(d, top, operationOf(top, op));
    else throw new RpcError('unknown-element', `unknown element ${top.name}`, 'application', el('bad-element', top.name));
  }
}

export interface RpcHooks {
  /** copy-config running to startup, or cisco-ia save-config. */
  save(): void;
}

export interface RpcResult {
  /** The reply to send, or nothing (a client <hello> gets no reply). */
  reply?: string;
  /** The session ends after this message. */
  close?: boolean;
}

/** Handles one message (a <hello> or an <rpc>) that a client sent in a session. */
export function netconfMessage(d: IosDevice, session: NetconfSession, text: string, hooks: RpcHooks): RpcResult {
  const server = d.netconf;
  let msg: XmlNode;
  try {
    msg = parseXml(text);
  } catch (err) {
    const e = new RpcError('malformed-message', `XML parse error: ${(err as Error).message}`, 'rpc');
    return { reply: wrap({}, [errorNode(e)]) };
  }
  if (msg.name === 'hello') {
    const caps = child(msg, 'capabilities')?.children.map((c) => c.text) ?? [];
    if (!caps.some((c) => c.startsWith('urn:ietf:params:netconf:base:1.'))) {
      server.close(session);
      return { close: true };
    }
    session.hello = true;
    return {};
  }
  if (!session.hello) {
    // A client must say hello first; the server drops the session otherwise.
    server.close(session);
    return { close: true };
  }
  const attrs: Record<string, string> = {};
  if (msg.attrs['message-id'] !== undefined) attrs['message-id'] = msg.attrs['message-id'];
  if (msg.name !== 'rpc') return { reply: wrap(attrs, [errorNode(new RpcError('unknown-element', `expected <rpc>, got <${msg.name}>`, 'rpc'))]) };
  if (msg.attrs['message-id'] === undefined) return { reply: wrap(attrs, [errorNode(new RpcError('missing-attribute', 'missing message-id attribute', 'rpc', el('bad-attribute', 'message-id')))]) };
  const op = msg.children[0];
  if (!op) return { reply: wrap(attrs, [errorNode(new RpcError('missing-element', 'empty <rpc>', 'rpc'))]) };
  const record = (ok: boolean) => server.history.push({ user: session.user, rpc: op.name, ok });
  if (session.privilege < 15 && op.name !== 'close-session') {
    record(false);
    return { reply: wrap(attrs, [errorNode(new RpcError('access-denied', `access denied: ${session.user} is at privilege level ${session.privilege}; NETCONF needs 15 (check aaa authorization exec)`, 'protocol'))]) };
  }
  try {
    const body = runRpc(d, session, op, hooks);
    record(true);
    return { reply: wrap(attrs, body), close: op.name === 'close-session' };
  } catch (err) {
    record(false);
    if (!(err instanceof RpcError)) throw err;
    return { reply: wrap(attrs, [errorNode(err)]) };
  }
}

function wrap(attrs: Record<string, string>, body: XmlNode[]): string {
  return `${XML_DECL}\n${renderXml(el('rpc-reply', body, { xmlns: NS.base, ...attrs }))}`;
}

function filterOf(op: XmlNode): XmlNode | undefined {
  const f = child(op, 'filter');
  if (!f) return undefined;
  const type = f.attrs.type ?? 'subtree';
  if (type === 'xpath') {
    const select = f.attrs.select;
    if (!select) throw new RpcError('missing-attribute', 'an xpath filter needs a select attribute', 'protocol', el('bad-attribute', 'select'));
    try {
      return xpathToFilter(select);
    } catch (err) {
      throw new RpcError('invalid-value', (err as Error).message, 'protocol');
    }
  }
  if (type !== 'subtree') throw new RpcError('bad-attribute', `unknown filter type ${type}`, 'protocol', el('bad-attribute', 'type'));
  return f;
}

function runRpc(d: IosDevice, session: NetconfSession, op: XmlNode, hooks: RpcHooks): XmlNode[] {
  const server = d.netconf;
  const lockedByOther = () => server.lockedBy !== undefined && server.lockedBy !== session.id;
  switch (op.name) {
    case 'get':
      return [el('data', filterData(allData(d), filterOf(op)))];
    case 'get-config':
      datastore(op, 'source');
      return [el('data', filterData(configData(d), filterOf(op)))];
    case 'edit-config': {
      datastore(op, 'target');
      if (lockedByOther()) throw new RpcError('in-use', `the running datastore is locked by session ${server.lockedBy}`, 'protocol', el('session-id', String(server.lockedBy)));
      const before = snapshot(d);
      try {
        editConfig(d, op);
      } catch (err) {
        restore(d, before);
        throw err;
      }
      d.log.push(`%DMI-5-CONFIG_I: ${d.hostname} dmiauthd: Configured from NETCONF/RESTCONF by ${session.user}, transaction-id ${server.nextTransaction()}`);
      d.network?.converge();
      return [el('ok')];
    }
    case 'lock':
    case 'unlock': {
      datastore(op, 'target');
      if (op.name === 'lock') {
        if (server.lockedBy !== undefined) throw new RpcError('lock-denied', `Lock failed, lock is already held by session ${server.lockedBy}`, 'protocol', el('session-id', String(server.lockedBy)));
        server.lockedBy = session.id;
      } else {
        if (server.lockedBy !== session.id) throw new RpcError('operation-failed', 'the running datastore is not locked by this session', 'protocol');
        server.lockedBy = undefined;
      }
      return [el('ok')];
    }
    case 'copy-config': {
      const target = datastore(op, 'target', ['startup']);
      datastore(op, 'source');
      if (target === 'startup') hooks.save();
      return [el('ok')];
    }
    case 'save-config':
      if (op.ns !== NS.ia) break;
      hooks.save();
      return [inNs(el('result', 'Save running-config successful'), NS.ia)];
    case 'close-session':
      server.close(session);
      return [el('ok')];
    case 'kill-session': {
      const id = Number(leafText(op, 'session-id'));
      const victim = server.sessions.get(id);
      if (!victim || id === session.id) throw new RpcError('invalid-value', `no other session ${leafText(op, 'session-id') ?? ''}`, 'protocol');
      server.close(victim);
      return [el('ok')];
    }
  }
  throw new RpcError('operation-not-supported', `${op.name} is not supported`, 'protocol');
}

/** Wraps an operation in an <rpc>, as a client library does. */
export function rpc(messageId: number, body: string): string {
  return `${XML_DECL}\n<rpc xmlns="${NS.base}" message-id="${messageId}">\n${body.trim()}\n</rpc>`;
}
