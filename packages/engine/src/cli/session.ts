import { shortName, type Interface } from '../devices/device';
import type { Device } from '../devices/device';
import { Switch } from '../devices/switch';

/** IOS command modes. Router-specific modes (config-router, config-line) arrive with the router device. */
export type Mode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan';

const PROMPT_SUFFIX: Record<Mode, string> = {
  user: '>',
  privileged: '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-vlan': '(config-vlan)#',
};

interface Command {
  /** Keywords, each matched by unambiguous prefix like IOS ("sh run", "conf t"). `<x>` is a free argument. */
  syntax: string;
  modes: Mode[];
  help: string;
  run: (s: CliSession, args: string[]) => string | void;
}

/**
 * One terminal attached to one device. Parses IOS-style input with abbreviation support
 * and returns the text a real device would print.
 */
export class CliSession {
  mode: Mode = 'user';
  currentInterface?: Interface;
  currentVlan?: number;

  constructor(readonly device: Device) {}

  get prompt(): string {
    return `${this.device.hostname}${PROMPT_SUFFIX[this.mode]}`;
  }

  execute(line: string): string {
    const input = line.trim();
    if (!input) return '';
    if (input.endsWith('?')) return this.help(input.slice(0, -1).trim());

    const words = input.split(/\s+/);
    const negated = words[0]?.toLowerCase() === 'no';
    const match = this.match(negated ? words.slice(1) : words, negated);
    if (match === 'ambiguous') return `% Ambiguous command:  "${input}"`;
    if (!match) return `% Invalid input detected at '^' marker.`;
    try {
      return match.cmd.run(this, match.args) ?? '';
    } catch (err) {
      return `% ${(err as Error).message}`;
    }
  }

  private match(words: string[], negated: boolean): { cmd: Command; args: string[] } | 'ambiguous' | undefined {
    const candidates = COMMANDS.filter((c) => c.modes.includes(this.mode) && c.syntax.startsWith('no ') === negated);
    const hits: { cmd: Command; args: string[] }[] = [];
    for (const cmd of candidates) {
      const tokens = cmd.syntax.replace(/^no /, '').split(' ');
      if (tokens.length !== words.length) continue;
      const args: string[] = [];
      const ok = tokens.every((tok, i) => {
        const w = words[i] ?? '';
        if (tok.startsWith('<')) return args.push(w), true;
        return tok.startsWith(w.toLowerCase());
      });
      if (ok) hits.push({ cmd, args });
    }
    if (hits.length > 1) {
      // Prefer exact keyword matches before calling it ambiguous ("show vlan" vs "show version").
      const exact = hits.filter((h) => h.cmd.syntax.replace(/^no /, '').split(' ').every((t, i) => t.startsWith('<') || t === words[i]?.toLowerCase()));
      return exact.length === 1 ? exact[0] : 'ambiguous';
    }
    return hits[0];
  }

  private help(prefix: string): string {
    const lines = COMMANDS.filter((c) => c.modes.includes(this.mode) && c.syntax.startsWith(prefix.toLowerCase())).map(
      (c) => `  ${c.syntax.padEnd(36)} ${c.help}`,
    );
    return lines.length ? lines.join('\n') : '% Unrecognized command';
  }
}

function requireSwitch(s: CliSession): Switch {
  if (!(s.device instanceof Switch)) throw new Error('Command not supported on this device');
  return s.device;
}

function vlanId(arg: string | undefined): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > 4094) throw new Error('Bad VLAN list');
  return n;
}

const CONFIG_MODES: Mode[] = ['config', 'config-if', 'config-vlan'];

const COMMANDS: Command[] = [
  { syntax: 'enable', modes: ['user'], help: 'Turn on privileged commands', run: (s) => void (s.mode = 'privileged') },
  { syntax: 'disable', modes: ['privileged'], help: 'Turn off privileged commands', run: (s) => void (s.mode = 'user') },
  { syntax: 'configure terminal', modes: ['privileged'], help: 'Enter configuration mode', run: (s) => {
    s.mode = 'config';
    return 'Enter configuration commands, one per line.  End with CNTL/Z.';
  } },
  { syntax: 'exit', modes: ['user', 'privileged', ...CONFIG_MODES], help: 'Exit from the current mode', run: (s) => {
    if (s.mode === 'config-if' || s.mode === 'config-vlan') s.mode = 'config';
    else if (s.mode === 'config') s.mode = 'privileged';
    else s.mode = 'user';
  } },
  { syntax: 'end', modes: CONFIG_MODES, help: 'Exit to privileged EXEC mode', run: (s) => void (s.mode = 'privileged') },
  { syntax: 'hostname <name>', modes: ['config'], help: 'Set system name', run: (s, [name]) => void (s.device.hostname = name ?? s.device.hostname) },

  // VLANs
  { syntax: 'vlan <id>', modes: ['config', 'config-vlan'], help: 'Create or modify a VLAN', run: (s, [id]) => {
    const sw = requireSwitch(s);
    const n = vlanId(id);
    if (!sw.vlans.has(n)) sw.vlans.set(n, `VLAN${String(n).padStart(4, '0')}`);
    s.currentVlan = n;
    s.mode = 'config-vlan';
  } },
  { syntax: 'no vlan <id>', modes: ['config'], help: 'Delete a VLAN', run: (s, [id]) => void requireSwitch(s).vlans.delete(vlanId(id)) },
  { syntax: 'name <name>', modes: ['config-vlan'], help: 'Name the VLAN', run: (s, [name]) => {
    if (s.currentVlan !== undefined && name) requireSwitch(s).vlans.set(s.currentVlan, name);
  } },

  // Interfaces
  { syntax: 'interface <name>', modes: CONFIG_MODES, help: 'Select an interface to configure', run: (s, [name]) => {
    s.currentInterface = s.device.iface(name ?? '');
    s.mode = 'config-if';
  } },
  { syntax: 'shutdown', modes: ['config-if'], help: 'Shut down the interface', run: (s) => void (s.currentInterface!.adminUp = false) },
  { syntax: 'no shutdown', modes: ['config-if'], help: 'Enable the interface', run: (s) => void (s.currentInterface!.adminUp = true) },
  { syntax: 'description <text>', modes: ['config-if'], help: 'Interface description', run: (s, [text]) => void (s.currentInterface!.description = text) },
  { syntax: 'switchport mode <mode>', modes: ['config-if'], help: 'access | trunk', run: (s, [mode]) => {
    requireSwitch(s);
    const m = mode?.toLowerCase();
    if (m !== undefined && 'access'.startsWith(m)) s.currentInterface!.mode = 'access';
    else if (m !== undefined && 'trunk'.startsWith(m)) s.currentInterface!.mode = 'trunk';
    else throw new Error('Invalid input detected');
  } },
  { syntax: 'switchport access vlan <id>', modes: ['config-if'], help: 'Set the access VLAN', run: (s, [id]) => {
    const sw = requireSwitch(s);
    const n = vlanId(id);
    s.currentInterface!.accessVlan = n;
    if (!sw.vlans.has(n)) {
      sw.vlans.set(n, `VLAN${String(n).padStart(4, '0')}`);
      return `% Access VLAN does not exist. Creating vlan ${n}`;
    }
  } },
  { syntax: 'switchport trunk native vlan <id>', modes: ['config-if'], help: 'Set the native VLAN', run: (s, [id]) => void (s.currentInterface!.nativeVlan = vlanId(id)) },
  { syntax: 'switchport trunk allowed vlan <list>', modes: ['config-if'], help: 'Set allowed VLANs (e.g. 10,20-30)', run: (s, [list]) => {
    s.currentInterface!.allowedVlans = parseVlanList(list ?? '');
  } },

  // Show commands
  { syntax: 'show vlan brief', modes: ['user', 'privileged'], help: 'VLAN summary', run: (s) => showVlanBrief(requireSwitch(s)) },
  { syntax: 'show mac address-table', modes: ['user', 'privileged'], help: 'MAC address table', run: (s) => showMacTable(requireSwitch(s)) },
  { syntax: 'show interfaces trunk', modes: ['user', 'privileged'], help: 'Trunk ports', run: (s) => showTrunks(requireSwitch(s)) },
  { syntax: 'show ip interface brief', modes: ['user', 'privileged'], help: 'Interface status summary', run: (s) => showIpIntBrief(s.device) },
];

export function parseVlanList(list: string): Set<number> {
  const out = new Set<number>();
  for (const part of list.split(',')) {
    const [a, b] = part.split('-').map((x) => vlanId(x));
    for (let v = a!; v <= (b ?? a!); v++) out.add(v);
  }
  return out;
}

function showVlanBrief(sw: Switch): string {
  const rows = [...sw.vlans.entries()].sort(([a], [b]) => a - b).map(([id, name]) => {
    const ports = sw.interfaces.filter((i) => i.mode === 'access' && i.accessVlan === id).map((i) => shortName(i.name)).join(', ');
    return `${String(id).padEnd(5)}${name.padEnd(33)}active    ${ports}`;
  });
  return ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------', ...rows].join('\n');
}

function showMacTable(sw: Switch): string {
  const rows = sw.macTable.map((e) => `${String(e.vlan).padStart(4)}    ${e.mac}    DYNAMIC     ${shortName(e.port.name)}`);
  return ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----', ...rows, `Total Mac Addresses for this criterion: ${rows.length}`].join('\n');
}

function showTrunks(sw: Switch): string {
  const trunks = sw.interfaces.filter((i) => i.mode === 'trunk');
  const rows = trunks.map((i) => `${shortName(i.name).padEnd(12)}on       802.1q         ${i.isUp ? 'trunking' : 'not-trunking'}  ${i.nativeVlan}`);
  const allowed = trunks.map((i) => `${shortName(i.name).padEnd(12)}${i.allowedVlans === 'all' ? '1-4094' : [...i.allowedVlans].join(',')}`);
  return ['Port        Mode     Encapsulation  Status        Native vlan', ...rows, '', 'Port        Vlans allowed on trunk', ...allowed].join('\n');
}

function showIpIntBrief(d: Device): string {
  const rows = d.interfaces.map((i) => {
    const status = !i.adminUp ? 'administratively down' : i.isUp ? 'up' : 'down';
    return `${i.name.padEnd(23)}${(i.ip?.address ?? 'unassigned').padEnd(16)}YES manual ${status.padEnd(22)}${i.isUp ? 'up' : 'down'}`;
  });
  return ['Interface              IP-Address      OK? Method Status                Protocol', ...rows].join('\n');
}
