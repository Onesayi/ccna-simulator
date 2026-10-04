import type { SnmpMessage, TcpPacket, UdpPacket } from '../core/frames';
import { AaaServerService } from '../services/aaa-server';
import { formatVarbind, translateOid } from '../services/snmp';
import { Pc } from './pc';

/** UDP ports a RADIUS server answers on: the standard pair and the old Cisco pair. */
const RADIUS_PORTS = [1812, 1813, 1645, 1646];

/**
 * A Linux server: everything a PC does, plus the network services the operations labs need. It is
 * an AAA server (RADIUS and TACACS+, like ISE), an SNMP manager with a trap receiver, and an
 * automation host with files for Ansible inventories and playbooks.
 */
export class Server extends Pc {
  override readonly kind = 'server' as const;
  readonly aaa: AaaServerService;
  /** Text files on the server (playbooks, inventories), by path. */
  readonly files = new Map<string, string>();
  /** Lines `snmptrapd` wrote, newest last. */
  readonly trapLog: string[] = [];
  private readonly snmpReplies = new Map<number, SnmpMessage>();
  private snmpId = 1000;

  constructor(hostname: string) {
    super(hostname);
    this.aaa = new AaaServerService(() => this.now);
  }

  protected override get listeningPorts(): readonly number[] {
    return [80, 443, ...(this.aaa.clients.size ? [49] : [])];
  }

  /** True while the AAA service has any network device to serve. */
  get aaaRunning(): boolean {
    return this.aaa.clients.size > 0;
  }

  protected override handleUdp(p: UdpPacket): void {
    if (p.radius && RADIUS_PORTS.includes(p.dstPort) && this.aaaRunning) {
      const reply = this.aaa.radius(p.src, p.radius);
      if (reply) this.sendIp({ kind: 'udp', src: p.dst, dst: p.src, ttl: 64, srcPort: p.dstPort, dstPort: p.srcPort, radius: reply });
      return;
    }
    if (!p.snmp) return;
    if (p.dstPort === 162 && p.snmp.pdu === 'trap') return this.logTrap(p.src, p.snmp);
    if (p.snmp.pdu === 'response' || p.snmp.pdu === 'report') this.snmpReplies.set(p.snmp.requestId, p.snmp);
  }

  protected override handleTcpData(p: TcpPacket): void {
    if (!p.tacacs || p.dstPort !== 49 || !this.aaaRunning) return;
    const reply = this.aaa.tacacs(p.src, p.tacacs);
    if (reply) this.sendIp({ kind: 'tcp', src: p.dst, dst: p.src, ttl: 64, srcPort: 49, dstPort: p.srcPort, flags: 'psh', tacacs: reply });
  }

  private logTrap(src: string, m: SnmpMessage): void {
    const trapOid = m.varbinds.find((v) => v.oid === '1.3.6.1.6.3.1.1.4.1.0');
    const who = m.version === '3' ? `v3, user ${m.user}` : `v${m.version}, community ${m.community}`;
    const s = Math.floor(this.now / 1000);
    const t = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    this.trapLog.push(`${t} Trap from ${src} (${who}): ${trapOid ? translateOid(String(trapOid.value)) : 'unknown'}`);
    for (const v of m.varbinds) if (v !== trapOid) this.trapLog.push(`    ${formatVarbind(v)}`);
  }

  /**
   * Sends one SNMP request to an agent and runs the network until it answers. Returns undefined
   * on a timeout: a wrong community, an ACL, or no route all look the same to the manager.
   */
  snmpRequest(dst: string, msg: Omit<SnmpMessage, 'requestId'>): SnmpMessage | undefined {
    const requestId = ++this.snmpId;
    const snmp: SnmpMessage = { ...msg, requestId };
    if (!this.originate(dst, (src) => ({ kind: 'udp', src, dst, ttl: 64, srcPort: 50161, dstPort: 161, snmp }))) return undefined;
    this.network?.run();
    const reply = this.snmpReplies.get(requestId);
    this.snmpReplies.delete(requestId);
    return reply;
  }
}
