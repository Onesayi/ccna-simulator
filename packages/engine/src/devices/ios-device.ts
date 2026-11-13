import { isValidIp } from '../core/addressing';
import { CDP_MAC, LLDP_MAC, type DiscoveryPdu, type DnsMessage, type DnsRecord, type Frame, type SnmpMessage, type TcpPacket, type UdpPacket } from '../core/frames';
import { IosDnsConfig, addressFromReverse, canonicalName } from '../services/dns';
import { Aaa, type AaaContext } from '../services/aaa';
import { CDP_HOLDTIME, Discovery, LLDP_HOLDTIME, advertisedAddress } from '../services/discovery';
import { Management, type LoginResult, type Transport } from '../services/management';
import { NetconfServer, NETCONF_PORT } from '../services/netconf';
import { NtpClock } from '../services/ntp';
import { SnmpAgent } from '../services/snmp';
import { buildMib } from '../services/snmp-mib';
import type { Interface } from './device';
import { IpDevice, LIMITED_BROADCAST } from './ip-device';

/** `ip http server`, `ip http secure-server` and `restconf`. */
export interface HttpConfig {
  server: boolean;
  secure: boolean;
  /** `ip http authentication local`: check the local user database (otherwise the enable password). */
  authLocal: boolean;
  restconf: boolean;
}

let trapRequestId = 7000;

/** How an IOS name lookup went, for the "Translating..." line and the error that follows. */
export interface IosResolution {
  address?: string;
  /** The name servers asked, in order (255.255.255.255 when none is configured). Empty for static or cached names. */
  servers: string[];
  /** `no ip domain lookup`: only the host table was consulted. */
  lookupOff?: boolean;
}

/** A query an `ip dns server` router forwarded upstream, waiting for the answer to relay back. */
interface ForwardedQuery {
  client: string;
  port: number;
  id: number;
  via: string;
}

/**
 * What routers and switches share as IOS devices: CDP and LLDP, the clock and NTP, and device
 * access (local users, enable passwords, VTY lines and the SSH server).
 */
export abstract class IosDevice extends IpDevice {
  readonly mgmt = new Management();
  readonly aaa: Aaa;
  readonly snmp: SnmpAgent;
  readonly http: HttpConfig = { server: false, secure: false, authLocal: false, restconf: false };
  /** `netconf-yang`: the NETCONF server on TCP 830. */
  readonly netconf = new NetconfServer();
  readonly discovery: Discovery;
  readonly ntp: NtpClock;
  /** `ip domain lookup`, `ip name-server`, `ip host` and `ip dns server`. */
  readonly dns = new IosDnsConfig();
  private readonly forwarded = new Map<number, ForwardedQuery>();
  private forwardId = 0x5000;
  /** CDP platform string, as `show cdp neighbors` shows it. */
  abstract readonly platform: string;
  /** The software version line in `show cdp neighbors detail`. */
  abstract readonly software: string;
  /** Files copied to flash, by name (the IOS image is listed separately). */
  readonly flash = new Map<string, string>();
  /** The saved configuration, once `copy running-config startup-config` or `write memory` ran. */
  startupConfig?: string;
  /** `ip ftp username` and `ip ftp password`: the FTP login `copy` uses when the URL has none. */
  readonly ftpLogin: { username?: string; password?: string } = {};
  /** `service timestamps log ...`: prefix console messages with the time. Off unless configured. */
  logTimestamps?: { kind: 'uptime' | 'datetime'; msec: boolean; localtime: boolean; showTimezone: boolean };
  /** Native VLAN mismatches already logged, so CDP does not repeat itself every round. */
  private readonly vlanWarnings = new Set<string>();
  /** Line protocol of each interface at the last round, for linkUp and linkDown traps. */
  private readonly lastOper = new Map<Interface, boolean>();

  constructor(hostname: string) {
    super(hostname);
    this.aaa = new Aaa({
      users: this.mgmt.users,
      enablePassword: () => this.mgmt.enableRequired,
      sendRadius: (server, port, radius) =>
        this.originate(server.address!, (src) => ({ kind: 'udp', src, dst: server.address!, ttl: 255, srcPort: port === server.acctPort ? 21646 : 21645, dstPort: port, radius })),
      sendTacacs: (server, tacacs) => this.originate(server.address!, (src) => ({ kind: 'tcp', src, dst: server.address!, ttl: 255, srcPort: 30049, dstPort: 49, flags: 'psh', tacacs })),
      schedule: (ms, label, run) => this.schedule(ms, label, run),
      cancel: (e) => this.cancel(e),
    });
    this.snmp = new SnmpAgent({ mib: () => buildMib(this), aclPermits: (acl, src) => this.standardAclPermits(acl, src) });
    this.discovery = new Discovery({
      ports: () => this.interfaces.filter((i) => i.kind === 'physical'),
      advertise: (port, kind) => this.advertise(port, kind),
      send: (port, pdu) => this.send(port, { src: port.mac, dst: pdu.kind === 'cdp' ? CDP_MAC : LLDP_MAC, payload: pdu }),
      now: () => this.now,
    });
    this.ntp = new NtpClock({
      now: () => this.now,
      log: this.log,
      request: (server, msg) => this.originate(server, (src) => ({ kind: 'udp', src, dst: server, ttl: 255, srcPort: 123, dstPort: 123, ntp: msg })),
      schedule: (ms, label, run) => this.schedule(ms, label, run),
    });
    // Stamp syslog messages as they are logged, so the time is the time of the event.
    const push = this.log.push.bind(this.log);
    this.log.push = (...lines: string[]) => push(...lines.map((l) => this.stamp(l)));
  }

  private stamp(line: string): string {
    const ts = this.logTimestamps;
    if (!ts || !line.startsWith('%')) return line;
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    if (ts.kind === 'uptime') {
      const s = Math.floor(this.now / 1000);
      return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}: ${line}`;
    }
    const zone = ts.localtime ? this.ntp.timezone : { name: 'UTC', hours: 0, minutes: 0 };
    const t = new Date(this.ntp.time + (zone.hours * 60 + Math.sign(zone.hours || 1) * zone.minutes) * 60_000);
    const month = t.toUTCString().slice(8, 11);
    const flag = this.ntp.synchronized || this.ntp.userSet ? '' : '*';
    const ms = ts.msec ? `.${pad(t.getUTCMilliseconds(), 3)}` : '';
    const tz = ts.showTimezone ? ` ${zone.name}` : '';
    return `${flag}${month} ${String(t.getUTCDate()).padStart(2)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}${ms}${tz}: ${line}`;
  }

  /** CDP capability letters: R router, B source-route bridge, S switch, I IGMP. */
  protected abstract cdpCapabilities(): string[];
  /** LLDP capability letters: R router, B bridge. */
  protected abstract lldpCapabilities(): string[];
  /** The native (or access) VLAN a port reports in CDP. Routers report none. */
  protected nativeVlanOf(_port: Interface): number | undefined {
    return undefined;
  }

  /** CDP adds the domain name to the device ID once one is configured. */
  get deviceId(): string {
    return this.mgmt.domainName ? `${this.hostname}.${this.mgmt.domainName}` : this.hostname;
  }

  private advertise(port: Interface, kind: 'cdp' | 'lldp'): DiscoveryPdu {
    return {
      kind,
      deviceId: kind === 'cdp' ? this.deviceId : this.hostname,
      portId: port.name,
      platform: this.platform,
      capabilities: kind === 'cdp' ? this.cdpCapabilities() : this.lldpCapabilities(),
      address: advertisedAddress(port, this.interfaces),
      nativeVlan: kind === 'cdp' ? this.nativeVlanOf(port) : undefined,
      holdtime: kind === 'cdp' ? CDP_HOLDTIME : LLDP_HOLDTIME,
      version: this.software,
      chassisId: this.interfaces[0]!.mac,
    };
  }

  protected override get listeningPorts(): readonly number[] {
    return [...this.mgmt.listeningPorts(), ...(this.http.server ? [80] : []), ...(this.http.secure ? [443] : []), ...(this.netconf.enabled ? [NETCONF_PORT] : [])];
  }

  /** A standard ACL check on a source address, for `snmp-server community ... <acl>`. Routers override. */
  protected standardAclPermits(_acl: string, _src: string): boolean | undefined {
    return undefined;
  }

  // ---------------------------------------------------------------- DNS

  /**
   * Resolves a name the way IOS does for ping, traceroute, telnet and a mistyped command: the host
   * table (static `ip host` entries and the cache) first, then, unless `no ip domain lookup`, a DNS
   * query to each name server in turn. A name without a dot gets the `ip domain name` appended.
   */
  resolveHost(name: string): IosResolution {
    if (isValidIp(name)) return { address: name, servers: [] };
    const fqdn = !name.includes('.') && this.mgmt.domainName ? `${name}.${this.mgmt.domainName}` : name;
    const known = this.dns.host(name) ?? this.dns.host(fqdn);
    if (known) return { address: known.addresses[0], servers: [] };
    if (!this.dns.lookup) return { servers: [], lookupOff: true };
    const servers = this.dns.nameServers.length ? [...this.dns.nameServers] : [LIMITED_BROADCAST];
    const asked: string[] = [];
    for (const server of servers) {
      asked.push(server);
      const r = this.dnsQuery(server, canonicalName(fqdn), 'A');
      if (r.status !== 'answer') continue;
      const a = r.reply.answers?.find((x) => x.type === 'A');
      if (a) {
        this.dns.hosts.set(canonicalName(fqdn), { name: canonicalName(fqdn), addresses: [a.data], perm: false });
        return { address: a.data, servers: asked };
      }
      // A definite "no such name" ends the search; only silence moves on to the next server.
      break;
    }
    return { servers: asked };
  }

  /** `ip dns server`: answers from the host table, and forwards the rest to our own name servers. */
  private serveDns(p: UdpPacket, q: DnsMessage): void {
    if (!this.dns.server || p.dst === LIMITED_BROADCAST) return;
    const reply = (fields: Partial<DnsMessage>) =>
      this.sendIp({ kind: 'udp', src: p.dst, dst: p.src, ttl: 255, srcPort: 53, dstPort: p.srcPort, dns: { id: q.id, response: true, name: q.name, qtype: q.qtype, rd: q.rd, ra: true, rcode: 'NOERROR', ...fields } });
    const name = canonicalName(q.name);
    const entry = this.dns.host(name);
    const reverse = addressFromReverse(name);
    if (q.qtype === 'A' && entry) {
      return reply({ aa: entry.perm, answers: entry.addresses.map((data): DnsRecord => ({ name, type: 'A', ttl: entry.perm ? 10 : 3600, data })) });
    }
    const owner = reverse && [...this.dns.hosts.values()].find((e) => e.perm && e.addresses.includes(reverse));
    if (q.qtype === 'PTR' && owner) return reply({ aa: true, answers: [{ name, type: 'PTR', ttl: 10, data: canonicalName(owner.name) }] });
    const upstream = this.dns.nameServers[0];
    if (!upstream || q.rd === false) return reply({ rcode: entry ? 'NOERROR' : 'NXDOMAIN' });
    const id = this.forwardId++ & 0xffff;
    this.forwarded.set(id, { client: p.src, port: p.srcPort, id: q.id, via: p.dst });
    this.originate(upstream, (src) => ({ kind: 'udp', src, dst: upstream, ttl: 255, srcPort: 53, dstPort: 53, dns: { ...q, id } }));
  }

  protected override receiveDnsReply(p: UdpPacket): void {
    const pending = this.forwarded.get(p.dns!.id);
    if (!pending) return super.receiveDnsReply(p);
    this.forwarded.delete(p.dns!.id);
    for (const a of p.dns!.answers ?? []) {
      if (a.type === 'A' && !this.dns.host(a.name)?.perm) this.dns.hosts.set(a.name, { name: a.name, addresses: [a.data], perm: false });
    }
    this.sendIp({ kind: 'udp', src: pending.via, dst: pending.client, ttl: 255, srcPort: 53, dstPort: pending.port, dns: { ...p.dns!, id: pending.id, aa: false, ra: true } });
  }

  protected override handleUdp(p: UdpPacket): void {
    if (p.dns && !p.dns.response && p.dstPort === 53) return this.serveDns(p, p.dns);
    if (p.radius) return this.aaa.receiveRadius(p.src, p.radius);
    if (p.snmp && p.dstPort === 161) {
      const reply = this.snmp.handle(p.snmp, p.src);
      if (reply) this.sendIp({ kind: 'udp', src: p.dst, dst: p.src, ttl: 255, srcPort: 161, dstPort: p.srcPort, snmp: reply });
      return;
    }
    if (!p.ntp || p.dstPort !== 123) return;
    const reply = this.ntp.receive(p.src, p.ntp);
    if (reply) this.sendIp({ kind: 'udp', src: p.dst, dst: p.src, ttl: 255, srcPort: 123, dstPort: p.srcPort, ntp: reply });
  }

  protected override handleTcpData(p: TcpPacket): void {
    if (p.tacacs) this.aaa.receiveTacacs(p.src, p.tacacs);
  }

  // ---------------------------------------------------------------- logins and AAA

  /** True when a console session must log in before it gets a prompt. */
  get consoleLoginRequired(): boolean {
    if (this.aaa.newModel) {
      const methods = this.aaa.loginMethods(this.mgmt.console.authList, 'console');
      return methods !== undefined && methods[0]?.kind !== 'none';
    }
    const c = this.mgmt.console;
    return c.login === 'local' || (c.login === 'line' && c.password !== undefined);
  }

  /** What a login asks for, in order. */
  loginPrompts(line: 'console' | 'vty', protocol: Transport | 'console'): ('username' | 'password')[] {
    if (protocol === 'ssh') return ['password'];
    if (this.aaa.newModel) {
      const methods = this.aaa.loginMethods(line === 'vty' ? this.mgmt.vty.authList : this.mgmt.console.authList, line) ?? [];
      return methods.length === 1 && (methods[0]!.kind === 'line' || methods[0]!.kind === 'enable') ? ['password'] : ['username', 'password'];
    }
    if (line === 'console' || protocol === 'console') return this.mgmt.console.login === 'local' ? ['username', 'password'] : ['password'];
    return this.mgmt.prompts(protocol);
  }

  /**
   * Checks a login on the console or a VTY line. Without `aaa new-model` that is the line password
   * or the local users; with it, the line's method list, which may ask RADIUS or TACACS+ servers
   * across the network (the topology runs until they answer or time out).
   */
  login(line: 'console' | 'vty', protocol: Transport | 'console', username: string | undefined, password: string | undefined): LoginResult {
    if (!this.aaa.newModel) return line === 'vty' ? this.mgmt.authenticate(protocol as Transport, username, password) : this.mgmt.authenticateConsole(username, password);
    const cfg = line === 'vty' ? this.mgmt.vty : this.mgmt.console;
    const failed = protocol === 'ssh' ? '% Authentication failed.' : '% Authentication failed';
    const methods = this.aaa.loginMethods(cfg.authList, line);
    if (!methods) return { ok: false, reason: failed };
    const ctx: AaaContext = { username, password, linePassword: cfg.password };
    let result: LoginResult | undefined;
    this.aaa.authenticate(methods, ctx, (o) => {
      if (o.status !== 'pass') {
        result = { ok: false, reason: failed };
        return;
      }
      // The console is only authorized with `aaa authorization console`.
      const skip = line === 'console' && !this.aaa.authorizeConsole;
      const list = skip ? undefined : this.aaa.authorization.get(cfg.authorList ?? 'default');
      this.aaa.authorize(list, ctx, (privilege) => {
        result = privilege === undefined ? { ok: false, reason: '% Authorization failed.' } : { ok: true, privilege };
        if (result.ok) this.aaa.account('start', username);
      });
    });
    if (!result) this.network?.run();
    return result ?? { ok: false, reason: failed };
  }

  /** `test aaa group <group> <user> <password> legacy`: asks the servers directly. */
  testAaa(group: string, username: string, password: string): 'pass' | 'fail' | 'error' {
    let outcome: 'pass' | 'fail' | 'error' | undefined;
    this.aaa.authenticate([{ kind: 'group', group }], { username, password }, (o) => (outcome = o.status));
    if (!outcome) this.network?.run();
    return outcome ?? 'error';
  }

  // ---------------------------------------------------------------- SNMP traps

  /** Sends a trap (sysUpTime, the trap OID, then `varbinds`) to every trap host. */
  protected sendTrap(trapOid: string, extra: SnmpMessage['varbinds']): void {
    if (!this.snmp.trapsEnabled) return;
    const varbinds: SnmpMessage['varbinds'] = [
      { oid: '1.3.6.1.2.1.1.3.0', type: 'Timeticks', value: Math.floor(this.now / 10) },
      { oid: '1.3.6.1.6.3.1.1.4.1.0', type: 'OID', value: trapOid },
      ...extra,
    ];
    for (const h of this.snmp.hosts) {
      const security = h.version === '3' ? { user: h.name, ...(this.snmp.userKeys(h.name) ?? { level: 'noAuthNoPriv' as const }) } : { community: h.name };
      const snmp: SnmpMessage = { version: h.version, pdu: 'trap', requestId: ++trapRequestId, varbinds, ...security };
      if (this.originate(h.address, (src) => ({ kind: 'udp', src, dst: h.address, ttl: 255, srcPort: 161, dstPort: 162, snmp }))) this.snmp.stats.traps++;
    }
  }

  /** Sends a linkUp or linkDown trap to every trap host. */
  private sendLinkTrap(i: Interface, up: boolean): void {
    const index = this.interfaces.indexOf(i) + 1;
    this.sendTrap(up ? '1.3.6.1.6.3.1.1.5.4' : '1.3.6.1.6.3.1.1.5.3', [
      { oid: `1.3.6.1.2.1.2.2.1.1.${index}`, type: 'INTEGER', value: index },
      { oid: `1.3.6.1.2.1.2.2.1.2.${index}`, type: 'STRING', value: i.name },
      { oid: `1.3.6.1.2.1.2.2.1.7.${index}`, type: 'INTEGER', value: i.adminUp ? 1 : 2 },
      { oid: `1.3.6.1.2.1.2.2.1.8.${index}`, type: 'INTEGER', value: up ? 1 : 2 },
    ]);
  }

  /** Compares each interface's line protocol with the last round and traps the changes. */
  private checkLinkTraps(): void {
    for (const i of this.interfaces) {
      if (i.kind === 'radio') continue;
      const was = this.lastOper.get(i);
      this.lastOper.set(i, i.isUp);
      if (was === undefined || was === i.isUp) continue;
      if (this.snmp.trapsEnabled && this.snmp.hosts.length) this.sendLinkTrap(i, i.isUp);
    }
  }

  /** Consumes a CDP or LLDP frame. Returns false for anything else. */
  protected receiveDiscovery(on: Interface, frame: Frame): boolean {
    const p = frame.payload;
    if (p.kind !== 'cdp' && p.kind !== 'lldp') return false;
    this.discovery.receive(on, p);
    const mine = this.nativeVlanOf(on);
    const key = `${on.name}|${p.deviceId}`;
    if (p.kind === 'cdp' && this.discovery.cdpEnabled && on.cdp !== false && mine !== undefined && p.nativeVlan !== undefined && on.mode === 'trunk') {
      if (p.nativeVlan === mine) this.vlanWarnings.delete(key);
      else if (!this.vlanWarnings.has(key)) {
        this.vlanWarnings.add(key);
        this.log.push(`%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on ${on.name} (${mine}), with ${p.deviceId} ${p.portId} (${p.nativeVlan}).`);
      }
    }
    return true;
  }

  /** Start of a round: advertise on every port and ask the NTP servers for the time. */
  protected tickServices(): void {
    this.discovery.tick();
    this.ntp.tick();
  }

  protected settleServices(): boolean {
    this.discovery.settle();
    this.checkLinkTraps();
    return this.ntp.settle();
  }
}
