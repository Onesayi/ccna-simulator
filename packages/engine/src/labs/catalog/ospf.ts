import type { LabDefinition } from '../types';

/** Three routers in a line, each with a LAN or loopback: the shared starting point of the OSPF labs. */
const LINE_R1 = `conf t
  int g0/0
  ip address 192.168.1.1 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.12.1 255.255.255.252
  no shut`;
const LINE_R2 = `conf t
  int g0/1
  ip address 10.0.12.2 255.255.255.252
  no shut
  int g0/2
  ip address 10.0.23.1 255.255.255.252
  no shut`;
const LINE_R3 = `conf t
  int g0/0
  ip address 192.168.3.1 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.23.2 255.255.255.252
  no shut`;

const LINE_ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
  { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30' },
  { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30' },
  { device: 'R2', interface: 'Gi0/2', address: '10.0.23.1/30' },
  { device: 'R3', interface: 'Gi0/1', address: '10.0.23.2/30' },
  { device: 'R3', interface: 'Gi0/0', address: '192.168.3.1/24' },
  { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
  { device: 'PC3', interface: 'Eth0', address: '192.168.3.10/24', gateway: '192.168.3.1' },
];

const LINE_LINKS: [string, string][] = [
  ['R1 Gi0/1', 'R2 Gi0/1'],
  ['R2 Gi0/2', 'R3 Gi0/1'],
  ['PC1 Eth0', 'R1 Gi0/0'],
  ['PC3 Eth0', 'R3 Gi0/0'],
];

const PCS = [
  { hostname: 'PC1', kind: 'pc' as const, at: [0, 200] as [number, number], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
  { hostname: 'PC3', kind: 'pc' as const, at: [600, 200] as [number, number], ip: '192.168.3.10/24', gateway: '192.168.3.1' },
];

/** Domain 3.0: single-area OSPFv2 (blueprint 3.3). */
export const ospfLabs: LabDefinition[] = [
  {
    id: 'ospf-single-area',
    title: 'Run single-area OSPF',
    domain: '3.0',
    blueprint: ['3.1', '3.3', '3.3.a', '3.3.d'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Replace static routes with OSPF: router IDs, network statements and passive LAN interfaces.',
    briefing: `Three routers sit in a line. They are addressed, but each only knows its connected networks, so PC1 cannot reach PC3. Instead of writing static routes, run **OSPF process 1** in **area 0** on all three.

- Give each router a manual router ID: R1 \`1.1.1.1\`, R2 \`2.2.2.2\`, R3 \`3.3.3.3\`
- Advertise every interface with \`network\` statements (wildcard masks, not subnet masks)
- Make the PC-facing ports passive: they need advertising, but no router will ever answer a hello there

Set the router ID **before** the first \`network\` statement. Once neighbors exist, a new ID only takes effect after \`clear ip ospf process\`.`,
    addressing: LINE_ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [0, 0], config: LINE_R1 },
        { hostname: 'R2', kind: 'router', at: [300, 0], config: LINE_R2 },
        { hostname: 'R3', kind: 'router', at: [600, 0], config: LINE_R3 },
        ...PCS,
      ],
      links: LINE_LINKS,
    },
    objectives: [
      { text: 'R1 has router ID 1.1.1.1', check: { type: 'ospfRouterId', device: 'R1', routerId: '1.1.1.1' }, hint: '`router ospf 1`, then `router-id 1.1.1.1`.' },
      { text: 'R2 has router ID 2.2.2.2', check: { type: 'ospfRouterId', device: 'R2', routerId: '2.2.2.2' } },
      { text: 'R3 has router ID 3.3.3.3', check: { type: 'ospfRouterId', device: 'R3', routerId: '3.3.3.3' } },
      { text: 'R2 is FULL with R1', check: { type: 'ospfNeighbor', device: 'R2', neighbor: '1.1.1.1' }, hint: '`network 10.0.12.0 0.0.0.3 area 0` on both R1 and R2. Check with `show ip ospf neighbor`.' },
      { text: 'R2 is FULL with R3', check: { type: 'ospfNeighbor', device: 'R2', neighbor: '3.3.3.3' } },
      { text: 'R1 learns 192.168.3.0/24 from OSPF', check: { type: 'route', device: 'R1', network: '192.168.3.0', prefix: 24, code: 'O' }, hint: 'R3 must advertise its LAN too: `network 192.168.3.0 0.0.0.255 area 0`.' },
      { text: "R1's LAN port is passive", check: { type: 'ospfInterface', device: 'R1', interface: 'Gi0/0', passive: true }, hint: '`passive-interface g0/0` under `router ospf 1`.' },
      { text: "R3's LAN port is passive", check: { type: 'ospfInterface', device: 'R3', interface: 'Gi0/0', passive: true } },
      { text: 'PC1 can ping PC3', check: { type: 'ping', from: 'PC1', to: '192.168.3.10', expect: 'success' } },
      {
        text: 'Administrative distance',
        check: {
          type: 'quiz',
          question: 'R1 has a static route and an OSPF route to the same prefix. Which one is installed by default?',
          options: ['The OSPF route, AD 110', 'The static route, AD 1', 'Both, load balanced', 'Whichever has the lower metric'],
          answer: 1,
          explain: 'The lowest administrative distance wins: static 1 beats OSPF 110. Metrics only compare routes from the same source. A floating static (`ip route ... 120`) would lose to OSPF instead.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        router ospf 1
        router-id 1.1.1.1
        network 192.168.1.0 0.0.0.255 area 0
        network 10.0.12.0 0.0.0.3 area 0
        passive-interface g0/0
        end`,
      R2: `enable
        conf t
        router ospf 1
        router-id 2.2.2.2
        network 10.0.12.0 0.0.0.3 area 0
        network 10.0.23.0 0.0.0.3 area 0
        end`,
      R3: `enable
        conf t
        router ospf 1
        router-id 3.3.3.3
        network 10.0.23.0 0.0.0.3 area 0
        network 192.168.3.0 0.0.0.255 area 0
        passive-interface g0/0
        end`,
    },
    debrief: 'Read `show ip route` on R1: the `O` routes show `[110/3]`, the AD and the cost (three Gigabit hops at cost 1 each). `show ip protocols` lists the networks and passive interfaces, and `show ip ospf interface brief` shows which routers became DR and BDR on each link.',
  },
  {
    id: 'ospf-dr-bdr',
    title: 'Choose the DR and BDR',
    domain: '3.0',
    blueprint: ['3.3.c', '3.3.a'],
    kind: 'guided',
    difficulty: 3,
    summary: 'Use OSPF priority to control the DR election on a shared LAN, and see why it never preempts.',
    briefing: `Four routers share one Ethernet segment through SW1 and already run OSPF. R1 booted first, so it won the election: R1 is **DR** and R2 is **BDR**.

The team wants the two biggest routers in charge: **R4 as DR** and **R3 as BDR**. R1 and R2 must never become DR or BDR.

- Raise R4's priority to 255 and R3's to 100 on Gi0/0 (\`ip ospf priority\`)
- Check \`show ip ospf neighbor\`: did anything change? Why not?
- Take R1 and R2 out of the election for good with priority 0

Each router's view of the others is in \`show ip ospf neighbor\`: \`FULL/DR\`, \`FULL/BDR\`, and \`2WAY/DROTHER\` between two DROTHERs, which is normal.`,
    addressing: [1, 2, 3, 4].map((n) => ({ device: `R${n}`, interface: 'Gi0/0', address: `10.0.0.${n}/24`, note: `router ID ${n}.${n}.${n}.${n}` })),
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [300, 200] },
        ...[1, 2, 3, 4].map((n) => ({
          hostname: `R${n}`,
          kind: 'router' as const,
          at: [(n - 1) * 200, n % 2 ? 0 : 0] as [number, number],
          config: `conf t
            int g0/0
            ip address 10.0.0.${n} 255.255.255.0
            no shut
            router ospf 1
            router-id ${n}.${n}.${n}.${n}
            network 10.0.0.0 0.0.0.255 area 0`,
        })),
      ],
      links: [1, 2, 3, 4].map((n) => [`R${n} Gi0/0`, `SW1 Gi0/${n}`] as [string, string]),
    },
    objectives: [
      { text: 'R4 is the DR', check: { type: 'ospfInterface', device: 'R4', interface: 'Gi0/0', role: 'DR' }, hint: 'Elections never preempt: a higher priority alone changes nothing while the current DR is up. Priority 0 takes a router out of the election straight away; so does `clear ip ospf process` on the current DR.' },
      { text: 'R3 is the BDR', check: { type: 'ospfInterface', device: 'R3', interface: 'Gi0/0', role: 'BDR' } },
      { text: 'R1 can never be DR (priority 0)', check: { type: 'ospfInterface', device: 'R1', interface: 'Gi0/0', priority: 0, role: 'DROTHER' }, hint: '`interface g0/0`, then `ip ospf priority 0`.' },
      { text: 'R2 can never be DR (priority 0)', check: { type: 'ospfInterface', device: 'R2', interface: 'Gi0/0', priority: 0, role: 'DROTHER' } },
      { text: 'R1 is FULL with the new DR', check: { type: 'ospfNeighbor', device: 'R1', neighbor: '4.4.4.4' } },
      {
        text: 'Non-preemption',
        check: {
          type: 'quiz',
          question: 'R5 is plugged into this LAN with OSPF priority 255. What happens to the DR?',
          options: ['R5 takes over as DR at once', 'R5 becomes BDR at once', 'Nothing until the current DR or BDR fails or OSPF restarts', 'An election starts after the dead interval'],
          answer: 2,
          explain: 'An OSPF router that joins a segment with a DR and BDR already elected accepts them. Priority only matters at the next election.',
        },
      },
      {
        text: 'DROTHER neighbors',
        check: {
          type: 'quiz',
          question: 'On R1, `show ip ospf neighbor` lists R2 as `2WAY/DROTHER`. What does that mean?',
          options: ['The adjacency is stuck and needs fixing', 'Normal: DROTHERs only become FULL with the DR and BDR', 'R2 has a hello timer mismatch', 'R2 is in a different area'],
          answer: 1,
          explain: 'On a multi-access network every router forms a FULL adjacency with the DR and BDR only. Two DROTHERs stop at 2-Way, which keeps flooding efficient.',
        },
      },
    ],
    solution: {
      R4: `enable
        conf t
        int g0/0
        ip ospf priority 255
        end`,
      R3: `enable
        conf t
        int g0/0
        ip ospf priority 100
        end`,
      R1: `enable
        conf t
        int g0/0
        ip ospf priority 0
        end`,
      R2: `enable
        conf t
        int g0/0
        ip ospf priority 0
        end`,
    },
    debrief: 'When R1 dropped out, the BDR (R2) was promoted and R4, the highest priority left, became BDR. When R2 dropped out too, R4 was promoted and R3 took BDR. In production, set priorities before the routers boot, or plan a `clear ip ospf process` on the DR and BDR in a maintenance window.',
  },
  {
    id: 'ospf-troubleshoot',
    title: 'Fix the OSPF adjacencies',
    domain: '3.0',
    blueprint: ['3.3.a', '3.3.b', '2.4'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'Three routers run OSPF but no adjacency comes up and a LAN is missing. Find the faults.',
    briefing: `Someone configured OSPF on R1, R2 and R3 and went home. Nothing works: R2 has no neighbors, and even when it does, R1 never learns PC3's LAN.

Find and fix the faults. Useful commands:

- \`show ip ospf neighbor\` and \`show ip ospf interface g0/1\` (timers, area, network type)
- \`show ip protocols\` (network statements)
- \`show logging\` (OSPF logs some mismatches)

While you are on the R1–R2 link: it only ever has two routers, so make it **point-to-point** on both ends. No DR election, and the adjacency comes up faster.`,
    addressing: LINE_ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [0, 0], config: `${LINE_R1}
          ip ospf hello-interval 5
          router ospf 1
          router-id 1.1.1.1
          network 192.168.1.0 0.0.0.255 area 0
          network 10.0.12.0 0.0.0.3 area 0
          passive-interface g0/0` },
        { hostname: 'R2', kind: 'router', at: [300, 0], config: `${LINE_R2}
          router ospf 1
          router-id 2.2.2.2
          network 10.0.0.0 0.255.255.255 area 0` },
        { hostname: 'R3', kind: 'router', at: [600, 0], config: `${LINE_R3}
          router ospf 1
          router-id 3.3.3.3
          network 10.0.23.0 0.0.0.3 area 1
          network 192.168.30.0 0.0.0.255 area 0
          passive-interface g0/0` },
        ...PCS,
      ],
      links: LINE_LINKS,
    },
    objectives: [
      { text: 'R2 is FULL with R1', check: { type: 'ospfNeighbor', device: 'R2', neighbor: '1.1.1.1' }, hint: 'Hello and dead timers must match on both ends. Compare `show ip ospf interface g0/1` on R1 and R2.' },
      { text: 'R2 is FULL with R3', check: { type: 'ospfNeighbor', device: 'R2', neighbor: '3.3.3.3' }, hint: 'Both ends of a link must be in the same area. `show logging` on R2 names the mismatch.' },
      { text: 'R1 learns 192.168.3.0/24 from OSPF', check: { type: 'route', device: 'R1', network: '192.168.3.0', prefix: 24, code: 'O' }, hint: 'Look closely at the LAN network statement in `show ip protocols` on R3.' },
      { text: 'R1 Gi0/1 is point-to-point', check: { type: 'ospfInterface', device: 'R1', interface: 'Gi0/1', role: 'P2P' }, hint: '`ip ospf network point-to-point` on the interface, on both routers.' },
      { text: 'R2 Gi0/1 is point-to-point', check: { type: 'ospfInterface', device: 'R2', interface: 'Gi0/1', role: 'P2P' } },
      { text: 'PC1 can ping PC3', check: { type: 'ping', from: 'PC1', to: '192.168.3.10', expect: 'success' } },
      {
        text: 'Hello parameters',
        check: {
          type: 'quiz',
          question: 'Which of these may differ between two routers and still let them become OSPF neighbors?',
          options: ['Hello interval', 'Area ID', 'Subnet mask on an Ethernet link', 'Router priority'],
          answer: 3,
          explain: 'Hello and dead intervals, area ID, subnet (on broadcast links), authentication and stub flags must match. Priority only affects the DR election.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        int g0/1
        no ip ospf hello-interval
        ip ospf network point-to-point
        end`,
      R2: `enable
        conf t
        int g0/1
        ip ospf network point-to-point
        end`,
      R3: `enable
        conf t
        router ospf 1
        no network 10.0.23.0 0.0.0.3 area 1
        network 10.0.23.0 0.0.0.3 area 0
        no network 192.168.30.0 0.0.0.255 area 0
        network 192.168.3.0 0.0.0.255 area 0
        end`,
    },
    debrief: 'The three classic faults: a timer mismatch (silent, so compare `show ip ospf interface`), an area mismatch (logged as `%OSPF-4-ERRRCV`), and a network statement that matches no interface. R2 got away with one broad statement, `network 10.0.0.0 0.255.255.255 area 0`, which covers both of its links.',
  },
];
