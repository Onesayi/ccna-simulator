import { isValidIp, parsePrefix, networkAddress } from '../core/addressing';
import type { Interface } from '../devices/device';
import type { Device } from '../devices/device';
import type { IpDevice } from '../devices/ip-device';
import { Router } from '../devices/router';
import { Switch } from '../devices/switch';
import type { OspfProcess } from '../routing/ospf';
import type { Acl } from '../services/acl';
import type { DhcpPool } from '../services/dhcp';
import { CONFIG_MODES, EXEC, IF_MODES, iface, ip, requireIp, requireSwitch, vlanId, type Command, type Mode, type Session } from './common';
import { OSPF_COMMANDS } from './commands-ospf';
import { SERVICE_COMMANDS } from './commands-services';
import {
  formatIosPing,
  formatIosTraceroute,
  interfaceStatus,
  runningConfig,
  showArp,
  showInterfacesSwitchport,
  showIpIntBrief,
  showIpInterface,
  showIpRoute,
  showLogging,
  showMacTable,
  showTrunks,
  showVlanBrief,
} from './show';

const PROMPT_SUFFIX: Record<Mode, string> = {
  user: '>',
  privileged: '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-subif': '(config-subif)#',
  'config-vlan': '(config-vlan)#',
  'config-router': '(config-router)#',
  'dhcp-config': '(dhcp-config)#',
  'config-std-nacl': '(config-std-nacl)#',
  'config-ext-nacl': '(config-ext-nacl)#',
};

/** Anything a terminal can drive: the IOS CLI here, or the PC command prompt. */
export interface Shell {
  readonly prompt: string;
  execute(line: string): string;
}

/**
 * One terminal attached to one router or switch. Parses IOS-style input with abbreviation
 * support and returns the text a real device would print.
 */
export class CliSession implements Shell, Session {
  mode: Mode = 'user';
  currentInterface?: Interface;
  currentVlan?: number;
  currentOspf?: OspfProcess;
  currentPool?: DhcpPool;
  currentAcl?: Acl;

  constructor(readonly device: Device) {}

  get prompt(): string {
    return `${this.device.hostname}${PROMPT_SUFFIX[this.mode]}`;
  }

  execute(line: string): string {
    const input = line.trim();
    if (!input) return '';
    if (input.endsWith('?')) return this.help(input.slice(0, -1).trim());

    const words = input.split(/\s+/);
    // "do show ip route" from any config mode runs the EXEC command without leaving config.
    if (words[0]?.toLowerCase() === 'do' && CONFIG_MODES.includes(this.mode) && words.length > 1) {
      const saved = this.mode;
      this.mode = 'privileged';
      try {
        return this.execute(words.slice(1).join(' '));
      } finally {
        this.mode = saved;
      }
    }

    const negated = words[0]?.toLowerCase() === 'no';
    let match = this.match(negated ? words.slice(1) : words, negated);
    if (!match && this.mode !== 'config' && CONFIG_MODES.includes(this.mode)) {
      // Like IOS, a global configuration command typed in a sub-mode drops back to global config.
      const saved = this.mode;
      this.mode = 'config';
      match = this.match(negated ? words.slice(1) : words, negated);
      if (!match) this.mode = saved;
    }
    if (match === 'ambiguous') return `% Ambiguous command:  "${input}"`;
    if (!match) return `% Invalid input detected at '^' marker.`;
    const logged = this.device.log.length;
    let out: string;
    try {
      out = match.cmd.run(this, match.args) ?? '';
    } catch (err) {
      out = `% ${(err as Error).message}`;
    }
    // Let routing protocols react, then show the console messages this device logged meanwhile.
    this.device.network?.converge();
    const messages = this.device.log.slice(logged);
    return [out, ...messages].filter(Boolean).join('\n');
  }

  private match(words: string[], negated: boolean): { cmd: Command; args: string[] } | 'ambiguous' | undefined {
    const candidates = COMMANDS.filter((c) => c.modes.includes(this.mode) && c.syntax.startsWith('no ') === negated);
    let hits: { cmd: Command; args: string[] }[] = [];
    for (const cmd of candidates) {
      const tokens = cmd.syntax.replace(/^no /, '').split(' ');
      const greedy = tokens[tokens.length - 1]!.endsWith('...>');
      if (greedy ? words.length < tokens.length : tokens.length !== words.length) continue;
      const args: string[] = [];
      const ok = tokens.every((tok, i) => {
        const w = words[i] ?? '';
        if (tok.endsWith('...>')) return args.push(words.slice(i).join(' ')), true;
        if (tok.startsWith('<')) return args.push(w), true;
        return tok.startsWith(w.toLowerCase());
      });
      if (ok) hits.push({ cmd, args });
    }
    // A command that starts with a free argument (ACL lines: "10 permit ...") only matches as a last resort.
    const keyworded = hits.filter((h) => !h.cmd.syntax.replace(/^no /, '').startsWith('<'));
    if (hits.length > 1 && keyworded.length) hits = keyworded;
    if (hits.length > 1) {
      // Prefer exact keyword matches before calling it ambiguous ("show vlan" vs "show version").
      const exact = hits.filter((h) => h.cmd.syntax.replace(/^no /, '').split(' ').every((t, i) => t.startsWith('<') || t === words[i]?.toLowerCase()));
      return exact.length === 1 ? exact[0] : 'ambiguous';
    }
    return hits[0];
  }

  private help(prefix: string): string {
    const p = prefix.toLowerCase();
    const lines = COMMANDS.filter((c) => c.modes.includes(this.mode) && c.syntax.startsWith(p) && this.supports(c)).map(
      (c) => `  ${c.syntax.padEnd(40)} ${c.help}`,
    );
    return lines.length ? lines.join('\n') : '% Unrecognized command';
  }

  private supports(c: Command): boolean {
    const isSwitch = this.device instanceof Switch;
    if (/switchport|vlan|mac address|trunk|default-gateway|ip routing/.test(c.syntax)) return isSwitch;
    if (/encapsulation|ospf|nat|dhcp|access|helper|bandwidth|router-id|passive|network|default-information|auto-cost|telnet/.test(c.syntax)) return !isSwitch;
    return true;
  }
}

/** IOS prints link state changes as console syslog messages after `[no] shutdown`. */
function linkMessages(i: Interface, wasUp: boolean, wasAdmin: boolean): void {
  const out: string[] = [];
  if (!i.adminUp && wasAdmin) {
    out.push(`%LINK-5-CHANGED: Interface ${i.name}, changed state to administratively down`);
    if (wasUp) out.push(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to down`);
  } else if (i.adminUp && !wasAdmin) {
    const { status } = interfaceStatus(i);
    out.push(`%LINK-5-CHANGED: Interface ${i.name}, changed state to ${status}`);
    if (i.isUp) out.push(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to up`);
  }
  for (const line of out) i.device.log.push(line);
}

function setAdmin(s: Session, up: boolean): void {
  const i = iface(s);
  const wasUp = i.isUp;
  const wasAdmin = i.adminUp;
  i.adminUp = up;
  linkMessages(i, wasUp, wasAdmin);
}

/** Parses the tail of `ip route <net> <mask> ...`: next hop, exit interface, or both, then an optional AD. */
function parseRouteTarget(d: IpDevice, network: string, mask: string, rest: string) {
  const prefix = parsePrefix(mask);
  ip(network);
  if (networkAddress(network, prefix) !== network) throw new Error('Inconsistent address and mask');
  const words = rest.split(/\s+/);
  let exitInterface: string | undefined;
  let nextHop: string | undefined;
  let ad = 1;
  for (const w of words) {
    if (isValidIp(w)) nextHop = w;
    else if (/^\d+$/.test(w)) ad = Number(w);
    else exitInterface = d.iface(w).name;
  }
  if (!nextHop && !exitInterface) throw new Error(`Invalid input detected at '^' marker.`);
  if (ad < 1 || ad > 255) throw new Error('Invalid distance');
  return { network, prefix, nextHop, exitInterface, ad };
}

const COMMANDS: Command[] = [
  // Mode navigation
  { syntax: 'enable', modes: ['user'], help: 'Turn on privileged commands', run: (s) => void (s.mode = 'privileged') },
  { syntax: 'disable', modes: ['privileged'], help: 'Turn off privileged commands', run: (s) => void (s.mode = 'user') },
  { syntax: 'configure terminal', modes: ['privileged'], help: 'Enter configuration mode', run: (s) => {
    s.mode = 'config';
    return 'Enter configuration commands, one per line.  End with CNTL/Z.';
  } },
  { syntax: 'exit', modes: [...EXEC, ...CONFIG_MODES], help: 'Exit from the current mode', run: (s) => {
    if (s.mode !== 'config' && CONFIG_MODES.includes(s.mode)) s.mode = 'config';
    else if (s.mode === 'config') s.mode = 'privileged';
    else s.mode = 'user';
  } },
  { syntax: 'end', modes: CONFIG_MODES, help: 'Exit to privileged EXEC mode', run: (s) => void (s.mode = 'privileged') },
  { syntax: 'hostname <name>', modes: ['config'], help: 'Set system name', run: (s, [name]) => {
    const net = s.device.network;
    const clash = net?.find(name!);
    if (clash && clash !== s.device) throw new Error(`Hostname ${name} is already used by another device in this topology`);
    s.device.hostname = name ?? s.device.hostname;
  } },
  { syntax: 'copy running-config startup-config', modes: ['privileged'], help: 'Save the configuration', run: () =>
    'Destination filename [startup-config]?\nBuilding configuration...\n[OK]' },
  { syntax: 'write memory', modes: ['privileged'], help: 'Save the configuration', run: () => 'Building configuration...\n[OK]' },

  // Connectivity tests
  { syntax: 'ping <ip>', modes: EXEC, help: 'Send echo messages', run: (s, [dst]) => {
    const results = requireIp(s).ping(ip(dst), 5);
    s.device.network?.run();
    return formatIosPing(dst!, results);
  } },
  { syntax: 'ping <ip> repeat <count>', modes: EXEC, help: 'Send <count> echo messages', run: (s, [dst, count]) => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('Invalid repeat count');
    const results = requireIp(s).ping(ip(dst), n);
    s.device.network?.run();
    return formatIosPing(dst!, results);
  } },
  { syntax: 'traceroute <ip>', modes: EXEC, help: 'Trace route to destination', run: (s, [dst]) => {
    const result = requireIp(s).traceroute(ip(dst));
    s.device.network?.run();
    return formatIosTraceroute(result);
  } },

  // Global routing config
  { syntax: 'ip route <network> <mask> <via...>', modes: ['config'], help: 'Static route: next hop and/or exit interface [distance]', run: (s, [net, mask, rest]) => {
    // On a switch IOS accepts static routes but ignores them until `ip routing` is on.
    const d = requireIp(s);
    d.addStaticRoute(parseRouteTarget(d, net!, mask!, rest!));
  } },
  { syntax: 'no ip route <network> <mask> <via...>', modes: ['config'], help: 'Remove a static route', run: (s, [net, mask, rest]) => {
    const d = requireIp(s);
    d.removeStaticRoute(parseRouteTarget(d, net!, mask!, rest!));
  } },
  { syntax: 'ip routing', modes: ['config'], help: 'Enable IP routing (Layer 3 switch)', run: (s) => void (requireSwitch(s).ipRouting = true) },
  { syntax: 'no ip routing', modes: ['config'], help: 'Disable IP routing', run: (s) => void (requireSwitch(s).ipRouting = false) },
  { syntax: 'ip default-gateway <ip>', modes: ['config'], help: 'Default gateway when not routing', run: (s, [gw]) => void (requireSwitch(s).defaultGateway = ip(gw)) },
  { syntax: 'no ip default-gateway', modes: ['config'], help: 'Remove the default gateway', run: (s) => void (requireSwitch(s).defaultGateway = undefined) },

  // VLANs
  { syntax: 'vlan <id>', modes: ['config', 'config-vlan'], help: 'Create or modify a VLAN', run: (s, [id]) => {
    const sw = requireSwitch(s);
    const n = vlanId(id);
    if (!sw.vlans.has(n)) sw.vlans.set(n, `VLAN${String(n).padStart(4, '0')}`);
    s.currentVlan = n;
    s.mode = 'config-vlan';
  } },
  { syntax: 'no vlan <id>', modes: ['config'], help: 'Delete a VLAN', run: (s, [id]) => {
    const n = vlanId(id);
    if (n === 1) throw new Error('Default VLAN 1 may not be deleted.');
    requireSwitch(s).vlans.delete(n);
  } },
  { syntax: 'name <name>', modes: ['config-vlan'], help: 'Name the VLAN', run: (s, [name]) => {
    if (s.currentVlan !== undefined && name) requireSwitch(s).vlans.set(s.currentVlan, name);
  } },

  // Interfaces
  { syntax: 'interface <name...>', modes: CONFIG_MODES, help: 'Select an interface to configure', run: (s, [name]) => {
    const i = s.device.configureInterface(name ?? '');
    s.currentInterface = i;
    s.mode = i.kind === 'subinterface' ? 'config-subif' : 'config-if';
  } },
  { syntax: 'shutdown', modes: IF_MODES, help: 'Shut down the interface', run: (s) => setAdmin(s, false) },
  { syntax: 'no shutdown', modes: IF_MODES, help: 'Enable the interface', run: (s) => setAdmin(s, true) },
  { syntax: 'description <text...>', modes: IF_MODES, help: 'Interface description', run: (s, [text]) => void (iface(s).description = text) },
  { syntax: 'no description', modes: IF_MODES, help: 'Remove the description', run: (s) => void (iface(s).description = undefined) },
  { syntax: 'ip address <ip> <mask>', modes: IF_MODES, help: 'Set the IPv4 address and mask', run: (s, [addr, mask]) => {
    const d = requireIp(s);
    const i = iface(s);
    if (i.kind === 'physical' && s.device instanceof Switch) throw new Error(`Invalid input detected at '^' marker. (use an SVI: interface vlan <id>)`);
    if (i.kind === 'subinterface' && i.encapVlan === undefined) {
      throw new Error('Configuring IP routing on a LAN subinterface is only allowed if that subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q, or ISL vLAN.');
    }
    d.setIp(i, ip(addr), parsePrefix(mask!));
  } },
  { syntax: 'no ip address', modes: IF_MODES, help: 'Remove the IPv4 address', run: (s) => {
    const i = iface(s);
    if (i.dhcpClient && s.device instanceof Router) s.device.disableDhcpClient(i);
    i.ip = undefined;
  } },
  { syntax: 'encapsulation dot1q <vlan>', modes: ['config-subif'], help: 'IEEE 802.1Q VLAN tag for this sub-interface', run: (s, [v]) => {
    Object.assign(iface(s), { encapVlan: vlanId(v), encapNative: false });
  } },
  { syntax: 'encapsulation dot1q <vlan> native', modes: ['config-subif'], help: 'Untagged (native) VLAN for this sub-interface', run: (s, [v]) => {
    Object.assign(iface(s), { encapVlan: vlanId(v), encapNative: true });
  } },
  { syntax: 'switchport mode <mode>', modes: ['config-if'], help: 'access | trunk', run: (s, [mode]) => {
    requireSwitch(s);
    const m = mode?.toLowerCase();
    if (m !== undefined && 'access'.startsWith(m)) iface(s).mode = 'access';
    else if (m !== undefined && 'trunk'.startsWith(m)) iface(s).mode = 'trunk';
    else throw new Error('Invalid input detected');
  } },
  { syntax: 'switchport access vlan <id>', modes: ['config-if'], help: 'Set the access VLAN', run: (s, [id]) => {
    const sw = requireSwitch(s);
    const n = vlanId(id);
    iface(s).accessVlan = n;
    if (!sw.vlans.has(n)) {
      sw.vlans.set(n, `VLAN${String(n).padStart(4, '0')}`);
      return `% Access VLAN does not exist. Creating vlan ${n}`;
    }
  } },
  { syntax: 'switchport trunk native vlan <id>', modes: ['config-if'], help: 'Set the native VLAN', run: (s, [id]) => {
    requireSwitch(s);
    iface(s).nativeVlan = vlanId(id);
  } },
  { syntax: 'switchport trunk allowed vlan <list>', modes: ['config-if'], help: 'Set allowed VLANs (e.g. 10,20-30 | all | none)', run: (s, [list]) => {
    requireSwitch(s);
    const l = list!.toLowerCase();
    iface(s).allowedVlans = l === 'all' ? 'all' : l === 'none' ? new Set() : parseVlanList(list!);
  } },
  { syntax: 'switchport trunk allowed vlan add <list>', modes: ['config-if'], help: 'Add VLANs to the allowed list', run: (s, [list]) => {
    requireSwitch(s);
    const i = iface(s);
    if (i.allowedVlans !== 'all') i.allowedVlans = new Set([...i.allowedVlans, ...parseVlanList(list!)]);
  } },
  { syntax: 'switchport trunk allowed vlan remove <list>', modes: ['config-if'], help: 'Remove VLANs from the allowed list', run: (s, [list]) => {
    requireSwitch(s);
    const i = iface(s);
    const current = i.allowedVlans === 'all' ? new Set(Array.from({ length: 4094 }, (_, k) => k + 1)) : i.allowedVlans;
    for (const v of parseVlanList(list!)) current.delete(v);
    i.allowedVlans = current;
  } },

  // Show commands
  { syntax: 'show running-config', modes: ['privileged'], help: 'Current operating configuration', run: (s) => runningConfig(requireIp(s)) },
  { syntax: 'show ip interface <name...>', modes: EXEC, help: 'brief | <interface>: IP settings, ACLs and NAT', run: (s, [name]) => {
    if (name && 'brief'.startsWith(name.toLowerCase())) return showIpIntBrief(s.device);
    return showIpInterface(s.device.iface(name!));
  } },
  { syntax: 'show ip route <filter>', modes: EXEC, help: 'connected | static | ospf', run: (s, [f]) => {
    const codes: Record<string, string[]> = { connected: ['C', 'L'], static: ['S'], ospf: ['O'] };
    const key = Object.keys(codes).find((k) => k.startsWith(f!.toLowerCase()));
    if (!key) throw new Error(`Invalid input detected at '^' marker.`);
    return showIpRoute(requireIp(s), codes[key]);
  } },
  { syntax: 'show ip route', modes: EXEC, help: 'IP routing table', run: (s) => showIpRoute(requireIp(s)) },
  { syntax: 'show ip arp', modes: EXEC, help: 'ARP table', run: (s) => showArp(requireIp(s)) },
  { syntax: 'show arp', modes: EXEC, help: 'ARP table', run: (s) => showArp(requireIp(s)) },
  { syntax: 'show vlan brief', modes: EXEC, help: 'VLAN summary', run: (s) => showVlanBrief(requireSwitch(s)) },
  { syntax: 'show mac address-table', modes: EXEC, help: 'MAC address table', run: (s) => showMacTable(requireSwitch(s)) },
  { syntax: 'show interfaces trunk', modes: EXEC, help: 'Trunk ports', run: (s) => showTrunks(requireSwitch(s)) },
  { syntax: 'show interfaces <name> switchport', modes: EXEC, help: 'Switchport settings for one port', run: (s, [name]) => {
    const sw = requireSwitch(s);
    return showInterfacesSwitchport(sw, sw.iface(name!));
  } },
  { syntax: 'show logging', modes: EXEC, help: 'Console log messages', run: (s) => showLogging(s.device) },
  ...OSPF_COMMANDS,
  ...SERVICE_COMMANDS,
];

export function parseVlanList(list: string): Set<number> {
  const out = new Set<number>();
  for (const part of list.split(',')) {
    const [a, b] = part.split('-').map((x) => vlanId(x));
    for (let v = a!; v <= (b ?? a!); v++) out.add(v);
  }
  return out;
}
