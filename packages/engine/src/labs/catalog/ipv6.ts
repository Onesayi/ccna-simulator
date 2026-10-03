import type { LabDefinition } from '../types';

/** Two sites joined by a /64 transit link: PC1 - SW1 - R1 - R2 - SW2 - PC2. */
const TWO_SITE_LINKS: [string, string][] = [
  ['R1 Gi0/1', 'R2 Gi0/1'],
  ['R1 Gi0/0', 'SW1 Gi0/8'],
  ['R2 Gi0/0', 'SW2 Gi0/8'],
  ['PC1 Eth0', 'SW1 Gi0/1'],
  ['PC2 Eth0', 'SW2 Gi0/1'],
];

const TWO_SITE_R1 = `conf t
  ipv6 unicast-routing
  int g0/0
  ipv6 address 2001:db8:1::1/64
  ipv6 address fe80::1 link-local
  no shut
  int g0/1
  ipv6 address 2001:db8:12::1/64
  ipv6 address fe80::1 link-local
  no shut`;

const TWO_SITE_R2 = `conf t
  ipv6 unicast-routing
  int g0/0
  ipv6 address 2001:db8:2::1/64
  ipv6 address fe80::2 link-local
  no shut
  int g0/1
  ipv6 address 2001:db8:12::2/64
  ipv6 address fe80::2 link-local
  no shut
  int lo0
  ipv6 address 2001:db8:ffff::2/128`;

const TWO_SITE_ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0', address: '2001:db8:1::1/64', note: 'link-local fe80::1' },
  { device: 'R1', interface: 'Gi0/1', address: '2001:db8:12::1/64', note: 'link-local fe80::1' },
  { device: 'R2', interface: 'Gi0/1', address: '2001:db8:12::2/64', note: 'link-local fe80::2' },
  { device: 'R2', interface: 'Gi0/0', address: '2001:db8:2::1/64', note: 'link-local fe80::2' },
  { device: 'R2', interface: 'Lo0', address: '2001:db8:ffff::2/128' },
  { device: 'PC1', interface: 'Eth0', address: '2001:db8:1::10/64', gateway: 'fe80::1' },
  { device: 'PC2', interface: 'Eth0', address: '2001:db8:2::10/64', gateway: 'fe80::2' },
];

/** Domain 1.0 (IPv6 addressing, blueprint 1.4) and 3.0 (IPv6 static routing, 3.2). */
export const ipv6Labs: LabDefinition[] = [
  {
    id: 'ipv6-addressing',
    title: 'Address a router for IPv6',
    domain: '1.0',
    blueprint: ['1.4'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Global, EUI-64 and link-local addresses on a router, then SLAAC on a PC.',
    briefing: `R1 joins two LANs. PC1 already has a static IPv6 address; PC2 should configure itself with **SLAAC** from R1's router advertisements.

On R1:
- Turn on IPv6 routing, which also makes R1 send router advertisements
- Gi0/0: \`2001:db8:acad:1::1/64\`, and link-local \`fe80::1\`
- Gi0/1: the \`2001:db8:acad:2::/64\` prefix with an **EUI-64** interface ID, and link-local \`fe80::1\`
- Bring both interfaces up

On PC2, run \`ipv6config autoconfig\` and check the address it builds. Then ping PC1 from PC2.

Use \`show ipv6 interface brief\` to see each interface's link-local and global addresses.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '2001:db8:acad:1::1/64', note: 'link-local fe80::1' },
      { device: 'R1', interface: 'Gi0/1', address: '2001:db8:acad:2::/64 eui-64', note: 'link-local fe80::1' },
      { device: 'PC1', interface: 'Eth0', address: '2001:db8:acad:1::10/64', gateway: 'fe80::1' },
      { device: 'PC2', interface: 'Eth0', address: 'SLAAC', note: 'learns 2001:db8:acad:2::/64 from R1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0] },
        { hostname: 'SW1', kind: 'switch', at: [0, 150] },
        { hostname: 'SW2', kind: 'switch', at: [500, 150] },
        { hostname: 'PC1', kind: 'pc', at: [0, 300], ipv6: '2001:db8:acad:1::10/64', gateway6: 'fe80::1' },
        { hostname: 'PC2', kind: 'pc', at: [500, 300] },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['R1 Gi0/1', 'SW2 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW2 Gi0/1'],
      ],
    },
    objectives: [
      { text: 'R1 routes IPv6', check: { type: 'ipv6Routing', device: 'R1' }, hint: 'Global config: `ipv6 unicast-routing`. Without it a router acts as a host and sends no router advertisements.' },
      { text: 'Gi0/0 is 2001:db8:acad:1::1/64', check: { type: 'ipv6Address', device: 'R1', interface: 'Gi0/0', address: '2001:db8:acad:1::1', prefix: 64 }, hint: '`interface g0/0`, then `ipv6 address 2001:db8:acad:1::1/64`.' },
      { text: 'Gi0/0 uses link-local FE80::1', check: { type: 'ipv6LinkLocal', device: 'R1', interface: 'Gi0/0', address: 'fe80::1' }, hint: '`ipv6 address fe80::1 link-local`. The same link-local address can be reused on every interface.' },
      {
        text: 'Gi0/1 has an EUI-64 address in 2001:db8:acad:2::/64',
        check: { type: 'ipv6Address', device: 'R1', interface: 'Gi0/1', network: '2001:db8:acad:2::', prefix: 64, eui64: true },
        hint: '`ipv6 address 2001:db8:acad:2::/64 eui-64`. Look at the result with `show ipv6 interface g0/1`.',
      },
      { text: 'Gi0/1 uses link-local FE80::1', check: { type: 'ipv6LinkLocal', device: 'R1', interface: 'Gi0/1', address: 'fe80::1' } },
      { text: 'Gi0/0 is up', check: { type: 'interfaceUp', device: 'R1', interface: 'Gi0/0' } },
      { text: 'Gi0/1 is up', check: { type: 'interfaceUp', device: 'R1', interface: 'Gi0/1' } },
      {
        text: 'PC2 built its own address with SLAAC',
        check: { type: 'ipv6Address', device: 'PC2', interface: 'Eth0', network: '2001:db8:acad:2::', prefix: 64, slaac: true },
        hint: 'On PC2: `ipv6config autoconfig`. It needs a router advertisement from R1 on that LAN.',
      },
      { text: 'PC2 can ping PC1', check: { type: 'ping', from: 'PC2', to: '2001:db8:acad:1::10', expect: 'success' } },
      {
        text: 'EUI-64',
        check: {
          type: 'quiz',
          question: 'How does EUI-64 turn the MAC 0050.7966.6801 into an interface ID?',
          options: [
            'It pads the MAC with zeros: 0000:0050:7966:6801',
            'It inserts FFFE in the middle and flips the 7th bit: 0250:79FF:FE66:6801',
            'It inserts FFFE at the start: FFFE:0050:7966:6801',
            'It hashes the MAC into a random 64-bit value',
          ],
          answer: 1,
          explain: 'Split the MAC in half, put FFFE between the halves, then invert the universal/local bit (0x02 in the first byte).',
        },
      },
      {
        text: 'Address types',
        check: {
          type: 'quiz',
          question: 'What default gateway does a SLAAC host use?',
          options: ['The first address in the /64', "The router's global address", "The router's link-local address, the source of its router advertisement", 'FF02::2, the all-routers group'],
          answer: 2,
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ipv6 unicast-routing
        int g0/0
        ipv6 address 2001:db8:acad:1::1/64
        ipv6 address fe80::1 link-local
        no shutdown
        int g0/1
        ipv6 address 2001:db8:acad:2::/64 eui-64
        ipv6 address fe80::1 link-local
        no shutdown
        end`,
      PC2: 'ipv6config autoconfig',
    },
    debrief: `Every IPv6 interface has a link-local address (FE80::/10), even with no global address; routers use it as the next hop and hosts use it as their gateway. EUI-64 builds the interface ID from the MAC, and SLAAC does the same on hosts from the /64 prefix in a router advertisement. Try \`show ipv6 neighbors\` on R1 after the ping: Neighbor Discovery has replaced ARP.`,
  },
  {
    id: 'ipv6-static-routing',
    title: 'Route between IPv6 sites with statics',
    domain: '3.0',
    blueprint: ['3.1', '3.2', '3.2.a', '3.2.b', '3.2.c'],
    kind: 'guided',
    difficulty: 2,
    summary: 'A network route, a default route with a link-local next hop, and a host route.',
    briefing: `Both routers are addressed and route IPv6, but each only knows its own networks.

- On R1, add a **network route** to \`2001:db8:2::/64\` through R2's global address \`2001:db8:12::2\`
- On R2, add a **default route** through R1's link-local address \`fe80::1\`. A link-local next hop is only unique on one link, so name the exit interface too
- On R1, add a **host route** to R2's loopback \`2001:db8:ffff::2/128\`, fully specified with exit interface Gi0/1 and next hop \`fe80::2\`

Then check \`show ipv6 route\` on both routers and ping across.`,
    addressing: TWO_SITE_ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [150, 0], config: TWO_SITE_R1 },
        { hostname: 'R2', kind: 'router', at: [450, 0], config: TWO_SITE_R2 },
        { hostname: 'SW1', kind: 'switch', at: [150, 150] },
        { hostname: 'SW2', kind: 'switch', at: [450, 150] },
        { hostname: 'PC1', kind: 'pc', at: [150, 300], ipv6: '2001:db8:1::10/64', gateway6: 'fe80::1' },
        { hostname: 'PC2', kind: 'pc', at: [450, 300], ipv6: '2001:db8:2::10/64', gateway6: 'fe80::2' },
      ],
      links: TWO_SITE_LINKS,
    },
    objectives: [
      {
        text: 'R1 routes 2001:db8:2::/64 via 2001:db8:12::2',
        check: { type: 'ipv6Route', device: 'R1', network: '2001:db8:2::', prefix: 64, code: 'S', nextHop: '2001:db8:12::2' },
        hint: '`ipv6 route 2001:db8:2::/64 2001:db8:12::2`',
      },
      {
        text: 'R2 has a default route via FE80::1',
        check: { type: 'ipv6Route', device: 'R2', network: '::', prefix: 0, code: 'S', nextHop: 'fe80::1' },
        hint: '`ipv6 route ::/0 g0/1 fe80::1`. Without the interface IOS rejects a link-local next hop.',
      },
      {
        text: 'R1 has a host route to 2001:db8:ffff::2',
        check: { type: 'ipv6Route', device: 'R1', network: '2001:db8:ffff::2', prefix: 128, code: 'S', nextHop: 'fe80::2' },
        hint: '`ipv6 route 2001:db8:ffff::2/128 g0/1 fe80::2`',
      },
      { text: 'PC1 can ping PC2', check: { type: 'ping', from: 'PC1', to: '2001:db8:2::10', expect: 'success' } },
      { text: "PC1 can ping R2's loopback", check: { type: 'ping', from: 'PC1', to: '2001:db8:ffff::2', expect: 'success' } },
      {
        text: 'Static routes',
        check: {
          type: 'quiz',
          question: 'Why does `ipv6 route ::/0 fe80::1` on its own get rejected?',
          options: [
            'Default routes cannot use a next hop',
            'The same link-local address can exist on every link, so IOS needs the exit interface to know which one',
            'Link-local addresses are not routable, so they can never be a next hop',
            'The prefix ::/0 must be written as 0::0/0',
          ],
          answer: 1,
        },
      },
      {
        text: 'Routing table',
        check: {
          type: 'quiz',
          question: 'R1 has routes to 2001:db8:2::/64 and ::/0. Which does it use for 2001:db8:2::10?',
          options: ['::/0, because default routes are checked first', '2001:db8:2::/64, the longest matching prefix', 'Whichever was configured first', 'Both, load-balanced'],
          answer: 1,
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ipv6 route 2001:db8:2::/64 2001:db8:12::2
        ipv6 route 2001:db8:ffff::2/128 g0/1 fe80::2
        end`,
      R2: `enable
        conf t
        ipv6 route ::/0 g0/1 fe80::1
        end`,
    },
    debrief: 'IPv6 static routes work like IPv4 ones: recursive (next hop only), directly attached (interface only) or fully specified (both). A link-local next hop always needs the interface. Add a distance at the end, such as `ipv6 route ::/0 g0/2 fe80::3 10`, for a floating static.',
  },
  {
    id: 'ipv6-troubleshoot',
    title: 'Fix the IPv6 branch',
    domain: '1.0',
    blueprint: ['1.4', '3.2', '2.4'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'A SLAAC host with only a link-local address, a wrong gateway and a bad static route.',
    briefing: `Users at both sites report that IPv6 does not work. PC2 uses SLAAC; PC1 is static, with gateway \`fe80::1\` as the design says.

Find and fix three faults. Useful commands:
- On the PCs: \`ipconfig\`, \`ipv6config\`, \`ping\`
- On the routers: \`show ipv6 interface brief\`, \`show ipv6 route\`, \`show running-config\``,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '2001:db8:1::1/64', note: 'link-local should be fe80::1' },
      { device: 'R1', interface: 'Gi0/1', address: '2001:db8:12::1/64' },
      { device: 'R2', interface: 'Gi0/1', address: '2001:db8:12::2/64' },
      { device: 'R2', interface: 'Gi0/0', address: '2001:db8:2::1/64' },
      { device: 'PC1', interface: 'Eth0', address: '2001:db8:1::10/64', gateway: 'fe80::1' },
      { device: 'PC2', interface: 'Eth0', address: 'SLAAC', note: '2001:db8:2::/64' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [150, 0],
          config: `conf t
            ipv6 unicast-routing
            int g0/0
            ipv6 address 2001:db8:1::1/64
            no shut
            int g0/1
            ipv6 address 2001:db8:12::1/64
            no shut
            exit
            ipv6 route 2001:db8:2::/64 2001:db8:12::3`,
        },
        {
          hostname: 'R2',
          kind: 'router',
          at: [450, 0],
          config: `conf t
            int g0/0
            ipv6 address 2001:db8:2::1/64
            no shut
            int g0/1
            ipv6 address 2001:db8:12::2/64
            no shut
            exit
            ipv6 route ::/0 2001:db8:12::1`,
        },
        { hostname: 'SW1', kind: 'switch', at: [150, 150] },
        { hostname: 'SW2', kind: 'switch', at: [450, 150] },
        { hostname: 'PC1', kind: 'pc', at: [150, 300], ipv6: '2001:db8:1::10/64', gateway6: 'fe80::1' },
        { hostname: 'PC2', kind: 'pc', at: [450, 300], ipv6: 'auto' },
      ],
      links: TWO_SITE_LINKS,
    },
    objectives: [
      { text: 'R2 sends router advertisements again', check: { type: 'ipv6Routing', device: 'R2' }, hint: 'PC2 shows only an FE80:: address. Which global command makes a router advertise prefixes?' },
      { text: 'PC2 has a SLAAC address in 2001:db8:2::/64', check: { type: 'ipv6Address', device: 'PC2', interface: 'Eth0', network: '2001:db8:2::', prefix: 64, slaac: true } },
      { text: "PC1's gateway exists on R1", check: { type: 'ipv6LinkLocal', device: 'R1', interface: 'Gi0/0', address: 'fe80::1' }, hint: 'Compare the link-local address in `show ipv6 interface brief` with the gateway PC1 uses.' },
      {
        text: 'R1 reaches 2001:db8:2::/64 through R2',
        check: { type: 'ipv6Route', device: 'R1', network: '2001:db8:2::', prefix: 64, nextHop: '2001:db8:12::2' },
        hint: 'Is the next hop in `show ipv6 route static` really R2?',
      },
      { text: 'PC2 can ping PC1', check: { type: 'ping', from: 'PC2', to: '2001:db8:1::10', expect: 'success' } },
      {
        text: 'Troubleshooting',
        check: {
          type: 'quiz',
          question: 'A host shows only an FE80:: address after enabling SLAAC. What is the most likely cause?',
          options: ['The host needs a DHCPv4 server', 'No router on the link is sending router advertisements', 'The switch port is in the wrong VLAN for IPv6', 'Link-local addresses block global ones'],
          answer: 1,
        },
      },
    ],
    solution: {
      R2: `enable
        conf t
        ipv6 unicast-routing
        end`,
      R1: `enable
        conf t
        int g0/0
        ipv6 address fe80::1 link-local
        exit
        no ipv6 route 2001:db8:2::/64 2001:db8:12::3
        ipv6 route 2001:db8:2::/64 2001:db8:12::2
        end`,
    },
    debrief: 'Without `ipv6 unicast-routing` a router neither forwards IPv6 nor advertises prefixes, so SLAAC hosts sit with a link-local address only. A gateway that does not exist on the link fails silently: Neighbor Discovery gets no answer. Check next hops against the neighbor actually on the link.',
  },
];
