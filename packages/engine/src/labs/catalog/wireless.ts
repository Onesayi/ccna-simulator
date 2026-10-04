import type { LabDefinition, LabDeviceSpec } from '../types';

/**
 * The wireless network every lab here starts from: R1 routes VLAN 10 (management: the WLC, APs
 * and servers) and VLAN 20 (staff clients) on a trunk to SW1, and hands out addresses in both.
 */
const R1_BASE = `conf t
  interface g0/0
  no shutdown
  interface g0/0.10
  encapsulation dot1Q 10
  ip address 192.168.10.1 255.255.255.0
  interface g0/0.20
  encapsulation dot1Q 20
  ip address 192.168.20.1 255.255.255.0
  exit
  ip dhcp excluded-address 192.168.10.1 192.168.10.9
  ip dhcp excluded-address 192.168.20.1 192.168.20.9
  ip dhcp pool MGMT
  network 192.168.10.0 255.255.255.0
  default-router 192.168.10.1
  ip dhcp pool STAFF
  network 192.168.20.0 255.255.255.0
  default-router 192.168.20.1`;

const SW1_BASE = `conf t
  vlan 10
  name MGMT
  vlan 20
  name STAFF
  interface g0/1
  switchport mode trunk
  interface g0/2
  switchport mode trunk
  interface range g0/3 - 6
  switchport access vlan 10`;

const WLC_MGMT = `config interface address management 192.168.10.5 255.255.255.0 192.168.10.1
  config interface vlan management 10`;

const STAFF_WLAN = `config interface create staff 20
  config interface address dynamic-interface staff 192.168.20.5 255.255.255.0 192.168.20.1
  config wlan create 1 Staff Staff
  config wlan interface 1 staff
  config wlan security wpa akm 802.1x disable 1
  config wlan security wpa akm psk enable 1
  config wlan security wpa akm psk set-key ascii CorpWiFi2024 1
  config wlan enable 1`;

const ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0.10', address: '192.168.10.1/24', note: 'VLAN 10, management' },
  { device: 'R1', interface: 'Gi0/0.20', address: '192.168.20.1/24', note: 'VLAN 20, staff Wi-Fi' },
  { device: 'WLC1', interface: 'management', address: '192.168.10.5/24', gateway: '192.168.10.1', note: 'VLAN 10, tagged' },
  { device: 'AP1', interface: 'Gi0', address: 'DHCP (VLAN 10)', note: 'SW1 Gi0/3, access' },
];

function base(extra: LabDeviceSpec[] = []): LabDeviceSpec[] {
  return [
    { hostname: 'R1', kind: 'router', at: [250, 0], config: R1_BASE },
    { hostname: 'SW1', kind: 'switch', at: [250, 150], config: SW1_BASE },
    { hostname: 'WLC1', kind: 'wlc', at: [30, 150], config: WLC_MGMT },
    { hostname: 'AP1', kind: 'ap', at: [250, 300] },
    ...extra,
  ];
}

const BASE_LINKS: [string, string][] = [
  ['R1 Gi0/0', 'SW1 Gi0/1'],
  ['WLC1 Gi1', 'SW1 Gi0/2'],
  ['AP1 Gi0', 'SW1 Gi0/3'],
];

export const wirelessLabs: LabDefinition[] = [
  {
    id: 'wlan-wpa2-psk',
    title: 'Build a WPA2-Personal WLAN',
    domain: '1.0',
    blueprint: ['1.5', '1.6'],
    kind: 'guided',
    difficulty: 2,
    summary: 'A dynamic interface, a WPA2-PSK WLAN mapped to the staff VLAN, and a laptop that joins it.',
    briefing: `AP1 has already joined WLC1 (check \`show ap summary\` on the controller), but it beacons nothing: there is no WLAN yet. Staff laptops belong in **VLAN 20**, where R1 runs DHCP.

On WLC1 (an AireOS controller; every command starts with \`config\` or \`show\`):

- Create a dynamic interface **staff** in VLAN **20** with address **192.168.20.5/24**, gateway **192.168.20.1**: \`config interface create\`, then \`config interface address dynamic-interface\`
- Create WLAN **1**, profile and SSID **Staff**: \`config wlan create 1 Staff Staff\`
- Map it to the staff interface, so its clients land in VLAN 20
- Security: a new WLAN uses WPA2 with 802.1X. Turn 802.1X off, PSK on, and set the passphrase **CorpWiFi2024**
- Enable the WLAN

Then on LAPTOP1, look around with \`netsh wlan show networks\` and join with \`netsh wlan connect ssid=Staff key=CorpWiFi2024\`. It should get an address in 192.168.20.0/24 and reach its gateway.`,
    addressing: ADDRESSING,
    topology: {
      devices: base([{ hostname: 'LAPTOP1', kind: 'pc', wireless: true, at: [420, 330], ip: 'dhcp' }]),
      links: BASE_LINKS,
    },
    objectives: [
      { text: 'AP1 has joined WLC1', check: { type: 'apJoined', device: 'AP1', controller: 'WLC1' } },
      { text: 'WLAN Staff uses WPA2-PSK, is mapped to VLAN 20 and is enabled', check: { type: 'wlan', device: 'WLC1', ssid: 'Staff', security: 'wpa2-psk', vlan: 20, enabled: true }, hint: 'A WLAN must be disabled to change its security; `show wlan 1` shows what it adds up to.' },
      { text: 'LAPTOP1 is on Staff with a VLAN 20 address', check: { type: 'wirelessClient', device: 'LAPTOP1', ssid: 'Staff', network: '192.168.20.0', prefix: 24 }, hint: '`netsh wlan connect ssid=Staff key=CorpWiFi2024`, then `ipconfig`.' },
      { text: 'LAPTOP1 reaches its gateway', check: { type: 'ping', from: 'LAPTOP1', to: '192.168.20.1', expect: 'success' } },
      {
        text: 'Split MAC',
        check: {
          type: 'quiz',
          question: 'LAPTOP1 pings R1. Which path does the echo request take?',
          options: ['Air to AP1, then AP1 switches it onto VLAN 20 itself', 'Air to AP1, CAPWAP tunnel to WLC1, then WLC1 puts it on VLAN 20 towards R1', 'Air straight to WLC1', 'Air to AP1, then AP1 routes it to R1'],
          answer: 1,
          explain: 'A lightweight AP in local mode tunnels every client frame to the controller inside CAPWAP (UDP 5247). The WLC bridges it onto the VLAN of the WLAN\'s interface. Open the capture on the AP1 cable to see CAPWAP-Data wrapping the ICMP.',
        },
      },
    ],
    solution: {
      WLC1: STAFF_WLAN,
      LAPTOP1: 'netsh wlan connect ssid=Staff key=CorpWiFi2024',
    },
    debrief: 'The WLAN is just the SSID and its security; the interface mapping decides the VLAN, and so the subnet and DHCP scope, for its clients. AireOS insists a WLAN is disabled while you change it, a common surprise in the GUI too. With PSK, a wrong passphrase fails at the 4-way handshake (`show msglog` on the WLC says so); try it.',
  },
  {
    id: 'ap-join-option43',
    title: 'Help an AP find its controller',
    domain: '1.0',
    blueprint: ['1.5', '1.7'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'An AP in its own subnet cannot hear the controller\'s broadcast reply: point it there with DHCP option 43.',
    briefing: `The new floor's AP, AP1, sits in **VLAN 30** (192.168.30.0/24) and gets its address from R1. WLC1 is in VLAN 10. The WLAN is ready and LAPTOP1 already has the Staff profile saved, yet nobody can connect: AP1 never joins.

A lightweight AP looks for controllers by broadcasting on its own subnet, by a controller it was primed with, or by the addresses in **DHCP option 43**. The broadcast cannot cross R1.

Fix it the scalable way: on R1's **APS** DHCP pool, add option 43 for WLC1 (192.168.10.5). The value is \`f1\`, the length \`04\` (one controller), then the address in hex: \`option 43 hex f104.c0a8.0a05\`.

Check with \`show capwap ip config\` and \`show capwap client rcb\` on AP1, and \`show ap summary\` on WLC1.`,
    addressing: [
      ...ADDRESSING.slice(0, 3),
      { device: 'R1', interface: 'Gi0/0.30', address: '192.168.30.1/24', note: 'VLAN 30, APs' },
      { device: 'AP1', interface: 'Gi0', address: 'DHCP (VLAN 30)', note: 'SW1 Gi0/3, access' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [250, 0],
          config: `${R1_BASE}
            interface g0/0.30
            encapsulation dot1Q 30
            ip address 192.168.30.1 255.255.255.0
            exit
            ip dhcp excluded-address 192.168.30.1 192.168.30.9
            ip dhcp pool APS
            network 192.168.30.0 255.255.255.0
            default-router 192.168.30.1`,
        },
        { hostname: 'SW1', kind: 'switch', at: [250, 150], config: `${SW1_BASE}\nvlan 30\nname APS\ninterface g0/3\nswitchport access vlan 30` },
        { hostname: 'WLC1', kind: 'wlc', at: [30, 150], config: `${WLC_MGMT}\n${STAFF_WLAN}` },
        { hostname: 'AP1', kind: 'ap', at: [250, 300] },
        { hostname: 'LAPTOP1', kind: 'pc', wireless: true, at: [420, 330], ip: 'dhcp', wifi: { ssid: 'Staff', key: 'CorpWiFi2024' } },
      ],
      links: BASE_LINKS,
    },
    objectives: [
      { text: 'R1 hands APs the controller address in option 43', check: { type: 'apJoined', device: 'AP1', controller: 'WLC1' }, hint: '`ip dhcp pool APS`, then `option 43 hex f104.c0a8.0a05` (192 = c0, 168 = a8, 10 = 0a, 5 = 05).' },
      { text: 'LAPTOP1 joins Staff on its own and gets a VLAN 20 address', check: { type: 'wirelessClient', device: 'LAPTOP1', ssid: 'Staff', network: '192.168.20.0', prefix: 24 }, hint: 'Once the AP beacons Staff, the saved profile connects. If the laptop still shows 169.254.x.x, `ipconfig /renew`.' },
      {
        text: 'Discovery options',
        check: {
          type: 'quiz',
          question: 'Which discovery method would also have worked here without touching DHCP?',
          options: ['A subnet broadcast from AP1', 'Priming AP1 with `capwap ap primary-base WLC1 192.168.10.5`', 'Enabling CDP on WLC1', 'Putting the WLC in VLAN 1'],
          answer: 1,
          explain: 'Priming (or a DNS entry for CISCO-CAPWAP-CONTROLLER) also works across subnets. A broadcast stays in VLAN 30 unless the router forwards UDP 5246 with `ip helper-address`. Option 43 scales best: every new AP learns it from DHCP.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip dhcp pool APS
        option 43 hex f104.c0a8.0a05
        end`,
      LAPTOP1: 'ipconfig /renew',
    },
    debrief: 'Layer 3 AP discovery needs the controller address from somewhere: a primed controller, DHCP option 43, DNS, or a broadcast that only reaches the local subnet. The CAPWAP join then runs over UDP 5246 like any routed traffic, which is why APs and controllers can live in different VLANs.',
  },
  {
    id: 'wlan-enterprise-guest',
    title: 'WPA2-Enterprise for staff, WPA3 for guests',
    domain: '1.0',
    blueprint: ['1.5', '1.6', '4.1'],
    kind: 'challenge',
    difficulty: 3,
    summary: 'An 802.1X WLAN that checks users against RADIUS, and a WPA3-SAE guest WLAN in its own VLAN.',
    briefing: `Shared passphrases are out. Build two WLANs on WLC1:

- **Corp** (WLAN 2): WPA2-Enterprise. Users log in with their own name and password, checked by the RADIUS server **SRV** (192.168.10.100, UDP **1812**, shared secret **RadKey123**). Corp clients go to VLAN 20 through the existing **staff** interface.
- **Guest** (WLAN 3): WPA3-Personal (SAE) with passphrase **GuestPass99**, in VLAN 30 through a new interface **guest** at 192.168.30.5/24, gateway 192.168.30.1. R1 already routes and serves DHCP for VLAN 30; SW1 already trunks it.

SRV knows WLC1 as a RADIUS client and has user **alice** (password **Wonder1**). Useful commands: \`config radius auth add\`, \`config wlan radius_server auth add\`, \`config wlan security wpa wpa3 enable\`, \`config wlan security wpa akm sae enable\`.

Prove it: LAPTOP1 joins Corp as alice (\`netsh wlan connect ssid=Corp user=alice password=Wonder1\`) and LAPTOP2 joins Guest. \`aaa log\` on SRV shows the RADIUS exchange.`,
    addressing: [
      ...ADDRESSING.slice(0, 3),
      { device: 'R1', interface: 'Gi0/0.30', address: '192.168.30.1/24', note: 'VLAN 30, guests' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.10.100/24', gateway: '192.168.10.1', note: 'RADIUS' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [250, 0],
          config: `${R1_BASE}
            interface g0/0.30
            encapsulation dot1Q 30
            ip address 192.168.30.1 255.255.255.0
            exit
            ip dhcp excluded-address 192.168.30.1 192.168.30.9
            ip dhcp pool GUEST
            network 192.168.30.0 255.255.255.0
            default-router 192.168.30.1`,
        },
        { hostname: 'SW1', kind: 'switch', at: [250, 150], config: `${SW1_BASE}\nvlan 30\nname GUEST` },
        { hostname: 'WLC1', kind: 'wlc', at: [30, 150], config: `${WLC_MGMT}\nconfig interface create staff 20\nconfig interface address dynamic-interface staff 192.168.20.5 255.255.255.0 192.168.20.1` },
        { hostname: 'AP1', kind: 'ap', at: [250, 300] },
        { hostname: 'SRV', kind: 'server', at: [470, 150], ip: '192.168.10.100/24', gateway: '192.168.10.1', config: 'aaa client add 192.168.10.5 RadKey123\naaa user add alice Wonder1' },
        { hostname: 'LAPTOP1', kind: 'pc', wireless: true, at: [120, 360], ip: 'dhcp' },
        { hostname: 'LAPTOP2', kind: 'pc', wireless: true, at: [400, 360], ip: 'dhcp' },
      ],
      links: [...BASE_LINKS, ['SRV Eth0', 'SW1 Gi0/4']],
    },
    objectives: [
      { text: 'Corp is a WPA2-Enterprise WLAN in VLAN 20', check: { type: 'wlan', device: 'WLC1', ssid: 'Corp', security: 'wpa2-enterprise', vlan: 20, enabled: true }, hint: 'A new WLAN already uses WPA2 + 802.1X: create it, map it to staff, add the RADIUS server, enable it.' },
      { text: 'Guest is a WPA3-SAE WLAN in VLAN 30', check: { type: 'wlan', device: 'WLC1', ssid: 'Guest', security: 'wpa3-sae', vlan: 30, enabled: true }, hint: 'Create interface guest in VLAN 30 first. On the WLAN: wpa3 enable, akm sae enable, akm 802.1x disable, then the key.' },
      { text: 'LAPTOP1 joins Corp as alice', check: { type: 'wirelessClient', device: 'LAPTOP1', ssid: 'Corp', network: '192.168.20.0', prefix: 24 }, hint: 'If it is rejected, `show radius summary` on WLC1 and `aaa log` on SRV tell you whether RADIUS answered.' },
      { text: 'LAPTOP2 joins Guest', check: { type: 'wirelessClient', device: 'LAPTOP2', ssid: 'Guest', network: '192.168.30.0', prefix: 24 } },
      {
        text: 'WPA3-Personal',
        check: {
          type: 'quiz',
          question: 'What does SAE in WPA3-Personal fix compared to WPA2-PSK?',
          options: ['It removes the need for a passphrase', 'A captured handshake can no longer be cracked offline, and each session gets its own key', 'It sends the passphrase to a RADIUS server', 'It turns off encryption for guests'],
          answer: 1,
          explain: 'SAE (Simultaneous Authentication of Equals) proves both sides know the password without exposing anything an attacker can brute-force offline, and gives forward secrecy. Enterprise (802.1X) instead gives every user their own credentials.',
        },
      },
    ],
    solution: {
      WLC1: `config radius auth add 1 192.168.10.100 1812 ascii RadKey123
        config wlan create 2 Corp Corp
        config wlan interface 2 staff
        config wlan radius_server auth add 2 1
        config wlan enable 2
        config interface create guest 30
        config interface address dynamic-interface guest 192.168.30.5 255.255.255.0 192.168.30.1
        config wlan create 3 Guest Guest
        config wlan interface 3 guest
        config wlan security wpa wpa3 enable 3
        config wlan security wpa akm 802.1x disable 3
        config wlan security wpa akm sae enable 3
        config wlan security wpa akm psk set-key ascii GuestPass99 3
        config wlan enable 3`,
      LAPTOP1: 'netsh wlan connect ssid=Corp user=alice password=Wonder1',
      LAPTOP2: 'netsh wlan connect ssid=Guest key=GuestPass99',
    },
    debrief: 'With 802.1X the controller is only the authenticator: it relays EAP between the laptop and the RADIUS server, which decides. A wrong shared secret looks exactly like a dead server (`show radius summary` counts timeouts). Mapping each WLAN to its own interface is what puts guests and staff in different VLANs on the same AP.',
  },
  {
    id: 'wireless-troubleshoot',
    title: 'Connected, but no network',
    domain: '1.0',
    blueprint: ['1.5', '1.6', '2.1'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'Laptops associate to Staff but end up with 169.254 addresses. Two faults between the WLC and R1.',
    briefing: `Users say the Staff Wi-Fi "connects but has no internet". LAPTOP1 shows Staff as connected, yet \`ipconfig\` shows a 169.254.x.x address.

Association works, so the radio side is fine. Follow a client frame instead: the WLC bridges Staff traffic onto the VLAN of the WLAN's interface, over its trunk to SW1, to R1's VLAN 20 subinterface where DHCP lives.

Useful: \`show wlan 1\` and \`show interface summary\` on WLC1, \`show interfaces trunk\` on SW1. There are two faults. When both are fixed, run \`ipconfig /renew\` on LAPTOP1.`,
    addressing: ADDRESSING,
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: R1_BASE },
        { hostname: 'SW1', kind: 'switch', at: [250, 150], config: `${SW1_BASE}\ninterface g0/2\nswitchport trunk allowed vlan 10` },
        { hostname: 'WLC1', kind: 'wlc', at: [30, 150], config: `${WLC_MGMT}\n${STAFF_WLAN.replace('config interface create staff 20', 'config interface create staff 21')}` },
        { hostname: 'AP1', kind: 'ap', at: [250, 300] },
        { hostname: 'LAPTOP1', kind: 'pc', wireless: true, at: [420, 330], ip: 'dhcp', wifi: { ssid: 'Staff', key: 'CorpWiFi2024' } },
      ],
      links: BASE_LINKS,
    },
    objectives: [
      { text: 'Staff traffic is bridged onto VLAN 20', check: { type: 'wlan', device: 'WLC1', ssid: 'Staff', vlan: 20 }, hint: 'The staff interface has the right address but the wrong VLAN tag: `config interface vlan staff 20`.' },
      { text: 'SW1 carries VLAN 20 to WLC1', check: { type: 'trunk', device: 'SW1', interface: 'Gi0/2', allowed: [10, 20] }, hint: '`switchport trunk allowed vlan add 20` on Gi0/2.' },
      { text: 'LAPTOP1 has a VLAN 20 address', check: { type: 'wirelessClient', device: 'LAPTOP1', ssid: 'Staff', network: '192.168.20.0', prefix: 24 }, hint: '`ipconfig /renew` once the path works.' },
      { text: 'LAPTOP1 reaches R1', check: { type: 'ping', from: 'LAPTOP1', to: '192.168.20.1', expect: 'success' } },
    ],
    solution: {
      WLC1: 'config interface vlan staff 20',
      SW1: `enable
        conf t
        interface g0/2
        switchport trunk allowed vlan add 20
        end`,
      LAPTOP1: 'ipconfig /renew',
    },
    debrief: 'Wi-Fi problems are often wired problems. The controller tags each WLAN\'s client traffic with its interface VLAN, so that VLAN must match the router subinterface and be allowed on the trunk. A 169.254 address after a good association always points at DHCP, not at the radio.',
  },
  {
    id: 'wireless-channels',
    title: 'Plan the channels',
    domain: '1.0',
    blueprint: ['1.5'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'Three APs set by hand to overlapping 2.4 GHz channels and a shared 5 GHz channel. Fix the plan.',
    briefing: `Someone set the channels of AP1, AP2 and AP3 by hand, and users near the APs complain of slow Wi-Fi. \`show advanced 802.11b summary\` and \`show advanced 802.11a summary\` on WLC1 show the plan and flag interference.

In 2.4 GHz only **1, 6 and 11** do not overlap (channels are 5 MHz apart but 20 MHz wide). In 5 GHz there are many channels; neighbours just need different ones.

Give the three APs non-overlapping 2.4 GHz channels and different 5 GHz channels, with \`config 802.11b channel ap <ap> <channel>\` and \`config 802.11a channel ap <ap> <channel>\`. (Setting \`global\` instead hands the AP back to DCA, which picks for you.)`,
    addressing: ADDRESSING.slice(0, 3),
    topology: {
      devices: [
        ...base([
          { hostname: 'AP2', kind: 'ap', at: [400, 300] },
          { hostname: 'AP3', kind: 'ap', at: [100, 300] },
        ]).map((d) =>
          d.hostname === 'WLC1'
            ? { ...d, config: `${WLC_MGMT}\nconfig 802.11b channel ap AP1 1\nconfig 802.11b channel ap AP2 1\nconfig 802.11b channel ap AP3 4\nconfig 802.11a channel ap AP1 36\nconfig 802.11a channel ap AP2 36\nconfig 802.11a channel ap AP3 40` }
            : d,
        ),
      ],
      links: [...BASE_LINKS, ['AP2 Gi0', 'SW1 Gi0/4'], ['AP3 Gi0', 'SW1 Gi0/5']],
    },
    objectives: [
      { text: 'All three APs have joined', check: { type: 'apJoined', device: 'AP3', controller: 'WLC1' } },
      { text: 'No overlapping 2.4 GHz channels', check: { type: 'apChannels', device: 'WLC1', band: '2.4' }, hint: 'Use 1, 6 and 11.' },
      { text: 'Different 5 GHz channels', check: { type: 'apChannels', device: 'WLC1', band: '5' }, hint: 'For example 36, 40 and 44.' },
      {
        text: 'Why 1, 6 and 11',
        check: {
          type: 'quiz',
          question: 'AP2 on channel 3 and AP1 on channel 1: what kind of interference is that?',
          options: ['None, they are different channels', 'Co-channel interference: they share airtime politely', 'Adjacent (overlapping) channel interference: each one\'s signal is noise to the other', 'It only matters in 5 GHz'],
          answer: 2,
          explain: 'Overlapping channels cannot decode each other, so they cannot take turns; they just raise each other\'s noise floor. Co-channel APs at least share the medium with CSMA/CA. That is why the 2.4 GHz plan is always 1, 6 and 11.',
        },
      },
    ],
    solution: {
      WLC1: `config 802.11b channel ap AP2 6
        config 802.11b channel ap AP3 11
        config 802.11a channel ap AP2 44`,
    },
    debrief: 'RRM\'s Dynamic Channel Assignment (DCA) does this automatically on a real controller, and static channels override it. Plan 2.4 GHz with 1, 6 and 11 only, and keep neighbouring 5 GHz radios apart too.',
  },
];
