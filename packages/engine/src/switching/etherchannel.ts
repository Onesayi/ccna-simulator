import type { ChannelPdu } from '../core/frames';
import { shortName, type ChannelMode, type Interface } from '../devices/device';

export type ChannelProtocol = 'lacp' | 'pagp' | 'on';

export function channelProtocol(mode: ChannelMode): ChannelProtocol {
  if (mode === 'active' || mode === 'passive') return 'lacp';
  if (mode === 'desirable' || mode === 'auto') return 'pagp';
  return 'on';
}

/**
 * Do these two ends agree to bundle? LACP needs at least one active side, PAgP at least one
 * desirable side, and both ends must speak the same protocol. Mode `on` sends nothing and never
 * negotiates, so it is handled by the caller.
 */
export function negotiates(local: ChannelMode, peer: ChannelPdu | undefined): boolean {
  if (!peer || channelProtocol(local) !== peer.kind) return false;
  if (peer.kind === 'lacp') return local === 'active' || peer.mode === 'active';
  return local === 'desirable' || peer.mode === 'desirable';
}

/** The Layer 2 settings every member of a bundle must share with its port-channel. */
export function sameL2(a: Interface, b: Interface): boolean {
  const allowed = (i: Interface) => (i.allowedVlans === 'all' ? 'all' : [...i.allowedVlans].sort((x, y) => x - y).join(','));
  if (a.mode !== b.mode) return false;
  if (a.mode === 'access') return a.accessVlan === b.accessVlan;
  return a.nativeVlan === b.nativeVlan && allowed(a) === allowed(b);
}

export function copyL2(from: Interface, to: Interface): void {
  to.mode = from.mode;
  to.accessVlan = from.accessVlan;
  to.nativeVlan = from.nativeVlan;
  to.allowedVlans = from.allowedVlans === 'all' ? 'all' : new Set(from.allowedVlans);
}

/** Why a member is or is not in its bundle, as the flags in `show etherchannel summary`. */
export type MemberFlag = 'P' | 'I' | 's' | 'D';

export interface ChannelView {
  id: number;
  po: Interface;
  members: { port: Interface; flag: MemberFlag }[];
  protocol: ChannelProtocol;
}

export function showEtherchannelSummary(channels: ChannelView[]): string {
  const proto: Record<ChannelProtocol, string> = { lacp: 'LACP', pagp: 'PAgP', on: '-' };
  const rows = channels.map((c) => {
    const ports = c.members.map((m) => `${shortName(m.port.name)}(${m.flag})`.padEnd(12)).join('');
    return `${String(c.id).padEnd(7)}${`Po${c.id}(S${c.po.isUp ? 'U' : 'D'})`.padEnd(16)}${proto[c.protocol].padEnd(10)}${ports.trimEnd()}`;
  });
  return [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '',
    `Number of channel-groups in use: ${channels.length}`,
    `Number of aggregators:           ${channels.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
    ...rows,
  ].join('\n');
}
