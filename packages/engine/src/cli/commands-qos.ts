import type { Interface } from '../devices/device';
import type { Router } from '../devices/router';
import { parseDscp } from '../services/dscp';
import { CLASS_DEFAULT, QOS_PROTOCOLS, interfacesWithPolicy, showClassMap, showPolicyMap, showPolicyMapInterface, type ClassMatch, type PolicyClass, type Rate } from '../services/qos';
import { EXEC, IF_MODES, INVALID, L2_IF_MODES, abbrev, iface, int, requireRouter, requireSwitch, type Command, type Session } from './common';

/**
 * QoS: the Modular QoS CLI on routers (class maps, policy maps, `service-policy`) and the
 * Catalyst trust boundary on switches (`mls qos`, `mls qos trust`).
 */

/** Kbps of an interface, for percentages: its `bandwidth`, or 1 Gbps for a GigabitEthernet port. */
export function linkKbps(i: Interface): number {
  return i.bandwidth ?? 1_000_000;
}

function matchLine(words: string[]): ClassMatch {
  const [kw, ...rest] = words;
  if (abbrev(kw, 'any') && !rest.length) return { kind: 'any' };
  if (abbrev(kw, 'dscp') && rest.length) return { kind: 'dscp', values: rest.map(parseDscp) };
  if (abbrev(kw, 'ip') && abbrev(rest[0], 'dscp') && rest.length > 1) return { kind: 'dscp', values: rest.slice(1).map(parseDscp) };
  if (abbrev(kw, 'ip') && abbrev(rest[0], 'precedence') && rest.length > 1) return { kind: 'precedence', values: rest.slice(1).map((v) => int(v, 0, 7)) };
  if (abbrev(kw, 'access-group') && rest.length === 1) return { kind: 'access-group', acl: rest[0]! };
  if (abbrev(kw, 'access-group') && abbrev(rest[0], 'name') && rest.length === 2) return { kind: 'access-group', acl: rest[1]! };
  if (abbrev(kw, 'protocol') && rest.length === 1) {
    const protocol = QOS_PROTOCOLS.find((p) => p === rest[0]!.toLowerCase());
    if (protocol) return { kind: 'protocol', protocol };
  }
  throw new Error(INVALID);
}

function sameMatch(a: ClassMatch, b: ClassMatch): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function policyClass(s: Session): PolicyClass {
  return s.currentPolicyClass!;
}

/** `priority 512`, `priority percent 10`, `bandwidth remaining percent 20`. */
function parseRate(words: string[], allowRemaining: boolean): Rate & { remaining?: boolean } {
  const remaining = allowRemaining && abbrev(words[0], 'remaining');
  const w = remaining ? words.slice(1) : words;
  if (abbrev(w[0], 'percent') && w.length === 2) return { percent: int(w[1], 1, 100), remaining: remaining || undefined };
  if (!remaining && w.length === 1) return { kbps: int(w[0], 8, 10_000_000) };
  throw new Error(INVALID);
}

/** `police [cir] <bps> [conform-action transmit] [exceed-action drop|transmit|set-dscp-transmit <dscp>]`. */
function parsePolice(words: string[]): NonNullable<PolicyClass['police']> {
  const w = abbrev(words[0], 'cir') ? words.slice(1) : words;
  const cir = int(w[0], 8000, 10_000_000_000);
  let exceed: NonNullable<PolicyClass['police']>['exceed'] = 'drop';
  for (let k = 1; k < w.length; k++) {
    if (abbrev(w[k], 'conform-action') && abbrev(w[k + 1], 'transmit')) k++;
    else if (abbrev(w[k], 'exceed-action')) {
      const a = w[++k];
      if (abbrev(a, 'drop')) exceed = 'drop';
      else if (abbrev(a, 'set-dscp-transmit')) exceed = { dscp: parseDscp(w[++k]) };
      else if (abbrev(a, 'transmit')) exceed = 'transmit';
      else throw new Error(INVALID);
    } else throw new Error(INVALID);
  }
  return { cir, exceed };
}

/** `service-policy input|output <name>`: the policy must exist and fit the interface. */
function attach(s: Session, dir: string, name: string): void {
  const r = requireRouter(s);
  const i = iface(s);
  const d = abbrev(dir, 'input') ? 'input' : abbrev(dir, 'output') ? 'output' : undefined;
  if (!d) throw new Error(INVALID);
  const pm = r.qos.policyMaps.get(name);
  if (!pm) throw new Error(`policy map ${name} not configured`);
  const err = r.qos.admission(pm, i, d, linkKbps(i));
  if (err) throw new Error(err);
  (i.servicePolicy ??= {})[d] = name;
}

function detach(s: Session, dir: string): void {
  const i = iface(s);
  if (!i.servicePolicy) return;
  if (abbrev(dir, 'input')) i.servicePolicy.input = undefined;
  else if (abbrev(dir, 'output')) i.servicePolicy.output = undefined;
  else throw new Error(INVALID);
}

/** Queuing in a class also has to fit every interface the policy is already attached to. */
function recheck(r: Router, policy: string): void {
  const pm = r.qos.policyMaps.get(policy)!;
  for (const i of r.interfaces) {
    for (const d of ['input', 'output'] as const) {
      if (i.servicePolicy?.[d] !== policy) continue;
      const err = r.qos.admission(pm, i, d, linkKbps(i));
      if (err) throw new Error(err);
    }
  }
}

/** Runs a change to the current class, undoing it if the policy no longer fits where it is attached. */
function changeClass(s: Session, change: (c: PolicyClass) => void): void {
  const r = requireRouter(s);
  const c = policyClass(s);
  const before = { ...c };
  change(c);
  try {
    recheck(r, s.currentPolicyMap!.name);
  } catch (err) {
    Object.keys(c).forEach((k) => delete (c as unknown as Record<string, unknown>)[k]);
    Object.assign(c, before);
    throw err;
  }
}

function showMlsQosInterface(s: Session, name?: string): string {
  const sw = requireSwitch(s);
  const ports = name ? [sw.iface(name)] : sw.ports;
  return ports
    .map((p) => {
      const trust = p.qosTrust ? `trust ${p.qosTrust}` : 'not trusted';
      return [p.name, `trust state: ${trust}`, `trust mode: ${trust}`, 'trust enabled flag: ena', 'COS override: dis', 'default COS: 0', 'DSCP Mutation Map: Default DSCP Mutation Map', 'Trust device: none', 'qos mode: port-based', ''].join('\n');
    })
    .join('\n');
}

const PMAP_C: Session['mode'][] = ['config-pmap-c'];

export const QOS_COMMANDS: Command[] = [
  // Class maps
  { syntax: 'class-map <name>', modes: ['config'], help: 'Create a class map (match-all)', run: (s, [name]) => classMap(s, name!, undefined) },
  { syntax: 'class-map match-all <name>', modes: ['config'], help: 'Every match line must match', run: (s, [name]) => classMap(s, name!, true) },
  { syntax: 'class-map match-any <name>', modes: ['config'], help: 'Any match line may match', run: (s, [name]) => classMap(s, name!, false) },
  { syntax: 'no class-map <args...>', modes: ['config'], help: 'Delete a class map', run: (s, [args]) => {
    const r = requireRouter(s);
    const name = args!.split(/\s+/).at(-1)!;
    const users = r.qos.usedBy(name);
    if (users.length) throw new Error(`Class-map ${name} is being used by policy-map ${users[0]}`);
    r.qos.classMaps.delete(name);
  } },
  { syntax: 'match <args...>', modes: ['config-cmap'], help: 'dscp <values> | ip precedence <values> | access-group [name] <acl> | protocol <name> | any', run: (s, [args]) => {
    const m = matchLine(args!.split(/\s+/));
    const cm = s.currentClassMap!;
    if (!cm.matches.some((x) => sameMatch(x, m))) cm.matches.push(m);
  } },
  { syntax: 'no match <args...>', modes: ['config-cmap'], help: 'Remove a match line', run: (s, [args]) => {
    const m = matchLine(args!.split(/\s+/));
    const cm = s.currentClassMap!;
    cm.matches = cm.matches.filter((x) => !sameMatch(x, m));
  } },

  // Policy maps
  { syntax: 'policy-map <name>', modes: ['config'], help: 'Create or edit a policy map', run: (s, [name]) => {
    const r = requireRouter(s);
    let pm = r.qos.policyMaps.get(name!);
    if (!pm) {
      pm = { name: name!, classes: [] };
      r.qos.policyMaps.set(name!, pm);
    }
    s.currentPolicyMap = pm;
    s.mode = 'config-pmap';
  } },
  { syntax: 'no policy-map <name>', modes: ['config'], help: 'Delete a policy map', run: (s, [name]) => {
    const r = requireRouter(s);
    if (r.interfaces.some((i) => i.servicePolicy?.input === name || i.servicePolicy?.output === name)) throw new Error(`Policy map ${name} is in use; remove the service-policy first`);
    r.qos.policyMaps.delete(name!);
  } },
  { syntax: 'class <name>', modes: ['config-pmap', 'config-pmap-c'], help: 'Actions for a class map (or class-default)', run: (s, [name]) => {
    const r = requireRouter(s);
    const pm = s.currentPolicyMap!;
    if (name !== CLASS_DEFAULT && !r.qos.classMaps.has(name!)) throw new Error(`class-map ${name} not configured`);
    let c = pm.classes.find((x) => x.name === name);
    if (!c) {
      c = { name: name! };
      // class-default always stays last.
      const at = pm.classes.findIndex((x) => x.name === CLASS_DEFAULT);
      if (at >= 0 && name !== CLASS_DEFAULT) pm.classes.splice(at, 0, c);
      else pm.classes.push(c);
    }
    s.currentPolicyClass = c;
    s.mode = 'config-pmap-c';
  } },
  { syntax: 'no class <name>', modes: ['config-pmap', 'config-pmap-c'], help: 'Remove a class from the policy', run: (s, [name]) => {
    const pm = s.currentPolicyMap!;
    pm.classes = pm.classes.filter((c) => c.name !== name);
    s.mode = 'config-pmap';
  } },
  { syntax: 'set dscp <value>', modes: PMAP_C, help: 'Mark the class: ef | af11-af43 | cs1-cs7 | default | 0-63', run: (s, [v]) => void (policyClass(s).setDscp = parseDscp(v)) },
  { syntax: 'set ip dscp <value>', modes: PMAP_C, help: 'Mark the class with a DSCP', run: (s, [v]) => void (policyClass(s).setDscp = parseDscp(v)) },
  { syntax: 'set ip precedence <value>', modes: PMAP_C, help: 'Mark the class with an IP precedence (0-7)', run: (s, [v]) => void (policyClass(s).setDscp = int(v, 0, 7) << 3) },
  { syntax: 'no set <args...>', modes: PMAP_C, help: 'Stop marking', run: (s) => void (policyClass(s).setDscp = undefined) },
  { syntax: 'priority <args...>', modes: PMAP_C, help: '<kbps> | percent <n>: low-latency queue (LLQ)', run: (s, [args]) => {
    const rate = parseRate(args!.split(/\s+/), false);
    if (policyClass(s).bandwidth) throw new Error('Cannot configure priority and bandwidth in the same class');
    changeClass(s, (c) => (c.priority = rate));
  } },
  { syntax: 'no priority', modes: PMAP_C, help: 'Remove the priority queue', run: (s) => void (policyClass(s).priority = undefined) },
  { syntax: 'bandwidth <args...>', modes: PMAP_C, help: '<kbps> | percent <n> | remaining percent <n>: guaranteed share (CBWFQ)', run: (s, [args]) => {
    const rate = parseRate(args!.split(/\s+/), true);
    if (policyClass(s).priority) throw new Error('Cannot configure priority and bandwidth in the same class');
    changeClass(s, (c) => (c.bandwidth = rate));
  } },
  { syntax: 'no bandwidth', modes: PMAP_C, help: 'Remove the bandwidth guarantee', run: (s) => void (policyClass(s).bandwidth = undefined) },
  { syntax: 'police <args...>', modes: PMAP_C, help: '[cir] <bps> [conform-action transmit] [exceed-action drop | transmit | set-dscp-transmit <dscp>]', run: (s, [args]) => void (policyClass(s).police = parsePolice(args!.split(/\s+/))) },
  { syntax: 'no police <args...>', modes: PMAP_C, help: 'Remove the policer', run: (s) => void (policyClass(s).police = undefined) },
  { syntax: 'no police', modes: PMAP_C, help: 'Remove the policer', run: (s) => void (policyClass(s).police = undefined) },
  { syntax: 'shape average <bps>', modes: PMAP_C, help: 'Shape the class to an average rate', run: (s, [bps]) => void (policyClass(s).shape = int(bps, 8000, 10_000_000_000)) },
  { syntax: 'no shape average <args...>', modes: PMAP_C, help: 'Remove shaping', run: (s) => void (policyClass(s).shape = undefined) },
  { syntax: 'fair-queue', modes: PMAP_C, help: 'Flow-based fair queuing', run: (s) => void (policyClass(s).fairQueue = true) },
  { syntax: 'no fair-queue', modes: PMAP_C, help: 'Remove fair queuing', run: (s) => void (policyClass(s).fairQueue = undefined) },

  // Applying a policy
  { syntax: 'service-policy <direction> <name>', modes: IF_MODES, help: 'input | output <policy-map>', run: (s, [dir, name]) => attach(s, dir!, name!) },
  { syntax: 'no service-policy <direction> <name>', modes: IF_MODES, help: 'Remove a service policy', run: (s, [dir]) => detach(s, dir!) },

  // Show
  { syntax: 'show class-map', modes: EXEC, help: 'Class maps and their match lines', run: (s) => showClassMap(requireRouter(s).qos) },
  { syntax: 'show policy-map', modes: EXEC, help: 'Policy maps and their actions', run: (s) => showPolicyMap(requireRouter(s).qos) },
  { syntax: 'show policy-map <name>', modes: EXEC, help: 'One policy map', run: (s, [name]) => showPolicyMap(requireRouter(s).qos, name) },
  { syntax: 'show policy-map interface', modes: EXEC, help: 'Service policies with per-class counters', run: (s) => {
    const r = requireRouter(s);
    return showPolicyMapInterface(r.qos, interfacesWithPolicy(r.interfaces), linkKbps);
  } },
  { syntax: 'show policy-map interface <name...>', modes: EXEC, help: 'One interface: per-class counters', run: (s, [name]) => {
    const r = requireRouter(s);
    return showPolicyMapInterface(r.qos, [r.iface(name!)], linkKbps);
  } },

  // Catalyst trust boundary
  { syntax: 'mls qos', modes: ['config'], help: 'Enable QoS (untrusted ports then reset DSCP to 0)', run: (s) => void (requireSwitch(s).mlsQos = true) },
  { syntax: 'no mls qos', modes: ['config'], help: 'Disable QoS (every marking passes through)', run: (s) => void (requireSwitch(s).mlsQos = false) },
  { syntax: 'mls qos trust <what>', modes: L2_IF_MODES, help: 'dscp | cos: keep the marking that arrives on this port', run: (s, [what]) => {
    requireSwitch(s);
    const t = (['dscp', 'cos'] as const).find((x) => abbrev(what, x));
    if (!t) throw new Error(INVALID);
    iface(s).qosTrust = t;
  } },
  { syntax: 'no mls qos trust', modes: L2_IF_MODES, help: 'Stop trusting markings on this port', run: (s) => void (iface(s).qosTrust = undefined) },
  { syntax: 'show mls qos', modes: EXEC, help: 'Whether QoS is enabled', run: (s) => `QoS is ${requireSwitch(s).mlsQos ? 'enabled' : 'disabled'}\nQoS ip packet dscp rewrite is enabled` },
  { syntax: 'show mls qos interface', modes: EXEC, help: 'Trust state of every port', run: (s) => showMlsQosInterface(s) },
  { syntax: 'show mls qos interface <name...>', modes: EXEC, help: 'Trust state of one port', run: (s, [name]) => showMlsQosInterface(s, name) },
];

function classMap(s: Session, name: string, matchAll: boolean | undefined): void {
  const r = requireRouter(s);
  if (name.toLowerCase() === CLASS_DEFAULT) throw new Error('class-default is predefined and cannot be changed');
  let cm = r.qos.classMaps.get(name);
  if (!cm) {
    cm = { name, matchAll: matchAll ?? true, matches: [] };
    r.qos.classMaps.set(name, cm);
  } else if (matchAll !== undefined) cm.matchAll = matchAll;
  s.currentClassMap = cm;
  s.mode = 'config-cmap';
}
