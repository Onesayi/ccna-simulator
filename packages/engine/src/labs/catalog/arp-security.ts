import type { LabDefinition } from '../types';

/**
 * Domain 4.0 blueprint 4.7.b/4.7.e: Dynamic ARP Inspection and IP Source Guard, both built on the
 * DHCP snooping binding table. The attacker is a PC with the `arpspoof` lab tool.
 */

const OFFICE_ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24', note: 'Gateway and DHCP server' },
  { device: 'PC1', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/1' },
  { device: 'PC2', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/2' },
  { device: 'EVIL', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/5 - the attacker' },
];

/** R1 serves DHCP for VLAN 10; SW1 already snoops DHCP with Gi0/8 (to R1) trusted. */
const R1_CONFIG = `conf t
  int g0/0
  ip address 192.168.10.1 255.255.255.0
  no shut
  exit
  ip dhcp excluded-address 192.168.10.1 192.168.10.10
  ip dhcp pool OFFICE
  network 192.168.10.0 255.255.255.0
  default-router 192.168.10.1
  dns-server 192.168.10.1`;

const SW1_SNOOPING = `conf t
  vlan 10
  name OFFICE
  exit
  interface range g0/1 - 8
  switchport mode access
  switchport access vlan 10
  exit
  ip dhcp snooping
  ip dhcp snooping vlan 10
  no ip dhcp snooping information option
  interface g0/8
  ip dhcp snooping trust`;

export const arpSecurityLabs: LabDefinition[] = [
  {
    id: 'dynamic-arp-inspection',
    title: 'Stop ARP poisoning with Dynamic ARP Inspection',
    domain: '4.0',
    blueprint: ['4.7', '4.7.b'],
    kind: 'guided',
    difficulty: 3,
    summary: 'A laptop forges the gateway with gratuitous ARP. DAI checks ARP against the snooping table.',
    briefing: `PC1, PC2 and a visitor's laptop (EVIL) all take DHCP leases on SW1, and DHCP snooping already runs for VLAN 10 with Gi0/8 (to R1) trusted. The problem is ARP: open EVIL's prompt and run \`arpspoof 192.168.10.1\`, then look at PC1 with \`arp -a\`. EVIL has claimed the gateway's address, so PC1 now sends its traffic to the attacker.

Turn on Dynamic ARP Inspection so the switch checks every ARP against the DHCP snooping binding table:
- Enable DAI for **VLAN 10** (one command, no global on/off like snooping has)
- Trust **Gi0/8**, the uplink to R1, so the gateway's own ARP is never inspected
- Leave the host ports untrusted

Then run \`arpspoof 192.168.10.1\` from EVIL again and confirm PC1 keeps the real gateway. The legitimate PCs, which have snooping bindings, must still reach R1. Check \`show ip arp inspection\`.`,
    addressing: OFFICE_ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: R1_CONFIG },
        { hostname: 'SW1', kind: 'switch', at: [250, 180], config: SW1_SNOOPING },
        { hostname: 'PC1', kind: 'pc', at: [40, 360], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [250, 360], ip: 'dhcp' },
        { hostname: 'EVIL', kind: 'pc', at: [460, 360], ip: 'dhcp' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['EVIL Eth0', 'SW1 Gi0/5'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
      ],
    },
    objectives: [
      { text: 'DAI runs on SW1 for VLAN 10', check: { type: 'arpInspection', device: 'SW1', vlan: 10 }, hint: '`ip arp inspection vlan 10`. There is no global command, unlike DHCP snooping.' },
      { text: 'Gi0/8 (to R1) is trusted for ARP', check: { type: 'arpInspectionTrust', device: 'SW1', interface: 'Gi0/8', trusted: true }, hint: '`interface g0/8`, `ip arp inspection trust`. The gateway must be trusted or its own ARP is dropped.' },
      { text: 'Gi0/5 (the attacker) is untrusted', check: { type: 'arpInspectionTrust', device: 'SW1', interface: 'Gi0/5', trusted: false } },
      { text: 'EVIL can no longer poison PC1', check: { type: 'arpSpoof', from: 'EVIL', claim: '192.168.10.1', victim: 'PC1', expect: 'blocked' }, hint: 'EVIL has a lease, but its binding is for its own address, not the gateway, so a spoofed ARP for 192.168.10.1 fails the check.' },
      { text: 'PC1 still reaches the gateway', check: { type: 'ping', from: 'PC1', to: '192.168.10.1', expect: 'success' } },
      { text: 'EVIL still reaches the gateway normally', check: { type: 'ping', from: 'EVIL', to: '192.168.10.1', expect: 'success' } },
      {
        text: 'What DAI checks',
        check: {
          type: 'quiz',
          question: 'On an untrusted port, what does DAI compare the ARP sender IP and MAC against?',
          options: ['The MAC address table', 'The DHCP snooping binding table (and any ARP ACL)', 'The routing table', 'The CAM table for that VLAN'],
          answer: 1,
          explain: 'DAI validates the sender IP and MAC against the bindings DHCP snooping learned. A host with no binding (and no ARP ACL permitting it) has its ARP dropped.',
        },
      },
      {
        text: 'Trusted ports',
        check: {
          type: 'quiz',
          question: 'Why must the uplink to R1 be trusted for ARP inspection?',
          options: [
            'R1 sends ARP replies for the gateway address, which has no snooping binding, so untrusted it would be dropped',
            'Trusted ports run DAI faster',
            'DAI only works on trunk ports',
            'R1 would otherwise be rate-limited',
          ],
          answer: 0,
          explain: 'The gateway, routers and other switches are not DHCP clients, so they have no binding. Trust the ports facing them, exactly as with DHCP snooping, or their legitimate ARP is dropped.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        ip arp inspection vlan 10
        interface g0/8
        ip arp inspection trust
        end`,
    },
    debrief: 'DAI filters ARP on untrusted ports, dropping any whose sender IP/MAC is not in the DHCP snooping binding table, which defeats the gratuitous-ARP man-in-the-middle. It needs only the per-VLAN command; trust the ports towards servers, routers and switches. Hosts with static addresses have no binding, so they need an ARP ACL (`arp access-list`), and `ip arp inspection validate` adds optional src-mac, dst-mac and IP checks.',
  },
  {
    id: 'dai-arp-acl',
    title: 'Let a static server past DAI with an ARP ACL',
    domain: '4.0',
    blueprint: ['4.7.b'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'DAI is dropping a statically addressed server. Permit it with an ARP ACL.',
    briefing: `DAI was turned on for VLAN 10 and Gi0/8 (to R1) was trusted, which stopped the ARP poisoning. But SRV, the file server on Gi0/7, uses a **static** IP address, so it has no DHCP snooping binding. Since DAI went in, nobody can reach it: try a ping from PC1 to 192.168.10.100, then look at \`show ip arp inspection\` and SW1's log.

Permit SRV without weakening the rest of DAI:
- Create an ARP ACL (\`arp access-list SERVERS\`) that permits SRV's IP **192.168.10.100** with its MAC
- Apply it to VLAN 10 (\`ip arp inspection filter SERVERS vlan 10\`)
- Leave the DHCP-learned hosts working off the binding table as before

Then ping SRV from PC1 again, and check \`show arp access-list\`.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24', note: 'Gateway and DHCP server' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.10.100/24', note: 'Static - SW1 Gi0/7' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: R1_CONFIG },
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [250, 180],
          config: `${SW1_SNOOPING}
            exit
            ip arp inspection vlan 10
            interface g0/8
            ip arp inspection trust`,
        },
        { hostname: 'SRV', kind: 'pc', at: [460, 360], ip: '192.168.10.100/24', gateway: '192.168.10.1', mac: '0050.7966.6810' },
        { hostname: 'PC1', kind: 'pc', at: [40, 360], ip: 'dhcp' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['SRV Eth0', 'SW1 Gi0/7'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
      ],
    },
    objectives: [
      { text: 'DAI still runs for VLAN 10', check: { type: 'arpInspection', device: 'SW1', vlan: 10 } },
      { text: 'An ARP ACL permits SRV on VLAN 10', check: { type: 'arpAclPermits', device: 'SW1', vlan: 10, client: 'SRV' }, hint: '`arp access-list SERVERS`, `permit ip host 192.168.10.100 mac host 0050.7966.6810`, then `ip arp inspection filter SERVERS vlan 10`.' },
      { text: 'PC1 can reach SRV', check: { type: 'ping', from: 'PC1', to: '192.168.10.100', expect: 'success' } },
      { text: 'SRV can reach the gateway', check: { type: 'ping', from: 'SRV', to: '192.168.10.1', expect: 'success' } },
      {
        text: 'Why SRV was dropped',
        check: {
          type: 'quiz',
          question: 'Why did DAI drop SRV once it was enabled?',
          options: [
            'SRV uses a static IP, so it has no DHCP snooping binding to match',
            'SRV was on a trusted port',
            'Static hosts cannot send ARP',
            'The server VLAN was wrong',
          ],
          answer: 0,
          explain: 'The binding table only holds DHCP leases. A statically addressed host has no entry, so without an ARP ACL its ARP is dropped on an untrusted port.',
        },
      },
      {
        text: 'ACL vs binding table',
        check: {
          type: 'quiz',
          question: 'With `ip arp inspection filter SERVERS vlan 10` (no `static` keyword), what happens to a DHCP host not listed in the ACL?',
          options: [
            'It is still checked against the DHCP snooping binding table',
            'It is dropped by the ACL\'s implicit deny',
            'It is permitted because the ACL did not mention it',
            'DAI is bypassed for that host',
          ],
          answer: 0,
          explain: 'Without `static`, the ARP ACL is checked first and then the binding table, so DHCP hosts keep working. Add `static` and only the ACL is consulted, with an implicit deny at the end.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        arp access-list SERVERS
        permit ip host 192.168.10.100 mac host 0050.7966.6810
        exit
        ip arp inspection filter SERVERS vlan 10
        end`,
    },
    debrief: 'ARP ACLs cover the hosts DHCP snooping cannot: servers, printers and gateways with static addresses. Applied without the `static` keyword, the ACL is checked first and the binding table second, so DHCP clients keep working off their leases; with `static`, only the ACL applies and its implicit deny drops everything else.',
  },
  {
    id: 'ip-source-guard',
    title: 'Pin addresses to ports with IP Source Guard',
    domain: '4.0',
    blueprint: ['4.7', '4.7.e'],
    kind: 'guided',
    difficulty: 3,
    summary: 'IP Source Guard drops traffic whose source IP was never leased to that port.',
    briefing: `DHCP snooping already runs on SW1 for VLAN 10, so the switch knows which address it leased to each port. IP Source Guard uses that binding table to drop any IPv4 packet whose source address does not belong on the port it came in on, which stops a host from spoofing someone else's address.

- Turn on IP Source Guard on the two host ports **Gi0/1 and Gi0/2** (\`ip verify source\`)
- Renew PC1 and PC2 so they hold a lease (a port with Source Guard but no binding drops everything except DHCP)
- SRV on **Gi0/7** has a static address 192.168.10.100 and no lease, so add a static binding for it and turn on Source Guard there too

Then confirm PC1 and SRV can reach the gateway, and check \`show ip verify source\`. To see it work, change PC2 to a made-up static address and watch its ping fail.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24', note: 'Gateway and DHCP server' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.10.100/24', note: 'Static - SW1 Gi0/7' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/1' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/2' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: R1_CONFIG },
        { hostname: 'SW1', kind: 'switch', at: [250, 180], config: SW1_SNOOPING },
        { hostname: 'SRV', kind: 'pc', at: [460, 360], ip: '192.168.10.100/24', gateway: '192.168.10.1', mac: '0050.7966.6820' },
        { hostname: 'PC1', kind: 'pc', at: [40, 360], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [250, 360], ip: 'dhcp' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['SRV Eth0', 'SW1 Gi0/7'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
      ],
    },
    objectives: [
      { text: 'IP Source Guard is on Gi0/1', check: { type: 'sourceGuard', device: 'SW1', interface: 'Gi0/1' }, hint: '`interface g0/1`, `ip verify source`.' },
      { text: 'IP Source Guard is on Gi0/2', check: { type: 'sourceGuard', device: 'SW1', interface: 'Gi0/2' } },
      { text: 'IP Source Guard is on Gi0/7', check: { type: 'sourceGuard', device: 'SW1', interface: 'Gi0/7' } },
      { text: 'A static binding ties SRV to Gi0/7', check: { type: 'sourceBinding', device: 'SW1', client: 'SRV', interface: 'Gi0/7' }, hint: '`ip source binding 0050.7966.6820 vlan 10 192.168.10.100 interface g0/7`.' },
      { text: 'PC1 has a lease', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' }, hint: '`ipconfig /renew` on PC1.' },
      { text: 'PC1 can reach the gateway', check: { type: 'ping', from: 'PC1', to: '192.168.10.1', expect: 'success' } },
      { text: 'SRV can reach the gateway', check: { type: 'ping', from: 'SRV', to: '192.168.10.1', expect: 'success' } },
      {
        text: 'What Source Guard uses',
        check: {
          type: 'quiz',
          question: 'Where does IP Source Guard get the list of addresses allowed on a port?',
          options: ['The DHCP snooping binding table, plus any static `ip source binding`', 'The ARP table', 'The running config `ip access-list`', 'The MAC address table'],
          answer: 0,
          explain: 'Like DAI, Source Guard reads the DHCP snooping bindings. Static hosts need an `ip source binding` entry, which is the equivalent of an ARP ACL for DAI.',
        },
      },
      {
        text: 'ip verify source port-security',
        check: {
          type: 'quiz',
          question: 'What does adding `port-security` to `ip verify source` do?',
          options: ['It also checks the source MAC against the binding, not just the source IP', 'It enables port security automatically', 'It shuts the port on a violation', 'It lets any MAC through'],
          answer: 0,
          explain: 'Plain `ip verify source` filters on source IP only. With `port-security` it checks source IP and MAC together, so a host cannot spoof the IP even if it keeps its own MAC.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        ip source binding 0050.7966.6820 vlan 10 192.168.10.100 interface g0/7
        interface range g0/1 - 2
        ip verify source
        interface g0/7
        ip verify source
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: 'IP Source Guard drops IPv4 traffic whose source address is not bound to the ingress port, so a host cannot impersonate another address. It reads the same DHCP snooping bindings as DAI; static hosts need an `ip source binding`. DHCP itself is always allowed through so a client can still get the lease that creates its binding. Add `port-security` to also pin the source MAC.',
  },
];
