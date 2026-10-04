import { shortName, type Interface } from '../devices/device';
import type { Switch } from '../devices/switch';
import { TRAFFIC_CLASSES, parseStormLevel, showStormControl, type TrafficClass } from '../switching/storm-control';
import { EXEC, INVALID, L2_IF_MODES, abbrev, iface, requireSwitch, type Command, type Session } from './common';

/** Storm control and IPv6 RA guard (Catalyst switches only). */

function port(s: Session): { sw: Switch; i: Interface } {
  const sw = requireSwitch(s);
  const i = iface(s);
  if (i.kind !== 'physical' && i.kind !== 'port-channel') throw new Error(INVALID);
  return { sw, i };
}

function trafficClass(word: string | undefined): TrafficClass {
  const cls = TRAFFIC_CLASSES.find((c) => abbrev(word, c));
  if (!cls) throw new Error(INVALID);
  return cls;
}

/** `no storm-control broadcast level ...` or `no storm-control action ...`. */
function removeStorm(s: Session, rest: string): void {
  const { sw, i } = port(s);
  const [what] = rest.split(/\s+/);
  const sc = i.stormControl;
  if (!sc) return;
  if (abbrev(what, 'action')) sc.action = undefined;
  else delete sc[trafficClass(what)];
  if (!sc.broadcast && !sc.multicast && !sc.unicast && !sc.action) {
    i.stormControl = undefined;
    sw.storm.reset(i);
  }
}

/** `show storm-control [interface] [broadcast|multicast|unicast]`. */
function showStorm(s: Session, args: string[]): string {
  const sw = requireSwitch(s);
  let cls: TrafficClass = 'broadcast';
  let ports = sw.interfaces.filter((i) => i.kind === 'physical' || i.kind === 'port-channel');
  if (args.length && TRAFFIC_CLASSES.some((c) => abbrev(args.at(-1), c))) cls = trafficClass(args.pop());
  if (args.length) ports = [sw.iface(args.join(''))];
  return showStormControl(sw.storm, ports, cls);
}

function showRaGuard(sw: Switch, name?: string): string {
  const policies = name ? [sw.raGuardPolicies.get(name)].filter((p) => p !== undefined) : [...sw.raGuardPolicies.values()];
  if (name && !policies.length) throw new Error(`Policy ${name} not found`);
  const out: string[] = [];
  for (const p of policies) {
    const targets = sw.interfaces.filter((i) => i.raGuard === p.name);
    out.push(`Policy ${p.name} configuration: `, `  device-role ${p.role}`);
    if (targets.length) {
      out.push(`Policy ${p.name} is applied on the following targets: `, 'Target               Type  Policy               Feature        Target range');
      for (const t of targets) out.push(`${shortName(t.name).padEnd(21)}PORT  ${p.name.padEnd(21)}RA guard       vlan all`);
    }
  }
  return out.join('\n');
}

export const L2_TRAFFIC_COMMANDS: Command[] = [
  // Storm control
  { syntax: 'storm-control <class> level <args...>', modes: L2_IF_MODES, help: 'broadcast|multicast|unicast level <rising %> [falling %] | level pps <rising> [falling]', run: (s, [cls, args]) => {
    const { i } = port(s);
    const level = parseStormLevel(args!.split(/\s+/));
    (i.stormControl ??= {})[trafficClass(cls)] = level;
  } },
  { syntax: 'storm-control action <action>', modes: L2_IF_MODES, help: 'shutdown | trap (the default only drops the excess)', run: (s, [action]) => {
    const { i } = port(s);
    const a = (['shutdown', 'trap'] as const).find((x) => abbrev(action, x));
    if (!a) throw new Error(INVALID);
    (i.stormControl ??= {}).action = a;
  } },
  { syntax: 'no storm-control <args...>', modes: L2_IF_MODES, help: 'Remove a storm-control threshold or action', run: (s, [rest]) => removeStorm(s, rest!) },
  { syntax: 'show storm-control', modes: EXEC, help: 'Storm-control thresholds and state (broadcast)', run: (s) => showStorm(s, []) },
  { syntax: 'show storm-control <args...>', modes: EXEC, help: '[interface] [broadcast | multicast | unicast]', run: (s, [args]) => showStorm(s, args!.split(/\s+/)) },

  // RA guard
  { syntax: 'ipv6 nd raguard policy <name>', modes: ['config'], help: 'Create or edit an RA guard policy', run: (s, [name]) => {
    const sw = requireSwitch(s);
    let policy = sw.raGuardPolicies.get(name!);
    if (!policy) {
      policy = { name: name!, role: 'host', dropped: 0 };
      sw.raGuardPolicies.set(name!, policy);
    }
    s.currentRaGuard = policy;
    s.mode = 'config-ra-guard';
  } },
  { syntax: 'no ipv6 nd raguard policy <name>', modes: ['config'], help: 'Delete an RA guard policy', run: (s, [name]) => {
    const sw = requireSwitch(s);
    if (sw.interfaces.some((i) => i.raGuard === name)) throw new Error(`Policy ${name} is in use; detach it first`);
    sw.raGuardPolicies.delete(name!);
  } },
  { syntax: 'device-role <role>', modes: ['config-ra-guard'], help: 'host (drop RAs, the default) | router (allow RAs)', run: (s, [role]) => {
    const r = (['host', 'router'] as const).find((x) => abbrev(role, x));
    if (!r) throw new Error(INVALID);
    s.currentRaGuard!.role = r;
  } },
  { syntax: 'ipv6 nd raguard attach-policy', modes: L2_IF_MODES, help: 'RA guard with the default (host) policy', run: (s) => {
    const { sw, i } = port(s);
    i.raGuard = 'default';
    sw.raGuardPolicy(i);
  } },
  { syntax: 'ipv6 nd raguard attach-policy <name>', modes: L2_IF_MODES, help: 'RA guard with a named policy', run: (s, [name]) => {
    const { sw, i } = port(s);
    if (!sw.raGuardPolicies.has(name!) && name !== 'default') throw new Error(`Policy ${name} not found`);
    i.raGuard = name;
  } },
  { syntax: 'no ipv6 nd raguard attach-policy', modes: L2_IF_MODES, help: 'Remove RA guard from the port', run: (s) => void (port(s).i.raGuard = undefined) },
  { syntax: 'no ipv6 nd raguard attach-policy <name>', modes: L2_IF_MODES, help: 'Remove RA guard from the port', run: (s) => void (port(s).i.raGuard = undefined) },
  { syntax: 'show ipv6 nd raguard policy', modes: EXEC, help: 'RA guard policies and where they are attached', run: (s) => showRaGuard(requireSwitch(s)) },
  { syntax: 'show ipv6 nd raguard policy <name>', modes: EXEC, help: 'One RA guard policy', run: (s, [name]) => showRaGuard(requireSwitch(s), name) },
];
