import type { LabDefinition } from '../types';
import { infrastructureLabs } from './infrastructure';
import { routingLabs } from './routing';
import { switchingLabs } from './switching';

/** Suggested study order: fundamentals, switching, routing, then the mixed troubleshooting and capstone labs. */
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
  'fix-the-office',
  'capstone-two-sites',
];

const ALL = [...infrastructureLabs, ...switchingLabs, ...routingLabs];

export const LABS: LabDefinition[] = [
  ...ORDER.map((id) => ALL.find((l) => l.id === id)).filter((l): l is LabDefinition => l !== undefined),
  // Anything not yet placed in ORDER still shows up, at the end.
  ...ALL.filter((l) => !ORDER.includes(l.id)),
];

export function findLab(id: string): LabDefinition | undefined {
  return LABS.find((l) => l.id === id);
}
