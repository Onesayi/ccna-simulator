import type { LabDefinition } from '../types';
import { discoveryLabs } from './discovery';
import { fhrpLabs } from './fhrp';
import { infrastructureLabs } from './infrastructure';
import { ipv6Labs } from './ipv6';
import { securityLabs } from './security';
import { arpSecurityLabs } from './arp-security';
import { stpLabs } from './stp';
import { operationsLabs } from './operations';
import { ospfLabs } from './ospf';
import { routingLabs } from './routing';
import { serviceLabs } from './services';
import { switchingLabs } from './switching';

/** Suggested study order: fundamentals, switching, routing, services, then the mixed troubleshooting and capstone labs. */
const ORDER = [
  'router-basics',
  'subnetting-hosts',
  'ipv6-addressing',
  'vlans-basic',
  'trunk-two-switches',
  'router-on-a-stick',
  'l3-switch-svi',
  'switch-management',
  'stp-root-bridge',
  'stp-portfast-bpduguard',
  'etherchannel-lacp',
  'etherchannel-troubleshoot',
  'cdp-lldp-map',
  'cdp-native-vlan',
  'static-routing',
  'default-route',
  'floating-static',
  'ipv6-static-routing',
  'ipv6-troubleshoot',
  'ospf-single-area',
  'ospf-dr-bdr',
  'ospf-troubleshoot',
  'hsrp-basic',
  'hsrp-troubleshoot',
  'dhcp-server',
  'dhcp-relay',
  'nat-pat',
  'nat-static',
  'acl-standard',
  'acl-extended',
  'acl-troubleshoot',
  'port-security',
  'port-security-errdisable',
  'dhcp-snooping',
  'dhcp-snooping-troubleshoot',
  'dynamic-arp-inspection',
  'dai-arp-acl',
  'ip-source-guard',
  'ssh-remote-access',
  'syslog-read',
  'ntp-clock',
  'capture-the-fault',
  'fix-the-office',
  'capstone-two-sites',
  'capstone-branch-internet',
];

const ALL = [...infrastructureLabs, ...ipv6Labs, ...switchingLabs, ...stpLabs, ...discoveryLabs, ...routingLabs, ...ospfLabs, ...fhrpLabs, ...serviceLabs, ...securityLabs, ...arpSecurityLabs, ...operationsLabs];

export const LABS: LabDefinition[] = [
  ...ORDER.map((id) => ALL.find((l) => l.id === id)).filter((l): l is LabDefinition => l !== undefined),
  // Anything not yet placed in ORDER still shows up, at the end.
  ...ALL.filter((l) => !ORDER.includes(l.id)),
];

export function findLab(id: string): LabDefinition | undefined {
  return LABS.find((l) => l.id === id);
}
