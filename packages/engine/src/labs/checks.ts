import { networkAddress, prefixToMask, sameSubnet } from '../core/addressing';
import { iosIpv6, ipv6InPrefix, ipv6Network, normaliseIpv6 } from '../core/ipv6';
import { channelProtocol } from '../switching/etherchannel';
import type { Device, Interface } from '../devices/device';
import { IpDevice } from '../devices/ip-device';
import { Pc } from '../devices/pc';
import { Router } from '../devices/router';
import { Switch } from '../devices/switch';
import { IosDevice } from '../devices/ios-device';
import { deviceAt } from '../cli/remote';
import type { Check } from './types';

export interface CheckResult {
  pass: boolean;
  /** What the grader saw when the check failed, phrased as a nudge rather than the answer. */
  detail?: string;
}

/** Resolves a lab hostname to the device it was built as, even after a `hostname` change. */
export type DeviceLookup = (name: string) => Device;

const ok: CheckResult = { pass: true };
const fail = (detail: string): CheckResult => ({ pass: false, detail });

function findIface(d: Device, name: string): Interface | undefined {
  return d.findIface(name);
}

function ipDevice(d: Device): IpDevice {
  if (!(d instanceof IpDevice)) throw new Error(`${d.hostname} has no IP stack`);
  return d;
}

function switchOf(d: Device): Switch {
  if (!(d instanceof Switch)) throw new Error(`${d.hostname} is not a switch`);
  return d;
}

function routerOf(d: Device): Router {
  if (!(d instanceof Router)) throw new Error(`${d.hostname} is not a router`);
  return d;
}

function iosOf(d: Device): IosDevice {
  if (!(d instanceof IosDevice)) throw new Error(`${d.hostname} is not a router or switch`);
  return d;
}

function vlanList(v: Set<number> | 'all'): string {
  return v === 'all' ? 'all' : [...v].sort((a, b) => a - b).join(',') || 'none';
}

/**
 * Evaluates one non-quiz check. Probe checks (ping, traceroute) send real traffic through the
 * topology and run it to completion.
 */
export function evaluate(check: Check, device: DeviceLookup): CheckResult {
  switch (check.type) {
    case 'hostname': {
      const d = device(check.device);
      return d.hostname === check.name ? ok : fail(`The hostname is ${d.hostname}`);
    }
    case 'interfaceUp': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (!i.adminUp) return fail(`${i.name} is administratively down`);
      return i.isUp ? ok : fail(`${i.name} is enabled but its line protocol is down`);
    }
    case 'interfaceIp': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (!i.ip) return fail(`${i.name} has no IP address`);
      const { address, prefix } = i.ip;
      if (prefix !== check.prefix) return fail(`${i.name} has mask ${prefixToMask(prefix)} (/${prefix})`);
      if (check.address && address !== check.address) return fail(`${i.name} is ${address}/${prefix}`);
      if (check.network) {
        if (!sameSubnet(address, check.network, check.prefix)) return fail(`${address}/${prefix} is outside ${check.network}/${check.prefix}`);
        if (address === networkAddress(address, prefix)) return fail(`${address} is the network address, not a host`);
        if (address === broadcast(address, prefix)) return fail(`${address} is the broadcast address, not a host`);
      }
      return ok;
    }
    case 'defaultGateway': {
      const d = ipDevice(device(check.device));
      if (!d.defaultGateway) return fail(`${d.hostname} has no default gateway`);
      return d.defaultGateway === check.address ? ok : fail(`${d.hostname} uses ${d.defaultGateway} as its gateway`);
    }
    case 'vlan': {
      const sw = switchOf(device(check.device));
      const name = sw.vlans.get(check.id);
      if (name === undefined) return fail(`VLAN ${check.id} does not exist on ${sw.hostname}`);
      return check.name === undefined || name === check.name ? ok : fail(`VLAN ${check.id} is named ${name}`);
    }
    case 'accessVlan': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (i.mode !== 'access') return fail(`${i.name} is a ${i.mode} port`);
      return i.accessVlan === check.vlan ? ok : fail(`${i.name} is in VLAN ${i.accessVlan}`);
    }
    case 'trunk': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (i.mode !== 'trunk') return fail(`${i.name} is an access port`);
      if (check.nativeVlan !== undefined && i.nativeVlan !== check.nativeVlan) return fail(`The native VLAN on ${i.name} is ${i.nativeVlan}`);
      if (check.allowed) {
        const want = [...check.allowed].sort((a, b) => a - b).join(',');
        if (vlanList(i.allowedVlans) !== want) return fail(`${i.name} allows VLANs ${vlanList(i.allowedVlans)}`);
      }
      return ok;
    }
    case 'subinterface': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (i.encapVlan === undefined) return fail(`${i.name} has no encapsulation`);
      if (i.encapVlan !== check.vlan) return fail(`${i.name} tags frames for VLAN ${i.encapVlan}`);
      if (Boolean(check.native) !== Boolean(i.encapNative)) return fail(check.native ? `${i.name} is not the native VLAN` : `${i.name} is marked native`);
      return ok;
    }
    case 'ipRouting': {
      const sw = switchOf(device(check.device));
      return sw.ipRouting ? ok : fail(`IP routing is off on ${sw.hostname}`);
    }
    case 'route': {
      const d = ipDevice(device(check.device));
      const match = d
        .routingTable()
        .find(
          (r) =>
            r.network === check.network &&
            r.prefix === check.prefix &&
            (!check.code || r.code === check.code) &&
            (!check.nextHop || r.nextHop === check.nextHop),
        );
      const what = `${check.network}/${check.prefix}${check.nextHop ? ` via ${check.nextHop}` : ''}`;
      if (check.absent) return match ? fail(`${what} is in the routing table`) : ok;
      return match ? ok : fail(`No route to ${what} in the routing table`);
    }
    case 'staticRoute': {
      const d = ipDevice(device(check.device));
      const routes = d.staticRoutes.filter((r) => r.network === check.network && r.prefix === check.prefix);
      if (!routes.length) return fail(`No static route for ${check.network}/${check.prefix} is configured`);
      const viaHop = check.nextHop ? routes.filter((r) => r.nextHop === check.nextHop) : routes;
      if (!viaHop.length) return fail(`The route for ${check.network}/${check.prefix} points somewhere else`);
      if (check.ad !== undefined && !viaHop.some((r) => r.ad === check.ad)) return fail(`The administrative distance is ${viaHop[0]!.ad}`);
      return ok;
    }
    case 'ping': {
      const from = ipDevice(device(check.from));
      const net = from.network;
      // Routers drop the packet that triggers ARP, so warm the path before judging it.
      const warm = from.pingAny(check.to, 4, 1_000);
      net?.run();
      const final = from.pingAny(check.to, 3, 1_000);
      net?.run();
      const reached = final.every((r) => r.success);
      const any = [...warm, ...final].some((r) => r.success);
      if (check.expect === 'success') return reached ? ok : fail(`${from.hostname} cannot reach ${check.to}${describeFailure(final)}`);
      return any ? fail(`${from.hostname} can still reach ${check.to}`) : ok;
    }
    case 'traceroute': {
      const from = ipDevice(device(check.from));
      from.ping(check.to, 4, 1_000);
      from.network?.run();
      const result = from.traceroute(check.to, 15, 1, 1_000);
      from.network?.run();
      const seen = result.hops.flatMap((h) => h.probes.map((p) => p.from).filter((x): x is string => !!x));
      let at = 0;
      for (const hop of check.via) {
        const idx = seen.indexOf(hop, at);
        if (idx < 0) return fail(`The path from ${from.hostname} goes ${seen.join(' → ') || 'nowhere'}`);
        at = idx + 1;
      }
      return ok;
    }
    case 'ospfRouterId': {
      const r = routerOf(device(check.device));
      const p = [...r.ospf.values()][0];
      if (!p) return fail(`OSPF is not running on ${r.hostname}`);
      if (!p.routerId) return fail(`OSPF on ${r.hostname} has no router ID yet`);
      if (p.routerId === check.routerId) return ok;
      const pending = p.configuredRouterId === check.routerId ? ' (configured, but not in use until the process restarts)' : '';
      return fail(`${r.hostname} uses router ID ${p.routerId}${pending}`);
    }
    case 'ospfNeighbor': {
      const r = routerOf(device(check.device));
      const want = check.state ?? 'FULL';
      const found = [...r.ospf.values()].flatMap((p) => p.neighbors()).find(({ n }) => n.routerId === check.neighbor);
      if (!found) return fail(`${r.hostname} has no OSPF neighbor ${check.neighbor}`);
      return found.n.state === want ? ok : fail(`${r.hostname} sees ${check.neighbor} in state ${found.n.state}`);
    }
    case 'ospfInterface': {
      const r = routerOf(device(check.device));
      const i = findIface(r, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const p = [...r.ospf.values()].find((x) => x.ifaces.has(i));
      const oi = p?.ifaces.get(i);
      if (!p || !oi) return fail(`OSPF is not running on ${i.name}`);
      if (check.passive !== undefined && oi.passive !== check.passive) return fail(`${i.name} is ${oi.passive ? '' : 'not '}passive`);
      if (check.priority !== undefined && p.priority(i) !== check.priority) return fail(`${i.name} has OSPF priority ${p.priority(i)}`);
      const role = p.interfaceState(oi);
      if (check.role && role !== check.role) return fail(`${i.name} is ${role}`);
      return ok;
    }
    case 'dhcpLease': {
      const d = device(check.device);
      if (!(d instanceof Pc)) throw new Error(`${d.hostname} is not a PC`);
      if (!d.dhcp) return fail(`${d.hostname} uses a static address`);
      if (!d.lease || !d.nic.ip) return fail(d.apipa ? `${d.hostname} has a self-assigned ${d.nic.ip!.address} (no DHCP server answered)` : `${d.hostname} has no DHCP lease`);
      if (!sameSubnet(d.nic.ip.address, check.network, check.prefix)) return fail(`${d.hostname} leased ${d.nic.ip.address}, outside ${check.network}/${check.prefix}`);
      if (check.gateway && d.defaultGateway !== check.gateway) return fail(`${d.hostname} was given gateway ${d.defaultGateway ?? 'none'}`);
      return ok;
    }
    case 'dhcpPool': {
      const r = routerOf(device(check.device));
      const pool = r.dhcpServer.poolFor(check.network);
      if (!pool || pool.prefix !== check.prefix) return fail(`${r.hostname} has no DHCP pool for ${check.network}/${check.prefix}`);
      if (check.defaultRouter && pool.defaultRouter !== check.defaultRouter) return fail(`Pool ${pool.name} hands out gateway ${pool.defaultRouter ?? 'none'}`);
      return ok;
    }
    case 'dhcpExcluded': {
      const r = routerOf(device(check.device));
      return r.dhcpServer.isExcluded(check.address) ? ok : fail(`${check.address} could be leased to a client`);
    }
    case 'helperAddress': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      return i.helpers?.includes(check.address) ? ok : fail(`${i.name} relays to ${i.helpers?.join(', ') || 'nobody'}`);
    }
    case 'natInterface': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      return i.nat === check.side ? ok : fail(i.nat ? `${i.name} is a NAT ${i.nat} interface` : `${i.name} has no NAT role`);
    }
    case 'natStatic': {
      const r = routerOf(device(check.device));
      const m = r.nat.statics.find((x) => x.local === check.local);
      if (!m) return fail(`${check.local} has no static translation`);
      return m.global === check.global ? ok : fail(`${check.local} is mapped to ${m.global}`);
    }
    case 'natOverload': {
      const r = routerOf(device(check.device));
      return r.nat.rules.some((x) => x.overload) ? ok : fail(`${r.hostname} has no NAT overload rule`);
    }
    case 'accessGroup': {
      const r = routerOf(device(check.device));
      const i = findIface(r, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const applied = i.accessGroup?.[check.direction];
      if (!applied) return fail(`No ACL is applied ${check.direction}bound on ${i.name}`);
      if (check.acl && applied !== check.acl) return fail(`${i.name} uses ACL ${applied} ${check.direction}bound`);
      return ok;
    }
    case 'connect': {
      const from = ipDevice(device(check.from));
      const r = from.connect(check.to, check.port);
      from.network?.run();
      const open = r.status === 'open';
      if (check.expect === 'open') return open ? ok : fail(`${from.hostname} cannot open port ${check.port} on ${check.to} (${r.status})`);
      return open ? fail(`${from.hostname} can still open port ${check.port} on ${check.to}`) : ok;
    }
    case 'ipv6Address': {
      const d = ipDevice(device(check.device));
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      const all = d.ipv6.globals(i);
      if (!all.length) return fail(`${i.name} has no global IPv6 address`);
      const want = check.address ? normaliseIpv6(check.address) : undefined;
      const match = all.find((a) => (want ? a.address === want : ipv6InPrefix(a.address, check.network!, check.prefix)));
      const seen = all.map((a) => `${iosIpv6(a.address)}/${a.prefix}`).join(', ');
      if (!match) return fail(`${i.name} has ${seen}`);
      if (match.prefix !== check.prefix) return fail(`${i.name} has ${iosIpv6(match.address)}/${match.prefix}`);
      if (check.eui64 && !match.eui64) return fail(`${iosIpv6(match.address)} was typed in full rather than built with EUI-64`);
      if (check.slaac && !match.slaac) return fail(`${iosIpv6(match.address)} is static, not learned with SLAAC`);
      return ok;
    }
    case 'ipv6LinkLocal': {
      const d = ipDevice(device(check.device));
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist yet`);
      if (!d.ipv6.enabled(i)) return fail(`IPv6 is not enabled on ${i.name}`);
      const ll = d.ipv6.linkLocal(i);
      return ll === normaliseIpv6(check.address) ? ok : fail(`${i.name} uses link-local address ${iosIpv6(ll)}`);
    }
    case 'ipv6Routing': {
      const r = routerOf(device(check.device));
      return r.ipv6Routing ? ok : fail(`IPv6 unicast routing is off on ${r.hostname}`);
    }
    case 'ipv6Route': {
      const d = ipDevice(device(check.device));
      const network = normaliseIpv6(check.network);
      const hop = check.nextHop ? normaliseIpv6(check.nextHop) : undefined;
      const match = d.ipv6
        .routingTable()
        .find((r) => r.network === network && r.prefix === check.prefix && (!check.code || r.code === check.code) && (!hop || r.nextHop === hop));
      const what = `${iosIpv6(network)}/${check.prefix}${hop ? ` via ${iosIpv6(hop)}` : ''}`;
      if (check.absent) return match ? fail(`${what} is in the IPv6 routing table`) : ok;
      return match ? ok : fail(`No route to ${what} in the IPv6 routing table`);
    }
    case 'stpMode': {
      const sw = switchOf(device(check.device));
      return sw.stp.mode === check.mode ? ok : fail(`${sw.hostname} runs ${sw.stp.mode}`);
    }
    case 'stpRoot': {
      const sw = switchOf(device(check.device));
      const st = sw.stp.vlans.get(check.vlan);
      if (!st) return fail(`Spanning tree is not running for VLAN ${check.vlan} on ${sw.hostname}`);
      return sw.stp.isRoot(check.vlan) ? ok : fail(`The root bridge for VLAN ${check.vlan} is ${st.root.mac} (priority ${st.root.priority})`);
    }
    case 'stpPortRole': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const info = sw.stp.vlans.get(check.vlan)?.ports.get(sw.logicalOf(i));
      if (!info) return fail(`${i.name} is not in the VLAN ${check.vlan} spanning tree`);
      return info.role === check.role ? ok : fail(`${i.name} is a ${info.role} port in VLAN ${check.vlan}`);
    }
    case 'portfast': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      return sw.stp.portfast(i) ? ok : fail(`PortFast is off on ${i.name}`);
    }
    case 'bpduGuard': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      return sw.stp.bpduGuard(i) ? ok : fail(`BPDU guard is off on ${i.name}`);
    }
    case 'errDisabled': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (check.expect) return i.errDisabled ? ok : fail(`${i.name} is not err-disabled`);
      return i.errDisabled ? fail(`${i.name} is err-disabled (${i.errDisabled})`) : ok;
    }
    case 'etherchannel': {
      const sw = switchOf(device(check.device));
      const po = sw.portChannel(check.group);
      if (!po) return fail(`Port-channel${check.group} does not exist on ${sw.hostname}`);
      const members = sw.members(po);
      if (!members.length) return fail(`Port-channel${check.group} has no member ports`);
      const proto = channelProtocol(members[0]!.channelGroup!.mode);
      if (check.protocol && proto !== check.protocol) return fail(`Port-channel${check.group} uses ${proto === 'on' ? 'mode on' : proto.toUpperCase()}`);
      const bundled = sw.bundledMembers(po).length;
      return bundled >= check.bundled ? ok : fail(`Port-channel${check.group} has ${bundled} of ${members.length} ports bundled`);
    }
    case 'portSecurity': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const ps = i.portSecurity;
      if (!ps?.enabled) return fail(`Port security is off on ${i.name}`);
      if (check.maximum !== undefined && ps.maximum !== check.maximum) return fail(`${i.name} allows ${ps.maximum} MAC address${ps.maximum > 1 ? 'es' : ''}`);
      if (check.violation && ps.violation !== check.violation) return fail(`The violation mode on ${i.name} is ${ps.violation}`);
      if (check.sticky !== undefined && ps.sticky !== check.sticky) return fail(`Sticky learning is ${ps.sticky ? 'on' : 'off'} on ${i.name}`);
      return ok;
    }
    case 'secureMac': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const found = (i.portSecurity?.addresses ?? []).filter((a) => !check.kind || a.type === check.kind);
      const want = check.count ?? 1;
      return found.length >= want ? ok : fail(`${i.name} has ${found.length} ${check.kind ?? 'secure'} address${found.length === 1 ? '' : 'es'}`);
    }
    case 'hsrp': {
      const r = routerOf(device(check.device));
      const i = findIface(r, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const st = r.hsrp.groups().find((g) => g.iface === i && g.config.group === check.group);
      if (!st) return fail(`${i.name} has no HSRP group ${check.group}`);
      const vip = r.hsrp.vip(st);
      if (check.vip && st.config.vip !== check.vip) return fail(`Group ${check.group} on ${r.hostname} uses virtual IP ${st.config.vip ?? 'none (learned)'}`);
      if (check.priority !== undefined && st.config.priority !== check.priority) return fail(`Group ${check.group} on ${r.hostname} has priority ${st.config.priority}`);
      if (check.preempt !== undefined && st.config.preempt !== check.preempt) return fail(`Preemption is ${st.config.preempt ? 'on' : 'off'} for group ${check.group} on ${r.hostname}`);
      if (check.track) {
        const t = st.config.tracks.find((x) => x.iface === r.findIface(check.track!)?.name);
        if (!t) return fail(`Group ${check.group} on ${r.hostname} does not track ${check.track}`);
      }
      if (check.state && st.state !== check.state) return fail(`${r.hostname} is ${st.state} for group ${check.group}${vip ? ` (${vip})` : ''}`);
      return ok;
    }
    case 'dhcpSnooping': {
      const sw = switchOf(device(check.device));
      if (!sw.snooping.enabled) return fail(`DHCP snooping is not enabled globally on ${sw.hostname}`);
      if (!sw.snooping.vlans.has(check.vlan)) return fail(`DHCP snooping is not enabled for VLAN ${check.vlan}`);
      if (check.option82 !== undefined && sw.snooping.option82 !== check.option82) return fail(`Option 82 insertion is ${sw.snooping.option82 ? 'on' : 'off'}`);
      return ok;
    }
    case 'dhcpSnoopingTrust': {
      const sw = switchOf(device(check.device));
      const i = findIface(sw, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const trusted = Boolean(i.dhcpSnooping?.trust);
      return trusted === check.trusted ? ok : fail(`${i.name} is ${trusted ? 'trusted' : 'untrusted'}`);
    }
    case 'dhcpSnoopingBinding': {
      const sw = switchOf(device(check.device));
      const client = device(check.client);
      const mac = client.interfaces[0]!.mac;
      const b = sw.snooping.bindings.find((x) => x.mac === mac);
      return b ? ok : fail(`${sw.hostname} has no snooping binding for ${client.hostname} (${sw.snooping.bindings.length} in total)`);
    }
    case 'sshServer': {
      const d = iosOf(device(check.device));
      const m = d.mgmt;
      if (!m.sshEnabled) return fail(`SSH is not running on ${d.hostname} (no RSA keys)`);
      if (check.modulus && m.rsaModulus! < check.modulus) return fail(`The RSA key on ${d.hostname} is only ${m.rsaModulus} bits`);
      if (check.version && m.sshVersion !== check.version) return fail(`${d.hostname} runs SSH version ${m.sshVersionLabel}`);
      return ok;
    }
    case 'vtyAccess': {
      const d = iosOf(device(check.device));
      const vty = d.mgmt.vty;
      if (check.transport) {
        const have = [...vty.transport].sort().join(' ') || 'none';
        const want = [...check.transport].sort().join(' ') || 'none';
        if (have !== want) return fail(`The VTY lines on ${d.hostname} accept ${have}`);
      }
      if (check.login && vty.login !== check.login) return fail(`The VTY lines on ${d.hostname} use ${vty.login === 'none' ? 'no login' : vty.login === 'local' ? 'login local' : 'login (line password)'}`);
      return ok;
    }
    case 'localUser': {
      const d = iosOf(device(check.device));
      const u = d.mgmt.users.get(check.username);
      if (!u) return fail(`${d.hostname} has no user ${check.username}`);
      if (check.privilege !== undefined && u.privilege !== check.privilege) return fail(`${check.username} has privilege ${u.privilege}`);
      if (check.secret !== undefined && u.secret !== check.secret) return fail(`${check.username} uses ${u.secret ? 'secret' : 'password'}`);
      return ok;
    }
    case 'enableSecret': {
      const d = iosOf(device(check.device));
      return d.mgmt.enableSecret !== undefined ? ok : fail(`${d.hostname} has no enable secret`);
    }
    case 'passwordEncryption': {
      const d = iosOf(device(check.device));
      return d.mgmt.passwordEncryption ? ok : fail(`Clear-text passwords on ${d.hostname} are not encrypted`);
    }
    case 'remoteLogin': {
      const from = ipDevice(device(check.from));
      const r = from.connect(check.to, check.protocol === 'ssh' ? 22 : 23);
      from.network?.run();
      const target = deviceAt(from, check.to);
      const result = r.status === 'open' && target ? target.mgmt.authenticate(check.protocol, check.username, check.password) : undefined;
      const what = `${check.protocol === 'ssh' ? 'SSH' : 'Telnet'} to ${check.to}`;
      if (check.expect === 'success') {
        if (r.status !== 'open') return fail(`${what} does not connect (${r.status})`);
        return result?.ok ? ok : fail(`${what} connects but the login fails`);
      }
      return result?.ok ? fail(`${what} still lets ${from.hostname} log in`) : ok;
    }
    case 'ntpSynced': {
      const d = iosOf(device(check.device));
      const n = d.ntp;
      if (!n.sync) return fail(n.servers.length ? `${d.hostname} is not synchronized to ${n.servers.join(', ')}` : `${d.hostname} has no NTP server`);
      if (check.server && n.sync.server !== check.server) return fail(`${d.hostname} is synchronized to ${n.sync.server}`);
      if (check.stratum !== undefined && n.sync.stratum !== check.stratum) return fail(`${d.hostname} is at stratum ${n.sync.stratum}`);
      return ok;
    }
    case 'ntpMaster': {
      const d = iosOf(device(check.device));
      if (d.ntp.master === undefined) return fail(`${d.hostname} is not an NTP master`);
      return check.stratum === undefined || d.ntp.master === check.stratum ? ok : fail(`${d.hostname} serves stratum ${d.ntp.master}`);
    }
    case 'clock': {
      const d = iosOf(device(check.device));
      const year = new Date(d.ntp.time).getUTCFullYear();
      if (year < check.minYear) return fail(`${d.hostname} thinks it is ${year}`);
      if (check.timezone && d.ntp.timezone.name !== check.timezone) return fail(`${d.hostname} shows time zone ${d.ntp.timezone.name}`);
      return ok;
    }
    case 'logTimestamps': {
      const d = iosOf(device(check.device));
      return d.logTimestamps?.kind === 'datetime' ? ok : fail(`Log messages on ${d.hostname} carry no date and time`);
    }
    case 'neighbor': {
      const d = iosOf(device(check.device));
      const protocol = check.protocol ?? 'cdp';
      const want = check.neighbor.toLowerCase();
      const found = d.discovery
        .neighbors(protocol)
        .find((n) => n.pdu.deviceId.toLowerCase().split('.')[0] === want && (!check.interface || n.local === d.findIface(check.interface)));
      const where = check.interface ? ` on ${check.interface}` : '';
      if (check.absent) return found ? fail(`${d.hostname} still sees ${check.neighbor} with ${protocol.toUpperCase()}`) : ok;
      return found ? ok : fail(`${d.hostname} has no ${protocol.toUpperCase()} neighbor ${check.neighbor}${where}`);
    }
    case 'discovery': {
      const d = iosOf(device(check.device));
      const name = check.protocol.toUpperCase();
      const global = check.protocol === 'cdp' ? d.discovery.cdpEnabled : d.discovery.lldpEnabled;
      if (!check.interface) return global === check.enabled ? ok : fail(`${name} is ${global ? 'running' : 'off'} on ${d.hostname}`);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      const port = check.protocol === 'cdp' ? i.cdp !== false : i.lldp?.transmit !== false;
      const on = global && port;
      return on === check.enabled ? ok : fail(`${name} is ${on ? 'running' : 'off'} on ${i.name}`);
    }
    case 'description': {
      const d = device(check.device);
      const i = findIface(d, check.interface);
      if (!i) return fail(`${check.interface} does not exist`);
      if (!i.description) return fail(`${i.name} has no description`);
      return i.description.toLowerCase().includes(check.contains.toLowerCase()) ? ok : fail(`${i.name} is described as "${i.description}"`);
    }
    case 'quiz':
      throw new Error('Quiz checks are graded from the answer, not the network');
  }
}

function describeFailure(results: { status: string; from?: string }[]): string {
  const r = results.find((x) => x.status !== 'success');
  if (!r) return '';
  if (r.status === 'unreachable') return ` (${r.from} reports it unreachable)`;
  if (r.status === 'no-route') return ' (no route or gateway to send it)';
  if (r.status === 'ttl-exceeded') return ` (TTL expired at ${r.from}: a routing loop?)`;
  return ' (requests time out)';
}

function broadcast(ip: string, prefix: number): string {
  const net = networkAddress(ip, prefix).split('.').map(Number);
  const mask = prefixToMask(prefix).split('.').map(Number);
  return net.map((o, k) => o | (~mask[k]! & 0xff)).join('.');
}
