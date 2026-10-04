import { parsePrefix, prefixToMask } from '../core/addressing';
import type { Interface } from '../devices/device';
import type { IosDevice } from '../devices/ios-device';

/**
 * RESTCONF (RFC 8040) on IOS XE: the device's configuration and state as YANG-modelled JSON,
 * read with GET and changed with PATCH, PUT and POST over HTTPS. Covers the `ietf-interfaces`
 * model (configuration and state) and the hostname from `Cisco-IOS-XE-native`.
 */

export interface HttpResponse {
  status: number;
  reason: string;
  body?: string;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
};

function respond(status: number, body?: unknown): HttpResponse {
  return { status, reason: REASONS[status]!, body: body === undefined ? undefined : JSON.stringify(body, null, 2) };
}

function error(status: number, message: string, tag = 'invalid-value'): HttpResponse {
  return respond(status, { 'ietf-restconf:errors': { error: [{ 'error-type': 'application', 'error-tag': tag, 'error-message': message }] } });
}

const IF_TYPES: Record<string, string> = {
  physical: 'iana-if-type:ethernetCsmacd',
  subinterface: 'iana-if-type:l2vlan',
  svi: 'iana-if-type:propVirtual',
  loopback: 'iana-if-type:softwareLoopback',
  'port-channel': 'iana-if-type:ieee8023adLag',
  radio: 'iana-if-type:ieee80211',
};

/** The configuration view of an interface (ietf-interfaces + ietf-ip). */
function interfaceConfig(i: Interface): Record<string, unknown> {
  const out: Record<string, unknown> = { name: i.name };
  if (i.description) out.description = i.description;
  out.type = IF_TYPES[i.kind];
  out.enabled = i.adminUp;
  out['ietf-ip:ipv4'] = i.ip ? { address: [{ ip: i.ip.address, netmask: prefixToMask(i.ip.prefix) }] } : {};
  out['ietf-ip:ipv6'] = {};
  return out;
}

/** The state view (ietf-interfaces:interfaces-state). */
function interfaceState(i: Interface): Record<string, unknown> {
  const mac = i.mac.replace(/\./g, '').replace(/(..)(?!$)/g, '$1:');
  return {
    name: i.name,
    type: IF_TYPES[i.kind],
    'admin-status': i.adminUp ? 'up' : 'down',
    'oper-status': i.isUp ? 'up' : 'down',
    'phys-address': mac,
    speed: i.kind === 'loopback' ? '8000000000' : '1000000000',
    statistics: { 'in-unicast-pkts': String(i.counters.in), 'out-unicast-pkts': String(i.counters.out) },
  };
}

function nativeConfig(d: IosDevice): Record<string, unknown> {
  return {
    version: '17.9',
    hostname: d.hostname,
    username: [...d.mgmt.users.values()].map((u) => ({ name: u.name, privilege: u.privilege })),
    ip: {
      route: { 'ip-route-interface-forwarding-list': d.staticRoutes.map((r) => ({ prefix: r.network, mask: prefixToMask(r.prefix), 'fwd-list': [{ fwd: r.nextHop ?? r.exitInterface }] })) },
      http: { server: d.http.server, 'secure-server': d.http.secure },
    },
    restconf: d.http.restconf ? [null] : undefined,
  };
}

/** Splits `interface=GigabitEthernet0%2F0` into the list key; RESTCONF URL-encodes the slash. */
function key(segment: string): string | undefined {
  const m = /^interface=(.+)$/.exec(segment);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Applies an `ietf-interfaces:interface` body to an interface. Returns an error message, if any. */
function applyInterface(d: IosDevice, i: Interface, data: Record<string, unknown>): string | undefined {
  if (typeof data.description === 'string') i.description = data.description || undefined;
  if (typeof data.enabled === 'boolean') {
    if (i.adminUp !== data.enabled) d.log.push(`%LINK-5-CHANGED: Interface ${i.name}, changed state to ${data.enabled ? 'up' : 'administratively down'}`);
    i.adminUp = data.enabled;
  }
  const v4 = data['ietf-ip:ipv4'] as { address?: { ip?: string; netmask?: string }[] } | undefined;
  const a = v4?.address?.[0];
  if (a?.ip && a.netmask) {
    try {
      d.setIp(i, a.ip, parsePrefix(a.netmask));
    } catch (err) {
      return (err as Error).message;
    }
  }
  return undefined;
}

/** Unwraps `{"ietf-interfaces:interface": {...}}` or `[{...}]`. */
function interfaceBody(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = data['ietf-interfaces:interface'] ?? data.interface;
  const entry = Array.isArray(v) ? v[0] : v;
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

/**
 * Answers one RESTCONF request. The caller has already connected to TCP 443 and checked the
 * credentials; this only resolves the resource.
 */
export function restconf(d: IosDevice, method: string, path: string, body?: string): HttpResponse {
  const m = method.toUpperCase();
  const clean = path.replace(/\?.*$/, '').replace(/\/+$/, '');
  if (clean === '/restconf') {
    return m === 'GET' ? respond(200, { 'ietf-restconf:restconf': { data: {}, operations: {}, 'yang-library-version': '2016-06-21' } }) : error(405, 'method not allowed', 'operation-not-supported');
  }
  const parts = clean.replace(/^\/restconf\/data\/?/, '').split('/').filter(Boolean);
  if (!clean.startsWith('/restconf/data') || !parts.length) return error(404, 'uri keypath not found');
  const [top, ...rest] = parts;
  const findIf = (seg: string | undefined) => {
    const name = seg ? key(seg) : undefined;
    return name ? d.findIface(name) : undefined;
  };

  if (top === 'ietf-interfaces:interfaces') {
    if (rest.length === 0) {
      if (m === 'GET') return respond(200, { 'ietf-interfaces:interfaces': { interface: d.interfaces.map(interfaceConfig) } });
      if (m === 'POST') {
        const data = parseBody(body);
        const entry = data && interfaceBody(data);
        if (!entry || typeof entry.name !== 'string') return error(400, 'malformed message', 'malformed-message');
        if (d.findIface(entry.name)) return error(409, 'object already exists', 'data-exists');
        let i: Interface;
        try {
          i = d.configureInterface(entry.name);
        } catch {
          return error(400, `invalid interface name ${entry.name}`);
        }
        const problem = applyInterface(d, i, entry);
        return problem ? error(400, problem) : respond(201);
      }
      return error(405, 'method not allowed', 'operation-not-supported');
    }
    const i = findIf(rest[0]);
    if (!i) return error(404, 'uri keypath not found');
    const leaf = rest[1];
    if (m === 'GET') {
      const cfg = interfaceConfig(i);
      if (!leaf) return respond(200, { 'ietf-interfaces:interface': [cfg] });
      if (!(leaf in cfg)) return error(404, 'uri keypath not found');
      return respond(200, { [`ietf-interfaces:${leaf}`]: cfg[leaf] });
    }
    if (m === 'PATCH' || m === 'PUT') {
      const data = parseBody(body);
      if (!data) return error(400, 'malformed message', 'malformed-message');
      const entry = leaf ? { [leaf]: data[`ietf-interfaces:${leaf}`] ?? data[leaf] } : interfaceBody(data);
      if (!entry) return error(400, 'malformed message', 'malformed-message');
      const problem = applyInterface(d, i, entry);
      return problem ? error(400, problem) : respond(204);
    }
    if (m === 'DELETE' && leaf === 'description') {
      i.description = undefined;
      return respond(204);
    }
    return error(405, 'method not allowed', 'operation-not-supported');
  }

  if (top === 'ietf-interfaces:interfaces-state') {
    if (m !== 'GET') return error(405, 'method not allowed', 'operation-not-supported');
    if (!rest.length) return respond(200, { 'ietf-interfaces:interfaces-state': { interface: d.interfaces.map(interfaceState) } });
    const i = findIf(rest[0]);
    return i ? respond(200, { 'ietf-interfaces:interface': [interfaceState(i)] }) : error(404, 'uri keypath not found');
  }

  if (top === 'Cisco-IOS-XE-native:native') {
    if (!rest.length) return m === 'GET' ? respond(200, { 'Cisco-IOS-XE-native:native': nativeConfig(d) }) : error(405, 'method not allowed', 'operation-not-supported');
    if (rest[0] !== 'hostname') return error(404, 'uri keypath not found');
    if (m === 'GET') return respond(200, { 'Cisco-IOS-XE-native:hostname': d.hostname });
    if (m === 'PATCH' || m === 'PUT') {
      const data = parseBody(body);
      const name = data?.['Cisco-IOS-XE-native:hostname'] ?? data?.hostname;
      if (typeof name !== 'string' || !/^[A-Za-z][\w-]*$/.test(name)) return error(400, 'malformed message', 'malformed-message');
      const clash = d.network?.find(name);
      if (clash && clash !== d) return error(400, `hostname ${name} is already in use`);
      d.hostname = name;
      return respond(204);
    }
    return error(405, 'method not allowed', 'operation-not-supported');
  }
  return error(404, 'uri keypath not found');
}
