import type { ChannelMode, Interface, PortSecurityConfig, ViolationMode } from '../devices/device';
import type { Switch } from '../devices/switch';
import { showEtherchannelSummary } from '../switching/etherchannel';
import { DEFAULT_BRIDGE_PRIORITY, compareBridge, showSpanningTree, showSpanningTreeSummary, showSpanningTreeVlan } from '../switching/stp';
import { EXEC, INVALID, L2_IF_MODES, abbrev, iface, int, parseVlanList, requireSwitch, vlanId, type Command, type Session } from './common';
import { showDhcpSnooping, showDhcpSnoopingBinding, showInterfacesStatus, showPortSecurity, showPortSecurityAddress, showPortSecurityInterface } from './show-switching';

/** Commands for spanning tree, EtherChannel and port security (Catalyst switches only). */

function port(s: Session): { sw: Switch; i: Interface } {
  const sw = requireSwitch(s);
  const i = iface(s);
  if (i.kind !== 'physical' && i.kind !== 'port-channel') throw new Error(INVALID);
  return { sw, i };
}

function stpConfig(s: Session) {
  const { i } = port(s);
  return (i.stp ??= {});
}

function bridgePriority(arg: string | undefined): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 0 || n > 61440 || n % 4096 !== 0) {
    const allowed = Array.from({ length: 16 }, (_, k) => String(k * 4096).padEnd(6)).join('');
    throw new Error(`Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  ${allowed.trimEnd()}`);
  }
  return n;
}

/**
 * `spanning-tree vlan <id> root primary|secondary`: primary goes to 24576, or 4096 below the
 * current root if that is already lower; secondary goes to 28672. It is a macro: the result is
 * an ordinary priority in the running config.
 */
function rootMacro(sw: Switch, vlan: number, which: string): number {
  if (abbrev(which, 'secondary')) return 28672;
  if (!abbrev(which, 'primary')) throw new Error(INVALID);
  const root = sw.stp.vlans.get(vlan)?.root;
  const me = sw.stp.bridgeId(vlan);
  if (!root || compareBridge(root, me) === 0) return Math.min(24576, sw.stp.priorities.get(vlan) ?? DEFAULT_BRIDGE_PRIORITY);
  const rootBase = root.priority - vlan;
  if (rootBase > 24576) return 24576;
  if (rootBase < 4096) throw new Error(`Failed to make the bridge root for vlan ${vlan}: the current root has priority ${rootBase}`);
  return rootBase - 4096;
}

function portSecurity(s: Session): PortSecurityConfig {
  const { i } = port(s);
  if (i.kind !== 'physical') throw new Error(INVALID);
  if (i.mode !== 'access') throw new Error(`Command rejected: ${i.name} is a trunk port.`);
  return (i.portSecurity ??= { enabled: false, maximum: 1, violation: 'shutdown', sticky: false, addresses: [], violations: 0 });
}

const MAC = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;

const CHANNEL_MODES: ChannelMode[] = ['on', 'active', 'passive', 'desirable', 'auto'];

export const SWITCHING_COMMANDS: Command[] = [
  // Spanning tree, global
  { syntax: 'spanning-tree mode <mode>', modes: ['config'], help: 'pvst | rapid-pvst', run: (s, [mode]) => {
    const sw = requireSwitch(s);
    const m = mode!.toLowerCase();
    if (m === 'rapid-pvst' || (m.length > 1 && 'rapid-pvst'.startsWith(m))) sw.stp.mode = 'rapid-pvst';
    else if ('pvst'.startsWith(m)) sw.stp.mode = 'pvst';
    else throw new Error(m.startsWith('m') ? 'MST is not supported by this simulator' : INVALID);
  } },
  { syntax: 'spanning-tree vlan <list> priority <n>', modes: ['config'], help: 'Bridge priority (0-61440, in steps of 4096)', run: (s, [list, n]) => {
    const sw = requireSwitch(s);
    const prio = bridgePriority(n);
    for (const v of parseVlanList(list!)) sw.stp.priorities.set(v, prio);
  } },
  { syntax: 'no spanning-tree vlan <list> priority', modes: ['config'], help: 'Back to the default priority', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.stp.priorities.delete(v);
  } },
  { syntax: 'spanning-tree vlan <list> root <which>', modes: ['config'], help: 'primary | secondary', run: (s, [list, which]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.stp.priorities.set(v, rootMacro(sw, v, which!));
  } },
  { syntax: 'spanning-tree vlan <list>', modes: ['config'], help: 'Enable spanning tree on VLANs', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.stp.disabled.delete(v);
  } },
  { syntax: 'no spanning-tree vlan <list>', modes: ['config'], help: 'Disable spanning tree on VLANs (loops become possible)', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.stp.disabled.add(v);
  } },
  { syntax: 'spanning-tree portfast default', modes: ['config'], help: 'PortFast on every access port', run: (s) => {
    requireSwitch(s).stp.portfastDefault = true;
    return '%Warning: this command enables portfast by default on all interfaces. You\n should now disable portfast explicitly on switched ports leading to hubs,\n switches and bridges as they may create temporary bridging loops.';
  } },
  { syntax: 'no spanning-tree portfast default', modes: ['config'], help: 'Turn off PortFast by default', run: (s) => void (requireSwitch(s).stp.portfastDefault = false) },
  { syntax: 'spanning-tree portfast bpduguard default', modes: ['config'], help: 'BPDU guard on every PortFast port', run: (s) => void (requireSwitch(s).stp.bpduGuardDefault = true) },
  { syntax: 'no spanning-tree portfast bpduguard default', modes: ['config'], help: 'Turn off BPDU guard by default', run: (s) => void (requireSwitch(s).stp.bpduGuardDefault = false) },

  // Spanning tree, per port
  { syntax: 'spanning-tree portfast', modes: L2_IF_MODES, help: 'Edge port: forward at once, for hosts only', run: (s) => {
    const { i } = port(s);
    stpConfig(s).portfast = true;
    if (i.mode === 'trunk') return '%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION';
    return `%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION\n\n%Portfast has been configured on ${i.name} but will only\n have effect when the interface is in a non-trunking mode.`;
  } },
  { syntax: 'spanning-tree portfast edge', modes: L2_IF_MODES, help: 'Edge port (newer IOS syntax)', run: (s) => void (stpConfig(s).portfast = true) },
  { syntax: 'spanning-tree portfast disable', modes: L2_IF_MODES, help: 'Never an edge port, even with portfast default', run: (s) => void (stpConfig(s).portfast = false) },
  { syntax: 'no spanning-tree portfast', modes: L2_IF_MODES, help: 'Not an edge port', run: (s) => void delete stpConfig(s).portfast },
  { syntax: 'spanning-tree bpduguard <state>', modes: L2_IF_MODES, help: 'enable | disable: err-disable the port if a BPDU arrives', run: (s, [state]) => {
    if (abbrev(state, 'enable')) stpConfig(s).bpduGuard = true;
    else if (abbrev(state, 'disable')) stpConfig(s).bpduGuard = false;
    else throw new Error(INVALID);
  } },
  { syntax: 'no spanning-tree bpduguard', modes: L2_IF_MODES, help: 'Use the global BPDU guard default', run: (s) => void delete stpConfig(s).bpduGuard },
  { syntax: 'spanning-tree guard <kind>', modes: L2_IF_MODES, help: 'root | none: block the port if it would lead to a new root', run: (s, [kind]) => {
    if (abbrev(kind, 'root')) stpConfig(s).guardRoot = true;
    else if (abbrev(kind, 'none')) delete stpConfig(s).guardRoot;
    else throw new Error(kind && abbrev(kind, 'loop') ? 'Loop guard is not supported by this simulator' : INVALID);
  } },
  { syntax: 'no spanning-tree guard', modes: L2_IF_MODES, help: 'Remove root guard', run: (s) => void delete stpConfig(s).guardRoot },
  { syntax: 'spanning-tree cost <n>', modes: L2_IF_MODES, help: 'Port path cost', run: (s, [n]) => void (stpConfig(s).cost = int(n, 1, 200000000)) },
  { syntax: 'no spanning-tree cost', modes: L2_IF_MODES, help: 'Cost from the link speed', run: (s) => void delete stpConfig(s).cost },
  { syntax: 'spanning-tree port-priority <n>', modes: L2_IF_MODES, help: 'Port priority (0-240, in steps of 16)', run: (s, [n]) => {
    const prio = int(n, 0, 240);
    if (prio % 16) throw new Error('Port Priority in increments of 16 is required');
    stpConfig(s).priority = prio;
  } },
  { syntax: 'no spanning-tree port-priority', modes: L2_IF_MODES, help: 'Default port priority (128)', run: (s) => void delete stpConfig(s).priority },

  // EtherChannel
  { syntax: 'channel-group <n> mode <mode>', modes: L2_IF_MODES, help: 'on | active | passive | desirable | auto', run: (s, [n, mode]) => {
    const { sw, i } = port(s);
    const m = CHANNEL_MODES.find((x) => abbrev(mode, x));
    if (!m) throw new Error(INVALID);
    return sw.joinChannel(i, int(n, 1, 48), m);
  } },
  { syntax: 'no channel-group', modes: L2_IF_MODES, help: 'Leave the EtherChannel', run: (s) => {
    const { sw, i } = port(s);
    sw.leaveChannel(i);
  } },

  // Port security
  { syntax: 'switchport port-security', modes: L2_IF_MODES, help: 'Enable port security', run: (s) => void (portSecurity(s).enabled = true) },
  { syntax: 'no switchport port-security', modes: L2_IF_MODES, help: 'Disable port security', run: (s) => {
    const ps = portSecurity(s);
    ps.enabled = false;
    ps.addresses = ps.addresses.filter((a) => a.type !== 'dynamic');
  } },
  { syntax: 'switchport port-security maximum <n>', modes: L2_IF_MODES, help: 'Secure MAC addresses allowed (default 1)', run: (s, [n]) => {
    const ps = portSecurity(s);
    const max = int(n, 1, 4096);
    if (max < ps.addresses.length) throw new Error('Maximum is less than the number of currently secured MAC addresses.');
    ps.maximum = max;
  } },
  { syntax: 'no switchport port-security maximum', modes: L2_IF_MODES, help: 'Back to one address', run: (s) => void (portSecurity(s).maximum = 1) },
  { syntax: 'switchport port-security violation <mode>', modes: L2_IF_MODES, help: 'shutdown | restrict | protect', run: (s, [mode]) => {
    const m = (['shutdown', 'restrict', 'protect'] as ViolationMode[]).find((x) => abbrev(mode, x));
    if (!m) throw new Error(INVALID);
    portSecurity(s).violation = m;
  } },
  { syntax: 'no switchport port-security violation', modes: L2_IF_MODES, help: 'Back to shutdown', run: (s) => void (portSecurity(s).violation = 'shutdown') },
  { syntax: 'switchport port-security mac-address sticky', modes: L2_IF_MODES, help: 'Keep learned addresses in the running config', run: (s) => {
    const ps = portSecurity(s);
    ps.sticky = true;
    for (const a of ps.addresses) if (a.type === 'dynamic') a.type = 'sticky';
  } },
  { syntax: 'no switchport port-security mac-address sticky', modes: L2_IF_MODES, help: 'Stop learning sticky addresses', run: (s) => {
    const ps = portSecurity(s);
    ps.sticky = false;
    for (const a of ps.addresses) if (a.type === 'sticky') a.type = 'dynamic';
  } },
  { syntax: 'switchport port-security mac-address sticky <mac>', modes: L2_IF_MODES, help: 'A sticky address (as saved in the config)', run: (s, [mac]) => {
    const ps = portSecurity(s);
    if (!MAC.test(mac!)) throw new Error(INVALID);
    addSecure(ps, mac!.toLowerCase(), 'sticky', iface(s).accessVlan);
  } },
  { syntax: 'switchport port-security mac-address <mac>', modes: L2_IF_MODES, help: 'A static secure address (H.H.H)', run: (s, [mac]) => {
    const ps = portSecurity(s);
    if (!MAC.test(mac!)) throw new Error(INVALID);
    addSecure(ps, mac!.toLowerCase(), 'static', iface(s).accessVlan);
  } },
  { syntax: 'no switchport port-security mac-address <mac>', modes: L2_IF_MODES, help: 'Remove a secure address', run: (s, [mac]) => {
    const ps = portSecurity(s);
    ps.addresses = ps.addresses.filter((a) => a.mac !== mac!.toLowerCase());
  } },

  // DHCP snooping
  { syntax: 'ip dhcp snooping', modes: ['config'], help: 'Enable DHCP snooping globally', run: (s) => void (requireSwitch(s).snooping.enabled = true) },
  { syntax: 'no ip dhcp snooping', modes: ['config'], help: 'Disable DHCP snooping', run: (s) => void (requireSwitch(s).snooping.enabled = false) },
  { syntax: 'ip dhcp snooping vlan <list>', modes: ['config'], help: 'Snoop DHCP in these VLANs', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.snooping.vlans.add(v);
  } },
  { syntax: 'no ip dhcp snooping vlan <list>', modes: ['config'], help: 'Stop snooping in these VLANs', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.snooping.vlans.delete(v);
  } },
  { syntax: 'ip dhcp snooping information option', modes: ['config'], help: 'Insert option 82 into client requests (default)', run: (s) => void (requireSwitch(s).snooping.option82 = true) },
  { syntax: 'no ip dhcp snooping information option', modes: ['config'], help: 'Do not insert option 82', run: (s) => void (requireSwitch(s).snooping.option82 = false) },
  { syntax: 'ip dhcp snooping trust', modes: L2_IF_MODES, help: 'Trust this port (it leads to a DHCP server)', run: (s) => {
    const { i } = port(s);
    (i.dhcpSnooping ??= {}).trust = true;
  } },
  { syntax: 'no ip dhcp snooping trust', modes: L2_IF_MODES, help: 'Untrusted: drop DHCP server messages here', run: (s) => {
    const { i } = port(s);
    if (i.dhcpSnooping) delete i.dhcpSnooping.trust;
  } },
  { syntax: 'ip dhcp snooping limit rate <pps>', modes: L2_IF_MODES, help: 'DHCP packets per second allowed in', run: (s, [pps]) => void ((port(s).i.dhcpSnooping ??= {}).rateLimit = int(pps, 1, 2048)) },
  { syntax: 'no ip dhcp snooping limit rate', modes: L2_IF_MODES, help: 'No rate limit', run: (s) => {
    const { i } = port(s);
    if (i.dhcpSnooping) delete i.dhcpSnooping.rateLimit;
  } },
  { syntax: 'show ip dhcp snooping', modes: EXEC, help: 'DHCP snooping state and trusted ports', run: (s) => showDhcpSnooping(requireSwitch(s)) },
  { syntax: 'show ip dhcp snooping binding', modes: EXEC, help: 'Leases DHCP snooping has seen', run: (s) => showDhcpSnoopingBinding(requireSwitch(s)) },

  // Show
  { syntax: 'show spanning-tree', modes: EXEC, help: 'Spanning tree state for every VLAN', run: (s) => showSpanningTree(requireSwitch(s).stp) },
  { syntax: 'show spanning-tree vlan <id>', modes: EXEC, help: 'Spanning tree for one VLAN', run: (s, [id]) => showSpanningTreeVlan(requireSwitch(s).stp, vlanId(id)) },
  { syntax: 'show spanning-tree summary', modes: EXEC, help: 'Mode, root bridge and port counts', run: (s) => showSpanningTreeSummary(requireSwitch(s).stp) },
  { syntax: 'show etherchannel summary', modes: EXEC, help: 'EtherChannels and their member ports', run: (s) => showEtherchannelSummary(requireSwitch(s).channels()) },
  { syntax: 'show port-security', modes: EXEC, help: 'Port security on every port', run: (s) => showPortSecurity(requireSwitch(s)) },
  { syntax: 'show port-security interface <name>', modes: EXEC, help: 'Port security on one port', run: (s, [name]) => showPortSecurityInterface(requireSwitch(s).iface(name!)) },
  { syntax: 'show port-security address', modes: EXEC, help: 'Secure MAC addresses', run: (s) => showPortSecurityAddress(requireSwitch(s)) },
  { syntax: 'show interfaces status', modes: EXEC, help: 'Port status, VLAN, speed and duplex', run: (s) => showInterfacesStatus(requireSwitch(s)) },
  { syntax: 'show interfaces status err-disabled', modes: EXEC, help: 'Err-disabled ports and why', run: (s) => showInterfacesStatus(requireSwitch(s), true) },
];

function addSecure(ps: PortSecurityConfig, mac: string, type: 'static' | 'sticky', vlan: number): void {
  if (ps.addresses.some((a) => a.mac === mac)) return;
  if (ps.addresses.length >= ps.maximum) throw new Error('Total secure mac-addresses on interface has reached maximum limit.');
  ps.addresses.push({ mac, vlan, type });
}
