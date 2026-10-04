import { parsePrefix } from '../core/addressing';
import { parseIpv6Prefix } from '../core/ipv6';
import { Topology } from '../core/topology';
import type { Device } from '../devices/device';
import { Pc } from '../devices/pc';
import { createShell } from '../cli/shells';
import { createDevice } from '../devices/factory';
import { IosDevice } from '../devices/ios-device';
import { Server } from '../devices/server';
import { CliSession } from '../cli/session';
import { evaluate } from './checks';
import { PROBE_CHECKS, type LabDefinition, type Objective } from './types';

/**
 * - `pass` / `fail`: graded just now.
 * - `untested`: a probe (ping, traceroute) not run in this pass, or an unanswered quiz.
 */
export type ObjectiveStatus = 'pass' | 'fail' | 'untested';

export interface ObjectiveResult {
  objective: Objective;
  status: ObjectiveStatus;
  detail?: string;
}

/** Splits "PC1 Eth0" into its hostname and interface. */
function endpoint(spec: string): [string, string] {
  const at = spec.indexOf(' ');
  if (at < 0) throw new Error(`Bad link endpoint "${spec}"`);
  return [spec.slice(0, at), spec.slice(at + 1)];
}

/** Lines that mean a command was refused, on any of the shells. */
export const SHELL_ERROR = /^(% |Invalid Command|Incorrect input|Error|usage:|ERROR!)/;

/**
 * Runs a device's starting configuration and throws on the first error, so a broken lab fails its
 * tests. IOS devices start from privileged EXEC; other devices take their own shell's commands.
 */
function configure(device: Device, commands: string): void {
  const ios = device instanceof IosDevice;
  const shell = ios ? new CliSession(device, { loggedIn: true }) : createShell(device);
  if (ios) shell.execute('enable');
  for (const raw of commands.trim().split('\n')) {
    const line = raw.trim();
    const out = shell.execute(line);
    if (SHELL_ERROR.test(out) && !out.startsWith('% Access VLAN')) throw new Error(`${device.hostname}: "${line}" -> ${out}`);
  }
}

/** One attempt at a lab: its own topology, plus the state the grader needs (quiz answers). */
export class LabRun {
  readonly topology = new Topology();
  /** Canvas positions keyed by device id. */
  readonly positions = new Map<string, { x: number; y: number }>();
  /** Quiz answers by objective index. */
  readonly answers = new Map<number, number>();
  /** Devices by the hostname the lab defines, which survives a `hostname` change. */
  private readonly byLabName = new Map<string, Device>();

  constructor(readonly lab: LabDefinition) {
    for (const spec of lab.topology.devices) {
      const d = createDevice(spec.kind, spec.hostname);
      this.topology.add(d);
      this.byLabName.set(spec.hostname.toLowerCase(), d);
      this.positions.set(d.id, { x: spec.at[0], y: spec.at[1] });
    }
    for (const [a, b] of lab.topology.links) {
      const [ha, ia] = endpoint(a);
      const [hb, ib] = endpoint(b);
      this.topology.connect(this.device(ha).iface(ia), this.device(hb).iface(ib));
    }
    for (const spec of lab.topology.devices) {
      const d = this.device(spec.hostname);
      if (d instanceof Pc && spec.mac) d.nic.mac = spec.mac;
      if (d instanceof Pc && spec.ip && spec.ip !== 'dhcp') {
        const [address = '', len = '24'] = spec.ip.split('/');
        d.configure(address, parsePrefix(len), spec.gateway);
      }
      if (d instanceof Pc && spec.ipv6 && spec.ipv6 !== 'auto') {
        const { address, prefix } = parseIpv6Prefix(spec.ipv6);
        d.configureIpv6(address, prefix, spec.gateway6);
      }
      if (d instanceof Server) for (const [path, text] of Object.entries(spec.files ?? {})) d.files.set(path, text.replace(/^\n/, ''));
      if (spec.config) configure(d, spec.config);
    }
    // DHCP and SLAAC clients ask once the network is built and spanning tree has settled, as if just powered on.
    this.topology.converge();
    for (const spec of lab.topology.devices) {
      const d = this.device(spec.hostname);
      if (d instanceof Pc && spec.ip === 'dhcp') d.renew();
      if (d instanceof Pc && spec.ipv6 === 'auto') d.autoconfigureIpv6();
    }
    this.topology.converge();
  }

  device(labName: string): Device {
    const d = this.byLabName.get(labName.toLowerCase());
    if (!d) throw new Error(`Lab ${this.lab.id} has no device ${labName}`);
    return d;
  }

  /**
   * Grades every objective. Without `probes`, pings and traceroutes are left `untested` so live
   * grading after each command never sends traffic the learner did not ask for.
   */
  grade({ probes = false } = {}): ObjectiveResult[] {
    return this.lab.objectives.map((objective, index) => {
      const { check } = objective;
      if (check.type === 'quiz') {
        const answer = this.answers.get(index);
        if (answer === undefined) return { objective, status: 'untested' };
        return answer === check.answer ? { objective, status: 'pass' } : { objective, status: 'fail', detail: 'Not quite. Try again.' };
      }
      if (!probes && PROBE_CHECKS.includes(check.type)) return { objective, status: 'untested' };
      try {
        const r = evaluate(check, (name) => this.device(name));
        return { objective, status: r.pass ? 'pass' : 'fail', detail: r.detail };
      } catch (err) {
        return { objective, status: 'fail', detail: (err as Error).message };
      }
    });
  }

  /** Types the model answer into each device's shell, as a learner would. Quizzes get the right answer. */
  applySolution(): void {
    for (const [name, commands] of Object.entries(this.lab.solution)) {
      const shell = createShell(this.device(name));
      for (const line of commands.trim().split('\n')) {
        const out = shell.execute(line.trim());
        if (SHELL_ERROR.test(out) && !out.startsWith('% Access VLAN')) throw new Error(`${name}: "${line.trim()}" -> ${out}`);
      }
    }
    this.lab.objectives.forEach((o, i) => {
      if (o.check.type === 'quiz') this.answers.set(i, o.check.answer);
    });
  }
}

export function isComplete(results: ObjectiveResult[]): boolean {
  return results.every((r) => r.status === 'pass');
}
