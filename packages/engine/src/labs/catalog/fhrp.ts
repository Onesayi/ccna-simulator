import type { AddressingRow, LabDeviceSpec, LabDefinition } from '../types';

/** Two gateways on one LAN, both uplinked to a core router with a server behind it. */
const ADDRESSING: AddressingRow[] = [
  { device: 'R1', interface: 'Gi0/0', address: '192.168.10.2/24', note: 'LAN' },
  { device: 'R2', interface: 'Gi0/0', address: '192.168.10.3/24', note: 'LAN' },
  { device: 'Virtual', interface: 'HSRP', address: '192.168.10.1', note: 'The gateway the PCs use' },
  { device: 'R1', interface: 'Gi0/1', address: '10.0.1.1/30', note: 'to CORE' },
  { device: 'R2', interface: 'Gi0/1', address: '10.0.2.1/30', note: 'to CORE' },
  { device: 'CORE', interface: 'Gi0/2', address: '172.16.0.1/24' },
  { device: 'PC1', interface: 'Eth0', address: '192.168.10.11/24', gateway: '192.168.10.1' },
  { device: 'PC2', interface: 'Eth0', address: '192.168.10.12/24', gateway: '192.168.10.1' },
  { device: 'SRV', interface: 'Eth0', address: '172.16.0.10/24', gateway: '172.16.0.1' },
];

const R1_BASE = `conf t
  int g0/0
  ip address 192.168.10.2 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.1.1 255.255.255.252
  no shut
  router ospf 1
  network 192.168.10.0 0.0.0.255 area 0
  network 10.0.1.0 0.0.0.3 area 0
  passive-interface g0/0
  exit`;

const R2_BASE = `conf t
  int g0/0
  ip address 192.168.10.3 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.2.1 255.255.255.252
  no shut
  router ospf 1
  network 192.168.10.0 0.0.0.255 area 0
  network 10.0.2.0 0.0.0.3 area 0
  passive-interface g0/0
  exit`;

const CORE: LabDeviceSpec = {
  hostname: 'CORE',
  kind: 'router',
  at: [250, 0],
  config: `conf t
    int g0/0
    ip address 10.0.1.2 255.255.255.252
    no shut
    int g0/1
    ip address 10.0.2.2 255.255.255.252
    no shut
    int g0/2
    ip address 172.16.0.1 255.255.255.0
    no shut
    router ospf 1
    network 10.0.0.0 0.0.255.255 area 0
    network 172.16.0.0 0.0.0.255 area 0`,
};

const OTHERS: LabDeviceSpec[] = [
  CORE,
  { hostname: 'SRV', kind: 'pc', at: [500, 0], ip: '172.16.0.10/24', gateway: '172.16.0.1' },
  { hostname: 'SW1', kind: 'switch', at: [250, 300] },
  { hostname: 'PC1', kind: 'pc', at: [100, 450], ip: '192.168.10.11/24', gateway: '192.168.10.1' },
];

const LINKS: [string, string][] = [
  ['PC1 Eth0', 'SW1 Gi0/1'],
  ['PC2 Eth0', 'SW1 Gi0/2'],
  ['R1 Gi0/0', 'SW1 Gi0/7'],
  ['R2 Gi0/0', 'SW1 Gi0/8'],
  ['R1 Gi0/1', 'CORE Gi0/0'],
  ['R2 Gi0/1', 'CORE Gi0/1'],
  ['SRV Eth0', 'CORE Gi0/2'],
];

/** Domain 3.0: first hop redundancy with HSRP, VRRP and GLBP (blueprint 3.4). */
export const fhrpLabs: LabDefinition[] = [
  {
    id: 'hsrp-basic',
    title: 'Give the LAN a gateway that survives a failure',
    domain: '3.0',
    blueprint: ['3.4'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Two routers share one virtual gateway with HSRP: priority, preemption and interface tracking.',
    briefing: `The PCs on 192.168.10.0/24 use **192.168.10.1** as their gateway, but no device owns that address yet. R1 and R2 are both on the LAN and both reach the server through CORE (OSPF is already running). Make them share the gateway with HSRP group **10**:

- R1 and R2 Gi0/0: HSRP group 10 with virtual IP 192.168.10.1
- R1 is the normal gateway: priority **110** and \`preempt\`, so it takes the role back after a failure
- R2 keeps the default priority but also preempts
- R1 tracks its uplink Gi0/1 with a decrement of **20**, so R2 takes over if the uplink fails

Check the result with \`show standby brief\` on both routers, then ping the server from the PCs. To watch a failover, shut R1's Gi0/0 and look again (bring it back up afterwards).`,
    addressing: ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [100, 150], config: R1_BASE },
        { hostname: 'R2', kind: 'router', at: [400, 150], config: R2_BASE },
        ...OTHERS,
        { hostname: 'PC2', kind: 'pc', at: [400, 450], ip: '192.168.10.12/24', gateway: '192.168.10.1' },
      ],
      links: LINKS,
    },
    objectives: [
      {
        text: 'R1 is active for group 10 (priority 110, preempt)',
        check: { type: 'hsrp', device: 'R1', interface: 'Gi0/0', group: 10, vip: '192.168.10.1', priority: 110, preempt: true, state: 'Active' },
        hint: 'On R1 Gi0/0: `standby 10 ip 192.168.10.1`, `standby 10 priority 110`, `standby 10 preempt`.',
      },
      {
        text: 'R2 is standby for group 10 and preempts',
        check: { type: 'hsrp', device: 'R2', interface: 'Gi0/0', group: 10, vip: '192.168.10.1', preempt: true, state: 'Standby' },
        hint: 'On R2 Gi0/0: `standby 10 ip 192.168.10.1` and `standby 10 preempt`.',
      },
      {
        text: 'R1 tracks its uplink Gi0/1',
        check: { type: 'hsrp', device: 'R1', interface: 'Gi0/0', group: 10, track: 'Gi0/1' },
        hint: '`standby 10 track GigabitEthernet0/1 20` on R1 Gi0/0.',
      },
      { text: 'PC1 reaches the server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' } },
      { text: 'PC2 reaches the server', check: { type: 'ping', from: 'PC2', to: '172.16.0.10', expect: 'success' } },
      {
        text: 'The virtual MAC',
        check: {
          type: 'quiz',
          question: 'Which MAC address do the PCs learn for 192.168.10.1 with HSRP version 1, group 10?',
          options: ['The MAC of R1 Gi0/0', '0000.0c07.ac0a', '0000.0c9f.f00a', '0000.5e00.010a'],
          answer: 1,
          explain: 'HSRPv1 uses 0000.0c07.acXX with the group number in hex (10 = 0a). HSRPv2 uses 0000.0c9f.fXXX and VRRP 0000.5e00.01XX. Check with `arp -a` on a PC.',
        },
      },
      {
        text: 'Tracking',
        check: {
          type: 'quiz',
          question: "R1's uplink fails. What happens with these settings?",
          options: [
            'Nothing: R1 stays active because its priority is still configured as 110',
            "R1's priority drops to 90, and R2 (priority 100, preempt) becomes active",
            'Both routers become active',
            'R2 becomes active only if R1 Gi0/0 also fails',
          ],
          answer: 1,
          explain: 'Tracking lowers the priority by the decrement while the interface is down. R2 only takes over because it is configured to preempt; without preempt it would wait for R1 to fail completely.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        interface g0/0
        standby 10 ip 192.168.10.1
        standby 10 priority 110
        standby 10 preempt
        standby 10 track g0/1 20
        end`,
      R2: `enable
        conf t
        interface g0/0
        standby 10 ip 192.168.10.1
        standby 10 preempt
        end`,
    },
    debrief: 'HSRP gives hosts one virtual gateway (IP and MAC) that the active router owns. The standby router takes over when it stops hearing hellos, and the PCs never notice because the virtual MAC moves with the role. The highest priority wins the election (then the highest interface IP), but a better router only takes over a working one when it is set to preempt. VRRP is the open standard version of the same idea; GLBP also load-balances between gateways.',
  },
  {
    id: 'hsrp-troubleshoot',
    title: 'Fix the gateway that does not fail over',
    domain: '3.0',
    blueprint: ['3.4', '5.6'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'PC1 has no gateway, R1 will not take over, and PC2 bypasses HSRP altogether.',
    briefing: `HSRP group 1 is meant to give the LAN a redundant gateway at **192.168.10.1**, with R1 (priority 110) active and R2 as backup. Instead:

- PC1 cannot reach the server
- R1 sits in standby even though its priority is higher
- PC2 works, but someone set it up in a way that will break the day R2 fails

Find the faults with \`show standby brief\`, \`show standby\`, \`show logging\` on the routers and \`ipconfig\` on the PCs, and fix them. Keep the group number, the virtual IP and R1's priority as they are.`,
    addressing: ADDRESSING.map((r) => (r.device === 'Virtual' ? { ...r, interface: 'HSRP group 1' } : r)),
    topology: {
      devices: [
        // R2 boots first, so it is active before R1 joins.
        { hostname: 'R2', kind: 'router', at: [400, 150], config: `${R2_BASE}\nint g0/0\nstandby 1 ip 192.168.10.254` },
        { hostname: 'R1', kind: 'router', at: [100, 150], config: `${R1_BASE}\nint g0/0\nstandby 1 ip 192.168.10.1\nstandby 1 priority 110` },
        ...OTHERS,
        { hostname: 'PC2', kind: 'pc', at: [400, 450], ip: '192.168.10.12/24', gateway: '192.168.10.3' },
      ],
      links: LINKS,
    },
    objectives: [
      {
        text: 'R2 uses the right virtual IP',
        check: { type: 'hsrp', device: 'R2', interface: 'Gi0/0', group: 1, vip: '192.168.10.1' },
        hint: 'R1 logged `%HSRP-4-DIFFVIP1`. On R2 Gi0/0: `standby 1 ip 192.168.10.1`.',
      },
      {
        text: 'R1 is the active router',
        check: { type: 'hsrp', device: 'R1', interface: 'Gi0/0', group: 1, priority: 110, preempt: true, state: 'Active' },
        hint: 'A higher priority alone does not take over from a working active router. `standby 1 preempt` on R1 Gi0/0.',
      },
      {
        text: 'PC2 uses the virtual gateway',
        check: { type: 'defaultGateway', device: 'PC2', address: '192.168.10.1' },
        hint: '192.168.10.3 is R2 itself. On PC2: `ipconfig 192.168.10.12 255.255.255.0 192.168.10.1`.',
      },
      { text: 'PC1 reaches the server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' } },
      { text: 'PC2 reaches the server', check: { type: 'ping', from: 'PC2', to: '172.16.0.10', expect: 'success' } },
      {
        text: 'Reading the log',
        check: {
          type: 'quiz',
          question: 'Which message pointed at the virtual IP mismatch?',
          options: ['%HSRP-5-STATECHANGE', '%HSRP-4-DIFFVIP1', '%OSPF-5-ADJCHG', '%LINEPROTO-5-UPDOWN'],
          answer: 1,
          explain: 'DIFFVIP1 (severity 4, a warning) says the active router advertises a different virtual IP from the one configured locally. STATECHANGE messages only record the role changes.',
        },
      },
      {
        text: 'Preemption',
        check: {
          type: 'quiz',
          question: 'With preempt now on both routers, R1 reloads and comes back. What happens?',
          options: ['R2 stays active until it fails', 'R1 becomes active again once it hears R2', 'Both stay active', 'The PCs must renew their ARP entries'],
          answer: 1,
          explain: 'With preempt, the router with the better priority takes the active role back as soon as it is up. The PCs keep the same virtual MAC in their ARP cache, so they never notice.',
        },
      },
    ],
    solution: {
      R2: `enable
        conf t
        interface g0/0
        standby 1 ip 192.168.10.1
        end`,
      R1: `enable
        conf t
        interface g0/0
        standby 1 preempt
        end`,
      PC2: 'ipconfig 192.168.10.12 255.255.255.0 192.168.10.1',
    },
    debrief: 'Three classic HSRP mistakes: mismatched virtual IPs (the active router decides which address is live), no preempt (the better router waits politely), and hosts pointing at a real router address instead of the virtual one (no redundancy at all). `show standby brief` answers most questions: who is active, who is standby, and which virtual IP is in use.',
  },
  {
    id: 'vrrp-basic',
    title: 'Build the redundant gateway with the open standard',
    domain: '3.0',
    blueprint: ['3.4'],
    kind: 'guided',
    difficulty: 2,
    summary: 'VRRP group 10 on two routers: a master, a backup, and preemption that is on by default.',
    briefing: `This office is replacing its gateways with routers from more than one vendor, so the redundant gateway has to use **VRRP** (RFC 5798) instead of Cisco's HSRP. The PCs already use **192.168.10.1** as their gateway. Set up VRRP group **10** on Gi0/0 of R1 and R2:

- Both routers: \`vrrp 10 ip 192.168.10.1\`
- R1 is the master: priority **110**
- R2 keeps the default priority (100) and becomes the backup

VRRP preempts by default, so there is no \`preempt\` command to remember this time. Check with \`show vrrp brief\` and \`show vrrp\`, then ping the server from both PCs. Look at \`arp -a\` on a PC to see which MAC address answers for the gateway.`,
    addressing: ADDRESSING.map((r) => (r.device === 'Virtual' ? { ...r, interface: 'VRRP group 10' } : r)),
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [100, 150], config: R1_BASE },
        { hostname: 'R2', kind: 'router', at: [400, 150], config: R2_BASE },
        ...OTHERS,
        { hostname: 'PC2', kind: 'pc', at: [400, 450], ip: '192.168.10.12/24', gateway: '192.168.10.1' },
      ],
      links: LINKS,
    },
    objectives: [
      {
        text: 'R1 is the master for group 10 with priority 110',
        check: { type: 'vrrp', device: 'R1', interface: 'Gi0/0', group: 10, vip: '192.168.10.1', priority: 110, state: 'Master' },
        hint: 'On R1 Gi0/0: `vrrp 10 ip 192.168.10.1` and `vrrp 10 priority 110`.',
      },
      {
        text: 'R2 is the backup for group 10',
        check: { type: 'vrrp', device: 'R2', interface: 'Gi0/0', group: 10, vip: '192.168.10.1', priority: 100, state: 'Backup' },
        hint: 'On R2 Gi0/0: `vrrp 10 ip 192.168.10.1`.',
      },
      { text: 'PC1 reaches the server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' } },
      { text: 'PC2 reaches the server', check: { type: 'ping', from: 'PC2', to: '172.16.0.10', expect: 'success' } },
      {
        text: 'The virtual MAC',
        check: {
          type: 'quiz',
          question: 'Which MAC address answers ARP for 192.168.10.1 in VRRP group 10?',
          options: ['0000.0c07.ac0a', '0000.5e00.010a', '0007.b400.0a01', 'The MAC of R1 Gi0/0'],
          answer: 1,
          explain: 'VRRP uses 0000.5e00.01XX with the group number in hex (10 = 0a). 0000.0c07.acXX is HSRPv1 and 0007.b4XX.XXYY is GLBP.',
        },
      },
      {
        text: 'Terminology',
        check: {
          type: 'quiz',
          question: 'How do HSRP and VRRP differ?',
          options: [
            'VRRP is Cisco proprietary; HSRP is an open standard',
            'VRRP calls the roles master and backup, preempts by default, and is an open standard',
            'VRRP load-balances between all routers in the group',
            'VRRP needs a separate virtual IP for each router',
          ],
          answer: 1,
          explain: 'HSRP (Cisco) has active and standby routers and no preemption unless configured. VRRP (IETF) has a master and backups and preempts by default. Neither load-balances within one group; GLBP does.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        interface g0/0
        vrrp 10 ip 192.168.10.1
        vrrp 10 priority 110
        end`,
      R2: `enable
        conf t
        interface g0/0
        vrrp 10 ip 192.168.10.1
        end`,
    },
    debrief: 'VRRP works like HSRP: the master owns a virtual IP and MAC (0000.5e00.01XX), sends advertisements to 224.0.0.18, and a backup takes over when they stop. The differences are worth remembering for the exam: it is an open standard, the roles are master and backup, preemption is on by default, and a router whose real address is the virtual IP becomes the "owner" with priority 255.',
  },
  {
    id: 'glbp-load-balancing',
    title: 'Share the load between both gateways',
    domain: '3.0',
    blueprint: ['3.4'],
    kind: 'guided',
    difficulty: 3,
    summary: 'GLBP gives each PC a different virtual MAC, so both routers forward traffic at once.',
    briefing: `With HSRP or VRRP one router forwards all the traffic while the other waits. **GLBP** (Gateway Load Balancing Protocol) keeps one virtual IP but hands out up to four virtual MACs, one per router, so both routers forward.

Set up GLBP group **1** with virtual IP **192.168.10.1** on Gi0/0 of R1 and R2:

- R1 is the active virtual gateway (AVG): priority **150** and \`glbp 1 preempt\`
- R2 keeps the default priority (100)
- Keep the default load balancing (round-robin): each ARP request for the gateway gets the next virtual MAC

Check with \`show glbp brief\`: R1 should be Active for the group and both routers should be Active for one forwarder each. Then ping the server from both PCs and compare \`arp -a\` on PC1 and PC2.`,
    addressing: ADDRESSING.map((r) => (r.device === 'Virtual' ? { ...r, interface: 'GLBP group 1' } : r)),
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [100, 150], config: R1_BASE },
        { hostname: 'R2', kind: 'router', at: [400, 150], config: R2_BASE },
        ...OTHERS,
        { hostname: 'PC2', kind: 'pc', at: [400, 450], ip: '192.168.10.12/24', gateway: '192.168.10.1' },
      ],
      links: LINKS,
    },
    objectives: [
      {
        text: 'R1 is the AVG (priority 150, preempt)',
        check: { type: 'glbp', device: 'R1', interface: 'Gi0/0', group: 1, vip: '192.168.10.1', priority: 150, preempt: true, state: 'Active' },
        hint: 'On R1 Gi0/0: `glbp 1 ip 192.168.10.1`, `glbp 1 priority 150`, `glbp 1 preempt`.',
      },
      {
        text: 'R2 is the standby AVG',
        check: { type: 'glbp', device: 'R2', interface: 'Gi0/0', group: 1, state: 'Standby' },
        hint: 'On R2 Gi0/0: `glbp 1 ip 192.168.10.1` (or just `glbp 1 ip`: it learns the address from the AVG).',
      },
      { text: 'R1 forwards for a virtual MAC', check: { type: 'glbp', device: 'R1', interface: 'Gi0/0', group: 1, forwarding: true } },
      { text: 'R2 forwards for a virtual MAC too', check: { type: 'glbp', device: 'R2', interface: 'Gi0/0', group: 1, forwarding: true } },
      { text: 'PC1 reaches the server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' } },
      { text: 'PC2 reaches the server', check: { type: 'ping', from: 'PC2', to: '172.16.0.10', expect: 'success' } },
      {
        text: 'Roles',
        check: {
          type: 'quiz',
          question: 'In GLBP, which router answers the PCs\' ARP requests for the virtual IP?',
          options: ['Every router in the group', 'The active virtual gateway (AVG)', 'The router with the lowest IP', 'Only the active virtual forwarder that owns forwarder 1'],
          answer: 1,
          explain: 'The AVG answers every ARP request for the virtual IP and decides which virtual MAC each host gets. Each router (including the AVG) is an active virtual forwarder (AVF) for the MAC it was given.',
        },
      },
      {
        text: 'Failure',
        check: {
          type: 'quiz',
          question: 'R2 fails. What happens to the PCs that were given R2\'s virtual MAC?',
          options: [
            'They lose their gateway until their ARP entry times out',
            'Another router (here R1) takes over forwarding for that virtual MAC, so they keep working',
            'They must run ipconfig /renew',
            'The AVG sends them a new virtual IP',
          ],
          answer: 1,
          explain: 'GLBP is still a redundancy protocol: a surviving router takes over the dead forwarder\'s virtual MAC, so hosts never have to change their ARP entry.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        interface g0/0
        glbp 1 ip 192.168.10.1
        glbp 1 priority 150
        glbp 1 preempt
        end`,
      R2: `enable
        conf t
        interface g0/0
        glbp 1 ip 192.168.10.1
        end`,
    },
    debrief: 'GLBP elects one active virtual gateway (AVG) the same way HSRP elects an active router, but the AVG then gives each group member its own virtual MAC (0007.b4XX.XXYY, up to four) and spreads the hosts across them when it answers ARP. Load balancing can be round-robin (the default), weighted, or host-dependent (each host always gets the same MAC). HSRP and VRRP can only load-balance by running several groups with different gateways.',
  },
];
