import { sameSubnet } from '../core/addressing';
import type { HsrpGroupConfig, Interface } from '../devices/device';
import { HSRP_DEFAULT_PRIORITY, showStandby, showStandbyBrief } from '../routing/hsrp';
import { EXEC, INVALID, abbrev, iface, int, ip, requireRouter, type Command, type Session } from './common';

/** HSRP: `standby` on router interfaces and sub-interfaces. */

const HSRP_MODES: Session['mode'][] = ['config-if', 'config-subif'];

function hsrpIface(s: Session): Interface {
  requireRouter(s);
  const i = iface(s);
  if (i.kind !== 'physical' && i.kind !== 'subinterface') throw new Error(INVALID);
  return i;
}

/** Finds (or with `create`, adds) a group on the interface. */
function group(i: Interface, n: number, create: boolean): HsrpGroupConfig | undefined {
  const cfg = (i.hsrp ??= { version: 1, groups: [] });
  let g = cfg.groups.find((x) => x.group === n);
  if (!g && create) {
    g = { group: n, priority: HSRP_DEFAULT_PRIORITY, preempt: false, tracks: [] };
    cfg.groups.push(g);
    cfg.groups.sort((a, b) => a.group - b.group);
  }
  return g;
}

/** `standby [group] <keyword> ...`: the group number is optional and defaults to 0. */
function standby(s: Session, rest: string, remove: boolean): string | void {
  const i = hsrpIface(s);
  const w = rest.split(/\s+/);
  if (abbrev(w[0], 'version')) {
    if (remove) return void (i.hsrp && (i.hsrp.version = 1));
    const v = int(w[1], 1, 2) as 1 | 2;
    const cfg = (i.hsrp ??= { version: 1, groups: [] });
    if (v === 1 && cfg.groups.some((g) => g.group > 255)) throw new Error('Group numbers above 255 need HSRP version 2');
    cfg.version = v;
    return;
  }
  const max = i.hsrp?.version === 2 ? 4095 : 255;
  let n = 0;
  if (/^\d+$/.test(w[0] ?? '')) n = int(w.shift(), 0, max);
  const [kw, ...args] = w;
  if (remove && kw === undefined) {
    if (i.hsrp) i.hsrp.groups = i.hsrp.groups.filter((g) => g.group !== n);
    return;
  }
  if (remove) {
    const g = group(i, n, false);
    if (!g) return;
    if (abbrev(kw, 'ip')) g.vip = undefined;
    else if (abbrev(kw, 'priority')) g.priority = HSRP_DEFAULT_PRIORITY;
    else if (abbrev(kw, 'preempt')) g.preempt = false;
    else if (abbrev(kw, 'track')) g.tracks = args[0] ? g.tracks.filter((t) => t.iface !== i.device.iface(args[0]!).name) : [];
    else throw new Error(INVALID);
    return;
  }
  if (abbrev(kw, 'ip')) {
    const g = group(i, n, true)!;
    if (!args[0]) return; // learn the virtual IP from the active router
    const vip = ip(args[0]);
    if (!i.ip || !sameSubnet(vip, i.ip.address, i.ip.prefix)) {
      if (!i.hsrp!.groups.some((x) => x !== g)) i.hsrp!.groups = i.hsrp!.groups.filter((x) => x !== g);
      throw new Error(`Address ${vip} in group ${n} not within a subnet on this interface`);
    }
    if (vip === i.ip.address) throw new Error(`address cannot equal interface IP address`);
    g.vip = vip;
    return;
  }
  if (abbrev(kw, 'priority')) return void (group(i, n, true)!.priority = int(args[0], 0, 255));
  if (abbrev(kw, 'preempt')) return void (group(i, n, true)!.preempt = true);
  if (abbrev(kw, 'track')) {
    const target = i.device.iface(args[0] ?? '');
    const value = abbrev(args[1], 'decrement') ? args[2] : args[1];
    const decrement = value === undefined ? 10 : int(value, 1, 255);
    const g = group(i, n, true)!;
    g.tracks = [...g.tracks.filter((t) => t.iface !== target.name), { iface: target.name, decrement }];
    return;
  }
  throw new Error(INVALID);
}

export const HSRP_COMMANDS: Command[] = [
  { syntax: 'standby <args...>', modes: HSRP_MODES, help: '[group] ip <vip> | priority <n> | preempt | track <if> [decrement n] | version 1|2', run: (s, [rest]) => standby(s, rest!, false) },
  { syntax: 'no standby <args...>', modes: HSRP_MODES, help: 'Remove an HSRP group or setting', run: (s, [rest]) => standby(s, rest!, true) },
  { syntax: 'show standby', modes: EXEC, help: 'HSRP groups in detail', run: (s) => {
    const r = requireRouter(s);
    return showStandby(r.hsrp, r.network?.scheduler.now ?? 0);
  } },
  { syntax: 'show standby brief', modes: EXEC, help: 'One line per HSRP group', run: (s) => showStandbyBrief(requireRouter(s).hsrp) },
];
