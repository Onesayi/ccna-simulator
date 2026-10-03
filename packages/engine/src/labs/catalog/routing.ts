import type { LabDefinition } from '../types';

/** Domain 3.0: IP Routing. */
export const routingLabs: LabDefinition[] = [
  {
    id: 'static-routing',
    title: 'Connect two sites with static routes',
    domain: '3.0',
    blueprint: ['3.1', '3.2.b'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Add a network route on each router so two LANs can reach each other.',
    briefing: `R1 and R2 are addressed and up, but each only knows its own connected networks. PC1 cannot reach PC2.

- On R1, add a static route to PC2's LAN through R2
- On R2, add a static route to PC1's LAN through R1

Remember that ping needs a path in **both** directions.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.2.1/24' },
      { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.2.10/24', gateway: '192.168.2.1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [0, 0],
          config: `conf t
            int g0/0
            ip address 192.168.1.1 255.255.255.0
            no shut
            int g0/1
            ip address 10.0.12.1 255.255.255.252
            no shut`,
        },
        {
          hostname: 'R2',
          kind: 'router',
          at: [420, 0],
          config: `conf t
            int g0/0
            ip address 192.168.2.1 255.255.255.0
            no shut
            int g0/1
            ip address 10.0.12.2 255.255.255.252
            no shut`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 180], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'PC2', kind: 'pc', at: [420, 180], ip: '192.168.2.10/24', gateway: '192.168.2.1' },
      ],
      links: [
        ['R1 Gi0/1', 'R2 Gi0/1'],
        ['PC1 Eth0', 'R1 Gi0/0'],
        ['PC2 Eth0', 'R2 Gi0/0'],
      ],
    },
    objectives: [
      { text: 'R1 routes 192.168.2.0/24 via R2', check: { type: 'route', device: 'R1', network: '192.168.2.0', prefix: 24, code: 'S', nextHop: '10.0.12.2' }, hint: '`ip route 192.168.2.0 255.255.255.0 10.0.12.2` in global config.' },
      { text: 'R2 routes 192.168.1.0/24 via R1', check: { type: 'route', device: 'R2', network: '192.168.1.0', prefix: 24, code: 'S', nextHop: '10.0.12.1' } },
      { text: 'PC1 can ping PC2', check: { type: 'ping', from: 'PC1', to: '192.168.2.10', expect: 'success' }, hint: 'If only one router has its route, the echo arrives but the reply has no way home.' },
      {
        text: 'Routing table',
        check: {
          type: 'quiz',
          question: 'A router has routes to 10.0.0.0/8, 10.1.0.0/16 and 10.1.1.0/24. Which one does it use for a packet to 10.1.1.77?',
          options: ['10.0.0.0/8, it was added first', '10.1.0.0/16', '10.1.1.0/24', 'The one with the lowest administrative distance'],
          answer: 2,
          explain: 'Longest prefix match always wins. Administrative distance only breaks ties between routes to the exact same prefix.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip route 192.168.2.0 255.255.255.0 10.0.12.2
        end`,
      R2: `enable
        conf t
        ip route 192.168.1.0 255.255.255.0 10.0.12.1
        end`,
    },
    debrief: 'Notice the first ping from PC1 shows timeouts: each router drops the packet that triggers its ARP request. Ping again and every reply comes back.',
  },
  {
    id: 'default-route',
    title: 'Send a branch to the internet with a default route',
    domain: '3.0',
    blueprint: ['3.1', '3.2.a'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Point a branch router at its ISP with a single default static route.',
    briefing: `The branch router R1 connects to an ISP over 198.51.100.0/30. The ISP already routes the branch LAN back to R1, and hosts a public server at 8.8.8.8.

R1 cannot list every network on the internet, so give it a **default route** (0.0.0.0/0) pointing at the ISP.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '198.51.100.1/30' },
      { device: 'ISP', interface: 'Gi0/1', address: '198.51.100.2/30' },
      { device: 'ISP', interface: 'Lo0', address: '8.8.8.8/32', note: 'public server' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [0, 0],
          config: `conf t
            int g0/0
            ip address 192.168.1.1 255.255.255.0
            no shut
            int g0/1
            description Uplink to ISP
            ip address 198.51.100.1 255.255.255.252
            no shut`,
        },
        {
          hostname: 'ISP',
          kind: 'router',
          at: [420, 0],
          config: `conf t
            int g0/1
            ip address 198.51.100.2 255.255.255.252
            no shut
            int lo0
            ip address 8.8.8.8 255.255.255.255
            exit
            ip route 192.168.1.0 255.255.255.0 198.51.100.1`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 180], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
      ],
      links: [
        ['R1 Gi0/1', 'ISP Gi0/1'],
        ['PC1 Eth0', 'R1 Gi0/0'],
      ],
    },
    objectives: [
      { text: 'R1 has a default route via the ISP', check: { type: 'route', device: 'R1', network: '0.0.0.0', prefix: 0, code: 'S', nextHop: '198.51.100.2' }, hint: '`ip route 0.0.0.0 0.0.0.0 198.51.100.2`. Then look for "Gateway of last resort" in `show ip route`.' },
      { text: 'R1 can ping 8.8.8.8', check: { type: 'ping', from: 'R1', to: '8.8.8.8', expect: 'success' } },
      { text: 'PC1 can ping 8.8.8.8', check: { type: 'ping', from: 'PC1', to: '8.8.8.8', expect: 'success' } },
      {
        text: 'Default routes',
        check: {
          type: 'quiz',
          question: 'In `show ip route`, how is a static default route marked?',
          options: ['S', 'S*', 'D*', 'C'],
          answer: 1,
          explain: 'The asterisk marks a candidate default. The header also changes to "Gateway of last resort is 198.51.100.2 to network 0.0.0.0".',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip route 0.0.0.0 0.0.0.0 198.51.100.2
        end`,
    },
    debrief: 'A /0 route matches every destination, but because it is the shortest possible prefix it is only used when nothing more specific matches.',
  },
  {
    id: 'floating-static',
    title: 'Add a backup link with a floating static route',
    domain: '3.0',
    blueprint: ['3.1', '3.2.b', '3.2.c', '3.2.d'],
    kind: 'guided',
    difficulty: 3,
    summary: 'Prefer the primary link, keep a backup route waiting, and add a host route.',
    briefing: `R1 and R2 are joined by two links: Gi0/1 is the primary and Gi0/2 a slower backup. R2 is already configured with a primary and a floating route back to the 192.168.1.0/24 LAN.

On R1:

- Route the server LAN 192.168.2.0/24 via the primary link (next hop 10.0.12.2)
- Add a floating static route to the same LAN via the backup link (next hop 10.0.21.2) with administrative distance 5
- Add a host route to R2's loopback 2.2.2.2 via the primary link`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30', note: 'primary' },
      { device: 'R1', interface: 'Gi0/2', address: '10.0.21.1/30', note: 'backup' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.2.1/24' },
      { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30', note: 'primary' },
      { device: 'R2', interface: 'Gi0/2', address: '10.0.21.2/30', note: 'backup' },
      { device: 'R2', interface: 'Lo0', address: '2.2.2.2/32' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'Server', interface: 'Eth0', address: '192.168.2.100/24', gateway: '192.168.2.1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [0, 0],
          config: `conf t
            int g0/0
            ip address 192.168.1.1 255.255.255.0
            no shut
            int g0/1
            description Primary to R2
            ip address 10.0.12.1 255.255.255.252
            no shut
            int g0/2
            description Backup to R2
            ip address 10.0.21.1 255.255.255.252
            no shut`,
        },
        {
          hostname: 'R2',
          kind: 'router',
          at: [420, 0],
          config: `conf t
            int g0/0
            ip address 192.168.2.1 255.255.255.0
            no shut
            int g0/1
            ip address 10.0.12.2 255.255.255.252
            no shut
            int g0/2
            ip address 10.0.21.2 255.255.255.252
            no shut
            int lo0
            ip address 2.2.2.2 255.255.255.255
            exit
            ip route 192.168.1.0 255.255.255.0 10.0.12.1
            ip route 192.168.1.0 255.255.255.0 10.0.21.1 5`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 200], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'Server', kind: 'pc', at: [420, 200], ip: '192.168.2.100/24', gateway: '192.168.2.1' },
      ],
      links: [
        ['R1 Gi0/1', 'R2 Gi0/1'],
        ['R1 Gi0/2', 'R2 Gi0/2'],
        ['PC1 Eth0', 'R1 Gi0/0'],
        ['Server Eth0', 'R2 Gi0/0'],
      ],
    },
    objectives: [
      { text: 'The primary route to 192.168.2.0/24 is installed', check: { type: 'route', device: 'R1', network: '192.168.2.0', prefix: 24, code: 'S', nextHop: '10.0.12.2' } },
      {
        text: 'A floating route via 10.0.21.2 with AD 5 is configured',
        check: { type: 'staticRoute', device: 'R1', network: '192.168.2.0', prefix: 24, nextHop: '10.0.21.2', ad: 5 },
        hint: 'Add the distance at the end: `ip route 192.168.2.0 255.255.255.0 10.0.21.2 5`. It will not show in `show ip route` while the primary is up, but it is in `show running-config`.',
      },
      { text: 'A host route to 2.2.2.2 uses the primary link', check: { type: 'route', device: 'R1', network: '2.2.2.2', prefix: 32, code: 'S', nextHop: '10.0.12.2' }, hint: 'A host route has a /32 mask: 255.255.255.255.' },
      { text: 'PC1 can reach the server', check: { type: 'ping', from: 'PC1', to: '192.168.2.100', expect: 'success' } },
      { text: 'Traffic to the server takes the primary link', check: { type: 'traceroute', from: 'PC1', to: '192.168.2.100', via: ['192.168.1.1', '10.0.12.2', '192.168.2.100'] } },
      {
        text: 'Floating statics',
        check: {
          type: 'quiz',
          question: 'If R1 Gi0/1 goes down, what does `show ip route` on R1 show for 192.168.2.0/24?',
          options: ['No route: static routes are removed for good', 'S [5/0] via 10.0.21.2', 'S [1/0] via 10.0.12.2, still installed', 'Both routes, load balanced'],
          answer: 1,
          explain: 'With its next hop unreachable the primary is withdrawn, and the floating route with AD 5 is installed in its place. Try it: `shutdown` R1 Gi0/1.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip route 192.168.2.0 255.255.255.0 10.0.12.2
        ip route 192.168.2.0 255.255.255.0 10.0.21.2 5
        ip route 2.2.2.2 255.255.255.255 10.0.12.2
        end`,
    },
    debrief: 'Try the failover now: shut down R1 Gi0/1, run `show ip route`, and ping the server again. Then `no shutdown` and the primary route comes back.',
  },
  {
    id: 'capstone-two-sites',
    title: 'Capstone: build two sites from scratch',
    domain: '3.0',
    blueprint: ['2.1.a', '2.1.b', '2.2', '3.2.b'],
    kind: 'challenge',
    difficulty: 3,
    summary: 'VLANs, a trunk, router-on-a-stick and static routes, all on blank devices.',
    briefing: `Every router and switch here is factory fresh; only the PCs are addressed. Build the network from the plan so every PC can reach every other PC.

- Site A: SW1 puts PC1 in VLAN 10 and PC2 in VLAN 20, and trunks both to R1 on Gi0/8
- R1 routes the two VLANs with sub-interfaces on Gi0/0
- Site B: PC3 sits on SW2 in VLAN 1 behind R2
- R1 and R2 share 10.0.12.0/30 and use static routes

There is no step-by-step list. Use the objectives and \`show\` commands to check your work.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0.10', address: '192.168.10.1/24', note: 'VLAN 10' },
      { device: 'R1', interface: 'Gi0/0.20', address: '192.168.20.1/24', note: 'VLAN 20' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.30.1/24' },
      { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.10.10/24', gateway: '192.168.10.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.20.10/24', gateway: '192.168.20.1' },
      { device: 'PC3', interface: 'Eth0', address: '192.168.30.10/24', gateway: '192.168.30.1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [0, 0] },
        { hostname: 'R2', kind: 'router', at: [420, 0] },
        { hostname: 'SW1', kind: 'switch', at: [0, 160] },
        { hostname: 'SW2', kind: 'switch', at: [420, 160] },
        { hostname: 'PC1', kind: 'pc', at: [-120, 320], ip: '192.168.10.10/24', gateway: '192.168.10.1' },
        { hostname: 'PC2', kind: 'pc', at: [120, 320], ip: '192.168.20.10/24', gateway: '192.168.20.1' },
        { hostname: 'PC3', kind: 'pc', at: [420, 320], ip: '192.168.30.10/24', gateway: '192.168.30.1' },
      ],
      links: [
        ['R1 Gi0/1', 'R2 Gi0/1'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['R2 Gi0/0', 'SW2 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['PC3 Eth0', 'SW2 Gi0/1'],
      ],
    },
    objectives: [
      { text: 'PC1 is in VLAN 10', check: { type: 'accessVlan', device: 'SW1', interface: 'Gi0/1', vlan: 10 } },
      { text: 'PC2 is in VLAN 20', check: { type: 'accessVlan', device: 'SW1', interface: 'Gi0/2', vlan: 20 } },
      { text: 'SW1 trunks to R1', check: { type: 'trunk', device: 'SW1', interface: 'Gi0/8' } },
      { text: 'PC1 can reach PC2', check: { type: 'ping', from: 'PC1', to: '192.168.20.10', expect: 'success' } },
      { text: 'PC1 can reach PC3', check: { type: 'ping', from: 'PC1', to: '192.168.30.10', expect: 'success' } },
      { text: 'PC2 can reach PC3', check: { type: 'ping', from: 'PC2', to: '192.168.30.10', expect: 'success' } },
    ],
    solution: {
      SW1: `enable
        conf t
        vlan 10
        vlan 20
        int g0/1
        switchport mode access
        switchport access vlan 10
        int g0/2
        switchport mode access
        switchport access vlan 20
        int g0/8
        switchport mode trunk
        end`,
      R1: `enable
        conf t
        int g0/0
        no shutdown
        int g0/0.10
        encapsulation dot1q 10
        ip address 192.168.10.1 255.255.255.0
        int g0/0.20
        encapsulation dot1q 20
        ip address 192.168.20.1 255.255.255.0
        int g0/1
        ip address 10.0.12.1 255.255.255.252
        no shutdown
        exit
        ip route 192.168.30.0 255.255.255.0 10.0.12.2
        end`,
      R2: `enable
        conf t
        int g0/0
        ip address 192.168.30.1 255.255.255.0
        no shutdown
        int g0/1
        ip address 10.0.12.2 255.255.255.252
        no shutdown
        exit
        ip route 192.168.10.0 255.255.255.0 10.0.12.1
        ip route 192.168.20.0 255.255.255.0 10.0.12.1
        end`,
    },
    debrief: 'This is the same network as the sandbox demo. Open it from the Sandbox tab and compare `show running-config` with yours.',
  },
];
