import { BROADCAST_MAC, type MacAddress } from '../core/addressing';
import { SLOW_PROTOCOLS_MAC, STP_MAC, type BpduPacket, type ChannelPdu, type Frame, type IpPacket, type Packet, type UdpPacket } from '../core/frames';
import { ArpInspection } from '../switching/arp-inspection';
import { sourceGuardAllows, type SourceBinding } from '../switching/source-guard';
import { channelProtocol, copyL2, negotiates, sameL2, type ChannelView, type MemberFlag } from '../switching/etherchannel';
import { SpanningTree } from '../switching/stp';
import { normaliseIfName, shortName, type ErrDisableReason, type Interface } from './device';
import { IosDevice } from './ios-device';
import type { Ipv4Address } from '../core/addressing';

export interface MacTableEntry {
  vlan: number;
  mac: MacAddress;
  /** A physical port, or the port-channel a bundled member belongs to. */
  port: Interface;
  learnedAt: number;
}

export interface DhcpSnoopingBinding {
  mac: MacAddress;
  ip: Ipv4Address;
  vlan: number;
  port: Interface;
  leaseSeconds: number;
}

/** `ip dhcp snooping ...`: global state, the VLANs it runs on, and the binding table it builds. */
export interface DhcpSnooping {
  enabled: boolean;
  vlans: Set<number>;
  /** Insert option 82 into client requests (on by default). */
  option82: boolean;
  bindings: DhcpSnoopingBinding[];
}

/** `errdisable recovery cause ...` and `errdisable recovery interval ...`. */
export interface ErrRecovery {
  causes: Set<string>;
  /** Seconds before an err-disabled port is brought back (default 300). */
  interval: number;
}

/** Causes `errdisable recovery cause` accepts, in the order `show errdisable recovery` lists them. */
export const ERR_RECOVERY_CAUSES = ['arp-inspection', 'bpduguard', 'channel-misconfig', 'dhcp-rate-limit', 'link-flap', 'psecure-violation'];

/** MAC address table aging time, matching the Catalyst default of 300 seconds. */
export const MAC_AGING_MS = 300_000;

/**
 * A Catalyst-style switch: VLAN-aware MAC learning, flooding and 802.1Q trunking, plus
 * SVIs (`interface vlan 10`) for management, and inter-VLAN routing once `ip routing` is on.
 * Runs per-VLAN spanning tree, bundles ports into EtherChannels (LACP, PAgP or static) and
 * enforces port security, DHCP snooping, Dynamic ARP Inspection and IP Source Guard.
 */
export class Switch extends IosDevice {
  readonly kind = 'switch' as const;
  readonly platform = 'cisco WS-C2960-24TT-L';
  readonly software = 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)';
  readonly snooping: DhcpSnooping = { enabled: false, vlans: new Set(), option82: true, bindings: [] };
  /** `ip source binding ...`: static entries for IP Source Guard. */
  readonly staticBindings: SourceBinding[] = [];
  readonly dai: ArpInspection;
  readonly errRecovery: ErrRecovery = { causes: new Set(), interval: 300 };
  /** When each port was err-disabled, for the recovery timer. */
  private readonly errDisabledAt = new Map<Interface, number>();
  /** Snooping drops already logged, so retransmits do not flood the console. */
  private readonly snoopWarnings = new Set<string>();
  readonly vlans = new Map<number, string>([[1, 'default']]);
  readonly macTable: MacTableEntry[] = [];
  /** `ip routing`: turns the switch into a Layer 3 switch that routes between its SVIs. */
  ipRouting = false;
  readonly stp: SpanningTree;
  /** LACP and PAgP messages heard on each member port in the current round. */
  private channelHeard = new Map<Interface, ChannelPdu>();
  /** Member flags from the last round, for `show etherchannel summary`. */
  private memberFlags = new Map<Interface, MemberFlag>();
  /** Port-channel line protocol at the end of the last round, to log changes. */
  private channelUp = new Map<Interface, boolean>();

  constructor(hostname: string, portCount = 8) {
    super(hostname);
    for (let i = 1; i <= portCount; i++) this.addInterface(`GigabitEthernet0/${i}`, true);
    this.configureInterface('Vlan1'); // every Catalyst ships with a (shut down) management SVI
    const sw = this;
    this.dai = new ArpInspection({
      now: () => this.now,
      log: this.log,
      bindings: () => this.snooping.bindings,
      errDisable: (port, reason) => this.errDisable(port, reason),
      vlanExists: (vlan) => this.vlans.has(vlan),
    });
    this.stp = new SpanningTree({
      get bridgeMac() {
        return sw.bridgeMac;
      },
      log: this.log,
      vlanIds: () => [...this.vlans.keys()],
      logicalPorts: () => this.logicalPorts(),
      carriesVlan: (p, v) => this.carriesVlan(p, v),
      sendBpdu: (port, bpdu) => this.egress(port, bpdu.vlan, { src: port.mac, dst: STP_MAC, payload: bpdu }),
      defaultCost: (p) => (p.kind === 'port-channel' && this.bundledMembers(p).length > 1 ? 3 : 4),
      portNumber: (p) => (p.kind === 'port-channel' ? 64 : 0) + Number(/(\d+)$/.exec(p.name)?.[1] ?? 0),
      flushMacs: (vlan) => this.flushMacs((e) => e.vlan === vlan && !this.stp.portfast(e.port)),
    });
  }

  get forwarding(): boolean {
    return this.ipRouting;
  }

  /** The switch's base MAC, used in its bridge ID. */
  get bridgeMac(): MacAddress {
    return this.interfaces[0]!.mac;
  }

  /** Physical switchports, without SVIs. */
  get ports(): Interface[] {
    return this.interfaces.filter((i) => i.kind === 'physical');
  }

  get portChannels(): Interface[] {
    return this.interfaces.filter((i) => i.kind === 'port-channel');
  }

  /** What frames are switched between: unbundled physical ports and port-channels with a bundled member. */
  logicalPorts(): Interface[] {
    return [...this.ports.filter((p) => !p.bundled && !this.suspended(p)), ...this.portChannels.filter((po) => this.bundledMembers(po).length > 0)];
  }

  /** A member whose settings do not match its port-channel passes no traffic at all. */
  private suspended(p: Interface): boolean {
    return p.channelGroup !== undefined && this.memberFlags.get(p) === 's';
  }

  members(po: Interface): Interface[] {
    const id = this.channelId(po);
    return this.ports.filter((p) => p.channelGroup?.id === id);
  }

  bundledMembers(po: Interface): Interface[] {
    return this.members(po).filter((p) => p.bundled && p.isUp);
  }

  portChannel(id: number): Interface | undefined {
    return this.portChannels.find((po) => this.channelId(po) === id);
  }

  private channelId(po: Interface): number {
    return Number(/(\d+)$/.exec(po.name)![1]);
  }

  /** The port a frame from `port` belongs to: its port-channel while bundled, otherwise itself. */
  logicalOf(port: Interface): Interface {
    return port.bundled && port.channelGroup ? (this.portChannel(port.channelGroup.id) ?? port) : port;
  }

  svi(vlan: number): Interface | undefined {
    return this.interfaces.find((i) => i.kind === 'svi' && i.vlan === vlan);
  }

  override configureInterface(name: string): Interface {
    const existing = this.findIface(name);
    if (existing) return existing;
    const canonical = normaliseIfName(name);
    const po = /^port-channel(\d+)$/.exec(canonical);
    if (po) return this.createPortChannel(Number(po[1]));
    const m = /^vlan(\d+)$/.exec(canonical);
    if (!m) throw new Error(`Invalid interface ${name}`);
    const vlan = Number(m[1]);
    if (vlan < 1 || vlan > 4094) throw new Error('Invalid VLAN');
    // SVI autostate: up only while the VLAN exists and some port carrying it is up. New SVIs start shut down.
    const iface = this.addInterface(`Vlan${vlan}`, false, 'svi', (i) => i.adminUp && this.vlanActive(i.vlan!));
    iface.vlan = vlan;
    return iface;
  }

  private createPortChannel(id: number): Interface {
    if (id < 1 || id > 48) throw new Error('Invalid port-channel number');
    return this.addInterface(`Port-channel${id}`, true, 'port-channel', (i) => i.adminUp && this.bundledMembers(i).length > 0);
  }

  /**
   * `channel-group <id> mode <mode>`. Creates the port-channel from the member's settings, or
   * copies the existing port-channel's settings onto the member, like IOS does.
   */
  joinChannel(port: Interface, id: number, mode: NonNullable<Interface['channelGroup']>['mode']): string | undefined {
    if (port.kind !== 'physical') throw new Error('Invalid input detected');
    const existing = this.portChannel(id);
    const others = existing ? this.members(existing).filter((p) => p !== port) : [];
    if (others.some((p) => channelProtocol(p.channelGroup!.mode) !== channelProtocol(mode))) {
      throw new Error(`Command rejected (Channel protocol mismatch for interface ${port.name} in group ${id}): the interface can not be added to the channel group`);
    }
    port.channelGroup = { id, mode };
    port.bundled = false;
    if (existing) {
      copyL2(existing, port);
      return undefined;
    }
    const po = this.createPortChannel(id);
    copyL2(port, po);
    return `Creating a port-channel interface Port-channel ${id}`;
  }

  leaveChannel(port: Interface): void {
    port.channelGroup = undefined;
    port.bundled = undefined;
    this.memberFlags.delete(port);
  }

  /** Switchport settings typed on a port-channel apply to its members too. */
  syncChannel(port: Interface): void {
    if (port.kind !== 'port-channel') return;
    for (const m of this.members(port)) copyL2(port, m);
  }

  channels(): ChannelView[] {
    return this.portChannels.map((po) => {
      const members = this.members(po);
      return {
        id: this.channelId(po),
        po,
        members: members.map((port) => ({ port, flag: this.memberFlags.get(port) ?? 'D' })),
        protocol: members[0] ? channelProtocol(members[0].channelGroup!.mode) : 'on',
      };
    });
  }

  private vlanActive(vlan: number): boolean {
    return this.vlans.has(vlan) && this.logicalPorts().some((p) => p.isUp && this.carriesVlan(p, vlan));
  }

  // ---------------------------------------------------------------- frames in

  receive(on: Interface, frame: Frame): void {
    if (this.receiveDiscovery(on, frame)) return;
    const p = frame.payload;
    if (p.kind === 'lacp' || p.kind === 'pagp') {
      if (on.channelGroup) this.channelHeard.set(on, p);
      return;
    }
    if (this.suspended(on)) return;
    if (on.portSecurity?.enabled && !this.portSecurityAllows(on, frame)) return;
    if (p.kind === 'bpdu') return this.receiveBpdu(on, p);

    const ingress = this.logicalOf(on);
    const vlan = this.ingressVlan(ingress, frame);
    if (vlan === undefined) return; // dropped: VLAN not allowed on this port
    if (!this.stp.forwarding(ingress, vlan)) return; // a discarding port neither learns nor forwards

    if (p.kind === 'arp' && this.dai.enabled(vlan) && !(ingress.arpInspection?.trust ?? on.arpInspection?.trust) && !this.dai.inspect(on, vlan, frame, p)) return;
    if (isIpv4(p) && !sourceGuardAllows(this, ingress, vlan, frame, p)) return;

    let out: Frame | undefined = frame;
    if (p.kind === 'udp' && p.dhcp && this.snoopingOn(vlan)) out = this.snoop(on, ingress, vlan, frame, p);
    if (!out) return;
    this.learn(vlan, frame.src, ingress);
    this.switchFrame(vlan, out, ingress);
  }

  // ---------------------------------------------------------------- DHCP snooping

  snoopingOn(vlan: number): boolean {
    return this.snooping.enabled && this.snooping.vlans.has(vlan);
  }

  /** Snooping leases and static bindings, as `show ip source binding` lists them. */
  sourceBindings(): SourceBinding[] {
    return [...this.snooping.bindings.map((b) => ({ ...b, type: 'dhcp-snooping' as const })), ...this.staticBindings];
  }

  /** Trusted ports pass everything; untrusted ports pass client messages only, and get option 82 added. */
  private snoop(on: Interface, ingress: Interface, vlan: number, frame: Frame, p: UdpPacket): Frame | undefined {
    const msg = p.dhcp!;
    const trusted = Boolean(ingress.dhcpSnooping?.trust ?? on.dhcpSnooping?.trust);
    const fromServer = msg.op === 'offer' || msg.op === 'ack' || msg.op === 'nak';
    const drop = (why: string) => {
      const key = `${on.name}|${why}|${frame.src}`;
      if (!this.snoopWarnings.has(key)) {
        this.snoopWarnings.add(key);
        this.log.push(`%DHCP_SNOOPING-5-DHCP_SNOOPING_${why}: DHCP_SNOOPING drop message on untrusted port, message type: DHCP${msg.op.toUpperCase()}, MAC sa: ${frame.src}`);
      }
      return undefined;
    };
    const bindings = this.snooping.bindings;
    const forget = (mac: MacAddress) => {
      for (let k = bindings.length - 1; k >= 0; k--) if (bindings[k]!.mac === mac && bindings[k]!.vlan === vlan) bindings.splice(k, 1);
    };
    if (fromServer) {
      if (!trusted) return drop('UNTRUSTED_PORT');
      if (msg.op === 'nak') forget(msg.chaddr);
      const client = this.macLookup(vlan, msg.chaddr)?.port;
      if (msg.op === 'ack' && msg.yiaddr && client) {
        forget(msg.chaddr);
        bindings.push({ mac: msg.chaddr, ip: msg.yiaddr, vlan, port: client, leaseSeconds: (msg.leaseDays ?? 1) * 86_400 });
      }
      return frame;
    }
    if (trusted) return frame;
    // An untrusted client must use its own MAC as the DHCP hardware address.
    if (msg.chaddr !== frame.src) return drop('MATCH_MAC_FAIL');
    if (msg.op === 'release') forget(msg.chaddr);
    if (!this.snooping.option82 || msg.option82) return frame;
    return { ...frame, payload: { ...p, dhcp: { ...msg, option82: { circuitId: `${vlan}-${shortName(on.name)}`, remoteId: this.bridgeMac } } } };
  }

  private receiveBpdu(on: Interface, bpdu: BpduPacket): void {
    if (this.stp.bpduGuard(on)) {
      this.log.push(`%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${on.name} with BPDU Guard enabled. Disabling port.`);
      return this.errDisable(on, 'bpduguard');
    }
    this.stp.receive(this.logicalOf(on), bpdu);
  }

  /** Port security: learn secure addresses up to the maximum, and act on a violation. */
  private portSecurityAllows(port: Interface, frame: Frame): boolean {
    const ps = port.portSecurity!;
    if (port.mode !== 'access') return true;
    const vlan = port.accessVlan;
    ps.lastSource = { mac: frame.src, vlan };
    if (ps.addresses.some((a) => a.mac === frame.src)) return true;
    if (ps.addresses.length < ps.maximum) {
      ps.addresses.push({ mac: frame.src, vlan, type: ps.sticky ? 'sticky' : 'dynamic' });
      return true;
    }
    if (ps.violation === 'protect') return false;
    ps.violations++;
    if (ps.violation === 'restrict') {
      this.log.push(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${frame.src} on port ${port.name}.`);
      return false;
    }
    this.errDisable(port, 'psecure-violation');
    this.log.push(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${frame.src} on port ${port.name}.`);
    return false;
  }

  /** Shuts a port down after a violation. `shutdown` followed by `no shutdown` recovers it. */
  errDisable(port: Interface, reason: ErrDisableReason): void {
    if (port.errDisabled) return;
    port.errDisabled = reason;
    this.errDisabledAt.set(port, this.now);
    const short = shortName(port.name);
    this.log.push(
      `%PM-4-ERR_DISABLE: ${reason} error detected on ${short}, putting ${short} in err-disable state`,
      `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port.name}, changed state to down`,
      `%LINK-3-UPDOWN: Interface ${port.name}, changed state to down`,
    );
    this.clearDynamicSecure(port);
    this.flushMacs((e) => e.port === port);
  }

  private clearDynamicSecure(port: Interface): void {
    const ps = port.portSecurity;
    if (ps) ps.addresses = ps.addresses.filter((a) => a.type !== 'dynamic');
  }

  /** Forwards a frame within a VLAN. `ingress` is undefined when the frame comes from our own SVI. */
  private switchFrame(vlan: number, frame: Frame, ingress: Interface | undefined): void {
    const svi = this.svi(vlan);
    if (ingress && svi?.isUp && (frame.dst === svi.mac || frame.dst === BROADCAST_MAC)) {
      const { vlan: _tag, ...untagged } = frame;
      this.receiveL3(svi, untagged);
      if (frame.dst === svi.mac) return;
    }

    const known = frame.dst === BROADCAST_MAC ? undefined : this.macLookup(vlan, frame.dst);
    if (known) {
      if (known.port !== ingress && this.stp.forwarding(known.port, vlan)) this.egress(known.port, vlan, frame);
      return;
    }
    for (const port of this.logicalPorts()) {
      if (port !== ingress && port.isUp && this.carriesVlan(port, vlan) && this.stp.forwarding(port, vlan)) this.egress(port, vlan, frame);
    }
  }

  protected override transmitL3(iface: Interface, dstMac: MacAddress, payload: Packet, srcMac: MacAddress = iface.mac): void {
    if (iface.kind !== 'svi') return super.transmitL3(iface, dstMac, payload, srcMac);
    this.switchFrame(iface.vlan!, { src: srcMac, dst: dstMac, payload }, undefined);
  }

  /** MAC table lookup (`lookup` on the base class is the routing table lookup). */
  macLookup(vlan: number, mac: MacAddress): MacTableEntry | undefined {
    return this.macTable.find((e) => e.vlan === vlan && e.mac === mac && this.now - e.learnedAt < MAC_AGING_MS);
  }

  private learn(vlan: number, mac: MacAddress, port: Interface): void {
    const existing = this.macTable.find((e) => e.vlan === vlan && e.mac === mac);
    if (existing) {
      existing.port = port;
      existing.learnedAt = this.now;
    } else {
      this.macTable.push({ vlan, mac, port, learnedAt: this.now });
    }
  }

  private flushMacs(match: (e: MacTableEntry) => boolean): void {
    for (let k = this.macTable.length - 1; k >= 0; k--) if (match(this.macTable[k]!)) this.macTable.splice(k, 1);
  }

  private ingressVlan(port: Interface, frame: Frame): number | undefined {
    if (port.mode === 'access') return frame.vlan === undefined ? port.accessVlan : undefined;
    const vlan = frame.vlan ?? port.nativeVlan;
    return this.carriesVlan(port, vlan) ? vlan : undefined;
  }

  carriesVlan(port: Interface, vlan: number): boolean {
    if (!this.vlans.has(vlan)) return false;
    if (port.mode === 'access') return port.accessVlan === vlan;
    return port.allowedVlans === 'all' || port.allowedVlans.has(vlan);
  }

  /** Sends a frame out of a logical port: tagged on a trunk outside the native VLAN, hashed across a bundle. */
  private egress(port: Interface, vlan: number, frame: Frame): void {
    const tagged = port.mode === 'trunk' && vlan !== port.nativeVlan;
    const { vlan: _drop, ...untagged } = frame;
    const out = tagged ? { ...untagged, vlan } : untagged;
    if (port.kind !== 'port-channel') return this.send(port, out);
    const members = this.bundledMembers(port);
    // src-dst-mac load balancing: the same conversation always uses the same member link.
    const hash = parseInt(frame.src.slice(-4), 16) ^ parseInt(frame.dst.slice(-4), 16);
    const member = members[hash % members.length];
    if (member) this.send(member, out);
  }

  // ---------------------------------------------------------------- control plane rounds

  protected cdpCapabilities(): string[] {
    return this.ipRouting ? ['R', 'S', 'I'] : ['S', 'I'];
  }

  protected lldpCapabilities(): string[] {
    return this.ipRouting ? ['B', 'R'] : ['B'];
  }

  protected override nativeVlanOf(port: Interface): number {
    return port.mode === 'trunk' ? port.nativeVlan : port.accessVlan;
  }

  override tick(): void {
    this.tickServices();
    this.channelHeard.clear();
    for (const p of this.ports) {
      const cg = p.channelGroup;
      // A suspended member stays quiet, so the far end does not bundle a link this end will not use.
      if (!cg || cg.mode === 'on' || !p.isUp || this.suspended(p)) continue;
      const kind = channelProtocol(cg.mode) as 'lacp' | 'pagp';
      this.send(p, { src: p.mac, dst: SLOW_PROTOCOLS_MAC, payload: { kind, mode: cg.mode as ChannelPdu['mode'], system: this.bridgeMac, group: cg.id } });
    }
    this.stp.tick();
  }

  override settle(): boolean {
    let changed = this.settleServices();
    changed = this.settleChannels() || changed;
    changed = this.stp.settle() || changed;
    for (const p of this.ports) if (!p.isUp) this.clearDynamicSecure(p);
    return this.recoverErrDisabled() || changed;
  }

  /** Seconds until each err-disabled port with recovery enabled comes back, for `show errdisable recovery`. */
  recoveryTimers(): { port: Interface; reason: ErrDisableReason; secondsLeft: number }[] {
    return this.ports
      .filter((p) => p.errDisabled && this.errRecovery.causes.has(p.errDisabled))
      .map((p) => {
        const elapsed = (this.now - (this.errDisabledAt.get(p) ?? this.now)) / 1000;
        return { port: p, reason: p.errDisabled!, secondsLeft: Math.max(0, Math.ceil(this.errRecovery.interval - elapsed)) };
      });
  }

  /**
   * `errdisable recovery`: brings a port back once its timer runs out. The virtual clock only
   * moves while traffic is in flight, so in practice this fires after long-running activity.
   */
  private recoverErrDisabled(): boolean {
    let changed = false;
    for (const { port, reason, secondsLeft } of this.recoveryTimers()) {
      if (secondsLeft > 0) continue;
      port.errDisabled = undefined;
      this.errDisabledAt.delete(port);
      this.log.push(`%PM-4-ERR_RECOVER: Attempting to recover from ${reason} err-disable state on ${shortName(port.name)}`);
      changed = true;
    }
    return changed;
  }

  /** Decides which member ports are bundled, from what the far end said this round. */
  private settleChannels(): boolean {
    let changed = false;
    for (const po of this.portChannels) {
      const wasUp = this.channelUp.get(po) ?? false;
      let partner: string | undefined;
      for (const m of this.members(po)) {
        const mode = m.channelGroup!.mode;
        const heard = this.channelHeard.get(m);
        let flag: MemberFlag;
        if (!m.isUp) flag = 'D';
        else if (mode !== 'on' && !negotiates(mode, heard)) flag = 'I';
        else if (!sameL2(m, po)) flag = 's';
        else if (heard && partner !== undefined && heard.system !== partner) flag = 's';
        else flag = 'P';
        if (flag === 'P' && heard) partner ??= heard.system;
        const bundled = flag === 'P';
        if (bundled !== m.bundled) {
          m.bundled = bundled;
          changed = true;
        }
        this.memberFlags.set(m, flag);
      }
      this.channelUp.set(po, po.isUp);
      if (po.isUp !== wasUp) {
        this.log.push(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${po.name}, changed state to ${po.isUp ? 'up' : 'down'}`);
        // MACs learned on the members or the old bundle are no longer valid.
        this.flushMacs((e) => e.port === po || this.members(po).includes(e.port));
      }
    }
    return changed;
  }
}

function isIpv4(p: Packet): p is IpPacket {
  return p.kind === 'icmp' || p.kind === 'tcp' || p.kind === 'udp' || p.kind === 'ospf';
}
