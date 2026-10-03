import type { LabDefinition } from '../types';

/** VLANs 10 and 20 with trunks on Gi0/1 and Gi0/2: the three switches of the triangle labs. */
const TRIANGLE_SWITCH = `conf t
  vlan 10
  name STAFF
  vlan 20
  name VOICE
  int range g0/1 - 2
  switchport mode trunk
  int g0/5
  switchport mode access
  switchport access vlan 10`;

/** VLAN 10 on Gi0/5 for the PCs, and two plain links between the switches on Gi0/1 and Gi0/2. */
const PAIR_SWITCH = `conf t
  vlan 10
  name STAFF
  int g0/5
  switchport mode access
  switchport access vlan 10`;

const PAIR_LINKS: [string, string][] = [
  ['SW1 Gi0/1', 'SW2 Gi0/1'],
  ['SW1 Gi0/2', 'SW2 Gi0/2'],
  ['PC1 Eth0', 'SW1 Gi0/5'],
  ['PC2 Eth0', 'SW2 Gi0/5'],
];

/** Domain 2.0: Rapid PVST+ (blueprint 2.5) and EtherChannel (2.1.c). */
export const stpLabs: LabDefinition[] = [
  {
    id: 'stp-root-bridge',
    title: 'Choose the root bridge per VLAN',
    domain: '2.0',
    blueprint: ['2.5', '2.5.a', '2.5.b'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Run Rapid PVST+ and split the root role between two switches, one per VLAN.',
    briefing: `Three switches form a triangle of trunks, so spanning tree must block one link. Right now the oldest switch, SW1, has the lowest MAC address and wins the root election for every VLAN, which is rarely what you want.

- Run **Rapid PVST+** on all three switches
- Make SW2 the root bridge for VLAN 10 and the backup root for VLAN 20
- Make SW3 the root bridge for VLAN 20 and the backup root for VLAN 10

\`spanning-tree vlan <id> root primary\` and \`root secondary\` set the priority for you. Compare \`show spanning-tree vlan 10\` on SW1 before and after: which of its ports ends up blocking?`,
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [250, 0], config: TRIANGLE_SWITCH },
        { hostname: 'SW2', kind: 'switch', at: [0, 200], config: TRIANGLE_SWITCH },
        { hostname: 'SW3', kind: 'switch', at: [500, 200], config: TRIANGLE_SWITCH },
        { hostname: 'PC1', kind: 'pc', at: [0, 380], ip: '10.10.10.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [500, 380], ip: '10.10.10.12/24' },
      ],
      links: [
        ['SW1 Gi0/1', 'SW2 Gi0/1'],
        ['SW1 Gi0/2', 'SW3 Gi0/1'],
        ['SW2 Gi0/2', 'SW3 Gi0/2'],
        ['PC1 Eth0', 'SW2 Gi0/5'],
        ['PC2 Eth0', 'SW3 Gi0/5'],
      ],
    },
    objectives: [
      { text: 'SW1 runs Rapid PVST+', check: { type: 'stpMode', device: 'SW1', mode: 'rapid-pvst' }, hint: 'Global config: `spanning-tree mode rapid-pvst`.' },
      { text: 'SW2 runs Rapid PVST+', check: { type: 'stpMode', device: 'SW2', mode: 'rapid-pvst' } },
      { text: 'SW3 runs Rapid PVST+', check: { type: 'stpMode', device: 'SW3', mode: 'rapid-pvst' } },
      { text: 'SW2 is the root bridge for VLAN 10', check: { type: 'stpRoot', device: 'SW2', vlan: 10 }, hint: 'On SW2: `spanning-tree vlan 10 root primary`.' },
      { text: 'SW3 is the root bridge for VLAN 20', check: { type: 'stpRoot', device: 'SW3', vlan: 20 }, hint: 'On SW3: `spanning-tree vlan 20 root primary`.' },
      {
        text: 'In VLAN 10, SW1 blocks its link to SW3',
        check: { type: 'stpPortRole', device: 'SW1', interface: 'Gi0/2', vlan: 10, role: 'alternate' },
        hint: 'SW1 Gi0/2 only becomes the alternate port if SW3 has the better bridge ID of the two. Make SW3 the secondary root for VLAN 10.',
      },
      {
        text: 'In VLAN 20, SW1 blocks its link to SW2',
        check: { type: 'stpPortRole', device: 'SW1', interface: 'Gi0/1', vlan: 20, role: 'alternate' },
        hint: 'Make SW2 the secondary root for VLAN 20.',
      },
      { text: 'PC1 can reach PC2 in VLAN 10', check: { type: 'ping', from: 'PC1', to: '10.10.10.12', expect: 'success' } },
      {
        text: 'Root election',
        check: {
          type: 'quiz',
          question: 'All switches use the default priority. Which becomes the root bridge?',
          options: ['The switch with the most ports', 'The switch with the lowest MAC address', 'The switch with the highest MAC address', 'The first switch to boot'],
          answer: 1,
          explain: 'The bridge ID is the priority (plus the VLAN as system ID extension) then the MAC. With equal priorities, the lowest MAC wins.',
        },
      },
      {
        text: 'Port roles',
        check: {
          type: 'quiz',
          question: 'In Rapid PVST+, what is an alternate port?',
          options: [
            'A port that forwards for a second VLAN',
            'A discarding port that offers a backup path to the root bridge',
            'The port with the lowest cost to the root',
            'A port connected to an end host',
          ],
          answer: 1,
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        spanning-tree mode rapid-pvst
        end`,
      SW2: `enable
        conf t
        spanning-tree mode rapid-pvst
        spanning-tree vlan 10 root primary
        spanning-tree vlan 20 root secondary
        end`,
      SW3: `enable
        conf t
        spanning-tree mode rapid-pvst
        spanning-tree vlan 20 root primary
        spanning-tree vlan 10 root secondary
        end`,
    },
    debrief: 'PVST+ runs a separate tree per VLAN, so different VLANs can block different links and both uplinks carry traffic. `root primary` sets priority 24576 (or 4096 below the current root), `root secondary` sets 28672; both are just ordinary priorities in the running config.',
  },
  {
    id: 'stp-portfast-bpduguard',
    title: 'Stop a rogue switch with BPDU guard',
    domain: '2.0',
    blueprint: ['2.5', '2.5.c', '2.5.d'],
    kind: 'guided',
    difficulty: 2,
    summary: 'PortFast and BPDU guard on access ports, against a switch that hijacked the root role.',
    briefing: `DSW1 is meant to be the root bridge, but someone has plugged a switch (ROGUE) into SW1 Gi0/3 under their desk. ROGUE has priority 0, so it has taken over as root and traffic now bends towards it. Check with \`show spanning-tree\` on SW1.

On SW1's access ports Gi0/1 to Gi0/3:
- Enable **PortFast**, so hosts get a working port straight away
- Enable **BPDU guard**, so a port that hears a BPDU shuts itself down

\`interface range g0/1 - 3\` saves typing. Watch what happens to Gi0/3.`,
    topology: {
      devices: [
        { hostname: 'DSW1', kind: 'switch', at: [250, 0], config: 'conf t\nspanning-tree vlan 1 priority 24576' },
        { hostname: 'SW1', kind: 'switch', at: [250, 170] },
        { hostname: 'ROGUE', kind: 'switch', at: [500, 330], config: 'conf t\nspanning-tree vlan 1 priority 0' },
        { hostname: 'PC1', kind: 'pc', at: [0, 330], ip: '192.168.1.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [250, 330], ip: '192.168.1.12/24' },
      ],
      links: [
        ['DSW1 Gi0/1', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['ROGUE Gi0/1', 'SW1 Gi0/3'],
      ],
    },
    objectives: [
      { text: 'PortFast on Gi0/1', check: { type: 'portfast', device: 'SW1', interface: 'Gi0/1' }, hint: '`spanning-tree portfast` in interface config.' },
      { text: 'PortFast on Gi0/2', check: { type: 'portfast', device: 'SW1', interface: 'Gi0/2' } },
      { text: 'BPDU guard on Gi0/3', check: { type: 'bpduGuard', device: 'SW1', interface: 'Gi0/3' }, hint: '`spanning-tree bpduguard enable`, or globally `spanning-tree portfast bpduguard default` for every PortFast port.' },
      { text: 'Gi0/3 is err-disabled', check: { type: 'errDisabled', device: 'SW1', interface: 'Gi0/3', expect: true }, hint: 'The port shuts down when the next BPDU arrives. See `show interfaces status err-disabled`.' },
      { text: 'DSW1 is the root bridge again', check: { type: 'stpRoot', device: 'DSW1', vlan: 1 } },
      { text: 'PC1 can reach PC2', check: { type: 'ping', from: 'PC1', to: '192.168.1.12', expect: 'success' } },
      {
        text: 'Recovery',
        check: {
          type: 'quiz',
          question: 'Once the rogue switch is removed, how do you bring Gi0/3 back?',
          options: ['It recovers on its own after 30 seconds', '`shutdown` then `no shutdown` on the interface', '`clear spanning-tree`', 'Reload the switch'],
          answer: 1,
          explain: 'Without `errdisable recovery`, an err-disabled port stays down until an administrator bounces it.',
        },
      },
      {
        text: 'Guards',
        check: {
          type: 'quiz',
          question: 'A port should accept BPDUs from a downstream switch but never let it become root. Which feature fits?',
          options: ['BPDU guard', 'PortFast', 'Root guard', 'Port security'],
          answer: 2,
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface range g0/1 - 3
        spanning-tree portfast
        spanning-tree bpduguard enable
        end`,
    },
    debrief: 'PortFast skips the wait on ports that lead to hosts; BPDU guard protects those same ports, err-disabling one the moment a switch shows up on it. Root guard (`spanning-tree guard root`) is the gentler choice on links to switches you do expect: it blocks the port only while it hears a better root.',
  },
  {
    id: 'etherchannel-lacp',
    title: 'Bundle two links with LACP',
    domain: '2.0',
    blueprint: ['2.1.c', '2.1.b'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Turn two parallel links into one LACP port-channel trunk, so neither is blocked.',
    briefing: `SW1 and SW2 are joined by two links, Gi0/1 and Gi0/2. Spanning tree blocks one of them, so you pay for two links and use one. They are also plain access ports in VLAN 1, so the PCs in VLAN 10 cannot reach each other.

- Bundle Gi0/1 and Gi0/2 into **Port-channel 1** with **LACP**: SW1 actively negotiates, SW2 passively
- Make Port-channel 1 an 802.1Q trunk on both switches

Settings on the port-channel interface are copied to its member ports. Check with \`show etherchannel summary\` and \`show spanning-tree\`.`,
    addressing: [
      { device: 'PC1', interface: 'Eth0', address: '10.10.10.11/24', note: 'SW1 Gi0/5, VLAN 10' },
      { device: 'PC2', interface: 'Eth0', address: '10.10.10.12/24', note: 'SW2 Gi0/5, VLAN 10' },
    ],
    topology: {
      devices: [
        { hostname: 'SW1', kind: 'switch', at: [0, 0], config: PAIR_SWITCH },
        { hostname: 'SW2', kind: 'switch', at: [450, 0], config: PAIR_SWITCH },
        { hostname: 'PC1', kind: 'pc', at: [0, 200], ip: '10.10.10.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [450, 200], ip: '10.10.10.12/24' },
      ],
      links: PAIR_LINKS,
    },
    objectives: [
      {
        text: 'SW1 bundles both links into Po1 with LACP',
        check: { type: 'etherchannel', device: 'SW1', group: 1, bundled: 2, protocol: 'lacp' },
        hint: '`interface range g0/1 - 2`, then `channel-group 1 mode active`.',
      },
      { text: 'SW2 bundles both links into Po1 with LACP', check: { type: 'etherchannel', device: 'SW2', group: 1, bundled: 2, protocol: 'lacp' }, hint: 'On SW2 use `channel-group 1 mode passive`.' },
      { text: 'Po1 is a trunk on SW1', check: { type: 'trunk', device: 'SW1', interface: 'Po1' }, hint: '`interface port-channel 1`, then `switchport mode trunk`.' },
      { text: 'Po1 is a trunk on SW2', check: { type: 'trunk', device: 'SW2', interface: 'Po1' } },
      { text: "Po1 is SW2's root port in VLAN 10, with nothing blocked", check: { type: 'stpPortRole', device: 'SW2', interface: 'Po1', vlan: 10, role: 'root' } },
      { text: 'PC1 can reach PC2 in VLAN 10', check: { type: 'ping', from: 'PC1', to: '10.10.10.12', expect: 'success' } },
      {
        text: 'LACP modes',
        check: {
          type: 'quiz',
          question: 'Which pair of LACP modes does NOT form an EtherChannel?',
          options: ['active and active', 'active and passive', 'passive and passive', 'passive and active'],
          answer: 2,
          explain: 'Passive only answers LACP; at least one side must be active to start negotiating.',
        },
      },
      {
        text: 'Spanning tree',
        check: {
          type: 'quiz',
          question: 'How does spanning tree treat a working EtherChannel?',
          options: ['It blocks all but one member link', 'As one logical port, so no member is blocked', 'It ignores the bundle completely', 'Each member gets its own VLAN'],
          answer: 1,
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface range g0/1 - 2
        channel-group 1 mode active
        interface port-channel 1
        switchport mode trunk
        end`,
      SW2: `enable
        conf t
        interface range g0/1 - 2
        channel-group 1 mode passive
        interface port-channel 1
        switchport mode trunk
        end`,
    },
    debrief: 'LACP (IEEE 802.3ad) bundles up to eight links; active starts negotiation, passive only answers. PAgP is the Cisco equivalent (desirable and auto), and mode `on` bundles without negotiating at all, which is risky if the far end disagrees. Frames are spread across members by a hash of their addresses, so one conversation always uses one link.',
  },
  {
    id: 'etherchannel-troubleshoot',
    title: 'Fix a port-channel that will not form',
    domain: '2.0',
    blueprint: ['2.1.c', '2.4'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'Three links meant to be one LACP bundle: a mode mismatch and a suspended member.',
    briefing: `SW1 and SW2 should share a three-link LACP port-channel (Po1) trunking VLANs 1 and 20. Instead, \`show etherchannel summary\` shows ports in odd states and spanning tree is blocking two of the three links.

Get all three links bundled on both switches. The member flags tell you a lot:
- \`P\` bundled, \`I\` stand-alone (no LACP partner agreed), \`s\` suspended (settings differ from the port-channel), \`D\` down`,
    addressing: [
      { device: 'PC1', interface: 'Eth0', address: '10.20.20.11/24', note: 'SW1 Gi0/5, VLAN 20' },
      { device: 'PC2', interface: 'Eth0', address: '10.20.20.12/24', note: 'SW2 Gi0/5, VLAN 20' },
    ],
    topology: {
      devices: [
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [0, 0],
          config: `conf t
            vlan 20
            int g0/5
            switchport mode access
            switchport access vlan 20
            int range g0/1 - 3
            switchport mode trunk
            channel-group 1 mode passive`,
        },
        {
          hostname: 'SW2',
          kind: 'switch',
          at: [450, 0],
          config: `conf t
            vlan 20
            vlan 99
            int g0/5
            switchport mode access
            switchport access vlan 20
            int range g0/1 - 3
            switchport mode trunk
            channel-group 1 mode passive
            int g0/3
            switchport trunk native vlan 99`,
        },
        { hostname: 'PC1', kind: 'pc', at: [0, 200], ip: '10.20.20.11/24' },
        { hostname: 'PC2', kind: 'pc', at: [450, 200], ip: '10.20.20.12/24' },
      ],
      links: [
        ['SW1 Gi0/1', 'SW2 Gi0/1'],
        ['SW1 Gi0/2', 'SW2 Gi0/2'],
        ['SW1 Gi0/3', 'SW2 Gi0/3'],
        ['PC1 Eth0', 'SW1 Gi0/5'],
        ['PC2 Eth0', 'SW2 Gi0/5'],
      ],
    },
    objectives: [
      { text: 'SW1 has all three links bundled', check: { type: 'etherchannel', device: 'SW1', group: 1, bundled: 3, protocol: 'lacp' }, hint: 'Two passive ends wait for each other forever. One side has to be active.' },
      { text: 'SW2 has all three links bundled', check: { type: 'etherchannel', device: 'SW2', group: 1, bundled: 3, protocol: 'lacp' }, hint: 'Compare `show interfaces g0/3 switchport` with Po1. A member must match its port-channel exactly.' },
      { text: 'PC1 can reach PC2 in VLAN 20', check: { type: 'ping', from: 'PC1', to: '10.20.20.12', expect: 'success' } },
      {
        text: 'Member flags',
        check: {
          type: 'quiz',
          question: 'In `show etherchannel summary`, what does Gi0/3(s) mean?',
          options: ['The port is shut down', 'The port is suspended because its settings do not match the port-channel', 'The port is in standby, waiting for a free slot', 'The port is a Layer 3 member'],
          answer: 1,
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface range g0/1 - 3
        channel-group 1 mode active
        end`,
      SW2: `enable
        conf t
        interface g0/3
        switchport trunk native vlan 1
        end`,
    },
    debrief: 'An EtherChannel needs agreement on both ends (a compatible mode pair) and identical settings on every member: mode, access VLAN or native and allowed VLANs. Configure the port-channel interface rather than the members, and the settings stay in step.',
  },
];
