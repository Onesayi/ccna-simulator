import type { LabDefinition } from '../types';

const ACCESS_PORTS = `conf t
  vlan 10
  name SALES
  vlan 20
  name ENG
  int g0/1
  switchport mode access
  switchport access vlan 10
  int g0/2
  switchport mode access
  switchport access vlan 20`;

/** Domain 2.0: Switching and Network Access. */
export const switchingLabs: LabDefinition[] = [
  {
    id: 'vlans-basic',
    title: 'Separate two departments with VLANs',
    domain: '2.0',
    blueprint: ['2.2', '2.2.a', '2.4'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Create two VLANs on one switch and put each PC in its own broadcast domain.',
    briefing: `Sales (PC1) and Engineering (PC2) share SW1 and the same subnet, so right now they can reach each other.

- Create VLAN 10 named \`SALES\` and VLAN 20 named \`ENG\`
- Make Gi0/1 an access port in VLAN 10 and Gi0/2 an access port in VLAN 20
- Prove the two PCs can no longer ping each other

Try \`ping 192.168.10.12\` from PC1 before you start, so you can see the change.`,
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [200, 0] },
        { hostname: 'PC1', kind: 'pc', at: [0, 180], ip: '192.168.10.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [400, 180], ip: '192.168.10.12/24' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
      ],
    },
    objectives: [
      { text: 'VLAN 10 exists and is named SALES', check: { type: 'vlan', device: 'SW1', id: 10, name: 'SALES' }, hint: 'In global config: `vlan 10`, then `name SALES`.' },
      { text: 'VLAN 20 exists and is named ENG', check: { type: 'vlan', device: 'SW1', id: 20, name: 'ENG' } },
      { text: 'Gi0/1 is an access port in VLAN 10', check: { type: 'accessVlan', device: 'SW1', interface: 'Gi0/1', vlan: 10 }, hint: '`interface g0/1`, `switchport mode access`, `switchport access vlan 10`.' },
      { text: 'Gi0/2 is an access port in VLAN 20', check: { type: 'accessVlan', device: 'SW1', interface: 'Gi0/2', vlan: 20 } },
      { text: 'PC1 can no longer reach PC2', check: { type: 'ping', from: 'PC1', to: '192.168.10.12', expect: 'fail' } },
      {
        text: 'VLANs',
        check: {
          type: 'quiz',
          question: 'Which command shows the VLANs on a switch and the access ports in each?',
          options: ['show interfaces trunk', 'show mac address-table', 'show vlan brief', 'show ip interface brief'],
          answer: 2,
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        vlan 10
        name SALES
        vlan 20
        name ENG
        int g0/1
        switchport mode access
        switchport access vlan 10
        int g0/2
        switchport mode access
        switchport access vlan 20
        end`,
    },
    debrief: 'Each VLAN is its own broadcast domain. Even with addresses in the same subnet, PC1 and PC2 now need a router to talk. The router-on-a-stick and Layer 3 switch labs add one.',
  },
  {
    id: 'trunk-two-switches',
    title: 'Trunk VLANs between two switches',
    domain: '2.0',
    blueprint: ['2.1.b', '2.2'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Carry VLANs 10 and 20 across an 802.1Q trunk with a dedicated native VLAN.',
    briefing: `Both switches already have VLAN 10 (SALES) and VLAN 20 (ENG) with their access ports set. The link between them, Gi0/8 on each side, is still a plain access port in VLAN 1, so users in the same VLAN on different switches cannot reach each other.

Following best practice, use an unused VLAN as the native VLAN:

- Create VLAN 99 named \`NATIVE\` on both switches
- Make Gi0/8 a trunk on both switches with native VLAN 99
- Allow only VLANs 10, 20 and 99 on the trunk`,
    addressing: [
      { device: 'PC1', interface: 'Eth0', address: '10.10.10.11/24', note: 'SW1, VLAN 10' },
      { device: 'PC2', interface: 'Eth0', address: '10.20.20.11/24', note: 'SW1, VLAN 20' },
      { device: 'PC3', interface: 'Eth0', address: '10.10.10.12/24', note: 'SW2, VLAN 10' },
      { device: 'PC4', interface: 'Eth0', address: '10.20.20.12/24', note: 'SW2, VLAN 20' },
    ],
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [0, 0], config: ACCESS_PORTS },
        { hostname: 'SW2', kind: 'switch', at: [420, 0], config: ACCESS_PORTS },
        { hostname: 'PC1', kind: 'pc', at: [-100, 180], ip: '10.10.10.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [100, 180], ip: '10.20.20.11/24' },
        { hostname: 'PC3', kind: 'pc', at: [320, 180], ip: '10.10.10.12/24' },
        { hostname: 'PC4', kind: 'pc', at: [520, 180], ip: '10.20.20.12/24' },
      ],
      links: [
        ['SW1 Gi0/8', 'SW2 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['PC3 Eth0', 'SW2 Gi0/1'],
        ['PC4 Eth0', 'SW2 Gi0/2'],
      ],
    },
    objectives: [
      { text: 'SW1 has VLAN 99 named NATIVE', check: { type: 'vlan', device: 'SW1', id: 99, name: 'NATIVE' } },
      { text: 'SW2 has VLAN 99 named NATIVE', check: { type: 'vlan', device: 'SW2', id: 99, name: 'NATIVE' } },
      {
        text: 'SW1 Gi0/8 trunks VLANs 10, 20, 99 with native VLAN 99',
        check: { type: 'trunk', device: 'SW1', interface: 'Gi0/8', nativeVlan: 99, allowed: [10, 20, 99] },
        hint: '`switchport mode trunk`, `switchport trunk native vlan 99`, `switchport trunk allowed vlan 10,20,99`. Verify with `show interfaces trunk`.',
      },
      { text: 'SW2 Gi0/8 trunks VLANs 10, 20, 99 with native VLAN 99', check: { type: 'trunk', device: 'SW2', interface: 'Gi0/8', nativeVlan: 99, allowed: [10, 20, 99] }, hint: 'Both ends of a trunk need matching settings.' },
      { text: 'PC1 can reach PC3 (VLAN 10)', check: { type: 'ping', from: 'PC1', to: '10.10.10.12', expect: 'success' } },
      { text: 'PC2 can reach PC4 (VLAN 20)', check: { type: 'ping', from: 'PC2', to: '10.20.20.12', expect: 'success' } },
      {
        text: '802.1Q',
        check: {
          type: 'quiz',
          question: 'Which frames cross an 802.1Q trunk without a VLAN tag?',
          options: ['Frames in VLAN 1, always', 'Frames in the native VLAN', 'Frames in the management VLAN', 'None: every frame on a trunk is tagged'],
          answer: 1,
        },
      },
      {
        text: '802.1Q',
        check: {
          type: 'quiz',
          question: 'What happens if the two ends of a trunk use different native VLANs?',
          options: ['The trunk stays down', 'Tagged frames are dropped', 'Untagged frames leak from one VLAN into the other', 'Nothing: the native VLAN is only local'],
          answer: 2,
          explain: 'Each side treats untagged frames as its own native VLAN, so traffic jumps VLANs. CDP logs a native VLAN mismatch to warn you.',
        },
      },
    ],
    solution: Object.fromEntries(
      ['SW1', 'SW2'].map((sw) => [
        sw,
        `enable
          conf t
          vlan 99
          name NATIVE
          int g0/8
          switchport mode trunk
          switchport trunk native vlan 99
          switchport trunk allowed vlan 10,20,99
          end`,
      ]),
    ),
    debrief: 'Pruning the allowed list keeps unneeded VLANs (and their broadcasts) off the link, and an unused native VLAN closes the door on VLAN hopping by double tagging.',
  },
  {
    id: 'router-on-a-stick',
    title: 'Route between VLANs with router-on-a-stick',
    domain: '2.0',
    blueprint: ['2.1.a', '2.1.b'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Use 802.1Q sub-interfaces on one router port to route between two VLANs.',
    briefing: `SW1 has PC1 in VLAN 10 and PC2 in VLAN 20. R1 has a single cable to SW1 Gi0/8 and must be the default gateway for both VLANs.

- Make SW1 Gi0/8 a trunk
- Enable R1 Gi0/0 (no address on the physical port)
- Create sub-interface Gi0/0.10 for VLAN 10 and Gi0/0.20 for VLAN 20, each with the gateway address from the table`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0.10', address: '192.168.10.1/24', note: 'VLAN 10' },
      { device: 'R1', interface: 'Gi0/0.20', address: '192.168.20.1/24', note: 'VLAN 20' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.10.10/24', gateway: '192.168.10.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.20.10/24', gateway: '192.168.20.1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [200, 0] },
        { hostname: 'SW1', kind: 'switch', at: [200, 160], config: ACCESS_PORTS },
        { hostname: 'PC1', kind: 'pc', at: [60, 320], ip: '192.168.10.10/24', gateway: '192.168.10.1' },
        { hostname: 'PC2', kind: 'pc', at: [340, 320], ip: '192.168.20.10/24', gateway: '192.168.20.1' },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
      ],
    },
    objectives: [
      { text: 'SW1 Gi0/8 is a trunk', check: { type: 'trunk', device: 'SW1', interface: 'Gi0/8' } },
      { text: 'R1 Gi0/0 is up', check: { type: 'interfaceUp', device: 'R1', interface: 'Gi0/0' }, hint: 'Sub-interfaces ride on the physical port, so it needs `no shutdown`.' },
      { text: 'Gi0/0.10 tags VLAN 10', check: { type: 'subinterface', device: 'R1', interface: 'Gi0/0.10', vlan: 10 }, hint: '`interface g0/0.10`, then `encapsulation dot1Q 10` before the IP address.' },
      { text: 'Gi0/0.10 is 192.168.10.1/24', check: { type: 'interfaceIp', device: 'R1', interface: 'Gi0/0.10', address: '192.168.10.1', prefix: 24 } },
      { text: 'Gi0/0.20 tags VLAN 20', check: { type: 'subinterface', device: 'R1', interface: 'Gi0/0.20', vlan: 20 } },
      { text: 'Gi0/0.20 is 192.168.20.1/24', check: { type: 'interfaceIp', device: 'R1', interface: 'Gi0/0.20', address: '192.168.20.1', prefix: 24 } },
      { text: 'PC1 can reach PC2', check: { type: 'ping', from: 'PC1', to: '192.168.20.10', expect: 'success' } },
    ],
    solution: {
      SW1: `enable
        conf t
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
        end`,
    },
    debrief: 'Run `tracert 192.168.20.10` from PC1: the first hop is 192.168.10.1. Every inter-VLAN packet crosses the trunk twice, once up to R1 and once back down, which is why larger sites use a Layer 3 switch instead.',
  },
  {
    id: 'l3-switch-svi',
    title: 'Route between VLANs on a Layer 3 switch',
    domain: '2.0',
    blueprint: ['2.1.d'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Turn on IP routing and create SVIs so a multilayer switch routes between VLANs.',
    briefing: `DSW1 is a multilayer switch with users in VLAN 10 and servers in VLAN 30. The VLANs and access ports are done. Make DSW1 the default gateway for both:

- Enable IP routing on the switch
- Create an SVI for each VLAN with the gateway address and bring it up`,
    addressing: [
      { device: 'DSW1', interface: 'Vlan10', address: '172.16.10.1/24' },
      { device: 'DSW1', interface: 'Vlan30', address: '172.16.30.1/24' },
      { device: 'PC1', interface: 'Eth0', address: '172.16.10.10/24', gateway: '172.16.10.1', note: 'VLAN 10' },
      { device: 'PC2', interface: 'Eth0', address: '172.16.30.10/24', gateway: '172.16.30.1', note: 'VLAN 30' },
    ],
    topology: {
      devices: [
        {
          hostname: 'DSW1',
          kind: 'switch',
          at: [200, 0],
          config: `conf t
            vlan 10
            name USERS
            vlan 30
            name SERVERS
            int g0/1
            switchport mode access
            switchport access vlan 10
            int g0/2
            switchport mode access
            switchport access vlan 30`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 180], ip: '172.16.10.10/24', gateway: '172.16.10.1' },
        { hostname: 'PC2', kind: 'pc', at: [400, 180], ip: '172.16.30.10/24', gateway: '172.16.30.1' },
      ],
      links: [
        ['PC1 Eth0', 'DSW1 Gi0/1'],
        ['PC2 Eth0', 'DSW1 Gi0/2'],
      ],
    },
    objectives: [
      { text: 'IP routing is enabled', check: { type: 'ipRouting', device: 'DSW1' }, hint: 'Global config: `ip routing`. Without it the switch only uses its SVIs for management.' },
      { text: 'Vlan10 is 172.16.10.1/24', check: { type: 'interfaceIp', device: 'DSW1', interface: 'Vlan10', address: '172.16.10.1', prefix: 24 }, hint: '`interface vlan 10`, then `ip address 172.16.10.1 255.255.255.0`.' },
      { text: 'Vlan10 is up', check: { type: 'interfaceUp', device: 'DSW1', interface: 'Vlan10' }, hint: 'New SVIs start shut down.' },
      { text: 'Vlan30 is 172.16.30.1/24', check: { type: 'interfaceIp', device: 'DSW1', interface: 'Vlan30', address: '172.16.30.1', prefix: 24 } },
      { text: 'Vlan30 is up', check: { type: 'interfaceUp', device: 'DSW1', interface: 'Vlan30' } },
      { text: 'PC1 can reach PC2', check: { type: 'ping', from: 'PC1', to: '172.16.30.10', expect: 'success' } },
      {
        text: 'SVIs',
        check: {
          type: 'quiz',
          question: 'An SVI stays up/down after `no shutdown`. What is the most likely cause?',
          options: ['IP routing is disabled', 'The VLAN does not exist or has no up port in it', 'The SVI has no IP address', 'The switch needs a default gateway'],
          answer: 1,
          explain: 'SVI autostate: the line protocol only comes up while the VLAN exists and at least one access or trunk port carrying it is up.',
        },
      },
    ],
    solution: {
      DSW1: `enable
        conf t
        ip routing
        interface vlan 10
        ip address 172.16.10.1 255.255.255.0
        no shutdown
        interface vlan 30
        ip address 172.16.30.1 255.255.255.0
        no shutdown
        end`,
    },
    debrief: 'Run `show ip route` on DSW1: both VLAN subnets appear as connected routes, exactly like on a router.',
  },
  {
    id: 'switch-management',
    title: 'Manage a switch from another subnet',
    domain: '2.0',
    blueprint: ['2.1.d', '2.4'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Give a Layer 2 switch a management address and gateway so remote admins can reach it.',
    briefing: `The network team sits in 10.0.0.0/24 behind R1. They need to reach SW1, a Layer 2 switch, for management.

- Give SW1's Vlan1 SVI the address in the table and bring it up
- Set SW1's default gateway so it can answer hosts outside its own subnet
- Prove both PC1 (local) and Admin (remote) can ping SW1`,
    addressing: [
      { device: 'SW1', interface: 'Vlan1', address: '192.168.1.2/24', gateway: '192.168.1.1' },
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.0.1/24' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'Admin', interface: 'Eth0', address: '10.0.0.10/24', gateway: '10.0.0.1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [200, 0],
          config: `conf t
            int g0/0
            ip address 192.168.1.1 255.255.255.0
            no shut
            int g0/1
            ip address 10.0.0.1 255.255.255.0
            no shut`,
        },
        { hostname: 'SW1', kind: 'switch', at: [0, 160] },
        { hostname: 'PC1', kind: 'pc', at: [0, 320], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'Admin', kind: 'pc', at: [400, 160], ip: '10.0.0.10/24', gateway: '10.0.0.1' },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['Admin Eth0', 'R1 Gi0/1'],
      ],
    },
    objectives: [
      { text: 'Vlan1 is 192.168.1.2/24', check: { type: 'interfaceIp', device: 'SW1', interface: 'Vlan1', address: '192.168.1.2', prefix: 24 }, hint: 'On a Layer 2 switch the IP address goes on an SVI: `interface vlan 1`.' },
      { text: 'Vlan1 is up', check: { type: 'interfaceUp', device: 'SW1', interface: 'Vlan1' } },
      { text: 'SW1 uses R1 as its default gateway', check: { type: 'defaultGateway', device: 'SW1', address: '192.168.1.1' }, hint: 'Global config: `ip default-gateway 192.168.1.1`.' },
      { text: 'PC1 can ping SW1', check: { type: 'ping', from: 'PC1', to: '192.168.1.2', expect: 'success' } },
      { text: 'Admin can ping SW1', check: { type: 'ping', from: 'Admin', to: '192.168.1.2', expect: 'success' } },
      {
        text: 'Management',
        check: {
          type: 'quiz',
          question: 'Why does a Layer 2 switch need `ip default-gateway`?',
          options: ['To forward users’ traffic between VLANs', 'To send its own replies to hosts outside the management subnet', 'To bring the management SVI up', 'To learn MAC addresses on remote subnets'],
          answer: 1,
          explain: 'A Layer 2 switch does not route. The gateway is only for traffic the switch itself sends, such as replies to an SSH session or a ping.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface vlan 1
        ip address 192.168.1.2 255.255.255.0
        no shutdown
        exit
        ip default-gateway 192.168.1.1
        end`,
    },
    debrief: 'Users never notice the switch\'s gateway: it only affects traffic the switch sends itself. Remove it with `no ip default-gateway` and watch the Admin ping fail while PC1 still works.',
  },
];
