import { CDP_MAC, LLDP_MAC, type DiscoveryPdu, type Frame, type UdpPacket } from '../core/frames';
import { CDP_HOLDTIME, Discovery, LLDP_HOLDTIME, advertisedAddress } from '../services/discovery';
import { Management } from '../services/management';
import { NtpClock } from '../services/ntp';
import type { Interface } from './device';
import { IpDevice } from './ip-device';

/**
 * What routers and switches share as IOS devices: CDP and LLDP, the clock and NTP, and device
 * access (local users, enable passwords, VTY lines and the SSH server).
 */
export abstract class IosDevice extends IpDevice {
  readonly mgmt = new Management();
  readonly discovery: Discovery;
  readonly ntp: NtpClock;
  /** CDP platform string, as `show cdp neighbors` shows it. */
  abstract readonly platform: string;
  /** The software version line in `show cdp neighbors detail`. */
  abstract readonly software: string;
  /** `service timestamps log ...`: prefix console messages with the time. Off unless configured. */
  logTimestamps?: { kind: 'uptime' | 'datetime'; msec: boolean; localtime: boolean; showTimezone: boolean };
  /** Native VLAN mismatches already logged, so CDP does not repeat itself every round. */
  private readonly vlanWarnings = new Set<string>();

  constructor(hostname: string) {
    super(hostname);
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
    return this.mgmt.listeningPorts();
  }

  protected override handleUdp(p: UdpPacket): void {
    if (!p.ntp || p.dstPort !== 123) return;
    const reply = this.ntp.receive(p.src, p.ntp);
    if (reply) this.sendIp({ kind: 'udp', src: p.dst, dst: p.src, ttl: 255, srcPort: 123, dstPort: p.srcPort, ntp: reply });
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
    return this.ntp.settle();
  }
}
