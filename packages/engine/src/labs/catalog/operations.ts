import type { LabDefinition } from '../types';

/** Domain 5.0: reading syslog messages to find a fault (blueprint 5.6). */
export const operationsLabs: LabDefinition[] = [
  {
    id: 'syslog-read',
    title: 'Read the logs',
    domain: '5.0',
    blueprint: ['5.6', '3.3.a'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'Two routers will not form an OSPF adjacency. The syslog buffer says why.',
    briefing: `R1 and R2 run OSPF on the link between them, yet \`show ip ospf neighbor\` stays empty and PC1 cannot reach PC2. The configuration looks fine at a glance, but the routers have been complaining.

Run \`show logging\` on either router and read the messages. Each one has the form \`%FACILITY-SEVERITY-MNEMONIC: description\`:

- **Facility**: the part of IOS that raised it (\`OSPF\`, \`LINK\`, \`LINEPROTO\`, \`DHCP\`)
- **Severity**: 0 (emergencies) to 7 (debugging); lower is more serious
- **Mnemonic**: a short code for the event

Answer the questions, then fix the fault. Keep R1's router ID as it is.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'R2', interface: 'Gi0/1', address: '10.0.12.2/30' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.2.1/24' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.2.10/24', gateway: '192.168.2.1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [0, 0], config: `conf t
          int g0/0
          ip address 192.168.1.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.1 255.255.255.252
          no shut
          router ospf 1
          router-id 1.1.1.1
          network 10.0.12.0 0.0.0.3 area 0
          network 192.168.1.0 0.0.0.255 area 0
          passive-interface g0/0` },
        { hostname: 'R2', kind: 'router', at: [300, 0], config: `conf t
          int g0/0
          ip address 192.168.2.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.2 255.255.255.252
          no shut
          router ospf 1
          router-id 1.1.1.1
          network 10.0.12.0 0.0.0.3 area 0
          network 192.168.2.0 0.0.0.255 area 0
          passive-interface g0/0` },
        { hostname: 'PC1', kind: 'pc', at: [0, 200], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'PC2', kind: 'pc', at: [300, 200], ip: '192.168.2.10/24', gateway: '192.168.2.1' },
      ],
      links: [
        ['R1 Gi0/1', 'R2 Gi0/1'],
        ['PC1 Eth0', 'R1 Gi0/0'],
        ['PC2 Eth0', 'R2 Gi0/0'],
      ],
    },
    objectives: [
      {
        text: 'Severity levels',
        check: {
          type: 'quiz',
          question: 'R1 logged `%OSPF-4-DUPID`. What does the 4 mean?',
          options: ['Severity 4, warnings', 'Severity 4, errors', 'OSPF process 4', 'The fourth message since boot'],
          answer: 0,
          explain: 'The levels are 0 emergencies, 1 alerts, 2 critical, 3 errors, 4 warnings, 5 notifications, 6 informational and 7 debugging. "Every Awesome Cisco Engineer Will Need Ice cream Daily".',
        },
      },
      {
        text: 'Logging thresholds',
        check: {
          type: 'quiz',
          question: 'With `logging trap 3`, which of these messages reaches the syslog server?',
          options: ['%LINEPROTO-5-UPDOWN', '%OSPF-4-DUPID', '%SYS-2-MALLOCFAIL', '%DHCP-6-ADDRESS_ASSIGN'],
          answer: 2,
          explain: 'A threshold sends that level and everything more severe, so `logging trap 3` sends levels 0 to 3. Only the severity 2 (critical) message qualifies.',
        },
      },
      {
        text: 'The cause',
        check: {
          type: 'quiz',
          question: 'What does the DUPID message tell you?',
          options: ['The two routers use the same OSPF router ID', 'Two interfaces share an IP address', 'The OSPF process numbers differ', 'The areas do not match'],
          answer: 0,
          explain: 'Every router in an OSPF domain needs a unique router ID. Process numbers are local and may differ; an area mismatch logs `%OSPF-4-ERRRCV` instead.',
        },
      },
      { text: 'R2 has router ID 2.2.2.2', check: { type: 'ospfRouterId', device: 'R2', routerId: '2.2.2.2' }, hint: '`router-id 2.2.2.2` under `router ospf 1`. If neighbors exist, follow it with `clear ip ospf process`.' },
      { text: 'R1 is FULL with R2', check: { type: 'ospfNeighbor', device: 'R1', neighbor: '2.2.2.2' } },
      { text: 'PC1 can ping PC2', check: { type: 'ping', from: 'PC1', to: '192.168.2.10', expect: 'success' } },
    ],
    solution: {
      R2: `enable
        conf t
        router ospf 1
        router-id 2.2.2.2
        end
        clear ip ospf process`,
    },
    debrief: 'Syslog turns silent failures into readable clues: `%OSPF-4-DUPID` named the fault exactly. On a real network you would also send these messages to a server with `logging host <ip>` and a `logging trap` level, and add `service timestamps log datetime msec` so you can line events up across devices.',
  },
];
