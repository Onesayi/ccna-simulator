import type { LabDefinition } from '../types';

/** Domain 2.0: mapping a network with CDP and LLDP (blueprint 2.3). */
export const discoveryLabs: LabDefinition[] = [
  {
    id: 'cdp-lldp-map',
    title: 'Map the network with CDP and LLDP',
    domain: '2.0',
    blueprint: ['2.3'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Find out what is plugged into SW1, label every port, and stop advertising to the ISP.',
    briefing: `You have inherited SW1 with no documentation. Discover its neighbors from the CLI rather than tracing cables.

1. On SW1, run \`show cdp neighbors\` (and \`show cdp neighbors detail\` for IP addresses). Give each connected port a \`description\` that names the device at the other end, for example \`description to SW2\`.
2. R1's Gi0/0 faces the ISP. CDP tells the provider your hostnames, platforms and addresses, so turn it off on that port only with \`no cdp enable\`.
3. SW3 is a third-party switch in real life, so the team standardizes on LLDP between SW1 and SW3. Enable it on both with \`lldp run\` and confirm SW1 sees SW3 in \`show lldp neighbors\`.

Leave CDP running everywhere else.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/1', address: '192.168.1.1/24', note: 'LAN' },
      { device: 'R1', interface: 'Gi0/0', address: '203.0.113.2/30', note: 'to ISP' },
      { device: 'ISP', interface: 'Gi0/0', address: '203.0.113.1/30' },
      { device: 'SW1', interface: 'Vlan1', address: '192.168.1.11/24' },
      { device: 'SW2', interface: 'Vlan1', address: '192.168.1.12/24' },
      { device: 'SW3', interface: 'Vlan1', address: '192.168.1.13/24' },
    ],
    topology: {
      devices: [
        { hostname: 'ISP', kind: 'router', at: [250, -150], config: `conf t
          int g0/0
          ip address 203.0.113.1 255.255.255.252
          no shut` },
        { hostname: 'R1', kind: 'router', at: [250, 0], config: `conf t
          int g0/0
          ip address 203.0.113.2 255.255.255.252
          no shut
          int g0/1
          ip address 192.168.1.1 255.255.255.0
          no shut` },
        { hostname: 'SW1', kind: 'switch', at: [250, 200], config: `conf t
          int vlan 1
          ip address 192.168.1.11 255.255.255.0
          no shut` },
        { hostname: 'SW2', kind: 'switch', at: [0, 350], config: `conf t
          int vlan 1
          ip address 192.168.1.12 255.255.255.0
          no shut` },
        { hostname: 'SW3', kind: 'switch', at: [500, 350], config: `conf t
          int vlan 1
          ip address 192.168.1.13 255.255.255.0
          no shut` },
      ],
      links: [
        ['R1 Gi0/0', 'ISP Gi0/0'],
        ['SW1 Gi0/5', 'R1 Gi0/1'],
        ['SW1 Gi0/3', 'SW2 Gi0/6'],
        ['SW1 Gi0/8', 'SW3 Gi0/2'],
      ],
    },
    objectives: [
      { text: "SW1 Gi0/3's description names its neighbor", check: { type: 'description', device: 'SW1', interface: 'g0/3', contains: 'SW2' }, hint: '`show cdp neighbors` lists the local interface first and the neighbor\'s port last.' },
      { text: "SW1 Gi0/5's description names its neighbor", check: { type: 'description', device: 'SW1', interface: 'g0/5', contains: 'R1' } },
      { text: "SW1 Gi0/8's description names its neighbor", check: { type: 'description', device: 'SW1', interface: 'g0/8', contains: 'SW3' } },
      { text: 'CDP is off on R1 Gi0/0', check: { type: 'discovery', device: 'R1', protocol: 'cdp', enabled: false, interface: 'g0/0' } },
      { text: 'The ISP no longer sees R1', check: { type: 'neighbor', device: 'ISP', neighbor: 'R1', absent: true } },
      { text: 'CDP still runs on R1', check: { type: 'discovery', device: 'R1', protocol: 'cdp', enabled: true } },
      { text: 'SW1 sees SW3 with LLDP', check: { type: 'neighbor', device: 'SW1', neighbor: 'SW3', protocol: 'lldp', interface: 'g0/8' }, hint: 'LLDP is off by default on Cisco devices; both ends need `lldp run`.' },
      {
        text: 'Reading the table',
        check: {
          type: 'quiz',
          question: 'SW1 shows `SW2   Gig 0/3   163   S I   WS-C2960-   Gig 0/6`. Which port on SW2 is the cable plugged into?',
          options: ['Gi0/6', 'Gi0/3', 'Both', 'CDP does not say'],
          answer: 0,
          explain: 'The Local Intrfce column is your own port (Gi0/3) and the Port ID column is the neighbor\'s port (Gi0/6).',
        },
      },
      {
        text: 'CDP and LLDP',
        check: {
          type: 'quiz',
          question: 'Which statement is true?',
          options: ['LLDP is an IEEE standard (802.1AB) and CDP is Cisco proprietary', 'CDP is an IEEE standard and LLDP is Cisco proprietary', 'Both are routed and cross every hop', 'LLDP is on by default on Cisco switches'],
          answer: 0,
          explain: 'CDP is Cisco only and on by default; LLDP is the vendor-neutral 802.1AB standard and off by default on IOS. Both are layer 2 and only reach directly connected neighbors.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        int g0/3
        description to SW2 Gi0/6
        int g0/5
        description to R1 Gi0/1
        int g0/8
        description to SW3 Gi0/2
        exit
        lldp run
        end`,
      R1: `enable
        conf t
        int g0/0
        no cdp enable
        end`,
      SW3: `enable
        conf t
        lldp run
        end`,
    },
    debrief: 'CDP and LLDP only describe directly connected devices, so mapping a large network means hopping from device to device. Both protocols leak useful information to anyone listening, which is why best practice is to disable them on ports facing the internet or untrusted users. `show cdp neighbors detail` and `show lldp neighbors detail` add the management addresses you would use to log in next.',
  },
  {
    id: 'cdp-native-vlan',
    title: 'Listen to CDP: native VLAN mismatch',
    domain: '2.0',
    blueprint: ['2.3', '2.1.b'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'Two switches cannot reach each other on the management VLAN, and CDP is complaining.',
    briefing: `SW1 and SW2 share a trunk, and both have a management SVI in VLAN 99. SW1 cannot ping SW2's management address.

Start with \`show logging\` on SW1 and \`show cdp neighbors detail\`, then compare \`show interfaces trunk\` on both switches. Fix SW2 so that it matches SW1: the team's standard is native VLAN 99 on every trunk.`,
    addressing: [
      { device: 'SW1', interface: 'Vlan99', address: '192.168.99.1/24', note: 'management' },
      { device: 'SW2', interface: 'Vlan99', address: '192.168.99.2/24', note: 'management' },
    ],
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [0, 0], config: `conf t
          vlan 99
          name MGMT
          exit
          int g0/1
          switchport mode trunk
          switchport trunk native vlan 99
          exit
          int vlan 99
          ip address 192.168.99.1 255.255.255.0
          no shut` },
        { hostname: 'SW2', kind: 'switch', at: [300, 0], config: `conf t
          int g0/1
          switchport mode trunk
          exit
          int vlan 99
          ip address 192.168.99.2 255.255.255.0
          no shut` },
      ],
      links: [['SW1 Gi0/1', 'SW2 Gi0/1']],
    },
    objectives: [
      {
        text: 'Read the message',
        check: {
          type: 'quiz',
          question: 'SW1 logs `%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on GigabitEthernet0/1 (99), with SW2 GigabitEthernet0/1 (1).` What does it mean?',
          options: ['SW1 sends untagged frames for VLAN 99 and SW2 treats untagged frames as VLAN 1', 'VLAN 99 is pruned from the trunk', 'SW2 is not a trunk', 'The link is half duplex'],
          answer: 0,
          explain: 'CDP advertises each side\'s native VLAN. Untagged frames leave SW1 as VLAN 99 traffic and arrive on SW2 as VLAN 1, so the two VLANs merge across the link and VLAN 99 itself is broken.',
        },
      },
      { text: 'VLAN 99 exists on SW2', check: { type: 'vlan', device: 'SW2', id: 99 }, hint: 'An SVI does not create its VLAN. Check `show vlan brief` on SW2.' },
      { text: "SW2's trunk uses native VLAN 99", check: { type: 'trunk', device: 'SW2', interface: 'g0/1', nativeVlan: 99 } },
      { text: 'SW1 can ping SW2 on VLAN 99', check: { type: 'ping', from: 'SW1', to: '192.168.99.2', expect: 'success' } },
    ],
    solution: {
      SW2: `enable
        conf t
        vlan 99
        name MGMT
        exit
        int g0/1
        switchport trunk native vlan 99
        end`,
    },
    debrief: 'The native VLAN must match on both ends of an 802.1Q trunk, and CDP is often the first thing to notice when it does not. Using an otherwise unused VLAN as the native VLAN (or tagging it with `vlan dot1q tag native`) also closes the VLAN hopping attack that relies on double-tagged frames.',
  },
];
