import type { LabDefinition } from '../types';

/** Domain 1.0: Network Infrastructure and Connectivity. */
export const infrastructureLabs: LabDefinition[] = [
  {
    id: 'router-basics',
    title: 'Bring a router online',
    domain: '1.0',
    blueprint: ['1.3', '2.1.a'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Name a fresh router, address two interfaces and route between two PCs.',
    briefing: `A new router has just been unboxed between two offices. Every port on a fresh router starts **administratively down**, so nothing works yet.

Open the router's console (click it on the canvas), then:

- Rename it to \`R1\`
- Give each interface the first usable address in its LAN (see the table)
- Enable both interfaces
- Prove PC1 can reach PC2 through the router`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '192.168.2.1/24' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.2.10/24', gateway: '192.168.2.1' },
    ],
    topology: {
      devices: [
        { hostname: 'Router', kind: 'router', at: [200, 0] },
        { hostname: 'PC1', kind: 'pc', at: [0, 180], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'PC2', kind: 'pc', at: [400, 180], ip: '192.168.2.10/24', gateway: '192.168.2.1' },
      ],
      links: [
        ['PC1 Eth0', 'Router Gi0/0'],
        ['PC2 Eth0', 'Router Gi0/1'],
      ],
    },
    objectives: [
      { text: 'The router is named R1', check: { type: 'hostname', device: 'Router', name: 'R1' }, hint: 'In global configuration mode: `hostname R1`. Get there with `enable` then `configure terminal`.' },
      { text: 'Gi0/0 is 192.168.1.1/24', check: { type: 'interfaceIp', device: 'Router', interface: 'Gi0/0', address: '192.168.1.1', prefix: 24 }, hint: '`interface g0/0`, then `ip address 192.168.1.1 255.255.255.0`.' },
      { text: 'Gi0/0 is up', check: { type: 'interfaceUp', device: 'Router', interface: 'Gi0/0' }, hint: 'Router ports start shut down. Use `no shutdown` inside the interface.' },
      { text: 'Gi0/1 is 192.168.2.1/24', check: { type: 'interfaceIp', device: 'Router', interface: 'Gi0/1', address: '192.168.2.1', prefix: 24 } },
      { text: 'Gi0/1 is up', check: { type: 'interfaceUp', device: 'Router', interface: 'Gi0/1' } },
      { text: 'PC1 can ping PC2', check: { type: 'ping', from: 'PC1', to: '192.168.2.10', expect: 'success' }, hint: 'Open PC1 and run `ping 192.168.2.10`. If it fails, check `show ip interface brief` on R1.' },
      {
        text: 'Quick check',
        check: {
          type: 'quiz',
          question: 'Which command lists every interface with its IP address and up/down status on one screen?',
          options: ['show running-config', 'show ip interface brief', 'show vlan brief', 'show ip route'],
          answer: 1,
          explain: '`show ip interface brief` (`sh ip int br`) is the fastest way to spot a shut down or unaddressed interface.',
        },
      },
    ],
    solution: {
      Router: `enable
        configure terminal
        hostname R1
        interface g0/0
        ip address 192.168.1.1 255.255.255.0
        no shutdown
        interface g0/1
        ip address 192.168.2.1 255.255.255.0
        no shutdown
        end`,
    },
    debrief: 'A router routes between its directly connected networks with no extra configuration: the `C` and `L` entries in `show ip route` appear the moment an addressed interface comes up.',
  },
  {
    id: 'subnetting-hosts',
    title: 'Address hosts from a VLSM plan',
    domain: '1.0',
    blueprint: ['1.3'],
    kind: 'challenge',
    difficulty: 2,
    summary: 'Work out the right host address, mask and gateway for two unequal subnets.',
    briefing: `The office network 192.168.50.0/24 has been split with VLSM. R1 is already configured:

- LAN A is 192.168.50.0/26, and R1 Gi0/0 is its first host
- LAN B is 192.168.50.64/27, and R1 Gi0/1 is its first host

Give **PC1 the last usable address in LAN A** and **PC2 the last usable address in LAN B**, each with the right mask and default gateway.

On a PC, set the address with \`ipconfig <address> <mask> <gateway>\`.`,
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [200, 0],
          config: `conf t
            int g0/0
            ip address 192.168.50.1 255.255.255.192
            no shut
            int g0/1
            ip address 192.168.50.65 255.255.255.224
            no shut`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 180] },
        { hostname: 'PC2', kind: 'pc', at: [400, 180] },
      ],
      links: [
        ['PC1 Eth0', 'R1 Gi0/0'],
        ['PC2 Eth0', 'R1 Gi0/1'],
      ],
    },
    objectives: [
      { text: 'PC1 has the last usable address in LAN A', check: { type: 'interfaceIp', device: 'PC1', interface: 'Eth0', address: '192.168.50.62', prefix: 26 }, hint: 'A /26 has blocks of 64. LAN A runs from .0 (network) to .63 (broadcast).' },
      { text: "PC1's gateway is R1", check: { type: 'defaultGateway', device: 'PC1', address: '192.168.50.1' } },
      { text: 'PC2 has the last usable address in LAN B', check: { type: 'interfaceIp', device: 'PC2', interface: 'Eth0', address: '192.168.50.94', prefix: 27 }, hint: 'A /27 has blocks of 32. LAN B starts at .64, so where does it end?' },
      { text: "PC2's gateway is R1", check: { type: 'defaultGateway', device: 'PC2', address: '192.168.50.65' } },
      { text: 'PC1 can ping PC2', check: { type: 'ping', from: 'PC1', to: '192.168.50.94', expect: 'success' } },
      {
        text: 'Subnetting',
        check: { type: 'quiz', question: 'How many usable host addresses does a /27 subnet provide?', options: ['32', '30', '28', '62'], answer: 1, explain: '2^(32-27) = 32 addresses, minus the network and broadcast addresses = 30.' },
      },
      {
        text: 'Subnetting',
        check: { type: 'quiz', question: 'What is the broadcast address of 192.168.50.0/26?', options: ['192.168.50.255', '192.168.50.64', '192.168.50.63', '192.168.50.62'], answer: 2 },
      },
    ],
    solution: {
      PC1: 'ipconfig 192.168.50.62 255.255.255.192 192.168.50.1',
      PC2: 'ipconfig 192.168.50.94 255.255.255.224 192.168.50.65',
    },
    debrief: 'Block size = 256 minus the interesting mask octet. /26 → 64, /27 → 32, /28 → 16. The last usable address is always the broadcast address minus one.',
  },
  {
    id: 'fix-the-office',
    title: 'Fix the office network',
    domain: '1.0',
    blueprint: ['1.6', '2.4', '3.2.b'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'Four faults stop two sites talking. Find them with show commands and fix them.',
    briefing: `Users at both sites say "the network is down". The design is sound but four configuration mistakes crept in during the install.

- Site A: SW1 carries VLAN 10 (PC1) and VLAN 20 (PC2) to R1 over a trunk. R1 routes between them with sub-interfaces.
- Site B: PC3 sits behind R2.
- R1 and R2 are joined by 10.0.12.0/30 and use static routes.

Use the addressing table as the source of truth. Start from the PCs and work outwards: \`ipconfig\`, \`ping\`, \`tracert\`, then \`show vlan brief\`, \`show ip interface brief\` and \`show ip route\`.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0.10', address: '192.168.10.1/24' },
      { device: 'R1', interface: 'Gi0/0.20', address: '192.168.20.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.30.1/24' },
      { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.10.10/24', gateway: '192.168.10.1', note: 'VLAN 10' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.20.10/24', gateway: '192.168.20.1', note: 'VLAN 20' },
      { device: 'PC3', interface: 'Eth0', address: '192.168.30.10/24', gateway: '192.168.30.1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [0, 0],
          config: `conf t
            int g0/0
            no shut
            int g0/0.10
            encapsulation dot1q 10
            ip address 192.168.10.1 255.255.255.0
            int g0/0.20
            encapsulation dot1q 20
            ip address 192.168.20.1 255.255.255.0
            int g0/1
            description Link to R2
            ip address 10.0.12.1 255.255.255.252
            no shut
            exit
            ip route 192.168.30.0 255.255.255.0 10.0.12.2`,
        },
        {
          hostname: 'R2',
          kind: 'router',
          at: [420, 0],
          config: `conf t
            int g0/0
            ip address 192.168.30.1 255.255.255.0
            no shut
            int g0/1
            description Link to R1
            ip address 10.0.12.2 255.255.255.252
            exit
            ip route 192.168.10.0 255.255.255.0 10.0.12.1`,
        },
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [0, 160],
          config: `conf t
            vlan 10
            name SALES
            vlan 20
            name ENG
            int g0/1
            switchport mode access
            switchport access vlan 100
            int g0/2
            switchport mode access
            switchport access vlan 20
            int g0/8
            switchport mode trunk`,
        },
        { hostname: 'SW2', kind: 'switch', at: [420, 160] },
        { hostname: 'PC1', kind: 'pc', at: [-120, 320], ip: '192.168.10.10/24', gateway: '192.168.10.1' },
        { hostname: 'PC2', kind: 'pc', at: [120, 320], ip: '192.168.20.10/24', gateway: '192.168.20.254' },
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
      { text: 'PC1 can reach its gateway', check: { type: 'ping', from: 'PC1', to: '192.168.10.1', expect: 'success' }, hint: 'If PC1 cannot reach its own gateway the fault is at Layer 1 or 2. Compare `show vlan brief` on SW1 with the plan.' },
      { text: 'PC2 can reach PC1', check: { type: 'ping', from: 'PC2', to: '192.168.10.10', expect: 'success' }, hint: 'Run `ipconfig` on PC2 and compare every field with the addressing table.' },
      { text: 'PC1 can reach PC3', check: { type: 'ping', from: 'PC1', to: '192.168.30.10', expect: 'success' }, hint: '`tracert` from PC1 shows how far packets get. Then check `show ip interface brief` on both routers.' },
      { text: 'PC2 can reach PC3', check: { type: 'ping', from: 'PC2', to: '192.168.30.10', expect: 'success' }, hint: 'Replies need a route back. Does R2 know every subnet at site A? `show ip route` on R2.' },
      {
        text: 'Troubleshooting',
        check: {
          type: 'quiz',
          question: 'A PC can ping its own gateway but nothing beyond it. Which is the most likely fault?',
          options: ['A wrong access VLAN on its switchport', 'A missing route on a router along the path', 'A faulty cable to the PC', 'A wrong subnet mask on the PC'],
          answer: 1,
          explain: 'Reaching the gateway proves Layers 1 to 3 work locally, so look at routing further along the path.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        int g0/1
        switchport access vlan 10
        end`,
      PC2: 'ipconfig 192.168.20.10 255.255.255.0 192.168.20.1',
      R2: `enable
        conf t
        int g0/1
        no shutdown
        exit
        ip route 192.168.20.0 255.255.255.0 10.0.12.1
        end`,
    },
    debrief: 'The four faults: SW1 Gi0/1 in VLAN 100 instead of 10, the wrong gateway on PC2, R2 Gi0/1 left shut down, and no route on R2 back to 192.168.20.0/24. Working outwards from the host, one layer at a time, finds each one quickly.',
  },
];
