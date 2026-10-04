import { BROADCAST_MAC } from '../core/addressing';
import type { Frame, IpPacket, Packet } from '../core/frames';

/** One row of the capture list, Wireshark style. */
export interface FrameSummary {
  protocol: string;
  source: string;
  destination: string;
  info: string;
}

/** One layer of the packet detail tree: a heading and its fields. */
export interface Layer {
  title: string;
  fields: [string, string][];
}

/** The protocol name shown in the capture list, and matched by a bare filter word. */
export function protocolOf(p: Packet): string {
  switch (p.kind) {
    case 'arp':
      return 'ARP';
    case 'icmp':
      return 'ICMP';
    case 'tcp':
      return 'TCP';
    case 'udp':
      return p.dhcp ? 'DHCP' : p.hsrp ? 'HSRP' : p.ntp ? 'NTP' : 'UDP';
    case 'ospf':
      return 'OSPF';
    case 'icmpv6':
      return 'ICMPv6';
    case 'bpdu':
      return 'STP';
    case 'lacp':
      return 'LACP';
    case 'pagp':
      return 'PAgP';
    case 'cdp':
      return 'CDP';
    case 'lldp':
      return 'LLDP';
  }
}

const ICMP_NAMES: Record<string, string> = {
  'echo-request': 'Echo (ping) request',
  'echo-reply': 'Echo (ping) reply',
  'time-exceeded': 'Time-to-live exceeded',
  unreachable: 'Destination unreachable',
};

const ICMPV6_NAMES: Record<string, string> = {
  ...ICMP_NAMES,
  ns: 'Neighbor Solicitation',
  na: 'Neighbor Advertisement',
  rs: 'Router Solicitation',
  ra: 'Router Advertisement',
};

function isIp(p: Packet): p is IpPacket {
  return p.kind === 'icmp' || p.kind === 'tcp' || p.kind === 'udp' || p.kind === 'ospf';
}

function info(p: Packet): string {
  switch (p.kind) {
    case 'arp':
      if (p.op === 'request') return `Who has ${p.targetIp}? Tell ${p.senderIp}`;
      return p.senderIp === p.targetIp ? `Gratuitous ARP for ${p.senderIp} (Reply)` : `${p.senderIp} is at ${p.senderMac}`;
    case 'icmp':
      return `${ICMP_NAMES[p.type]}  id=${p.id}, seq=${p.seq}, ttl=${p.ttl}`;
    case 'tcp':
      return `${p.srcPort} → ${p.dstPort} [${p.flags === 'syn' ? 'SYN' : p.flags === 'syn-ack' ? 'SYN, ACK' : 'RST'}]`;
    case 'udp': {
      if (p.dhcp) return `DHCP ${p.dhcp.op[0]!.toUpperCase()}${p.dhcp.op.slice(1)}  - Transaction ID 0x${p.dhcp.xid.toString(16)}`;
      if (p.hsrp) return `Hello (state ${p.hsrp.state[0]!.toUpperCase()}${p.hsrp.state.slice(1)}), group ${p.hsrp.group}, priority ${p.hsrp.priority}`;
      if (p.ntp) return `NTP Version 4, ${p.ntp.mode}`;
      return `${p.srcPort} → ${p.dstPort}`;
    }
    case 'ospf':
      return p.ospf.type === 'hello' ? 'Hello Packet' : p.ospf.type === 'dbd' ? 'DB Description' : 'LS Update';
    case 'icmpv6':
      return p.target ? `${ICMPV6_NAMES[p.type]} for ${p.target}` : `${ICMPV6_NAMES[p.type]}`;
    case 'bpdu':
      return `RST. Root = ${p.root.priority}/${p.root.mac}  Cost = ${p.rootCost}  Port = 0x${(p.portId.priority * 256 + p.portId.number).toString(16)}`;
    case 'lacp':
    case 'pagp':
      return `${p.mode}, group ${p.group}`;
    case 'cdp':
    case 'lldp':
      return `Device ID: ${p.deviceId}  Port ID: ${p.portId}`;
  }
}

export function summarize(frame: Frame): FrameSummary {
  const p = frame.payload;
  const protocol = protocolOf(p);
  if (isIp(p) || p.kind === 'icmpv6') return { protocol, source: p.src, destination: p.dst, info: info(p) };
  const destination = frame.dst === BROADCAST_MAC ? 'Broadcast' : frame.dst;
  return { protocol, source: frame.src, destination, info: info(p) };
}

/** The layered detail view of a frame, outermost header first. */
export function dissect(frame: Frame): Layer[] {
  const p = frame.payload;
  const layers: Layer[] = [];
  const ethertype = p.kind === 'arp' ? 'ARP (0x0806)' : p.kind === 'icmpv6' ? 'IPv6 (0x86dd)' : isIp(p) ? 'IPv4 (0x0800)' : 'none (802.3 with LLC)';
  layers.push({
    title: `Ethernet II, Src: ${frame.src}, Dst: ${frame.dst}`,
    fields: [
      ['Destination', frame.dst === BROADCAST_MAC ? `${frame.dst} (Broadcast)` : frame.dst],
      ['Source', frame.src],
      ['Type', frame.vlan !== undefined ? '802.1Q Virtual LAN (0x8100)' : ethertype],
    ],
  });
  if (frame.vlan !== undefined) layers.push({ title: `802.1Q Virtual LAN, ID: ${frame.vlan}`, fields: [['VLAN ID', String(frame.vlan)], ['Type', ethertype]] });

  switch (p.kind) {
    case 'arp':
      layers.push({
        title: `Address Resolution Protocol (${p.op})`,
        fields: [
          ['Opcode', p.op === 'request' ? 'request (1)' : 'reply (2)'],
          ['Sender MAC address', p.senderMac],
          ['Sender IP address', p.senderIp],
          ['Target MAC address', p.targetMac],
          ['Target IP address', p.targetIp],
        ],
      });
      break;
    case 'icmpv6':
      layers.push({ title: `Internet Protocol Version 6, Src: ${p.src}, Dst: ${p.dst}`, fields: [['Hop Limit', String(p.hopLimit)], ['Next Header', 'ICMPv6 (58)']] });
      layers.push({
        title: 'Internet Control Message Protocol v6',
        fields: [['Type', ICMPV6_NAMES[p.type]!], ...(p.target ? [['Target Address', p.target] as [string, string]] : []), ...(p.prefixes ?? []).map((x) => ['Prefix', `${x.prefix}/${x.length}`] as [string, string])],
      });
      break;
    case 'bpdu':
      layers.push({
        title: 'Spanning Tree Protocol',
        fields: [
          ['Protocol', 'Rapid Spanning Tree (PVST+)'],
          ['VLAN', String(p.vlan)],
          ['Root Identifier', `${p.root.priority} / ${p.root.mac}`],
          ['Root Path Cost', String(p.rootCost)],
          ['Bridge Identifier', `${p.bridge.priority} / ${p.bridge.mac}`],
          ['Port identifier', `${p.portId.priority}.${p.portId.number}`],
          ['Message Age', String(p.messageAge)],
        ],
      });
      break;
    case 'lacp':
    case 'pagp':
      layers.push({ title: p.kind === 'lacp' ? 'Link Aggregation Control Protocol' : 'Port Aggregation Protocol', fields: [['Mode', p.mode], ['System', p.system], ['Group', String(p.group)]] });
      break;
    case 'cdp':
    case 'lldp':
      layers.push({
        title: p.kind === 'cdp' ? 'Cisco Discovery Protocol' : 'Link Layer Discovery Protocol',
        fields: [
          ['Device ID', p.deviceId],
          ['Port ID', p.portId],
          ['Platform', p.platform],
          ['Capabilities', p.capabilities.join(' ')],
          ...(p.address ? [['Management Address', p.address] as [string, string]] : []),
          ...(p.nativeVlan !== undefined ? [['Native VLAN', String(p.nativeVlan)] as [string, string]] : []),
          ['Holdtime', `${p.holdtime} sec`],
        ],
      });
      break;
    default: {
      const proto = p.kind === 'icmp' ? 'ICMP (1)' : p.kind === 'tcp' ? 'TCP (6)' : p.kind === 'udp' ? 'UDP (17)' : 'OSPF (89)';
      layers.push({ title: `Internet Protocol Version 4, Src: ${p.src}, Dst: ${p.dst}`, fields: [['Time to Live', String(p.ttl)], ['Protocol', proto], ['Source Address', p.src], ['Destination Address', p.dst]] });
      layers.push(...transport(p));
    }
  }
  return layers;
}

function transport(p: IpPacket): Layer[] {
  switch (p.kind) {
    case 'icmp':
      return [{ title: 'Internet Control Message Protocol', fields: [['Type', ICMP_NAMES[p.type]!], ['Identifier', String(p.id)], ['Sequence Number', String(p.seq)]] }];
    case 'tcp':
      return [{ title: `Transmission Control Protocol, Src Port: ${p.srcPort}, Dst Port: ${p.dstPort}`, fields: [['Source Port', String(p.srcPort)], ['Destination Port', String(p.dstPort)], ['Flags', p.flags.toUpperCase()]] }];
    case 'ospf': {
      const o = p.ospf;
      const fields: [string, string][] = [['Message Type', info(p)], ['Source OSPF Router', o.routerId], ['Area ID', String(o.area)]];
      if (o.type === 'hello') fields.push(['Hello Interval', `${o.helloInterval} sec`], ['Dead Interval', `${o.deadInterval} sec`], ['Router Priority', String(o.priority)], ['Designated Router', o.dr], ['Backup Designated Router', o.bdr]);
      else fields.push(['LSAs', String(o.lsas.length)]);
      return [{ title: 'Open Shortest Path First', fields }];
    }
    case 'udp': {
      const layers: Layer[] = [{ title: `User Datagram Protocol, Src Port: ${p.srcPort}, Dst Port: ${p.dstPort}`, fields: [['Source Port', String(p.srcPort)], ['Destination Port', String(p.dstPort)]] }];
      if (p.dhcp) {
        const d = p.dhcp;
        const opt = (name: string, v: string | number | undefined): [string, string][] => (v === undefined ? [] : [[name, String(v)]]);
        layers.push({
          title: `Dynamic Host Configuration Protocol (${d.op})`,
          fields: [
            ['Message type', d.op],
            ['Transaction ID', `0x${d.xid.toString(16)}`],
            ['Client MAC address', d.chaddr],
            ...opt('Your (client) IP address', d.yiaddr),
            ...opt('Relay agent IP address', d.giaddr),
            ...opt('DHCP Server Identifier', d.serverId),
            ...opt('Requested IP Address', d.requested),
            ...opt('Router', d.router),
            ...opt('Domain Name Server', d.dns),
            ...(d.option82 ? [['Relay Agent Information (82)', `circuit-id ${d.option82.circuitId}, remote-id ${d.option82.remoteId}`] as [string, string]] : []),
          ],
        });
      }
      if (p.hsrp) layers.push({ title: 'Cisco Hot Standby Router Protocol', fields: [['Version', String(p.hsrp.version)], ['Group', String(p.hsrp.group)], ['State', p.hsrp.state], ['Priority', String(p.hsrp.priority)], ...(p.hsrp.vip ? [['Virtual IP Address', p.hsrp.vip] as [string, string]] : [])] });
      if (p.ntp) layers.push({ title: 'Network Time Protocol', fields: [['Mode', p.ntp.mode], ...(p.ntp.stratum !== undefined ? [['Stratum', String(p.ntp.stratum)] as [string, string]] : [])] });
      return layers;
    }
  }
}
