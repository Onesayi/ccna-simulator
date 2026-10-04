import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import { isLinkLocal, isValidIpv6, normaliseIpv6, parseIpv6Prefix } from '../core/ipv6';
import type { Device } from '../devices/device';
import type { PingResult, TracerouteResult } from '../devices/ip-device';
import { Pc } from '../devices/pc';
import { CliSession } from './session';
import { Interaction, beginLogin, parseSsh, type Shell } from './remote';

const PC_HELP = `Available commands:
  ipconfig [/all]                        Show the IP configuration
  ipconfig <ip> <mask|/len> [gateway]    Set a static IP address (Packet Tracer style)
  ipconfig /renew                        Get an address from DHCP
  ipconfig /release                      Give the DHCP address back
  ipv6config                             Show the IPv6 configuration
  ipv6config <ipv6>/<len> [gateway]      Set a static IPv6 address
  ipv6config autoconfig                  Get an IPv6 address with SLAAC
  ping [-n count] <ip|ipv6>              Send ICMP echo requests
  tracert <ip|ipv6>                      Trace the route to a host
  arp -a                                 Show the ARP cache
  arp -d                                 Clear the ARP cache
  telnet <ip> [port]                     Open a telnet session (or a TCP connection to a port)
  ssh -l <user> <ip>                     Open an SSH session
  curl http://<ip>[:port]                Fetch a web page (tests TCP 80 or 443)
  arpspoof <ip> [-n count]               Lab attack tool: gratuitous ARP claiming <ip> (ARP poisoning)`;

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
        return PC_HELP;
      case 'ipconfig':
        return this.ipconfigCommand(args);
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
        return `${this.ipconfig(false)}\nAn error occurred while renewing interface Ethernet0 : unable to contact your DHCP server. Request has timed out.`;
      }
      return this.ipconfig(false);
    }
    if (flag === '/release') {
      this.pc.release();
      this.pc.network?.run();
      return this.ipconfig(false);
    }
    return this.setIp(args);
  }

  private ipconfig(all: boolean): string {
    const pc = this.pc;
    const ip = pc.nic.ip;
    const lines = ['', 'Ethernet0 Connection:(default port)', '', `   Connection-specific DNS Suffix..: ${pc.lease?.domain ?? ''}`];
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
    let [address = '', mask, gateway] = args;
    if (address.includes('/')) [address = '', mask, gateway] = [address.split('/')[0]!, address.split('/')[1], args[1]];
    if (!isValidIp(address) || !mask) return 'Invalid Command.';
    if (gateway && !isValidIp(gateway)) return 'Invalid gateway address.';
    try {
      this.pc.configure(address, parsePrefix(mask), gateway);
    } catch (err) {
      return (err as Error).message;
    }
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
    const dst = target(args[0]);
    if (!dst) return `Ping request could not find host ${args[0] ?? ''}. Please check the name and try again.`;
    const results = this.pc.pingAny(dst, count);
    this.pc.network?.run();
    return formatWindowsPing(dst, results);
  }

  private tracert(args: string[]): string {
    const dst = target(args[0]);
    if (!dst) return `Unable to resolve target system name ${args[0] ?? ''}.`;
    const result = this.pc.tracerouteAny(dst);
    this.pc.network?.run();
    return formatWindowsTracert(result);
  }

  protected connect(dst: string, port: number) {
    const result = this.pc.connect(dst, port);
    this.pc.network?.run();
    return result;
  }

  private telnet(args: string[]): string {
    const [dst, p = '23'] = args;
    const port = Number(p);
    if (!dst || !isValidIp(dst) || !Number.isInteger(port) || port < 1 || port > 65535) return 'Usage: telnet <ip> [port]';
    const r = this.connect(dst, port);
    if (r.status === 'open' && port === 23) return `Trying ${dst} ...Open${this.login(dst, 'telnet')}`;
    if (r.status === 'open') return `Trying ${dst} ...Open\n\n[Connection to ${dst} closed by foreign host]`;
    return `Trying ${dst} ...\n% Connection ${r.status === 'refused' ? 'refused by remote host' : 'timed out; remote host not responding'}`;
  }

  private ssh(args: string[]): string {
    const { user, host } = parseSsh(args);
    if (!user || !host || !isValidIp(host)) return 'Usage: ssh -l <username> <ip>';
    const r = this.connect(host, 22);
    if (r.status === 'open') return this.login(host, 'ssh', user);
    return `% Connection ${r.status === 'refused' ? 'refused by remote host' : 'timed out; remote host not responding'}`;
  }

  private login(host: string, protocol: 'ssh' | 'telnet', user?: string): string {
    return beginLogin(this.io, this.pc, host, protocol, user, (device, privilege) => new CliSession(device, { remote: true, privilege }));
  }

  protected curl(args: string[]): string {
    const m = /^(?:(https?):\/\/)?([\d.]+)(?::(\d+))?\/?$/i.exec(args[0] ?? '');
    if (!m || !isValidIp(m[2]!)) return `curl: (3) URL using bad/illegal format or missing URL`;
    const host = m[2]!;
    const port = m[3] ? Number(m[3]) : m[1]?.toLowerCase() === 'https' ? 443 : 80;
    const r = this.connect(host, port);
    if (r.status === 'open') return `<html><body><h1>It works!</h1><p>Served by ${host}:${port}</p></body></html>`;
    if (r.status === 'refused') return `curl: (7) Failed to connect to ${host} port ${port}: Connection refused`;
    if (r.status === 'unreachable' || r.status === 'no-route') return `curl: (7) Failed to connect to ${host} port ${port}: No route to host`;
    return `curl: (28) Failed to connect to ${host} port ${port}: Timed out`;
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

export function formatWindowsPing(dst: string, results: PingResult[]): string {
  const lines = ['', `Pinging ${dst} with 32 bytes of data:`, ''];
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

export function formatWindowsTracert(t: TracerouteResult): string {
  const lines = ['', `Tracing route to ${t.destination} over a maximum of 30 hops:`, ''];
  for (const hop of t.hops) {
    const cells = hop.probes.map((p) => (p.from ? `${p.rttMs! < 1 ? '<1' : p.rttMs} ms` : '*').padEnd(9));
    const who = hop.probes.find((p) => p.from);
    const tail = who ? (who.unreachable ? `${who.from} reports: Destination host unreachable.` : who.from) : 'Request timed out.';
    lines.push(`${String(hop.ttl).padStart(3)}   ${cells.join('')}${tail}`);
  }
  lines.push('', 'Trace complete.', '');
  return lines.join('\n');
}
