import { isValidIp } from '../core/addressing';
import type { Interface } from '../devices/device';
import { ERR_RECOVERY_CAUSES, type Switch } from '../devices/switch';
import { ARP_VALIDATIONS, parseArpAclEntry, type ArpAcl, type ArpValidation } from '../switching/arp-inspection';
import { showBindings, showIpVerifySource } from '../switching/source-guard';
import { EXEC, INVALID, L2_IF_MODES, abbrev, iface, int, parseVlanList, requireSwitch, vlanId, type Command, type Session } from './common';
import { showErrdisableRecovery } from './show-switching';

/** Dynamic ARP Inspection, ARP ACLs, IP Source Guard and err-disable recovery (Catalyst switches only). */

const MAC = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;

function port(s: Session): { sw: Switch; i: Interface } {
  const sw = requireSwitch(s);
  const i = iface(s);
  if (i.kind !== 'physical' && i.kind !== 'port-channel') throw new Error(INVALID);
  return { sw, i };
}

/** `ip arp inspection validate src-mac ip`: every keyword must name a check. */
function validations(words: string): Set<ArpValidation> {
  const out = new Set<ArpValidation>();
  for (const w of words.split(/\s+/)) {
    const v = ARP_VALIDATIONS.find((x) => abbrev(w, x));
    if (!v) throw new Error(INVALID);
    out.add(v);
  }
  return out;
}

function currentArpAcl(s: Session): ArpAcl {
  return s.currentArpAcl!;
}

/** `ip source binding <mac> vlan <id> <ip> interface <name>`. */
function staticBinding(s: Session, mac: string, vlan: string, ip: string, ifName: string) {
  const sw = requireSwitch(s);
  if (!MAC.test(mac) || !isValidIp(ip)) throw new Error(INVALID);
  return { sw, binding: { mac: mac.toLowerCase(), vlan: vlanId(vlan), ip, port: sw.iface(ifName), type: 'static' as const } };
}

function recoveryCause(arg: string | undefined): string[] {
  if (abbrev(arg, 'all') && arg!.length > 1) return ERR_RECOVERY_CAUSES;
  const cause = ERR_RECOVERY_CAUSES.find((c) => c === arg?.toLowerCase());
  if (!cause) throw new Error(INVALID);
  return [cause];
}

export const L2_SECURITY_COMMANDS: Command[] = [
  // Dynamic ARP Inspection, global
  { syntax: 'ip arp inspection vlan <list>', modes: ['config'], help: 'Inspect ARP in these VLANs', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.dai.vlans.add(v);
  } },
  { syntax: 'no ip arp inspection vlan <list>', modes: ['config'], help: 'Stop inspecting ARP in these VLANs', run: (s, [list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.dai.vlans.delete(v);
  } },
  { syntax: 'ip arp inspection validate <checks...>', modes: ['config'], help: 'src-mac | dst-mac | ip (all in one command: each one replaces the last)', run: (s, [checks]) => {
    requireSwitch(s).dai.validate = validations(checks!);
  } },
  { syntax: 'no ip arp inspection validate', modes: ['config'], help: 'Turn off the extra validation checks', run: (s) => void (requireSwitch(s).dai.validate = new Set()) },
  { syntax: 'no ip arp inspection validate <checks...>', modes: ['config'], help: 'Turn off some validation checks', run: (s, [checks]) => {
    const dai = requireSwitch(s).dai;
    for (const v of validations(checks!)) dai.validate.delete(v);
  } },
  { syntax: 'ip arp inspection filter <acl> vlan <list>', modes: ['config'], help: 'Check ARP against an ARP ACL first', run: (s, [acl, list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.dai.filters.set(v, { acl: acl!, static: false });
  } },
  { syntax: 'ip arp inspection filter <acl> vlan <list> static', modes: ['config'], help: 'Check ARP against the ARP ACL only (implicit deny)', run: (s, [acl, list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) sw.dai.filters.set(v, { acl: acl!, static: true });
  } },
  { syntax: 'no ip arp inspection filter <acl> vlan <list>', modes: ['config'], help: 'Remove an ARP ACL from VLANs', run: (s, [acl, list]) => {
    const sw = requireSwitch(s);
    for (const v of parseVlanList(list!)) if (sw.dai.filters.get(v)?.acl === acl) sw.dai.filters.delete(v);
  } },

  // ARP ACLs
  { syntax: 'arp access-list <name>', modes: ['config', 'config-arp-nacl'], help: 'Define an ARP ACL (IP-to-MAC pairs for static hosts)', run: (s, [name]) => {
    const sw = requireSwitch(s);
    let acl = sw.dai.acls.get(name!);
    if (!acl) sw.dai.acls.set(name!, (acl = { name: name!, entries: [] }));
    s.currentArpAcl = acl;
    s.mode = 'config-arp-nacl';
  } },
  { syntax: 'no arp access-list <name>', modes: ['config'], help: 'Delete an ARP ACL', run: (s, [name]) => void requireSwitch(s).dai.acls.delete(name!) },
  { syntax: 'permit <entry...>', modes: ['config-arp-nacl'], help: 'ip host <ip> mac host <mac>', run: (s, [rest]) => void currentArpAcl(s).entries.push(parseArpAclEntry('permit', rest!.split(/\s+/))) },
  { syntax: 'deny <entry...>', modes: ['config-arp-nacl'], help: 'ip host <ip> mac host <mac>', run: (s, [rest]) => void currentArpAcl(s).entries.push(parseArpAclEntry('deny', rest!.split(/\s+/))) },
  { syntax: 'no permit <entry...>', modes: ['config-arp-nacl'], help: 'Remove a permit line', run: (s, [rest]) => removeArpEntry(currentArpAcl(s), 'permit', rest!) },
  { syntax: 'no deny <entry...>', modes: ['config-arp-nacl'], help: 'Remove a deny line', run: (s, [rest]) => removeArpEntry(currentArpAcl(s), 'deny', rest!) },

  // Dynamic ARP Inspection, per port
  { syntax: 'ip arp inspection trust', modes: L2_IF_MODES, help: 'Trust this port: ARP is not inspected here', run: (s) => void ((port(s).i.arpInspection ??= {}).trust = true) },
  { syntax: 'no ip arp inspection trust', modes: L2_IF_MODES, help: 'Untrusted (the default)', run: (s) => {
    const { i } = port(s);
    if (i.arpInspection) delete i.arpInspection.trust;
  } },
  { syntax: 'ip arp inspection limit rate <pps>', modes: L2_IF_MODES, help: 'ARP packets per second before the port is err-disabled (default 15)', run: (s, [pps]) => {
    Object.assign((port(s).i.arpInspection ??= {}), { rate: int(pps, 0, 2048), burst: undefined });
  } },
  { syntax: 'ip arp inspection limit rate <pps> burst interval <seconds>', modes: L2_IF_MODES, help: 'Allow <pps> per second, averaged over <seconds>', run: (s, [pps, secs]) => {
    Object.assign((port(s).i.arpInspection ??= {}), { rate: int(pps, 0, 2048), burst: int(secs, 1, 15) });
  } },
  { syntax: 'ip arp inspection limit none', modes: L2_IF_MODES, help: 'No ARP rate limit', run: (s) => void Object.assign((port(s).i.arpInspection ??= {}), { rate: 'none', burst: undefined }) },
  { syntax: 'no ip arp inspection limit', modes: L2_IF_MODES, help: 'Back to the default limit', run: (s) => {
    const { i } = port(s);
    if (i.arpInspection) Object.assign(i.arpInspection, { rate: undefined, burst: undefined });
  } },

  // IP Source Guard
  { syntax: 'ip verify source', modes: L2_IF_MODES, help: 'IP Source Guard: filter on the source IP', run: (s) => void (port(s).i.sourceGuard = 'ip') },
  { syntax: 'ip verify source <options...>', modes: L2_IF_MODES, help: 'port-security: filter on the source IP and MAC', run: (s, [opts]) => {
    const words = opts!.toLowerCase().split(/\s+/);
    // Older IOS spells it `ip verify source vlan dhcp-snooping [port-security]`.
    const rest = abbrev(words[0], 'vlan') && abbrev(words[1], 'dhcp-snooping') ? words.slice(2) : words;
    if (rest.length > 1 || (rest[0] !== undefined && !abbrev(rest[0], 'port-security'))) throw new Error(INVALID);
    port(s).i.sourceGuard = rest.length ? 'ip-mac' : 'ip';
  } },
  { syntax: 'no ip verify source', modes: L2_IF_MODES, help: 'Turn off IP Source Guard', run: (s) => void (port(s).i.sourceGuard = undefined) },
  { syntax: 'ip source binding <mac> vlan <id> <ip> interface <name...>', modes: ['config'], help: 'A static binding for a host with a fixed address', run: (s, [mac, vlan, ip, name]) => {
    const { sw, binding } = staticBinding(s, mac!, vlan!, ip!, name!);
    const list = sw.staticBindings;
    const at = list.findIndex((b) => b.mac === binding.mac && b.vlan === binding.vlan);
    if (at >= 0) list.splice(at, 1);
    list.push(binding);
  } },
  { syntax: 'no ip source binding <mac> vlan <id> <ip> interface <name...>', modes: ['config'], help: 'Remove a static binding', run: (s, [mac, vlan, ip, name]) => {
    const { sw, binding } = staticBinding(s, mac!, vlan!, ip!, name!);
    const at = sw.staticBindings.findIndex((b) => b.mac === binding.mac && b.vlan === binding.vlan && b.ip === binding.ip);
    if (at >= 0) sw.staticBindings.splice(at, 1);
  } },

  // Err-disable recovery
  { syntax: 'errdisable recovery cause <cause>', modes: ['config'], help: `Recover on a timer: ${ERR_RECOVERY_CAUSES.join(' | ')} | all`, run: (s, [cause]) => {
    const sw = requireSwitch(s);
    for (const c of recoveryCause(cause)) sw.errRecovery.causes.add(c);
  } },
  { syntax: 'no errdisable recovery cause <cause>', modes: ['config'], help: 'Stop recovering this cause', run: (s, [cause]) => {
    const sw = requireSwitch(s);
    for (const c of recoveryCause(cause)) sw.errRecovery.causes.delete(c);
  } },
  { syntax: 'errdisable recovery interval <seconds>', modes: ['config'], help: 'Seconds before recovery (30-86400, default 300)', run: (s, [secs]) => void (requireSwitch(s).errRecovery.interval = int(secs, 30, 86400)) },
  { syntax: 'no errdisable recovery interval', modes: ['config'], help: 'Back to 300 seconds', run: (s) => void (requireSwitch(s).errRecovery.interval = 300) },

  // Show and clear
  { syntax: 'show ip arp inspection', modes: EXEC, help: 'DAI checks, VLANs and counters', run: (s) => requireSwitch(s).dai.show() },
  { syntax: 'show ip arp inspection vlan <list>', modes: EXEC, help: 'DAI for some VLANs', run: (s, [list]) => requireSwitch(s).dai.show(parseVlanList(list!)) },
  { syntax: 'show ip arp inspection interfaces', modes: EXEC, help: 'Trust state and rate limit per port', run: (s) => {
    const sw = requireSwitch(s);
    return sw.dai.showInterfaces([...sw.ports, ...sw.portChannels]);
  } },
  { syntax: 'show arp access-list', modes: EXEC, help: 'ARP ACLs', run: (s) => requireSwitch(s).dai.showAcls() },
  { syntax: 'clear ip arp inspection statistics', modes: ['privileged'], help: 'Reset the DAI counters', run: (s) => requireSwitch(s).dai.clearStatistics() },
  { syntax: 'show ip verify source', modes: EXEC, help: 'IP Source Guard filters per port', run: (s) => {
    const sw = requireSwitch(s);
    return showIpVerifySource(sw, sw.ports);
  } },
  { syntax: 'show ip source binding', modes: EXEC, help: 'DHCP snooping and static bindings', run: (s) => showBindings(requireSwitch(s).sourceBindings()) },
  { syntax: 'show errdisable recovery', modes: EXEC, help: 'Err-disable recovery causes and timers', run: (s) => showErrdisableRecovery(requireSwitch(s)) },
];

function removeArpEntry(acl: ArpAcl, action: 'permit' | 'deny', rest: string): void {
  const wanted = JSON.stringify(parseArpAclEntry(action, rest.split(/\s+/)));
  acl.entries = acl.entries.filter((e) => JSON.stringify(e) !== wanted);
}
