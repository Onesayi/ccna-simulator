import { isValidIp } from '../core/addressing';
import type { Device, Interface } from '../devices/device';
import { IpDevice } from '../devices/ip-device';
import { Router } from '../devices/router';
import { Switch } from '../devices/switch';
import type { OspfProcess } from '../routing/ospf';
import type { Acl } from '../services/acl';
import type { ArpAcl } from '../switching/arp-inspection';
import type { DhcpPool } from '../services/dhcp';
import type { LineConfig } from '../services/management';
import { IosDevice } from '../devices/ios-device';
import type { Interaction, Shell } from './remote';

/** IOS command modes. */
export type Mode =
  | 'user'
  | 'privileged'
  | 'config'
  | 'config-if'
  | 'config-if-range'
  | 'config-subif'
  | 'config-vlan'
  | 'config-router'
  | 'dhcp-config'
  | 'config-std-nacl'
  | 'config-ext-nacl'
  | 'config-arp-nacl'
  | 'config-line';

/** The parts of a CLI session that commands read and change. */
export interface Session {
  readonly device: Device;
  mode: Mode;
  currentInterface?: Interface;
  /** `interface range`: interface commands run once per port in the range. */
  currentRange?: Interface[];
  currentVlan?: number;
  currentOspf?: OspfProcess;
  currentPool?: DhcpPool;
  currentAcl?: Acl;
  /** `arp access-list <name>`. */
  currentArpAcl?: ArpAcl;
  /** `line vty` or `line con`. */
  currentLine?: LineConfig;
  /** Questions the session is waiting on (`Password:`) and the telnet or SSH session it opened. */
  readonly io: Interaction;
  /** True for a telnet or SSH session, false on the console. */
  readonly remote: boolean;
  /** Set by `exit` in a remote session: the connection closes. */
  closed: boolean;
  /** Opens a session on another device, for telnet and SSH. */
  spawn(device: IosDevice, privilege: number): Shell;
}

export interface Command {
  /**
   * Keywords, each matched by unambiguous prefix like IOS ("sh run", "conf t"). `<x>` is a free
   * argument; a final `<x...>` swallows the rest of the line.
   */
  syntax: string;
  modes: Mode[];
  help: string;
  run: (s: Session, args: string[]) => string | void;
}

export const CONFIG_MODES: Mode[] = ['config', 'config-if', 'config-if-range', 'config-subif', 'config-vlan', 'config-router', 'dhcp-config', 'config-std-nacl', 'config-ext-nacl', 'config-arp-nacl', 'config-line'];
export const IF_MODES: Mode[] = ['config-if', 'config-if-range', 'config-subif'];
/** Switchport commands: one interface, or a range of them. */
export const L2_IF_MODES: Mode[] = ['config-if', 'config-if-range'];
export const EXEC: Mode[] = ['user', 'privileged'];

export const INVALID = `Invalid input detected at '^' marker.`;

export function requireSwitch(s: Session): Switch {
  if (!(s.device instanceof Switch)) throw new Error('Invalid input detected');
  return s.device;
}

export function requireRouter(s: Session): Router {
  if (!(s.device instanceof Router)) throw new Error(INVALID);
  return s.device;
}

export function requireIos(s: Session): IosDevice {
  if (!(s.device instanceof IosDevice)) throw new Error(INVALID);
  return s.device;
}

export function requireIp(s: Session): IpDevice {
  if (!(s.device instanceof IpDevice)) throw new Error('Command not supported on this device');
  return s.device;
}

export function vlanId(arg: string | undefined): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > 4094) throw new Error('Bad VLAN list');
  return n;
}

export function ip(arg: string | undefined): string {
  if (!arg || !isValidIp(arg)) throw new Error(INVALID);
  return arg;
}

export function int(arg: string | undefined, min: number, max: number): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(INVALID);
  return n;
}

export function iface(s: Session): Interface {
  return s.currentInterface!;
}

/** True when `word` is an abbreviation of `keyword` ("ov" for "overload"). */
export function abbrev(word: string | undefined, keyword: string): boolean {
  return word !== undefined && word.length > 0 && keyword.startsWith(word.toLowerCase());
}

export function parseVlanList(list: string): Set<number> {
  const out = new Set<number>();
  for (const part of list.split(',')) {
    const [a, b] = part.split('-').map((x) => vlanId(x));
    for (let v = a!; v <= (b ?? a!); v++) out.add(v);
  }
  return out;
}
