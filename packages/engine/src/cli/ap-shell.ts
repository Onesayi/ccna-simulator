import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import { parseOption43, type LightweightAp } from '../devices/ap';
import { Interaction, type Shell } from './remote';

const AP_HELP = `Lightweight AP commands:
  show capwap client rcb                       Controller this AP joined
  show capwap ip config                        Static or DHCP address, and controllers to try
  show ip interface brief                      Interfaces and addresses
  show dot11 associations                      Wireless clients on this AP
  show controllers dot11Radio <0|1>            Radio channel (0 = 2.4 GHz, 1 = 5 GHz)
  capwap ap ip address <ip> <mask>             Static address instead of DHCP
  capwap ap ip default-gateway <ip>            Gateway for the static address
  capwap ap primary-base <wlc-name> <wlc-ip>   Prime the controller to join
  clear capwap ap ip address                   Back to DHCP
  clear capwap ap primary-base                 Forget the primed controller
  ping <ip>                                    Ping from the AP`;

const INVALID = '% Invalid input detected at \'^\' marker.';

/** The console of a lightweight AP: mostly show commands, plus the few `capwap ap` settings it keeps. */
export class ApShell implements Shell {
  readonly io = new Interaction();
  readonly instantHelp = false;

  constructor(readonly ap: LightweightAp) {}

  get prompt(): string {
    return `${this.ap.hostname}#`;
  }

  execute(line: string): string {
    const out = this.run(line.trim().replace(/\s+/g, ' '));
    this.ap.network?.converge();
    return out;
  }

  private run(line: string): string {
    const ap = this.ap;
    const lower = line.toLowerCase();
    const w = line.split(' ');
    if (!line) return '';
    if (lower === '?' || lower === 'help') return AP_HELP;
    if (lower === 'show capwap client rcb') return this.rcb();
    if (lower === 'show capwap ip config') return this.ipConfig();
    if (lower === 'show ip interface brief') return this.brief();
    if (lower === 'show dot11 associations') return this.associations();
    const radio = /^show controllers dot11radio ?([01])$/.exec(lower);
    if (radio) {
      const n = Number(radio[1]);
      return [`interface Dot11Radio${n}`, `Radio ${n === 0 ? '2.4 GHz (802.11b/g/n)' : '5 GHz (802.11a/n/ac)'}, ${ap.radios[n]!.isUp ? 'up' : 'down'}`, `Current Channel ${ap.channels[n]}`, `Beaconing SSIDs: ${ap.joined ? ap.wlans.map((x) => x.ssid).join(', ') || 'none' : 'none (not joined)'}`].join('\n');
    }
    if (/^capwap ap ip address /i.test(line) && w.length === 6) {
      if (!isValidIp(w[4]!)) return INVALID;
      try {
        ap.setStaticIp(w[4]!, parsePrefix(w[5]!), ap.defaultGateway);
      } catch (err) {
        return `% ${(err as Error).message}`;
      }
      return '';
    }
    if (/^capwap ap ip default-gateway /i.test(line) && w.length === 5) {
      if (!isValidIp(w[4]!)) return INVALID;
      if (ap.dhcp) return '% Configure a static address first: capwap ap ip address <ip> <mask>';
      ap.defaultGateway = w[4];
      return '';
    }
    if (/^capwap ap primary-base /i.test(line) && w.length === 5) {
      if (!isValidIp(w[4]!)) return INVALID;
      ap.primaryBase = { name: w[3]!, address: w[4]! };
      return '';
    }
    if (lower === 'clear capwap ap ip address') {
      ap.useDhcp();
      return '';
    }
    if (lower === 'clear capwap ap primary-base') {
      ap.primaryBase = undefined;
      return '';
    }
    if (w[0] === 'ping' && w.length === 2) {
      if (!isValidIp(w[1]!)) return INVALID;
      const results = ap.ping(w[1]!, 5);
      ap.network?.run();
      const ok = results.filter((r) => r.success).length;
      return `Sending 5, 100-byte ICMP Echos to ${w[1]}, timeout is 2 seconds:\n${results.map((r) => (r.success ? '!' : '.')).join('')}\nSuccess rate is ${ok * 20} percent (${ok}/5)`;
    }
    return INVALID;
  }

  private rcb(): string {
    const ap = this.ap;
    if (!ap.controller) return 'AP is not joined to any controller. Use "show capwap ip config" to see what it is trying.';
    return [`AdminState                  : ADMIN_ENABLED`, `SwVer                       : 8.10.185.0`, `Name                        : ${ap.hostname}`, `MwarName                    : ${ap.controller.name}`, `MwarApMgrIp                 : ${ap.controller.address}`, `OperationState              : UP`, `ApMode                      : Local`, `Number of WLANs             : ${ap.wlans.length}`].join('\n');
  }

  private ipConfig(): string {
    const ap = this.ap;
    const ip = ap.nic.ip;
    const lines = [
      `LWAPP Static IP Configuration : ${ap.dhcp ? 'Disabled (DHCP)' : 'Enabled'}`,
      `IP Address                    : ${ip && !ap.apipa ? `${ip.address} ${prefixToMask(ip.prefix)}` : 'none'}`,
      `Default Gateway               : ${ap.defaultGateway ?? 'none'}`,
      `Primary Controller            : ${ap.primaryBase ? `${ap.primaryBase.name} ${ap.primaryBase.address}` : 'not configured'}`,
      `DHCP Option 43 Controllers    : ${parseOption43(ap.lease?.option43).join(', ') || 'none'}`,
    ];
    return lines.join('\n');
  }

  private brief(): string {
    const ap = this.ap;
    const rows = [`${'Interface'.padEnd(23)}${'IP-Address'.padEnd(16)}OK? Method Status                Protocol`];
    for (const i of ap.interfaces) {
      const addr = i === ap.nic && i.ip && !ap.apipa ? i.ip.address : 'unassigned';
      const method = i === ap.nic ? (ap.dhcp ? 'DHCP ' : 'NVRAM') : 'unset';
      const status = i.adminUp ? (i.isUp ? 'up' : 'down') : 'administratively down';
      rows.push(`${i.name.padEnd(23)}${addr.padEnd(16)}YES ${method.padEnd(7)}${status.padEnd(22)}${i.isUp ? 'up' : 'down'}`);
    }
    return rows.join('\n');
  }

  private associations(): string {
    const ap = this.ap;
    const lines = ['802.11 Client Stations on this AP:', '', 'MAC Address    Device      Radio        Name'];
    for (const [mac, s] of ap.stations) lines.push(`${mac.padEnd(15)}ccx-client  ${s.radio.name.padEnd(13)}${s.peer.device.hostname}`);
    return lines.join('\n');
  }
}
