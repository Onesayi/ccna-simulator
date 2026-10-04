import type { LabDefinition } from '../types';

/** Domain 4.0 blueprint 4.7.c/4.7.d: storm control and IPv6 RA guard on access ports. */
export const l2ProtectionLabs: LabDefinition[] = [
  {
    id: 'storm-control',
    title: 'Stop a broadcast storm at the port',
    domain: '4.0',
    blueprint: ['4.7', '4.7.c'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Storm-control thresholds on access ports, a shutdown action for the lab bench, and automatic recovery.',
    briefing: `A faulty NIC on the lab bench flooded the office with broadcasts last week and every PC on the VLAN slowed to a crawl. Protect SW1's access ports with **storm control**:

- Gi0/1 and Gi0/2 (office PCs): limit broadcasts to **1.00%** of the link, with a falling threshold of 0.50% (\`storm-control broadcast level 1.00 0.50\`). Over the limit, the switch drops the excess until the rate falls back.
- Gi0/3 (the lab bench): the same **1.00%** broadcast limit, but err-disable the port when a storm starts (\`storm-control action shutdown\`)
- Bring storm-disabled ports back on their own after **60** seconds (\`errdisable recovery cause storm-control\` and \`errdisable recovery interval 60\`)

In this simulator every link carries at most 1,000 frames per second, so 1.00% is 10 frames per second. Try it: \`flood broadcast\` on PC1 sends 1,000 broadcasts in a second, then \`show storm-control\` and \`show logging\` on SW1 show what happened.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.11/24', gateway: '192.168.1.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.1.12/24', gateway: '192.168.1.1' },
      { device: 'BENCH', interface: 'Eth0', address: '192.168.1.50/24', gateway: '192.168.1.1', note: 'Lab bench' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut' },
        { hostname: 'SW1', kind: 'switch', at: [250, 150] },
        { hostname: 'PC1', kind: 'pc', at: [50, 320], ip: '192.168.1.11/24', gateway: '192.168.1.1' },
        { hostname: 'PC2', kind: 'pc', at: [250, 320], ip: '192.168.1.12/24', gateway: '192.168.1.1' },
        { hostname: 'BENCH', kind: 'pc', at: [450, 320], ip: '192.168.1.50/24', gateway: '192.168.1.1' },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['BENCH Eth0', 'SW1 Gi0/3'],
      ],
    },
    objectives: [
      {
        text: 'Gi0/1 limits broadcasts to 1.00%',
        check: { type: 'stormControl', device: 'SW1', interface: 'Gi0/1', class: 'broadcast', level: 1 },
        hint: '`interface g0/1`, then `storm-control broadcast level 1.00 0.50`.',
      },
      { text: 'Gi0/2 limits broadcasts to 1.00%', check: { type: 'stormControl', device: 'SW1', interface: 'Gi0/2', class: 'broadcast', level: 1 } },
      {
        text: 'Gi0/3 err-disables on a broadcast storm',
        check: { type: 'stormControl', device: 'SW1', interface: 'Gi0/3', class: 'broadcast', level: 1, action: 'shutdown' },
        hint: 'On Gi0/3: `storm-control broadcast level 1.00` and `storm-control action shutdown`.',
      },
      {
        text: 'Storm-disabled ports recover after 60 seconds',
        check: { type: 'errdisableRecovery', device: 'SW1', cause: 'storm-control', interval: 60 },
        hint: 'Global config: `errdisable recovery cause storm-control` and `errdisable recovery interval 60`.',
      },
      { text: 'PC1 still reaches its gateway', check: { type: 'ping', from: 'PC1', to: '192.168.1.1', expect: 'success' } },
      { text: 'A broadcast storm from PC1 is filtered at Gi0/1', check: { type: 'stormProbe', from: 'PC1', device: 'SW1', interface: 'Gi0/1', expect: 'filtered' } },
      {
        text: 'Thresholds',
        check: {
          type: 'quiz',
          question: 'With `storm-control broadcast level 1.00 0.50`, when does Gi0/1 forward broadcasts again after a storm?',
          options: [
            'As soon as the rate drops below 1.00%',
            'Once the broadcast rate in an interval falls below 0.50%',
            'Only after `shutdown` and `no shutdown`',
            'After the errdisable recovery interval',
          ],
          answer: 1,
          explain: 'The first value is the rising threshold that starts filtering; the second is the falling threshold that ends it. With the default action the port never goes down: it just drops the excess of that traffic class.',
        },
      },
      {
        text: 'Actions',
        check: {
          type: 'quiz',
          question: 'What does `storm-control action trap` add to the default behavior?',
          options: ['It shuts the port down', 'It sends an SNMP trap when a storm is detected', 'It drops all traffic, not only the storm class', 'It disables the falling threshold'],
          answer: 1,
          explain: 'By default the switch only filters. `action trap` also sends an SNMP trap (and a log message) so the NMS knows; `action shutdown` err-disables the port.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface g0/1
        storm-control broadcast level 1.00 0.50
        interface g0/2
        storm-control broadcast level 1.00 0.50
        interface g0/3
        storm-control broadcast level 1.00
        storm-control action shutdown
        exit
        errdisable recovery cause storm-control
        errdisable recovery interval 60
        end`,
    },
    debrief: 'Storm control measures broadcast, multicast and unknown-unicast traffic arriving on a port in one-second intervals. Above the rising level it drops the excess (the default), sends a trap, or err-disables the port. It protects the rest of the VLAN from a looping or babbling device; spanning tree prevents loops, but storm control limits the damage when something slips past it.',
  },
  {
    id: 'ra-guard',
    title: 'Keep rogue IPv6 routers off the LAN',
    domain: '4.0',
    blueprint: ['4.7', '4.7.d'],
    kind: 'guided',
    difficulty: 2,
    summary: 'RA guard policies drop router advertisements from host ports, so SLAAC clients only follow the real router.',
    briefing: `The PCs on this LAN get their IPv6 addresses and default router from R1's router advertisements (SLAAC). Any host can send router advertisements too: a misconfigured PC or an attacker running \`fake_router6\` would become the default router for every SLAAC client.

Use **IPv6 RA guard** on SW1:

- Create a policy **HOSTS** with \`device-role host\` and attach it to the PC ports Gi0/1, Gi0/2 and Gi0/3 (\`ipv6 nd raguard attach-policy HOSTS\`)
- Create a policy **ROUTER** with \`device-role router\` and attach it to Gi0/8, where R1 is

Then test it: \`fake_router6 2001:db8:bad::/64\` on PC3 should no longer change \`ipconfig\` on PC1. \`show ipv6 nd raguard policy\` lists the policies and where they are attached.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '2001:db8:10::1/64' },
      { device: 'PC1', interface: 'Eth0', address: 'SLAAC (2001:db8:10::/64)' },
      { device: 'PC2', interface: 'Eth0', address: 'SLAAC (2001:db8:10::/64)' },
      { device: 'PC3', interface: 'Eth0', address: 'SLAAC (2001:db8:10::/64)', note: 'Untrusted' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: 'conf t\nipv6 unicast-routing\nint g0/0\nipv6 address 2001:db8:10::1/64\nno shut' },
        { hostname: 'SW1', kind: 'switch', at: [250, 150] },
        { hostname: 'PC1', kind: 'pc', at: [50, 320], ipv6: 'auto' },
        { hostname: 'PC2', kind: 'pc', at: [250, 320], ipv6: 'auto' },
        { hostname: 'PC3', kind: 'pc', at: [450, 320], ipv6: 'auto' },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['PC3 Eth0', 'SW1 Gi0/3'],
      ],
    },
    objectives: [
      {
        text: 'Gi0/1 drops router advertisements (host policy)',
        check: { type: 'raGuard', device: 'SW1', interface: 'Gi0/1', role: 'host' },
        hint: '`ipv6 nd raguard policy HOSTS`, `device-role host`, then on Gi0/1 `ipv6 nd raguard attach-policy HOSTS`.',
      },
      { text: 'Gi0/2 drops router advertisements', check: { type: 'raGuard', device: 'SW1', interface: 'Gi0/2', role: 'host' } },
      { text: 'Gi0/3 drops router advertisements', check: { type: 'raGuard', device: 'SW1', interface: 'Gi0/3', role: 'host' } },
      {
        text: "Gi0/8 accepts R1's advertisements (router policy)",
        check: { type: 'raGuard', device: 'SW1', interface: 'Gi0/8', role: 'router' },
        hint: '`ipv6 nd raguard policy ROUTER`, `device-role router`, then on Gi0/8 `ipv6 nd raguard attach-policy ROUTER`.',
      },
      {
        text: 'PC1 has a SLAAC address from R1',
        check: { type: 'ipv6Address', device: 'PC1', interface: 'Eth0', network: '2001:db8:10::', prefix: 64, slaac: true },
      },
      { text: "PC3's rogue router advertisement does not reach PC1", check: { type: 'rogueRa', from: 'PC3', victim: 'PC1', expect: 'blocked' } },
      {
        text: 'The attack',
        check: {
          type: 'quiz',
          question: 'Without RA guard, what does a rogue router advertisement do to a SLAAC host?',
          options: [
            'Nothing: hosts only accept advertisements from the router they first learned',
            'The host adds an address in the rogue prefix and may use the rogue PC as its default router',
            'It err-disables the host port',
            'It changes the host\'s IPv4 gateway',
          ],
          answer: 1,
          explain: 'Hosts trust any router advertisement on the link. A rogue one can make itself the default router (a man-in-the-middle) or hand out a bogus prefix. RA guard stops it at the switch port, much as DHCP snooping stops rogue DHCP servers.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        ipv6 nd raguard policy HOSTS
        device-role host
        exit
        ipv6 nd raguard policy ROUTER
        device-role router
        exit
        interface g0/1
        ipv6 nd raguard attach-policy HOSTS
        interface g0/2
        ipv6 nd raguard attach-policy HOSTS
        interface g0/3
        ipv6 nd raguard attach-policy HOSTS
        interface g0/8
        ipv6 nd raguard attach-policy ROUTER
        end`,
    },
    debrief: 'RA guard is to IPv6 router advertisements what DHCP snooping is to DHCP offers: the switch only lets them in on ports where a real router lives. A port with a host policy drops every RA; a port with a router policy lets them through. `ipv6 nd raguard attach-policy` with no name applies the default host policy.',
  },
];
