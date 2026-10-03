import type { LabDefinition } from '../types';
import { infrastructureLabs } from './infrastructure';
import { operationsLabs } from './operations';
import { ospfLabs } from './ospf';
import { routingLabs } from './routing';
import { serviceLabs } from './services';
import { switchingLabs } from './switching';

/** Suggested study order: fundamentals, switching, routing, services, then the mixed troubleshooting and capstone labs. */
const ORDER = [
  'router-basics',
  'subnetting-hosts',
  'vlans-basic',
  'trunk-two-switches',
  'router-on-a-stick',
  'l3-switch-svi',
  'switch-management',
  'static-routing',
  'default-route',
  'floating-static',
  'ospf-single-area',
  'ospf-dr-bdr',
  'ospf-troubleshoot',
  'dhcp-server',
  'dhcp-relay',
  'nat-pat',
  'nat-static',
  'acl-standard',
  'acl-extended',
  'acl-troubleshoot',
  'syslog-read',
  'fix-the-office',
  'capstone-two-sites',
  'capstone-branch-internet',
];

const ALL = [...infrastructureLabs, ...switchingLabs, ...routingLabs, ...ospfLabs, ...serviceLabs, ...operationsLabs];

export const LABS: LabDefinition[] = [
  ...ORDER.map((id) => ALL.find((l) => l.id === id)).filter((l): l is LabDefinition => l !== undefined),
  // Anything not yet placed in ORDER still shows up, at the end.
  ...ALL.filter((l) => !ORDER.includes(l.id)),
];

export function findLab(id: string): LabDefinition | undefined {
  return LABS.find((l) => l.id === id);
}
