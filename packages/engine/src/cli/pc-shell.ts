import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import type { Device } from '../devices/device';
import type { PingResult, TracerouteResult } from '../devices/ip-device';
import { Pc } from '../devices/pc';
import { CliSession, type Shell } from './session';

const PC_HELP = `Available commands:
  ipconfig                               Show the IP configuration
  ipconfig <ip> <mask|/len> [gateway]    Set a static IP address (Packet Tracer style)
  ping [-n count] <ip>                   Send ICMP echo requests
  tracert <ip>                           Trace the route to a host
  arp -a                                 Show the ARP cache
  arp -d                                 Clear the ARP cache`;

/** A Windows-flavoured command prompt for PCs, close to Packet Tracer's. */
export class PcShell implements Shell {
  constructor(readonly pc: Pc) {}

  get prompt(): string {
    return 'C:\\>';
  }

  execute(line: string): string {
    const [cmd = '', ...args] = line.trim().split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '':
        return '';
      case '?':
      case 'help':
        return PC_HELP;
      case 'ipconfig':
        return args.length ? this.setIp(args) : this.ipconfig();
      case 'ping':
        return this.ping(args);
      case 'tracert':
      case 'traceroute':
        return this.tracert(args);
      case 'arp':
        return this.arp(args);
      default:
        return `Invalid Command.`;
    }
  }

  private ipconfig(): string {
    const ip = this.pc.nic.ip;
    return [
      '',
      'Ethernet0 Connection:(default port)',
      '',
      '   Connection-specific DNS Suffix..: ',
      `   Physical Address................: ${this.pc.nic.mac.toUpperCase()}`,
      `   IPv4 Address....................: ${ip?.address ?? '0.0.0.0'}`,
      `   Subnet Mask.....................: ${ip ? prefixToMask(ip.prefix) : '0.0.0.0'}`,
      `   Default Gateway.................: ${this.pc.defaultGateway ?? '0.0.0.0'}`,
      '',
    ].join('\n');
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

  private ping(args: string[]): string {
    let count = 4;
    const n = args.findIndex((a) => a.toLowerCase() === '-n');
    if (n >= 0) {
      count = Number(args[n + 1]);
      args = args.filter((_, i) => i !== n && i !== n + 1);
      if (!Number.isInteger(count) || count < 1 || count > 100) return 'Bad value for option -n.';
    }
    const dst = args[0];
    if (!dst || !isValidIp(dst)) return `Ping request could not find host ${dst ?? ''}. Please check the name and try again.`;
    const results = this.pc.ping(dst, count);
    this.pc.network?.run();
    return formatWindowsPing(dst, results);
  }

  private tracert(args: string[]): string {
    const dst = args[0];
    if (!dst || !isValidIp(dst)) return `Unable to resolve target system name ${dst ?? ''}.`;
    const result = this.pc.traceroute(dst);
    this.pc.network?.run();
    return formatWindowsTracert(result);
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

export function formatWindowsPing(dst: string, results: PingResult[]): string {
  const lines = ['', `Pinging ${dst} with 32 bytes of data:`, ''];
  for (const r of results) {
    if (r.status === 'success') lines.push(`Reply from ${dst}: bytes=32 time${r.rttMs! < 1 ? '<1' : '='}${r.rttMs! < 1 ? '' : r.rttMs}ms TTL=${r.ttl}`);
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

/** The right terminal for a device: a command prompt for PCs, the IOS CLI for everything else. */
export function createShell(device: Device): Shell {
  return device instanceof Pc ? new PcShell(device) : new CliSession(device);
}
