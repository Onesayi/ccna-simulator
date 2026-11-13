import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import { isLinkLocal, isValidIpv6, normaliseIpv6, parseIpv6Prefix } from '../core/ipv6';
import type { Device } from '../devices/device';
import type { PingResult, TracerouteResult } from '../devices/ip-device';
import { Pc } from '../devices/pc';
import { CliSession } from './session';
import { Interaction, beginLogin, parseSsh, type Shell } from './remote';
import { SECURITY_LABEL } from '../wireless/wifi';
import type { DnsMessage, DnsRecord, DnsType } from '../core/frames';
import { trafficCommand } from '../services/traffic';
import { DNS_TYPES, RCODE_TEXT, canonicalName, formatRecord, reverseName, soaBlock } from '../services/dns';

const PC_HELP = `Available commands:
  ipconfig [/all]                        Show the IP configuration
  ipconfig <ip> <mask|/len> [gateway] [dns]   Set a static IP address (Packet Tracer style)
  ipconfig /renew                        Get an address from DHCP
  ipconfig /release                      Give the DHCP address back
  ipconfig /flushdns                     Clear the DNS resolver cache
  netsh interface ip set dns Ethernet0 static <ip> | dhcp   Set the DNS server
  nslookup [-type=A|AAAA|CNAME|MX|NS|PTR|SOA] <name|ip> [server]   Ask a DNS server
  ipv6config                             Show the IPv6 configuration
  ipv6config <ipv6>/<len> [gateway]      Set a static IPv6 address
  ipv6config autoconfig                  Get an IPv6 address with SLAAC
  ping [-n count] [-v tos] <host>        Send ICMP echo requests (-v sets the ToS byte: 184 is DSCP EF)
  tracert <host>                         Trace the route to a host
  arp -a                                 Show the ARP cache
  arp -d                                 Clear the ARP cache
  telnet <host> [port]                   Open a telnet session (or a TCP connection to a port)
  ssh -l <user> <host>                   Open an SSH session
  curl http://<host>[:port]              Fetch a web page (tests TCP 80 or 443)
  (<host> is an IPv4 or IPv6 address, or a name the DNS server resolves)
  arpspoof <ip> [-n count]               Lab attack tool: gratuitous ARP claiming <ip> (ARP poisoning)
  fake_router6 <prefix>/64               Lab attack tool: rogue IPv6 router advertisement
  flood broadcast|multicast|unicast [-n count]   Lab traffic generator: count frames in one second (default 1000)
  traffic add <name> <ip> rate <kbps> [dscp <v>] [udp|tcp <port>] [size <bytes>] [burst <on-ms> <off-ms>]
  traffic [delete <name> | clear]        List or remove this host's traffic flows
  traffic run [seconds]                  Run every host's flows at once: rates, loss, delay and jitter`;

const WIFI_HELP = `
Wi-Fi (laptops):
  netsh wlan show networks               WLANs in range
  netsh wlan connect ssid=<ssid> key=<passphrase>
  netsh wlan connect ssid=<ssid> user=<name> password=<password>   (WPA2-Enterprise)
  netsh wlan show interfaces             Connection state, SSID, BSSID and channel
  netsh wlan disconnect                  Leave the network`;

/** A Windows-flavoured command prompt for PCs, close to Packet Tracer's. */
export class PcShell implements Shell {
  readonly io = new Interaction();

  constructor(readonly pc: Pc) {}

  get prompt(): string {
    return this.io.prompt ?? 'C:\\>';
  }

  get masked(): boolean {
    return this.io.masked;
  }

  get instantHelp(): boolean {
    return this.io.remote !== undefined && this.io.instantHelp;
  }

  /** The command prompt has no Tab completion of its own; inside telnet or SSH the far end completes. */
  complete(line: string): string | undefined {
    return this.io.complete(line);
  }

  execute(line: string): string {
    const out = this.io.active ? this.io.execute(line) : this.run(line);
    this.pc.network?.converge();
    return out;
  }

  protected run(line: string): string {
    const [cmd = '', ...args] = line.trim().split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '':
        return '';
      case '?':
      case 'help':
        return this.pc.wifi ? PC_HELP + WIFI_HELP : PC_HELP;
      case 'netsh':
        return this.netsh(args);
      case 'ipconfig':
        return this.ipconfigCommand(args);
      case 'nslookup':
        return this.nslookup(args);
      case 'ipv6config':
        return this.ipv6config(args);
      case 'ping':
        return this.ping(args);
      case 'tracert':
      case 'traceroute':
        return this.tracert(args);
      case 'arp':
        return this.arp(args);
      case 'telnet':
        return this.telnet(args);
      case 'ssh':
        return this.ssh(args);
      case 'curl':
        return this.curl(args);
      case 'arpspoof':
        return this.arpspoof(args);
      case 'fake_router6':
        return this.fakeRouter6(args);
      case 'flood':
        return this.flood(args);
      case 'traffic':
        return trafficCommand(this.pc, args);
      default:
        return `Invalid Command.`;
    }
  }

  private ipconfigCommand(args: string[]): string {
    const flag = args[0]?.toLowerCase();
    if (!flag) return this.ipconfig(false);
    if (flag === '/all') return this.ipconfig(true);
    if (flag === '/renew') {
      this.pc.renew();
      this.pc.network?.run();
      if (this.pc.dhcpState !== 'bound') {
        return `${this.ipconfig(false)}\nAn error occurred while renewing interface ${this.pc.nic.name} : unable to contact your DHCP server. Request has timed out.`;
      }
      return this.ipconfig(false);
    }
    if (flag === '/flushdns') return '\nWindows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.\n';
    if (flag === '/release') {
      this.pc.release();
      this.pc.network?.run();
      return this.ipconfig(false);
    }
    return this.setIp(args);
  }

  // ---------------------------------------------------------------- Wi-Fi

  private netsh(args: string[]): string {
    const wifi = this.pc.wifi;
    const [ctx, verb, ...rest] = args.map((a, i) => (i < 2 ? a.toLowerCase() : a));
    if (ctx === 'interface') return this.netshDns(args);
    if (ctx !== 'wlan') return 'The following command was not found: netsh ' + args.join(' ');
    if (!wifi) return 'There is no wireless interface on the system.';
    if (verb === 'show' && rest[0]?.toLowerCase() === 'networks') return this.networks();
    if (verb === 'show' && rest[0]?.toLowerCase() === 'interfaces') return this.wifiStatus();
    if (verb === 'disconnect') {
      wifi.disconnect();
      this.pc.network?.run();
      return 'Disconnection request was completed successfully for interface "Wireless0".';
    }
    if (verb === 'connect') {
      const opts: Record<string, string> = {};
      for (const a of rest) {
        const at = a.indexOf('=');
        if (at > 0) opts[a.slice(0, at).toLowerCase()] = a.slice(at + 1);
      }
      const ssid = opts.ssid ?? opts.name;
      if (!ssid) return 'Usage: netsh wlan connect ssid=<ssid> [key=<passphrase>] [user=<name> password=<password>]';
      wifi.connect({ ssid, key: opts.key, username: opts.user, password: opts.password });
      this.pc.network?.run();
      if (wifi.connected) return 'Connection request was completed successfully.';
      const reason = wifi.reason ?? 'The access point did not answer.';
      if (wifi.state !== 'disconnected') wifi.disconnect();
      return `Unable to connect to "${ssid}". ${reason}`;
    }
    return 'Usage: netsh wlan show networks | show interfaces | connect ssid=<ssid> ... | disconnect';
  }

  private networks(): string {
    const seen = new Map<string, { auth: string; cipher: string; bssids: string[] }>();
    for (const b of this.pc.wifi!.scanAll()) {
      const entry = seen.get(b.wlan.ssid) ?? { ...SECURITY_LABEL[b.wlan.security], bssids: [] };
      entry.bssids.push(`${b.radio.mac} (${b.apName}, channel ${b.channel})`);
      seen.set(b.wlan.ssid, entry);
    }
    const lines = ['', `Interface name : ${this.pc.nic.name}`, `There are ${seen.size} networks currently visible.`];
    let n = 0;
    for (const [ssid, e] of seen) {
      lines.push('', `SSID ${++n} : ${ssid}`, '    Network type            : Infrastructure', `    Authentication          : ${e.auth}`, `    Encryption              : ${e.cipher}`);
      e.bssids.forEach((b, k) => lines.push(`    BSSID ${k + 1}                 : ${b}`));
    }
    return lines.join('\n');
  }

  private wifiStatus(): string {
    const w = this.pc.wifi!;
    const lines = ['', 'There is 1 interface on the system:', '', `    Name                   : ${this.pc.nic.name}`, `    Physical address       : ${this.pc.nic.mac}`, `    State                  : ${w.connected ? 'connected' : w.state === 'disconnected' ? 'disconnected' : 'authenticating'}`];
    if (w.connected && w.bss) {
      lines.push(
        `    SSID                   : ${w.bss.wlan.ssid}`,
        `    BSSID                  : ${w.bss.radio.mac}`,
        `    Authentication         : ${SECURITY_LABEL[w.bss.wlan.security].auth}`,
        `    Cipher                 : ${SECURITY_LABEL[w.bss.wlan.security].cipher}`,
        `    Radio type             : ${w.bss.radio.name.endsWith('0') ? '802.11n' : '802.11ac'}`,
        `    Channel                : ${w.bss.channel}`,
        `    Access point           : ${w.bss.apName}`,
      );
    } else if (w.reason) lines.push(`    Last error             : ${w.reason}`);
    return lines.join('\n');
  }

  private ipconfig(all: boolean): string {
    const pc = this.pc;
    const ip = pc.nic.ip;
    const lines = ['', `${this.pc.nic.name} Connection:(default port)`, '', `   Connection-specific DNS Suffix..: ${pc.lease?.domain ?? ''}`];
    lines.push(`   Physical Address................: ${pc.nic.mac.toUpperCase()}`);
    lines.push(`   Link-local IPv6 Address.........: ${pc.ipv6.linkLocal(pc.nic).toUpperCase()}`);
    for (const a of pc.ipv6.globals(pc.nic)) lines.push(`   IPv6 Address....................: ${a.address.toUpperCase()}/${a.prefix}`);
    lines.push(
      `   ${pc.apipa ? 'Autoconfiguration IPv4 Address..' : 'IPv4 Address....................'}: ${ip?.address ?? '0.0.0.0'}`,
      `   Subnet Mask.....................: ${ip ? prefixToMask(ip.prefix) : '0.0.0.0'}`,
    );
    // Windows lists the IPv6 gateway first, with the IPv4 one underneath.
    const gateways = [pc.gateway6?.toUpperCase(), pc.defaultGateway ?? (pc.gateway6 ? undefined : '0.0.0.0')].filter((g): g is string => !!g);
    lines.push(`   Default Gateway.................: ${gateways[0]}`, ...gateways.slice(1).map((g) => `${' '.repeat(37)}${g}`));
    if (all) {
      lines.push(`   DHCP Enabled....................: ${pc.dhcp ? 'Yes' : 'No'}`);
      if (pc.lease?.serverId) lines.push(`   DHCP Server.....................: ${pc.lease.serverId}`);
      lines.push(`   DNS Servers.....................: ${pc.dnsServer ?? '0.0.0.0'}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private setIp(args: string[]): string {
    // Accept "ipconfig 10.0.0.5 255.255.255.0 10.0.0.1" and "ipconfig 10.0.0.5/24 10.0.0.1".
    let [address = '', mask, gateway, dns] = args;
    if (address.includes('/')) [address = '', mask, gateway, dns] = [address.split('/')[0]!, address.split('/')[1], args[1], args[2]];
    if (!isValidIp(address) || !mask) return 'Invalid Command.';
    if (gateway && !isValidIp(gateway)) return 'Invalid gateway address.';
    if (dns && !isValidIp(dns)) return 'Invalid DNS server address.';
    try {
      this.pc.configure(address, parsePrefix(mask), gateway);
    } catch (err) {
      return (err as Error).message;
    }
    if (dns) this.pc.dnsServer = dns;
    return '';
  }

  private ipv6config(args: string[]): string {
    const pc = this.pc;
    const [first, gateway] = args;
    if (first && /^\/?auto/i.test(first)) {
      pc.autoconfigureIpv6();
      pc.network?.run();
      if (!pc.ipv6.globals(pc.nic).length) return 'No router advertisement received. Only the link-local address is configured.';
    } else if (first) {
      let parsed: { address: string; prefix: number };
      try {
        parsed = parseIpv6Prefix(first);
      } catch {
        return 'Invalid Command.';
      }
      if (isLinkLocal(parsed.address)) return 'Use a global or unique local address; the link-local address is automatic.';
      if (gateway && !isValidIpv6(gateway)) return 'Invalid gateway address.';
      pc.configureIpv6(parsed.address, parsed.prefix, gateway);
      return '';
    }
    const v6 = pc.nic.ipv6!;
    const lines = ['', 'Ethernet0 Connection:(default port)', ''];
    lines.push(`   IPv6 configuration..............: ${v6.autoconfig ? 'Automatic (SLAAC)' : 'Static'}`);
    lines.push(`   Link-local IPv6 Address.........: ${pc.ipv6.linkLocal(pc.nic).toUpperCase()}`);
    for (const a of pc.ipv6.globals(pc.nic)) lines.push(`   IPv6 Address....................: ${a.address.toUpperCase()}/${a.prefix}`);
    lines.push(`   Default Gateway.................: ${pc.gateway6?.toUpperCase() ?? '::'}`, '');
    return lines.join('\n');
  }

  private ping(args: string[]): string {
    let count = 4;
    const n = args.findIndex((a) => a.toLowerCase() === '-n');
    if (n >= 0) {
      count = Number(args[n + 1]);
      args = args.filter((_, i) => i !== n && i !== n + 1);
      if (!Number.isInteger(count) || count < 1 || count > 100) return 'Bad value for option -n.';
    }
    // Windows' -v sets the whole ToS byte; the DSCP is its top six bits.
    let dscp: number | undefined;
    const v = args.findIndex((a) => a.toLowerCase() === '-v');
    if (v >= 0) {
      const tos = Number(args[v + 1]);
      args = args.filter((_, i) => i !== v && i !== v + 1);
      if (!Number.isInteger(tos) || tos < 0 || tos > 255) return 'Bad value for option -v, valid range is from 0 to 255.';
      dscp = tos >> 2;
    }
    const host = this.host(args[0]);
    if (!host) return `Ping request could not find host ${args[0] ?? ''}. Please check the name and try again.`;
    const results = this.pc.pingAny(host.address, count, undefined, dscp);
    this.pc.network?.run();
    return formatWindowsPing(host.address, results, host.name);
  }

  private tracert(args: string[]): string {
    const host = this.host(args[0]);
    if (!host) return `Unable to resolve target system name ${args[0] ?? ''}.`;
    const result = this.pc.tracerouteAny(host.address);
    this.pc.network?.run();
    return formatWindowsTracert(result, host.name);
  }

  protected connect(dst: string, port: number) {
    const result = this.pc.connect(dst, port);
    this.pc.network?.run();
    return result;
  }

  private telnet(args: string[]): string {
    const [name, p = '23'] = args;
    const port = Number(p);
    if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return 'Usage: telnet <host> [port]';
    const dst = this.host(name)?.address;
    if (!dst) return `Connecting To ${name}...Could not open connection to the host, on port ${port}: Connect failed`;
    if (!isValidIp(dst)) return 'Usage: telnet <host> [port]';
    const r = this.connect(dst, port);
    if (r.status === 'open' && port === 23) return `Trying ${dst} ...Open${this.login(dst, 'telnet')}`;
    if (r.status === 'open') return `Trying ${dst} ...Open\n\n[Connection to ${dst} closed by foreign host]`;
    return `Trying ${dst} ...\n% Connection ${r.status === 'refused' ? 'refused by remote host' : 'timed out; remote host not responding'}`;
  }

  private ssh(args: string[]): string {
    const { user, host: name } = parseSsh(args);
    if (!user || !name) return 'Usage: ssh -l <username> <host>';
    const host = this.host(name)?.address;
    if (!host || !isValidIp(host)) return `ssh: Could not resolve hostname ${name}: No such host is known.`;
    const r = this.connect(host, 22);
    if (r.status === 'open') return this.login(host, 'ssh', user);
    return `% Connection ${r.status === 'refused' ? 'refused by remote host' : 'timed out; remote host not responding'}`;
  }

  private login(host: string, protocol: 'ssh' | 'telnet', user?: string): string {
    return beginLogin(this.io, this.pc, host, protocol, user, (device, privilege) => new CliSession(device, { remote: true, privilege }));
  }

  protected curl(args: string[]): string {
    const m = /^(?:(https?):\/\/)?([\w.-]+)(?::(\d+))?\/?$/i.exec(args[0] ?? '');
    if (!m || (/^[\d.]+$/.test(m[2]!) && !isValidIp(m[2]!))) return `curl: (3) URL using bad/illegal format or missing URL`;
    const host = this.host(m[2]!)?.address;
    if (!host || !isValidIp(host)) return `curl: (6) Could not resolve host: ${m[2]}`;
    const port = m[3] ? Number(m[3]) : m[1]?.toLowerCase() === 'https' ? 443 : 80;
    const r = this.connect(host, port);
    if (r.status === 'open') return `<html><body><h1>It works!</h1><p>Served by ${host}:${port}</p></body></html>`;
    if (r.status === 'refused') return `curl: (7) Failed to connect to ${host} port ${port}: Connection refused`;
    if (r.status === 'unreachable' || r.status === 'no-route') return `curl: (7) Failed to connect to ${host} port ${port}: No route to host`;
    return `curl: (28) Failed to connect to ${host} port ${port}: Timed out`;
  }

  /** An address typed as is, or a name looked up through the PC's DNS server. */
  protected host(arg: string | undefined): { address: string; name?: string } | undefined {
    const address = target(arg);
    if (address) return { address };
    if (!arg || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/i.test(arg) || /^[\d.]+$/.test(arg)) return undefined;
    const r = this.pc.resolveName(arg);
    return r.address ? { address: r.address, name: r.fqdn } : undefined;
  }

  /** `netsh interface ip set dns "Ethernet0" static 192.168.1.100` (or `dhcp`). */
  private netshDns(args: string[]): string {
    const words = args.map((a) => a.toLowerCase().replace(/^name=/, '').replace(/"/g, ''));
    const at = words.findIndex((w) => w === 'static' || w === 'source=static' || w === 'dhcp' || w === 'source=dhcp');
    if (!(words[1] === 'ip' || words[1] === 'ipv4') || words[2] !== 'set') return `The following command was not found: netsh ${args.join(' ')}`;
    if (words[3] !== 'dns' || at < 0) return 'Usage: netsh interface ip set dns Ethernet0 static <ip> | dhcp';
    if (words[at]!.endsWith('dhcp')) {
      this.pc.dnsServer = this.pc.lease?.dns;
      return '';
    }
    const server = args[at + 1]?.replace(/^addr=/i, '');
    if (!server || !isValidIp(server)) return 'The parameter is incorrect.';
    this.pc.dnsServer = server;
    return '';
  }

  /** Windows nslookup: names the server (by a reverse lookup of its address), then asks the question. */
  private nslookup(args: string[]): string {
    let qtype: DnsType | undefined;
    const rest: string[] = [];
    for (const a of args) {
      const m = /^-(?:type|q|querytype)=(\w+)$/i.exec(a);
      if (!m) {
        rest.push(a);
        continue;
      }
      const t = m[1]!.toUpperCase() as DnsType;
      if (!DNS_TYPES.includes(t)) return `unknown query type: ${m[1]}`;
      qtype = t;
    }
    const [name, serverArg] = rest;
    if (!name) return 'Usage: nslookup [-type=A|AAAA|CNAME|MX|NS|PTR|SOA] <name|ip> [server]';
    if (serverArg && !isValidIp(serverArg)) return `*** Can't find address for server ${serverArg}: Non-existent domain`;
    const server = serverArg ?? this.pc.dnsServer;
    if (!server) return ['*** Default servers are not available', 'Server:  UnKnown', 'Address:  127.0.0.1', '', `*** UnKnown can't find ${name}: No response from server`].join('\n');
    const timedOut = ['DNS request timed out.', '    timeout was 2 seconds.'];
    const out: string[] = [];
    const ptr = this.pc.dnsQuery(server, reverseName(server), 'PTR');
    if (ptr.status !== 'answer') out.push(...timedOut);
    const serverName = (ptr.status === 'answer' && ptr.reply.answers?.find((a) => a.type === 'PTR')?.data) || 'UnKnown';
    out.push(`Server:  ${serverName}`, `Address:  ${server}`, '');
    const reverse = isValidIp(name);
    const suffix = this.pc.searchSuffix;
    const qname = reverse ? reverseName(name) : canonicalName(!name.includes('.') && suffix ? `${name}.${suffix}` : name);
    const types: DnsType[] = qtype ? [qtype] : reverse ? ['PTR'] : ['A', 'AAAA'];
    const replies: DnsMessage[] = [];
    for (const t of types) {
      const r = this.pc.dnsQuery(server, qname, t);
      if (r.status !== 'answer') return [...out, ...timedOut, `*** Request to ${serverName} timed-out`].join('\n');
      replies.push(r.reply);
    }
    const failed = replies.find((r) => r.rcode && r.rcode !== 'NOERROR');
    if (failed) return [...out, `*** ${serverName} can't find ${reverse ? name : qname}: ${RCODE_TEXT[failed.rcode!]}`].join('\n');
    const answers = replies.flatMap((r) => r.answers ?? []);
    if (answers.length && !replies.every((r) => r.aa)) out.push('Non-authoritative answer:');
    const typed = qtype !== undefined && qtype !== 'A' && qtype !== 'AAAA';
    if (typed || (reverse && qtype)) {
      if (!answers.length) out.push(...replies.flatMap((r) => (r.authority ?? []).filter((a) => a.type === 'SOA').map(soaBlock)));
      out.push(...answers.map(formatRecord));
      const extra = dedupe(replies.flatMap((r) => r.additional ?? []));
      if (extra.length) out.push('', ...extra.map(formatRecord));
    } else if (reverse) {
      const p = answers.find((a) => a.type === 'PTR');
      out.push(`Name:    ${p?.data ?? qname}`, `Address:  ${name}`);
    } else {
      const addresses = dedupe(answers.filter((a) => a.type === 'A' || a.type === 'AAAA'));
      const aliases = [...new Set(answers.filter((a) => a.type === 'CNAME').map((a) => a.name))];
      out.push(`Name:    ${addresses[0]?.name ?? answers.find((a) => a.type === 'CNAME' && !aliases.includes(a.data))?.data ?? qname}`);
      // Windows lists IPv6 addresses before IPv4 ones.
      const list = [...addresses.filter((a) => a.type === 'AAAA'), ...addresses.filter((a) => a.type === 'A')].map((a) => a.data);
      if (list.length) out.push(`${list.length > 1 ? 'Addresses' : 'Address'}:  ${list.join('\n          ')}`);
      if (aliases.length) out.push(`Aliases:  ${aliases.join('\n          ')}`);
    }
    out.push('');
    return out.join('\n');
  }

  private arpspoof(args: string[]): string {
    let count = 1;
    const n = args.findIndex((a) => a.toLowerCase() === '-n');
    if (n >= 0) {
      count = Number(args[n + 1]);
      args = args.filter((_, i) => i !== n && i !== n + 1);
      if (!Number.isInteger(count) || count < 1 || count > 500) return 'Bad value for option -n.';
    }
    const ip = args[0];
    if (!ip || !isValidIp(ip)) return 'Usage: arpspoof <ip> [-n count]';
    if (!this.pc.nic.isUp) return 'Ethernet0 is not connected.';
    this.pc.gratuitousArp(ip, count);
    this.pc.network?.run();
    const mac = this.pc.nic.mac;
    return `Sent ${count} gratuitous ARP ${count === 1 ? 'reply' : 'replies'}: ${ip} is-at ${mac}`;
  }

  private fakeRouter6(args: string[]): string {
    let parsed: { address: string; prefix: number };
    try {
      parsed = parseIpv6Prefix(args[0] ?? '');
    } catch {
      return 'Usage: fake_router6 <prefix>/64';
    }
    if (!this.pc.nic.isUp) return 'Ethernet0 is not connected.';
    this.pc.rogueRouterAdvert(parsed.address, parsed.prefix);
    this.pc.network?.run();
    return `Starting to advertise router ${this.pc.ipv6.linkLocal(this.pc.nic).toUpperCase()} with prefix ${args[0]!.toUpperCase()} (Press Control-C to end) ...`;
  }

  private flood(args: string[]): string {
    let count = 1000;
    const n = args.findIndex((a) => a.toLowerCase() === '-n');
    if (n >= 0) {
      count = Number(args[n + 1]);
      args = args.filter((_, i) => i !== n && i !== n + 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) return 'Bad value for option -n (1-5000).';
    }
    const kind = (['broadcast', 'multicast', 'unicast'] as const).find((k) => k.startsWith(args[0]?.toLowerCase() ?? '-'));
    if (!kind) return 'Usage: flood broadcast|multicast|unicast [-n count]';
    if (!this.pc.nic.isUp) return 'Ethernet0 is not connected.';
    const before = this.pc.nic.counters.out;
    this.pc.flood(kind, count);
    this.pc.network?.run();
    return `Sent ${this.pc.nic.counters.out - before} ${kind} frames in 1 second (${count} pps).`;
  }

  private arp(args: string[]): string {
    const flag = args[0]?.toLowerCase();
    if (flag === '-d') {
      this.pc.arpTable.clear();
      return '';
    }
    if (flag !== '-a') return PC_HELP;
    if (!this.pc.arpTable.size) return 'No ARP Entries Found';
    const rows = [...this.pc.arpTable].map(([ip, e]) => `  ${ip.padEnd(22)}${e.mac.padEnd(22)}dynamic`);
    return [`  Internet Address      Physical Address      Type`, ...rows].join('\n');
  }
}

/** A valid IPv4 or IPv6 address, normalised, or undefined. */
function target(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.includes(':')) return isValidIpv6(arg) ? normaliseIpv6(arg) : undefined;
  return isValidIp(arg) ? arg : undefined;
}

/** The same record once, however many answers carried it. */
function dedupe(records: DnsRecord[]): DnsRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.name}|${r.type}|${r.data}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatWindowsPing(dst: string, results: PingResult[], name?: string): string {
  const lines = ['', `Pinging ${name ? `${name} [${dst}]` : dst} with 32 bytes of data:`, ''];
  const v6 = dst.includes(':');
  for (const r of results) {
    // Windows leaves the bytes and TTL off IPv6 replies.
    if (r.status === 'success') lines.push(`Reply from ${dst}: ${v6 ? '' : 'bytes=32 '}time${r.rttMs! < 1 ? '<1' : '='}${r.rttMs! < 1 ? '' : r.rttMs}ms${v6 ? '' : ` TTL=${r.ttl}`}`);
    else if (r.status === 'unreachable') lines.push(`Reply from ${r.from}: Destination host unreachable.`);
    else if (r.status === 'ttl-exceeded') lines.push(`Reply from ${r.from}: TTL expired in transit.`);
    else if (r.status === 'no-route') lines.push('PING: transmit failed. General failure.');
    else lines.push('Request timed out.');
  }
  const received = results.filter((r) => r.status === 'success' || r.status === 'unreachable' || r.status === 'ttl-exceeded').length;
  const lost = results.length - received;
  lines.push('', `Ping statistics for ${dst}:`, `    Packets: Sent = ${results.length}, Received = ${received}, Lost = ${lost} (${Math.round((lost / results.length) * 100)}% loss),`);
  const ok = results.filter((r) => r.success).map((r) => r.rttMs ?? 0);
  if (ok.length) {
    const avg = Math.round(ok.reduce((a, b) => a + b, 0) / ok.length);
    lines.push('Approximate round trip times in milli-seconds:', `    Minimum = ${Math.min(...ok)}ms, Maximum = ${Math.max(...ok)}ms, Average = ${avg}ms`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatWindowsTracert(t: TracerouteResult, name?: string): string {
  const lines = ['', `Tracing route to ${name ? `${name} [${t.destination}]` : t.destination} over a maximum of 30 hops:`, ''];
  for (const hop of t.hops) {
    const cells = hop.probes.map((p) => (p.from ? `${p.rttMs! < 1 ? '<1' : p.rttMs} ms` : '*').padEnd(9));
    const who = hop.probes.find((p) => p.from);
    const tail = who ? (who.unreachable ? `${who.from} reports: Destination host unreachable.` : who.from) : 'Request timed out.';
    lines.push(`${String(hop.ttl).padStart(3)}   ${cells.join('')}${tail}`);
  }
  lines.push('', 'Trace complete.', '');
  return lines.join('\n');
}
