import type { LabDefinition } from '../types';

/** Branch R1 (LAN 192.168.1.0/24 on SW1) with an uplink to an ISP that hosts 8.8.8.8. */
const EDGE_R1 = `conf t
  int g0/0
  ip address 192.168.1.1 255.255.255.0
  no shut
  int g0/1
  description Uplink to ISP
  ip address 203.0.113.1 255.255.255.248
  no shut
  exit
  ip route 0.0.0.0 0.0.0.0 203.0.113.6`;
const EDGE_ISP = `conf t
  int g0/1
  ip address 203.0.113.6 255.255.255.248
  no shut
  int lo0
  ip address 8.8.8.8 255.255.255.255`;

/** R1 with three LANs: staff on Gi0/0, guests on Gi0/1, servers on Gi0/2. */
const THREE_LANS = `conf t
  int g0/0
  description Staff
  ip address 192.168.10.1 255.255.255.0
  no shut
  int g0/1
  description Guests
  ip address 192.168.20.1 255.255.255.0
  no shut
  int g0/2
  description Servers
  ip address 192.168.30.1 255.255.255.0
  no shut`;

const THREE_LANS_ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24', note: 'staff' },
  { device: 'R1', interface: 'Gi0/1', address: '192.168.20.1/24', note: 'guests' },
  { device: 'R1', interface: 'Gi0/2', address: '192.168.30.1/24', note: 'servers' },
  { device: 'STAFF', interface: 'Eth0', address: '192.168.10.10/24', gateway: '192.168.10.1' },
  { device: 'GUEST', interface: 'Eth0', address: '192.168.20.10/24', gateway: '192.168.20.1' },
  { device: 'SRV', interface: 'Eth0', address: '192.168.30.100/24', gateway: '192.168.30.1', note: 'web server (80, 443)' },
];

const THREE_LANS_TOPOLOGY = {
  devices: [
    { hostname: 'R1', kind: 'router' as const, at: [250, 0] as [number, number], config: THREE_LANS },
    { hostname: 'STAFF', kind: 'pc' as const, at: [0, 200] as [number, number], ip: '192.168.10.10/24', gateway: '192.168.10.1' },
    { hostname: 'GUEST', kind: 'pc' as const, at: [250, 220] as [number, number], ip: '192.168.20.10/24', gateway: '192.168.20.1' },
    { hostname: 'SRV', kind: 'pc' as const, at: [500, 200] as [number, number], ip: '192.168.30.100/24', gateway: '192.168.30.1' },
  ],
  links: [
    ['STAFF Eth0', 'R1 Gi0/0'],
    ['GUEST Eth0', 'R1 Gi0/1'],
    ['SRV Eth0', 'R1 Gi0/2'],
  ] as [string, string][],
};

/** Domain 1.0 (DHCP, blueprint 1.7) and domain 4.0 (NAT and ACLs, 4.3 and 4.6). */
export const serviceLabs: LabDefinition[] = [
  {
    id: 'dhcp-server',
    title: 'Hand out addresses with DHCP',
    domain: '1.0',
    blueprint: ['1.7', '1.6', '1.3'],
    kind: 'guided',
    difficulty: 1,
    summary: 'Turn the router into a DHCP server, keep static addresses out of the pool, and renew the PCs.',
    briefing: `The office PCs are set to get their address automatically, but there is no DHCP server, so Windows gave them a **169.254.x.x** address (APIPA) and they cannot leave the LAN. The printer has a static address.

Make R1 the DHCP server:

- Exclude \`192.168.10.1\` to \`192.168.10.10\` (the router and printers live there)
- Create a pool \`OFFICE\` for 192.168.10.0/24 with gateway 192.168.10.1 and DNS server 8.8.8.8
- On each PC run \`ipconfig /renew\`, then \`ipconfig /all\` to see where the lease came from

Exclusions are global commands (\`ip dhcp excluded-address\`), not part of the pool.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24' },
      { device: 'PRINTER', interface: 'Eth0', address: '192.168.10.5/24', gateway: '192.168.10.1', note: 'static' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: `conf t
          int g0/0
          ip address 192.168.10.1 255.255.255.0
          no shut` },
        { hostname: 'SW1', kind: 'switch', at: [250, 150] },
        { hostname: 'PC1', kind: 'pc', at: [50, 300], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [250, 320], ip: 'dhcp' },
        { hostname: 'PRINTER', kind: 'pc', at: [450, 300], ip: '192.168.10.5/24', gateway: '192.168.10.1' },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['PRINTER Eth0', 'SW1 Gi0/3'],
      ],
    },
    objectives: [
      { text: 'The printer address can never be leased', check: { type: 'dhcpExcluded', device: 'R1', address: '192.168.10.5' }, hint: '`ip dhcp excluded-address 192.168.10.1 192.168.10.10` in global config.' },
      { text: 'The gateway address can never be leased', check: { type: 'dhcpExcluded', device: 'R1', address: '192.168.10.1' } },
      { text: 'A pool serves 192.168.10.0/24 with gateway 192.168.10.1', check: { type: 'dhcpPool', device: 'R1', network: '192.168.10.0', prefix: 24, defaultRouter: '192.168.10.1' }, hint: '`ip dhcp pool OFFICE`, then `network 192.168.10.0 255.255.255.0` and `default-router 192.168.10.1`.' },
      { text: 'PC1 leased an address and gateway', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' }, hint: 'On PC1: `ipconfig /renew`.' },
      { text: 'PC2 leased an address and gateway', check: { type: 'dhcpLease', device: 'PC2', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' } },
      { text: 'PC1 can ping the printer', check: { type: 'ping', from: 'PC1', to: '192.168.10.5', expect: 'success' } },
      {
        text: 'APIPA',
        check: {
          type: 'quiz',
          question: 'A Windows PC shows IPv4 address 169.254.17.42 and no default gateway. What is the most likely cause?',
          options: ['A duplicate IP address', 'It could not reach a DHCP server', 'The DNS server is down', 'The switch port is in the wrong VLAN for its gateway'],
          answer: 1,
          explain: 'Windows assigns itself a link-local 169.254.0.0/16 address (APIPA) when no DHCP server answers. A wrong VLAN can cause it too, precisely because the DHCP broadcast then never reaches a server.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip dhcp excluded-address 192.168.10.1 192.168.10.10
        ip dhcp pool OFFICE
        network 192.168.10.0 255.255.255.0
        default-router 192.168.10.1
        dns-server 8.8.8.8
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: 'On R1, `show ip dhcp binding` lists each lease against the client MAC address and `show ip dhcp pool` shows how full the pool is. The first lease went to 192.168.10.11, the lowest address not excluded.',
  },
  {
    id: 'dhcp-relay',
    title: 'Relay DHCP to a central server',
    domain: '1.0',
    blueprint: ['1.7', '1.6'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: "Branch PCs get APIPA addresses from a central DHCP server. Fix the relay and the pool.",
    briefing: `The DHCP server for every branch runs on the HQ router. Branch PCs are not getting addresses: they show 169.254.x.x.

DHCP Discover is a **broadcast**, and routers do not forward broadcasts. The branch router must relay it as a unicast to the server with \`ip helper-address\` on the interface facing the clients.

Once leases arrive, check what gateway the PCs were given. Then prove PC1 can reach the HQ server.`,
    addressing: [
      { device: 'BRANCH', interface: 'Gi0/0', address: '192.168.20.1/24', note: 'branch LAN' },
      { device: 'BRANCH', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'HQ', interface: 'Gi0/1', address: '10.0.12.2/30', note: 'DHCP server' },
      { device: 'HQ', interface: 'Gi0/0', address: '172.16.0.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '172.16.0.10/24', gateway: '172.16.0.1' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP' },
    ],
    topology: {
      devices: [
        { hostname: 'BRANCH', kind: 'router', at: [0, 0], config: `conf t
          int g0/0
          ip address 192.168.20.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.1 255.255.255.252
          no shut
          exit
          ip route 0.0.0.0 0.0.0.0 10.0.12.2` },
        { hostname: 'HQ', kind: 'router', at: [400, 0], config: `conf t
          int g0/0
          ip address 172.16.0.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.2 255.255.255.252
          no shut
          exit
          ip route 192.168.20.0 255.255.255.0 10.0.12.1
          ip dhcp excluded-address 192.168.20.1 192.168.20.9
          ip dhcp pool BRANCH-LAN
          network 192.168.20.0 255.255.255.0
          default-router 192.168.20.254
          dns-server 172.16.0.10` },
        { hostname: 'SW1', kind: 'switch', at: [0, 150] },
        { hostname: 'PC1', kind: 'pc', at: [-120, 300], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [120, 300], ip: 'dhcp' },
        { hostname: 'SRV', kind: 'pc', at: [400, 200], ip: '172.16.0.10/24', gateway: '172.16.0.1' },
      ],
      links: [
        ['BRANCH Gi0/1', 'HQ Gi0/1'],
        ['BRANCH Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['SRV Eth0', 'HQ Gi0/0'],
      ],
    },
    objectives: [
      { text: 'BRANCH relays DHCP to 10.0.12.2', check: { type: 'helperAddress', device: 'BRANCH', interface: 'Gi0/0', address: '10.0.12.2' }, hint: 'On the client-facing interface: `interface g0/0`, `ip helper-address 10.0.12.2`.' },
      { text: 'PC1 leased an address with gateway 192.168.20.1', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.20.0', prefix: 24, gateway: '192.168.20.1' }, hint: 'Leases arrive but with the wrong gateway? Fix `default-router` in the pool on HQ, then `ipconfig /renew` again.' },
      { text: 'PC2 leased an address with gateway 192.168.20.1', check: { type: 'dhcpLease', device: 'PC2', network: '192.168.20.0', prefix: 24, gateway: '192.168.20.1' } },
      { text: 'PC1 can ping the HQ server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' } },
      {
        text: 'Relay agent',
        check: {
          type: 'quiz',
          question: 'How does the HQ server know which pool to lease from for a relayed request?',
          options: ['From the client MAC address', 'From the giaddr field, set by the relay to its interface address', 'From the source port of the packet', 'It always uses the first pool'],
          answer: 1,
          explain: 'The relay agent writes the address of the interface that heard the broadcast into giaddr. The server picks the pool whose network contains giaddr, and replies to the relay.',
        },
      },
    ],
    solution: {
      BRANCH: `enable
        conf t
        int g0/0
        ip helper-address 10.0.12.2
        end`,
      HQ: `enable
        conf t
        ip dhcp pool BRANCH-LAN
        default-router 192.168.20.1
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: "`ipconfig /all` on a PC shows **DHCP Server 10.0.12.2**: the HQ router's address facing the relay. One server can serve many branches, one pool per branch subnet.",
  },
  {
    id: 'nat-pat',
    title: 'Share one public address with PAT',
    domain: '4.0',
    blueprint: ['4.3'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Configure NAT overload so every PC on a private LAN reaches the internet through one address.',
    briefing: `The branch uses private addresses (192.168.1.0/24). Its router has a default route to the ISP, but the ISP has no route back to private space, so pings to 8.8.8.8 go out and never return.

Configure **PAT** (NAT overload) on R1 so the whole LAN shares the public address on Gi0/1:

- Mark Gi0/0 as \`ip nat inside\` and Gi0/1 as \`ip nat outside\`
- Write standard ACL 1 permitting 192.168.1.0/24: it selects who gets translated
- \`ip nat inside source list 1 interface g0/1 overload\``,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'inside' },
      { device: 'R1', interface: 'Gi0/1', address: '203.0.113.1/29', note: 'outside' },
      { device: 'ISP', interface: 'Gi0/1', address: '203.0.113.6/29' },
      { device: 'ISP', interface: 'Lo0', address: '8.8.8.8/32', note: 'internet server' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'PC2', interface: 'Eth0', address: '192.168.1.20/24', gateway: '192.168.1.1' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [200, 0], config: EDGE_R1 },
        { hostname: 'ISP', kind: 'router', at: [520, 0], config: EDGE_ISP },
        { hostname: 'SW1', kind: 'switch', at: [200, 150] },
        { hostname: 'PC1', kind: 'pc', at: [60, 300], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'PC2', kind: 'pc', at: [340, 300], ip: '192.168.1.20/24', gateway: '192.168.1.1' },
      ],
      links: [
        ['R1 Gi0/1', 'ISP Gi0/1'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
      ],
    },
    objectives: [
      { text: 'Gi0/0 is the NAT inside interface', check: { type: 'natInterface', device: 'R1', interface: 'Gi0/0', side: 'inside' }, hint: '`interface g0/0`, then `ip nat inside`.' },
      { text: 'Gi0/1 is the NAT outside interface', check: { type: 'natInterface', device: 'R1', interface: 'Gi0/1', side: 'outside' } },
      { text: 'R1 overloads the LAN onto one address', check: { type: 'natOverload', device: 'R1' }, hint: '`access-list 1 permit 192.168.1.0 0.0.0.255`, then `ip nat inside source list 1 interface g0/1 overload`.' },
      { text: 'PC1 can ping 8.8.8.8', check: { type: 'ping', from: 'PC1', to: '8.8.8.8', expect: 'success' } },
      { text: 'PC2 can ping 8.8.8.8', check: { type: 'ping', from: 'PC2', to: '8.8.8.8', expect: 'success' } },
      {
        text: 'NAT terms',
        check: {
          type: 'quiz',
          question: 'In `show ip nat translations`, what is 192.168.1.10 called?',
          options: ['Inside global', 'Inside local', 'Outside local', 'Outside global'],
          answer: 1,
          explain: 'Inside local is the real, private address of the inside host. Inside global is what the internet sees it as (203.0.113.1 here, with a port number that keeps each flow apart).',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        int g0/0
        ip nat inside
        int g0/1
        ip nat outside
        exit
        access-list 1 permit 192.168.1.0 0.0.0.255
        ip nat inside source list 1 interface g0/1 overload
        end`,
    },
    debrief: 'Ping from both PCs, then run `show ip nat translations` on R1: every entry has the same inside global address, told apart by the port (the ICMP identifier for ping). That is the "port" in Port Address Translation.',
  },
  {
    id: 'nat-static',
    title: 'Publish a web server with static NAT',
    domain: '4.0',
    blueprint: ['4.3'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Map a private web server to a public address so the internet can reach it.',
    briefing: `PAT lets inside hosts start connections out, but nobody outside can start a connection in. The company web server SRV (192.168.1.100) must be reachable from the internet at **203.0.113.3**.

- Set the NAT inside and outside interfaces on R1
- Add a static translation from 192.168.1.100 to 203.0.113.3

R1 answers ARP for 203.0.113.3 on its outside interface once the mapping exists, so the ISP needs no extra route: the address is in the shared /29.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'inside' },
      { device: 'R1', interface: 'Gi0/1', address: '203.0.113.1/29', note: 'outside' },
      { device: 'ISP', interface: 'Gi0/1', address: '203.0.113.6/29' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'public as 203.0.113.3' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [200, 0], config: EDGE_R1 },
        { hostname: 'ISP', kind: 'router', at: [520, 0], config: EDGE_ISP },
        { hostname: 'SRV', kind: 'pc', at: [200, 200], ip: '192.168.1.100/24', gateway: '192.168.1.1' },
      ],
      links: [
        ['R1 Gi0/1', 'ISP Gi0/1'],
        ['R1 Gi0/0', 'SRV Eth0'],
      ],
    },
    objectives: [
      { text: 'Gi0/0 is the NAT inside interface', check: { type: 'natInterface', device: 'R1', interface: 'Gi0/0', side: 'inside' } },
      { text: 'Gi0/1 is the NAT outside interface', check: { type: 'natInterface', device: 'R1', interface: 'Gi0/1', side: 'outside' } },
      { text: 'SRV is published as 203.0.113.3', check: { type: 'natStatic', device: 'R1', local: '192.168.1.100', global: '203.0.113.3' }, hint: '`ip nat inside source static 192.168.1.100 203.0.113.3`.' },
      { text: 'The ISP can browse to 203.0.113.3', check: { type: 'connect', from: 'ISP', to: '203.0.113.3', port: 80, expect: 'open' }, hint: 'Test it from the ISP router: `telnet 203.0.113.3 80`.' },
      { text: 'SRV can ping 8.8.8.8', check: { type: 'ping', from: 'SRV', to: '8.8.8.8', expect: 'success' } },
      {
        text: 'Static or dynamic',
        check: {
          type: 'quiz',
          question: 'Why does a public server need static NAT rather than PAT?',
          options: ['PAT cannot translate TCP', 'Outside clients need a fixed address to start connections to, and PAT only creates entries for traffic started inside', 'Static NAT is faster', 'PAT needs a pool'],
          answer: 1,
          explain: 'Dynamic NAT and PAT create a translation when an inside host sends first. A static entry exists all the time, so traffic can arrive unannounced.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        int g0/0
        ip nat inside
        int g0/1
        ip nat outside
        exit
        ip nat inside source static 192.168.1.100 203.0.113.3
        end`,
    },
    debrief: '`show ip nat translations` shows the permanent `---` line for the static mapping plus one line per flow, such as the ISP\'s TCP connection to port 80. The same static entry also translated SRV\'s own ping to 8.8.8.8 on the way out.',
  },
  {
    id: 'acl-standard',
    title: 'Keep guests off the servers with a standard ACL',
    domain: '4.0',
    blueprint: ['4.6'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Write a numbered standard ACL and place it close to the destination.',
    briefing: `R1 routes between three LANs. Guests must not reach the server LAN, but they still need everything else (here: the staff LAN, for the shared printer).

A **standard** ACL can only match the source address, so place it **as close to the destination as possible**: outbound on the server-facing interface. Placed inbound on the guest interface it would also cut guests off from the staff LAN.

- ACL 10: deny 192.168.20.0/24, permit everything else
- Apply it with \`ip access-group 10 out\` on Gi0/2

Every ACL ends with an invisible **deny any**. Forget the permit and you block everyone.`,
    addressing: THREE_LANS_ADDRESSING,
    topology: THREE_LANS_TOPOLOGY,
    objectives: [
      { text: 'An ACL filters traffic leaving Gi0/2', check: { type: 'accessGroup', device: 'R1', interface: 'Gi0/2', direction: 'out' }, hint: '`access-list 10 deny 192.168.20.0 0.0.0.255`, `access-list 10 permit any`, then on Gi0/2: `ip access-group 10 out`.' },
      { text: 'GUEST cannot reach the server', check: { type: 'ping', from: 'GUEST', to: '192.168.30.100', expect: 'fail' } },
      { text: 'STAFF can still reach the server', check: { type: 'ping', from: 'STAFF', to: '192.168.30.100', expect: 'success' }, hint: 'Did you permit everything else? The implicit deny at the end blocks whatever you did not permit.' },
      { text: 'GUEST can still reach the staff LAN', check: { type: 'ping', from: 'GUEST', to: '192.168.10.10', expect: 'success' } },
      {
        text: 'Wildcards',
        check: {
          type: 'quiz',
          question: 'Which wildcard mask matches every host in 192.168.20.0/24?',
          options: ['255.255.255.0', '0.0.0.255', '0.0.0.0', '255.255.255.255'],
          answer: 1,
          explain: 'A wildcard is the inverse of the subnet mask: 0 bits must match, 1 bits are ignored. `0.0.0.0` matches one host (`host`), `255.255.255.255` matches anything (`any`).',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        access-list 10 remark Guests stay off the server LAN
        access-list 10 deny 192.168.20.0 0.0.0.255
        access-list 10 permit any
        int g0/2
        ip access-group 10 out
        end`,
    },
    debrief: 'Ping from GUEST shows `Destination host unreachable` from 192.168.20.1: R1 sends an ICMP unreachable for every packet an ACL drops. `show access-lists` counts the matches on each line.',
  },
  {
    id: 'acl-extended',
    title: 'Filter by port with a named extended ACL',
    domain: '4.0',
    blueprint: ['4.6'],
    kind: 'guided',
    difficulty: 3,
    summary: 'Block guests from one service on the server while allowing ping and HTTPS, close to the source.',
    briefing: `New policy for the guest LAN (192.168.20.0/24):

- No plain HTTP (TCP 80) to the server 192.168.30.100; HTTPS (443) and ping are fine
- No access at all to the staff LAN 192.168.10.0/24
- Everything else is allowed

An **extended** ACL matches protocol, source, destination and ports, so place it **close to the source**: inbound on the guest interface Gi0/1. Use a **named** ACL called \`GUEST-IN\`.

Test from GUEST with \`curl http://192.168.30.100\` and \`curl https://192.168.30.100\`.`,
    addressing: THREE_LANS_ADDRESSING,
    topology: THREE_LANS_TOPOLOGY,
    objectives: [
      { text: 'GUEST-IN filters traffic entering Gi0/1', check: { type: 'accessGroup', device: 'R1', interface: 'Gi0/1', direction: 'in', acl: 'GUEST-IN' }, hint: '`ip access-list extended GUEST-IN`, add the entries, then on Gi0/1: `ip access-group GUEST-IN in`.' },
      { text: 'GUEST cannot open HTTP on the server', check: { type: 'connect', from: 'GUEST', to: '192.168.30.100', port: 80, expect: 'blocked' }, hint: '`deny tcp 192.168.20.0 0.0.0.255 host 192.168.30.100 eq www`.' },
      { text: 'GUEST can open HTTPS on the server', check: { type: 'connect', from: 'GUEST', to: '192.168.30.100', port: 443, expect: 'open' } },
      { text: 'GUEST can ping the server', check: { type: 'ping', from: 'GUEST', to: '192.168.30.100', expect: 'success' } },
      { text: 'GUEST cannot reach the staff LAN', check: { type: 'ping', from: 'GUEST', to: '192.168.10.10', expect: 'fail' }, hint: '`deny ip 192.168.20.0 0.0.0.255 192.168.10.0 0.0.0.255`, and finish with `permit ip any any`.' },
      { text: 'STAFF can still browse the server', check: { type: 'connect', from: 'STAFF', to: '192.168.30.100', port: 80, expect: 'open' } },
      {
        text: 'Placement',
        check: {
          type: 'quiz',
          question: 'Why place an extended ACL close to the source?',
          options: ['Extended ACLs only work inbound', 'It drops unwanted traffic before it crosses the network, and the ACL is specific enough not to block other flows', 'Standard ACLs must be near the destination, so extended ones cannot be', 'It uses less memory'],
          answer: 1,
          explain: 'Extended ACLs name source, destination and port, so filtering early wastes no bandwidth and affects nothing else. Standard ACLs only know the source, so they go near the destination.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip access-list extended GUEST-IN
        remark Guests: no HTTP to the server, no staff LAN
        deny tcp 192.168.20.0 0.0.0.255 host 192.168.30.100 eq www
        deny ip 192.168.20.0 0.0.0.255 192.168.10.0 0.0.0.255
        permit ip any any
        exit
        int g0/1
        ip access-group GUEST-IN in
        end`,
    },
    debrief: 'Named ACL entries get sequence numbers (10, 20, 30). To add a rule above an existing one, enter `ip access-list extended GUEST-IN` and type `15 deny ...`; `no 20` removes a single line. With numbered ACLs, `no access-list 101 ...` deletes the whole list.',
  },
  {
    id: 'acl-troubleshoot',
    title: 'Fix the ACLs that broke the WAN',
    domain: '4.0',
    blueprint: ['4.6', '3.3.a'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'A security change killed OSPF and locked everyone out of the servers. Fix it without dropping the filters.',
    briefing: `Last night two ACLs went onto HQ:

- \`WAN-IN\`, inbound on the WAN link, was meant to allow only ping and OSPF from the branch, plus traffic from the branch LAN
- ACL \`5\`, outbound towards the servers, was meant to block a single compromised guest laptop, **192.168.1.66**

This morning the OSPF adjacency is down and nobody at the branch reaches the server. Keep both ACLs applied, but fix their entries.

\`show access-lists\` shows which lines match (and which never do). Remember the implicit **deny any** at the end of each.`,
    addressing: [
      { device: 'BRANCH', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'BRANCH', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'HQ', interface: 'Gi0/1', address: '10.0.12.2/30', note: 'WAN-IN in' },
      { device: 'HQ', interface: 'Gi0/0', address: '172.16.0.1/24', note: 'ACL 5 out' },
      { device: 'PC1', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
      { device: 'LAPTOP', interface: 'Eth0', address: '192.168.1.66/24', gateway: '192.168.1.1', note: 'blocked' },
      { device: 'SRV', interface: 'Eth0', address: '172.16.0.10/24', gateway: '172.16.0.1' },
    ],
    topology: {
      devices: [
        { hostname: 'BRANCH', kind: 'router', at: [0, 0], config: `conf t
          int g0/0
          ip address 192.168.1.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.1 255.255.255.252
          no shut
          router ospf 1
          router-id 1.1.1.1
          network 192.168.1.0 0.0.0.255 area 0
          network 10.0.12.0 0.0.0.3 area 0
          passive-interface g0/0` },
        { hostname: 'HQ', kind: 'router', at: [400, 0], config: `conf t
          int g0/0
          ip address 172.16.0.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.2 255.255.255.252
          no shut
          router ospf 1
          router-id 2.2.2.2
          network 172.16.0.0 0.0.0.255 area 0
          network 10.0.12.0 0.0.0.3 area 0
          passive-interface g0/0
          exit
          ip access-list extended WAN-IN
          permit icmp any any
          permit ip 192.168.1.0 0.0.0.255 any
          exit
          access-list 5 deny 192.168.1.0 0.0.0.255
          int g0/1
          ip access-group WAN-IN in
          int g0/0
          ip access-group 5 out` },
        { hostname: 'SW1', kind: 'switch', at: [0, 150] },
        { hostname: 'PC1', kind: 'pc', at: [-120, 300], ip: '192.168.1.10/24', gateway: '192.168.1.1' },
        { hostname: 'LAPTOP', kind: 'pc', at: [120, 300], ip: '192.168.1.66/24', gateway: '192.168.1.1' },
        { hostname: 'SRV', kind: 'pc', at: [400, 200], ip: '172.16.0.10/24', gateway: '172.16.0.1' },
      ],
      links: [
        ['BRANCH Gi0/1', 'HQ Gi0/1'],
        ['BRANCH Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['LAPTOP Eth0', 'SW1 Gi0/2'],
        ['SRV Eth0', 'HQ Gi0/0'],
      ],
    },
    objectives: [
      { text: 'HQ is FULL with BRANCH again', check: { type: 'ospfNeighbor', device: 'HQ', neighbor: '1.1.1.1' }, hint: 'OSPF hellos come from 10.0.12.1 and are protocol 89, not ICMP or the branch LAN. Add `permit ospf any any` to WAN-IN.' },
      { text: 'WAN-IN is still applied inbound on Gi0/1', check: { type: 'accessGroup', device: 'HQ', interface: 'Gi0/1', direction: 'in', acl: 'WAN-IN' } },
      { text: 'ACL 5 is still applied outbound on Gi0/0', check: { type: 'accessGroup', device: 'HQ', interface: 'Gi0/0', direction: 'out', acl: '5' } },
      { text: 'PC1 can reach the server', check: { type: 'ping', from: 'PC1', to: '172.16.0.10', expect: 'success' }, hint: 'ACL 5 denies the whole branch subnet and has no permit, so the implicit deny catches everyone else. Deny just `host 192.168.1.66`, then `permit any`.' },
      { text: 'LAPTOP cannot reach the server', check: { type: 'ping', from: 'LAPTOP', to: '172.16.0.10', expect: 'fail' } },
      {
        text: 'Numbered ACL edits',
        check: {
          type: 'quiz',
          question: 'On IOS, what does `no access-list 5 deny 192.168.1.0 0.0.0.255` do?',
          options: ['Removes that one line', 'Deletes the whole of ACL 5', 'Turns the deny into a permit', 'Nothing, the syntax is wrong'],
          answer: 1,
          explain: 'For numbered ACLs in global config, any `no access-list 5 ...` deletes the entire list. Edit single lines in ACL mode instead: `ip access-list standard 5`, then `no 10`.',
        },
      },
    ],
    solution: {
      HQ: `enable
        conf t
        ip access-list extended WAN-IN
        permit ospf any any
        exit
        ip access-list standard 5
        no 10
        deny host 192.168.1.66
        permit any
        end`,
    },
    debrief: 'An inbound ACL filters everything arriving on the interface, routing protocol traffic included; outbound ACLs never filter packets the router sends itself. ACL 5 kept its place on Gi0/0 while you edited its lines in standard ACL mode.',
  },
  {
    id: 'capstone-branch-internet',
    title: 'Capstone: branch to the internet',
    domain: '4.0',
    blueprint: ['3.3', '1.7', '4.3', '3.2.a'],
    kind: 'challenge',
    difficulty: 3,
    summary: 'OSPF between branch and HQ, a default route from HQ, PAT to the ISP and DHCP at the branch.',
    briefing: `Bring a new branch online. Everything is addressed; nothing else is configured except the ISP.

- **OSPF** area 0 between BRANCH and HQ
- **HQ** has a static default route to the ISP and shares it with OSPF (\`default-information originate\`)
- **HQ** translates both private LANs (192.168.0.0/16) to its ISP-facing address with **PAT**
- **BRANCH** is the DHCP server for its LAN (gateway 192.168.10.1, keep .1 to .9 out of the pool)
- PC1 and PC2 renew their address and reach 8.8.8.8

The branch never needs a static route: it learns the default route from HQ.`,
    addressing: [
      { device: 'BRANCH', interface: 'Gi0/0', address: '192.168.10.1/24' },
      { device: 'BRANCH', interface: 'Gi0/1', address: '10.0.12.1/30' },
      { device: 'HQ', interface: 'Gi0/1', address: '10.0.12.2/30' },
      { device: 'HQ', interface: 'Gi0/0', address: '192.168.50.1/24' },
      { device: 'HQ', interface: 'Gi0/2', address: '203.0.113.1/29', note: 'to ISP' },
      { device: 'ISP', interface: 'Gi0/2', address: '203.0.113.6/29' },
      { device: 'ISP', interface: 'Lo0', address: '8.8.8.8/32' },
      { device: 'HQPC', interface: 'Eth0', address: '192.168.50.10/24', gateway: '192.168.50.1' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP' },
    ],
    topology: {
      devices: [
        { hostname: 'BRANCH', kind: 'router', at: [0, 0], config: `conf t
          int g0/0
          ip address 192.168.10.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.1 255.255.255.252
          no shut` },
        { hostname: 'HQ', kind: 'router', at: [350, 0], config: `conf t
          int g0/0
          ip address 192.168.50.1 255.255.255.0
          no shut
          int g0/1
          ip address 10.0.12.2 255.255.255.252
          no shut
          int g0/2
          ip address 203.0.113.1 255.255.255.248
          no shut` },
        { hostname: 'ISP', kind: 'router', at: [650, 0], config: `conf t
          int g0/2
          ip address 203.0.113.6 255.255.255.248
          no shut
          int lo0
          ip address 8.8.8.8 255.255.255.255` },
        { hostname: 'SW1', kind: 'switch', at: [0, 150] },
        { hostname: 'PC1', kind: 'pc', at: [-120, 300], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [120, 300], ip: 'dhcp' },
        { hostname: 'HQPC', kind: 'pc', at: [350, 200], ip: '192.168.50.10/24', gateway: '192.168.50.1' },
      ],
      links: [
        ['BRANCH Gi0/1', 'HQ Gi0/1'],
        ['HQ Gi0/2', 'ISP Gi0/2'],
        ['BRANCH Gi0/0', 'SW1 Gi0/8'],
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['HQPC Eth0', 'HQ Gi0/0'],
      ],
    },
    objectives: [
      { text: 'BRANCH and HQ are OSPF neighbors', check: { type: 'ospfNeighbor', device: 'BRANCH', neighbor: '2.2.2.2' }, hint: 'Use router IDs 1.1.1.1 (BRANCH) and 2.2.2.2 (HQ).' },
      { text: 'BRANCH learns a default route from OSPF', check: { type: 'route', device: 'BRANCH', network: '0.0.0.0', prefix: 0, code: 'O' }, hint: 'HQ needs `ip route 0.0.0.0 0.0.0.0 203.0.113.6` first; `default-information originate` only advertises a default route the router already has.' },
      { text: 'HQ overloads inside traffic onto its ISP address', check: { type: 'natOverload', device: 'HQ' } },
      { text: 'PC1 leased an address from BRANCH', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' } },
      { text: 'PC2 leased an address from BRANCH', check: { type: 'dhcpLease', device: 'PC2', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' } },
      { text: 'PC1 can ping 8.8.8.8', check: { type: 'ping', from: 'PC1', to: '8.8.8.8', expect: 'success' }, hint: 'NAT needs both inside interfaces (Gi0/0 and Gi0/1 on HQ) marked `ip nat inside`.' },
      { text: 'HQPC can ping 8.8.8.8', check: { type: 'ping', from: 'HQPC', to: '8.8.8.8', expect: 'success' } },
      {
        text: 'Reading the route',
        check: {
          type: 'quiz',
          question: 'BRANCH shows `O*E2 0.0.0.0/0 [110/1] via 10.0.12.2`. What does E2 mean?',
          options: ['The route crossed two areas', 'An external route whose metric stays as advertised, whatever the internal path cost', 'The second equal-cost path', 'The route is about to expire'],
          answer: 1,
          explain: 'Routes injected into OSPF from outside (here a static default) are external. Type 2 (the default) keeps the advertised metric, 1, however far away the ASBR is.',
        },
      },
    ],
    solution: {
      BRANCH: `enable
        conf t
        ip dhcp excluded-address 192.168.10.1 192.168.10.9
        ip dhcp pool BRANCH-LAN
        network 192.168.10.0 255.255.255.0
        default-router 192.168.10.1
        exit
        router ospf 1
        router-id 1.1.1.1
        network 192.168.10.0 0.0.0.255 area 0
        network 10.0.12.0 0.0.0.3 area 0
        passive-interface g0/0
        end`,
      HQ: `enable
        conf t
        ip route 0.0.0.0 0.0.0.0 203.0.113.6
        router ospf 1
        router-id 2.2.2.2
        network 10.0.12.0 0.0.0.3 area 0
        network 192.168.50.0 0.0.0.255 area 0
        passive-interface g0/0
        default-information originate
        exit
        access-list 1 permit 192.168.0.0 0.0.255.255
        ip nat inside source list 1 interface g0/2 overload
        int g0/0
        ip nat inside
        int g0/1
        ip nat inside
        int g0/2
        ip nat outside
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: 'Follow a ping from PC1: DHCP gave it a gateway, BRANCH forwards by its OSPF default route, HQ forwards by its static default and translates the source to 203.0.113.1, and the reply is translated back. `show ip nat translations` on HQ shows both LANs sharing one address.',
  },
];
