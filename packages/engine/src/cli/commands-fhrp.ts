import { sameSubnet } from '../core/addressing';
import type { GlbpGroupConfig, GlbpLoadBalancing, Interface, VrrpGroupConfig } from '../devices/device';
import { GLBP_DEFAULT_PRIORITY, GLBP_DEFAULT_WEIGHTING, showGlbp, showGlbpBrief } from '../routing/glbp';
import { VRRP_DEFAULT_PRIORITY, showVrrp, showVrrpBrief } from '../routing/vrrp';
import { EXEC, INVALID, abbrev, iface, int, ip, requireRouter, type Command, type Session } from './common';

/** VRRP and GLBP: `vrrp` and `glbp` on router interfaces and sub-interfaces (HSRP is in commands-hsrp). */

const FHRP_MODES: Session['mode'][] = ['config-if', 'config-subif'];

function fhrpIface(s: Session): Interface {
  requireRouter(s);
  const i = iface(s);
  if (i.kind !== 'physical' && i.kind !== 'subinterface') throw new Error(INVALID);
  return i;
}

/** A virtual IP must sit in the interface's subnet. */
function checkVip(i: Interface, vip: string, group: number): string {
  if (!i.ip || !sameSubnet(ip(vip), i.ip.address, i.ip.prefix)) throw new Error(`Address ${vip} in group ${group} not within a subnet on this interface`);
  return vip;
}

// ---------------------------------------------------------------- VRRP

function vrrpGroup(i: Interface, n: number): VrrpGroupConfig {
  const list = (i.vrrp ??= []);
  let g = list.find((x) => x.group === n);
  if (!g) {
    g = { group: n, priority: VRRP_DEFAULT_PRIORITY, preempt: true };
    list.push(g);
    list.sort((a, b) => a.group - b.group);
  }
  return g;
}

/** `vrrp <group> ip|priority|preempt|description ...`. */
function vrrp(s: Session, rest: string, remove: boolean): void {
  const i = fhrpIface(s);
  const [num, kw, ...args] = rest.split(/\s+/);
  const n = int(num, 1, 255);
  if (remove) {
    if (kw === undefined) return void (i.vrrp = i.vrrp?.filter((g) => g.group !== n));
    const g = i.vrrp?.find((x) => x.group === n);
    if (!g) return;
    if (abbrev(kw, 'ip')) g.vip = undefined;
    else if (abbrev(kw, 'priority')) g.priority = VRRP_DEFAULT_PRIORITY;
    else if (abbrev(kw, 'preempt')) g.preempt = false;
    else if (abbrev(kw, 'description')) g.description = undefined;
    else throw new Error(INVALID);
    return;
  }
  if (abbrev(kw, 'ip')) {
    const vip = checkVip(i, args[0] ?? '', n);
    vrrpGroup(i, n).vip = vip;
  } else if (abbrev(kw, 'priority')) vrrpGroup(i, n).priority = int(args[0], 1, 254);
  else if (abbrev(kw, 'preempt')) vrrpGroup(i, n).preempt = true;
  else if (abbrev(kw, 'description') && args.length) vrrpGroup(i, n).description = args.join(' ');
  else throw new Error(INVALID);
}

// ---------------------------------------------------------------- GLBP

const LOAD_BALANCING: GlbpLoadBalancing[] = ['round-robin', 'weighted', 'host-dependent'];

function glbpGroup(i: Interface, n: number): GlbpGroupConfig {
  const list = (i.glbp ??= []);
  let g = list.find((x) => x.group === n);
  if (!g) {
    g = { group: n, priority: GLBP_DEFAULT_PRIORITY, preempt: false, weighting: GLBP_DEFAULT_WEIGHTING, loadBalancing: 'round-robin' };
    list.push(g);
    list.sort((a, b) => a.group - b.group);
  }
  return g;
}

/** `glbp <group> ip [vip] | priority | preempt | weighting | load-balancing ...`. */
function glbp(s: Session, rest: string, remove: boolean): void {
  const i = fhrpIface(s);
  const [num, kw, ...args] = rest.split(/\s+/);
  const n = int(num, 0, 1023);
  if (remove) {
    if (kw === undefined) return void (i.glbp = i.glbp?.filter((g) => g.group !== n));
    const g = i.glbp?.find((x) => x.group === n);
    if (!g) return;
    if (abbrev(kw, 'ip')) g.vip = undefined;
    else if (abbrev(kw, 'priority')) g.priority = GLBP_DEFAULT_PRIORITY;
    else if (abbrev(kw, 'preempt')) g.preempt = false;
    else if (abbrev(kw, 'weighting')) g.weighting = GLBP_DEFAULT_WEIGHTING;
    else if (abbrev(kw, 'load-balancing')) g.loadBalancing = 'round-robin';
    else throw new Error(INVALID);
    return;
  }
  if (abbrev(kw, 'ip')) {
    // With no address the router learns the virtual IP from the AVG, as HSRP does.
    const vip = args[0] ? checkVip(i, args[0], n) : undefined;
    const g = glbpGroup(i, n);
    if (vip) g.vip = vip;
  } else if (abbrev(kw, 'priority')) glbpGroup(i, n).priority = int(args[0], 1, 255);
  else if (abbrev(kw, 'preempt')) glbpGroup(i, n).preempt = true;
  else if (abbrev(kw, 'weighting')) glbpGroup(i, n).weighting = int(args[0], 1, 254);
  else if (abbrev(kw, 'load-balancing')) {
    const mode = LOAD_BALANCING.find((m) => abbrev(args[0], m));
    if (!mode) throw new Error(INVALID);
    glbpGroup(i, n).loadBalancing = mode;
  } else throw new Error(INVALID);
}

export const FHRP_COMMANDS: Command[] = [
  { syntax: 'vrrp <args...>', modes: FHRP_MODES, help: '<group> ip <vip> | priority <n> | preempt | description <text>', run: (s, [rest]) => vrrp(s, rest!, false) },
  { syntax: 'no vrrp <args...>', modes: FHRP_MODES, help: 'Remove a VRRP group or setting', run: (s, [rest]) => vrrp(s, rest!, true) },
  { syntax: 'show vrrp', modes: EXEC, help: 'VRRP groups in detail', run: (s) => showVrrp(requireRouter(s).vrrp) },
  { syntax: 'show vrrp brief', modes: EXEC, help: 'One line per VRRP group', run: (s) => showVrrpBrief(requireRouter(s).vrrp) },
  { syntax: 'glbp <args...>', modes: FHRP_MODES, help: '<group> ip [vip] | priority <n> | preempt | weighting <n> | load-balancing <mode>', run: (s, [rest]) => glbp(s, rest!, false) },
  { syntax: 'no glbp <args...>', modes: FHRP_MODES, help: 'Remove a GLBP group or setting', run: (s, [rest]) => glbp(s, rest!, true) },
  { syntax: 'show glbp', modes: EXEC, help: 'GLBP groups and forwarders in detail', run: (s) => {
    const r = requireRouter(s);
    return showGlbp(r.glbp, r.network?.scheduler.now ?? 0);
  } },
  { syntax: 'show glbp brief', modes: EXEC, help: 'GLBP gateways and forwarders, one line each', run: (s) => showGlbpBrief(requireRouter(s).glbp) },
];
