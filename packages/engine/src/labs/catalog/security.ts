import type { LabDefinition } from '../types';

const OFFICE_ADDRESSING = [
  { device: 'PC1', interface: 'Eth0', address: '192.168.10.11/24', note: 'SW1 Gi0/1' },
  { device: 'PC2', interface: 'Eth0', address: '192.168.10.12/24', note: 'SW1 Gi0/2' },
  { device: 'SRV', interface: 'Eth0', address: '192.168.10.100/24', note: 'SW1 Gi0/8' },
];

const OFFICE_DEVICES = [
  { hostname: 'PC1', kind: 'pc' as const, at: [0, 200] as [number, number], ip: '192.168.10.11/24' },
  { hostname: 'PC2', kind: 'pc' as const, at: [250, 220] as [number, number], ip: '192.168.10.12/24' },
  { hostname: 'SRV', kind: 'pc' as const, at: [500, 200] as [number, number], ip: '192.168.10.100/24' },
];

const OFFICE_LINKS: [string, string][] = [
  ['PC1 Eth0', 'SW1 Gi0/1'],
  ['PC2 Eth0', 'SW1 Gi0/2'],
  ['SRV Eth0', 'SW1 Gi0/8'],
];

/** Domain 4.0: Layer 2 security (port security, DHCP snooping) and device access over SSH. */
export const securityLabs: LabDefinition[] = [
  {
    id: 'port-security',
    title: 'Lock down access ports with port security',
    domain: '4.0',
    blueprint: ['4.7', '4.7.e'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Sticky MAC learning, a maximum, and different violation modes on two access ports.',
    briefing: `Anyone can plug a laptop into SW1's access ports today. Limit each port to the devices that belong there.

- Gi0/1 serves a desk that may have a PC and an IP phone: allow **2** MAC addresses, and on a violation **restrict** (drop and log, but keep the port up)
- Gi0/2 serves a single PC: allow **1** MAC address, and **shut down** the port on a violation (the default)
- On both, learn the addresses with **sticky** learning so they are kept in the running config
- Both must be static access ports before port security will turn on

Then ping the server from each PC so the switch learns their addresses, and look at \`show port-security\` and \`show port-security address\`.`,
    addressing: OFFICE_ADDRESSING,
    topology: {
      devices: [{ hostname: 'SW1', kind: 'switch', at: [250, 0] }, ...OFFICE_DEVICES],
      links: OFFICE_LINKS,
    },
    objectives: [
      {
        text: 'Gi0/1: port security, maximum 2, restrict, sticky',
        check: { type: 'portSecurity', device: 'SW1', interface: 'Gi0/1', maximum: 2, violation: 'restrict', sticky: true },
        hint: '`switchport mode access`, `switchport port-security`, `switchport port-security maximum 2`, `switchport port-security violation restrict`, `switchport port-security mac-address sticky`.',
      },
      {
        text: 'Gi0/2: port security, maximum 1, shutdown, sticky',
        check: { type: 'portSecurity', device: 'SW1', interface: 'Gi0/2', maximum: 1, violation: 'shutdown', sticky: true },
      },
      { text: 'PC1 can reach the server', check: { type: 'ping', from: 'PC1', to: '192.168.10.100', expect: 'success' } },
      { text: 'PC2 can reach the server', check: { type: 'ping', from: 'PC2', to: '192.168.10.100', expect: 'success' } },
      { text: "Gi0/1 learned PC1's address as sticky", check: { type: 'secureMac', device: 'SW1', interface: 'Gi0/1', kind: 'sticky' }, hint: 'Ping from PC1, then check `show port-security address`.' },
      { text: "Gi0/2 learned PC2's address as sticky", check: { type: 'secureMac', device: 'SW1', interface: 'Gi0/2', kind: 'sticky' } },
      {
        text: 'Violation modes',
        check: {
          type: 'quiz',
          question: 'Which violation mode drops the offending frames and increments the violation counter, but keeps the port up?',
          options: ['protect', 'restrict', 'shutdown', 'err-disable'],
          answer: 1,
          explain: 'protect drops silently, restrict drops and logs (and counts), shutdown err-disables the port.',
        },
      },
      {
        text: 'Sticky learning',
        check: {
          type: 'quiz',
          question: 'Where does a sticky secure MAC address end up?',
          options: ['Only in the MAC address table', 'In the running config, as a `switchport port-security mac-address sticky` line', 'In the startup config automatically', 'In the ARP table'],
          answer: 1,
          explain: 'Sticky addresses are added to the running config. Save it with `copy running-config startup-config` to keep them after a reload.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface g0/1
        switchport mode access
        switchport port-security
        switchport port-security maximum 2
        switchport port-security violation restrict
        switchport port-security mac-address sticky
        interface g0/2
        switchport mode access
        switchport port-security
        switchport port-security mac-address sticky
        end`,
    },
    debrief: 'Port security counts source MAC addresses per port. Static addresses are typed in, dynamic ones are learned and forgotten when the port goes down, and sticky ones are learned and written to the running config. When the maximum is reached, a new address is a violation: protect, restrict or shutdown (err-disabled until `shutdown` and `no shutdown`).',
  },
  {
    id: 'port-security-errdisable',
    title: 'Recover a port shut by port security',
    domain: '4.0',
    blueprint: ['4.7.e', '2.4'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'A replaced PC trips a static secure address. Find the cause and bring the port back.',
    briefing: `PC1 is a new computer that replaced an old one on SW1 Gi0/1. The user says the network does not work. Try a ping from PC1 to the server and then look at SW1.

Keep port security on Gi0/1, but let PC1 in:
- Find out why the port shut down (\`show interfaces status\`, \`show port-security interface g0/1\`, \`show logging\`)
- Remove the old PC's address and use **sticky** learning instead, so the port learns whoever is plugged in first
- Bring the port back into service`,
    addressing: OFFICE_ADDRESSING,
    topology: {
      devices: [
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [250, 0],
          config: `conf t
            interface g0/1
            switchport mode access
            switchport port-security
            switchport port-security mac-address 0050.7966.6801
            interface g0/2
            switchport mode access
            switchport port-security
            switchport port-security mac-address sticky`,
        },
        ...OFFICE_DEVICES,
      ],
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'Gi0/1 learns sticky addresses', check: { type: 'portSecurity', device: 'SW1', interface: 'Gi0/1', maximum: 1, sticky: true }, hint: '`no switchport port-security mac-address 0050.7966.6801`, then `switchport port-security mac-address sticky`.' },
      { text: 'Gi0/1 is not err-disabled', check: { type: 'errDisabled', device: 'SW1', interface: 'Gi0/1', expect: false }, hint: 'An err-disabled port needs `shutdown` and then `no shutdown`.' },
      { text: 'PC1 can reach the server', check: { type: 'ping', from: 'PC1', to: '192.168.10.100', expect: 'success' } },
      { text: "Gi0/1 now holds PC1's address", check: { type: 'secureMac', device: 'SW1', interface: 'Gi0/1', kind: 'sticky' } },
      {
        text: 'Diagnosis',
        check: {
          type: 'quiz',
          question: 'Which command shows the MAC address that caused the last port security violation?',
          options: ['show mac address-table', 'show port-security interface g0/1', 'show interfaces trunk', 'show ip interface brief'],
          answer: 1,
          explain: 'Look for "Last Source Address:Vlan" and "Security Violation Count".',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface g0/1
        no switchport port-security mac-address 0050.7966.6801
        switchport port-security mac-address sticky
        shutdown
        no shutdown
        end`,
    },
    debrief: 'A static secure address ties a port to one device, so replacing the hardware trips a violation. Sticky learning gives the same protection with less upkeep. In production, `errdisable recovery cause psecure-violation` can bring ports back automatically after a timer.',
  },
  {
    id: 'dhcp-snooping',
    title: 'Stop a rogue DHCP server with DHCP snooping',
    domain: '4.0',
    blueprint: ['4.7', '4.7.a'],
    kind: 'guided',
    difficulty: 2,
    summary: 'A rogue router hands out itself as the gateway. Trust only the real server port.',
    briefing: `Someone plugged a home router into SW1 Gi0/5, and it answers DHCP faster than R1. Both PCs got an address from it with **192.168.10.250** as their gateway, so their traffic now flows through a device nobody controls. Run \`ipconfig /all\` on a PC to see the DHCP server that answered.

Turn on DHCP snooping on SW1 for VLAN 10:
- Enable snooping globally and for VLAN 10
- Trust only Gi0/8, the port to R1 (the real DHCP server); every other port stays untrusted
- R1 is the server itself, not a relay, so stop SW1 from inserting **option 82** (IOS servers drop requests that carry option 82 without a relay address)

Then renew both PCs (\`ipconfig /renew\`) and check \`show ip dhcp snooping binding\`.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.10.1/24', note: 'Gateway and DHCP server' },
      { device: 'ROGUE', interface: 'Gi0/0', address: '192.168.10.250/24', note: 'Not ours' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/1' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/2' },
    ],
    topology: {
      devices: [
        {
          hostname: 'R1',
          kind: 'router',
          at: [250, 0],
          config: `conf t
            int g0/0
            ip address 192.168.10.1 255.255.255.0
            no shut
            exit
            ip dhcp excluded-address 192.168.10.1 192.168.10.10
            ip dhcp pool OFFICE
            network 192.168.10.0 255.255.255.0
            default-router 192.168.10.1
            dns-server 192.168.10.1`,
        },
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [250, 180],
          config: `conf t
            vlan 10
            name OFFICE
            exit
            interface range g0/1 - 8
            switchport mode access
            switchport access vlan 10`,
        },
        {
          hostname: 'ROGUE',
          kind: 'router',
          at: [520, 180],
          config: `conf t
            int g0/0
            ip address 192.168.10.250 255.255.255.0
            no shut
            exit
            ip dhcp excluded-address 192.168.10.250
            ip dhcp pool FREE-WIFI
            network 192.168.10.0 255.255.255.0
            default-router 192.168.10.250`,
        },
        { hostname: 'PC1', kind: 'pc', at: [100, 380], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [400, 380], ip: 'dhcp' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['ROGUE Gi0/0', 'SW1 Gi0/5'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
      ],
    },
    objectives: [
      { text: 'DHCP snooping runs on SW1 for VLAN 10', check: { type: 'dhcpSnooping', device: 'SW1', vlan: 10 }, hint: '`ip dhcp snooping` and `ip dhcp snooping vlan 10`. Both are needed.' },
      { text: 'Gi0/8 (to R1) is trusted', check: { type: 'dhcpSnoopingTrust', device: 'SW1', interface: 'Gi0/8', trusted: true }, hint: '`interface g0/8`, `ip dhcp snooping trust`.' },
      { text: 'Gi0/5 (the rogue) is untrusted', check: { type: 'dhcpSnoopingTrust', device: 'SW1', interface: 'Gi0/5', trusted: false } },
      { text: 'SW1 does not insert option 82', check: { type: 'dhcpSnooping', device: 'SW1', vlan: 10, option82: false }, hint: '`no ip dhcp snooping information option`.' },
      { text: 'PC1 has a lease from R1', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' }, hint: 'Renew it: `ipconfig /renew` on PC1.' },
      { text: 'PC2 has a lease from R1', check: { type: 'dhcpLease', device: 'PC2', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' } },
      { text: 'SW1 recorded a binding for PC1', check: { type: 'dhcpSnoopingBinding', device: 'SW1', client: 'PC1' } },
      {
        text: 'What snooping drops',
        check: {
          type: 'quiz',
          question: 'Which DHCP messages does a snooping switch drop when they arrive on an untrusted port?',
          options: ['DISCOVER and REQUEST', 'OFFER, ACK and NAK', 'Every DHCP message', 'Only messages from a different VLAN'],
          answer: 1,
          explain: 'Untrusted ports may only send client messages. Server messages (OFFER, ACK, NAK) are allowed only on trusted ports, which is what stops a rogue server.',
        },
      },
      {
        text: 'The binding table',
        check: {
          type: 'quiz',
          question: 'Which other Layer 2 security feature relies on the DHCP snooping binding table?',
          options: ['Port security', 'Dynamic ARP inspection', 'BPDU guard', 'Root guard'],
          answer: 1,
          explain: 'Dynamic ARP inspection checks every ARP message against the MAC-to-IP bindings that snooping learned, which stops ARP spoofing. IP Source Guard uses the same table.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        ip dhcp snooping
        ip dhcp snooping vlan 10
        no ip dhcp snooping information option
        interface g0/8
        ip dhcp snooping trust
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: 'DHCP snooping splits ports into trusted (towards real servers) and untrusted (everything else). Server messages are dropped on untrusted ports, client messages must use their own MAC, and every lease the switch sees is recorded in the binding table. By default the switch also adds option 82; that is fine with a relay in the path, but an IOS server on the same LAN drops those requests, so turn insertion off or make the server trust it.',
  },
  {
    id: 'dhcp-snooping-troubleshoot',
    title: 'Fix DHCP after snooping was turned on',
    domain: '4.0',
    blueprint: ['4.7.a', '1.7'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'Since DHCP snooping went in, every PC falls back to a 169.254 address.',
    briefing: `The DHCP server is R2, at the data centre, and R1 relays requests to it with \`ip helper-address\`. Yesterday someone enabled DHCP snooping on SW1, and since then PC1 and PC2 only get self-assigned 169.254.x.x addresses.

Keep DHCP snooping on, and get the PCs their addresses back:
- Look at \`show ip dhcp snooping\` on SW1: which port is trusted, and which port leads to the relay?
- Snooping adds **option 82** to requests. Find out what R1 does with a request that carries option 82 but no relay address, and fix it on R1 this time (leave option 82 insertion on)
- Renew both PCs with \`ipconfig /renew\``,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'Relay to 10.0.0.2' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.0.1/30' },
      { device: 'R2', interface: 'Gi0/0', address: '10.0.0.2/30', note: 'DHCP server' },
      { device: 'PC1', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/1' },
      { device: 'PC2', interface: 'Eth0', address: 'DHCP', note: 'SW1 Gi0/2' },
    ],
    topology: {
      devices: [
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [250, 200],
          config: `conf t
            ip dhcp snooping
            ip dhcp snooping vlan 1
            interface g0/7
            ip dhcp snooping trust`,
        },
        {
          hostname: 'R1',
          kind: 'router',
          at: [250, 20],
          config: `conf t
            int g0/0
            ip address 192.168.1.1 255.255.255.0
            ip helper-address 10.0.0.2
            no shut
            int g0/1
            ip address 10.0.0.1 255.255.255.252
            no shut`,
        },
        {
          hostname: 'R2',
          kind: 'router',
          at: [520, 20],
          config: `conf t
            int g0/0
            ip address 10.0.0.2 255.255.255.252
            no shut
            exit
            ip route 192.168.1.0 255.255.255.0 10.0.0.1
            ip dhcp excluded-address 192.168.1.1 192.168.1.49
            ip dhcp pool BRANCH
            network 192.168.1.0 255.255.255.0
            default-router 192.168.1.1`,
        },
        { hostname: 'PC1', kind: 'pc', at: [100, 380], ip: 'dhcp' },
        { hostname: 'PC2', kind: 'pc', at: [400, 380], ip: 'dhcp' },
      ],
      links: [
        ['PC1 Eth0', 'SW1 Gi0/1'],
        ['PC2 Eth0', 'SW1 Gi0/2'],
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['R1 Gi0/1', 'R2 Gi0/0'],
      ],
    },
    objectives: [
      { text: 'DHCP snooping still runs for VLAN 1', check: { type: 'dhcpSnooping', device: 'SW1', vlan: 1, option82: true } },
      { text: 'Gi0/8, the port to R1, is trusted', check: { type: 'dhcpSnoopingTrust', device: 'SW1', interface: 'Gi0/8', trusted: true }, hint: '`show cdp neighbors` on SW1 shows which port leads to R1.' },
      { text: 'Gi0/7 is no longer trusted', check: { type: 'dhcpSnoopingTrust', device: 'SW1', interface: 'Gi0/7', trusted: false }, hint: 'Nothing is plugged into Gi0/7, and a trusted port is an open door. `no ip dhcp snooping trust`.' },
      { text: 'PC1 has a lease', check: { type: 'dhcpLease', device: 'PC1', network: '192.168.1.0', prefix: 24, gateway: '192.168.1.1' }, hint: 'R1 drops requests with option 82 and no relay address. On R1 Gi0/0: `ip dhcp relay information trusted`. Then `ipconfig /renew`.' },
      { text: 'PC2 has a lease', check: { type: 'dhcpLease', device: 'PC2', network: '192.168.1.0', prefix: 24, gateway: '192.168.1.1' } },
      { text: 'SW1 recorded a binding for PC2', check: { type: 'dhcpSnoopingBinding', device: 'SW1', client: 'PC2' } },
      {
        text: 'Option 82',
        check: {
          type: 'quiz',
          question: 'Why did R1 drop the requests even after the right port was trusted?',
          options: [
            'The helper address was wrong',
            'They carried option 82 but a giaddr of 0.0.0.0, which an IOS relay or server treats as suspicious',
            'DHCP snooping blocks DISCOVER messages',
            'R2 had run out of addresses',
          ],
          answer: 1,
          explain: 'Option 82 is relay information, so a request that has it but no relay address (giaddr) looks forged. Fix it on the switch (`no ip dhcp snooping information option`) or tell the router to accept it (`ip dhcp relay information trusted` on the interface, or `ip dhcp relay information trust-all`).',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface g0/7
        no ip dhcp snooping trust
        interface g0/8
        ip dhcp snooping trust
        end`,
      R1: `enable
        conf t
        interface g0/0
        ip dhcp relay information trusted
        end`,
      PC1: 'ipconfig /renew',
      PC2: 'ipconfig /renew',
    },
    debrief: 'Two faults stacked: the trusted port did not lead to the server, so every OFFER was dropped; and once it did, R1 refused requests carrying option 82 without a relay address. Trust exactly the ports that lead towards DHCP servers (uplinks, often port-channels), and decide where option 82 is handled.',
  },
  {
    id: 'ssh-remote-access',
    title: 'Manage a switch over SSH only',
    domain: '4.0',
    blueprint: ['4.1'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Local users, an enable secret, RSA keys, SSH version 2, and VTY lines that refuse telnet.',
    briefing: `SW1 is managed from the ADMIN PC at 192.168.1.2, but today anyone can try telnet, which sends passwords in clear text. Lock it down:

- An enable secret of **Class123**
- A local user **admin** with privilege 15 and the secret **Cisco123**
- Domain name **ccna.lab** and an RSA key of **2048** bits (the key is named after hostname and domain, so both are needed)
- SSH version 2 only
- VTY lines 0 to 15: log in against the local users, and accept SSH only
- Encrypt any clear-text passwords in the configuration

Then log in from ADMIN with \`ssh -l admin 192.168.1.2\`. Try \`telnet 192.168.1.2\` too: it should be refused.`,
    addressing: [
      { device: 'SW1', interface: 'Vlan1', address: '192.168.1.2/24', note: 'Management' },
      { device: 'ADMIN', interface: 'Eth0', address: '192.168.1.10/24', note: 'SW1 Gi0/1' },
    ],
    topology: {
      devices: [
        {
          hostname: 'SW1',
          kind: 'switch',
          at: [250, 0],
          config: `conf t
            interface vlan 1
            ip address 192.168.1.2 255.255.255.0
            no shut
            line vty 0 15
            password cisco
            login`,
        },
        { hostname: 'ADMIN', kind: 'pc', at: [250, 200], ip: '192.168.1.10/24' },
      ],
      links: [['ADMIN Eth0', 'SW1 Gi0/1']],
    },
    objectives: [
      { text: 'SW1 has an enable secret', check: { type: 'enableSecret', device: 'SW1' }, hint: '`enable secret Class123`.' },
      { text: 'A local user admin with privilege 15 and a secret', check: { type: 'localUser', device: 'SW1', username: 'admin', privilege: 15, secret: true }, hint: '`username admin privilege 15 secret Cisco123`.' },
      { text: 'SSH version 2 runs with a 2048-bit key', check: { type: 'sshServer', device: 'SW1', version: 2, modulus: 2048 }, hint: '`ip domain-name ccna.lab`, `crypto key generate rsa modulus 2048`, then `ip ssh version 2`.' },
      { text: 'The VTY lines use local logins and SSH only', check: { type: 'vtyAccess', device: 'SW1', transport: ['ssh'], login: 'local' }, hint: '`line vty 0 15`, `login local`, `transport input ssh`.' },
      { text: 'Clear-text passwords are encrypted', check: { type: 'passwordEncryption', device: 'SW1' }, hint: '`service password-encryption`.' },
      { text: 'ADMIN logs in over SSH', check: { type: 'remoteLogin', from: 'ADMIN', to: '192.168.1.2', protocol: 'ssh', username: 'admin', password: 'Cisco123', expect: 'success' } },
      { text: 'Telnet is refused', check: { type: 'connect', from: 'ADMIN', to: '192.168.1.2', port: 23, expect: 'blocked' } },
      {
        text: 'Password types',
        check: {
          type: 'quiz',
          question: 'After `service password-encryption`, the VTY password shows as `password 7 0822455D0A16`. How safe is that?',
          options: ['Very: type 7 is a one-way hash', 'Not at all: type 7 is reversible and only stops shoulder-surfing', 'As safe as `enable secret`', 'It cannot be read back by anyone'],
          answer: 1,
          explain: 'Type 7 is a simple, published cipher; free tools reverse it. `secret` (type 5, or 8/9 on newer IOS) stores a one-way hash, which is why it is preferred for every password that supports it.',
        },
      },
      {
        text: 'Why login local',
        check: {
          type: 'quiz',
          question: 'Why does SSH need `login local` (or AAA) on the VTY lines?',
          options: ['SSH always authenticates a username, so a line password alone is not enough', 'It turns on the RSA keys', 'It allows telnet as a fallback', 'It sets the SSH version'],
          answer: 0,
          explain: 'SSH logs in a user, not a line. With `login local` the switch checks the username and secret against its `username` entries.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        enable secret Class123
        username admin privilege 15 secret Cisco123
        ip domain-name ccna.lab
        crypto key generate rsa modulus 2048
        ip ssh version 2
        line vty 0 15
        login local
        transport input ssh
        exit
        service password-encryption
        end`,
      ADMIN: `ssh -l admin 192.168.1.2
        Cisco123
        show ip ssh
        exit`,
    },
    debrief: 'SSH needs four things: a hostname other than the default, a domain name, RSA keys (768 bits or more for version 2), and VTY lines that authenticate users (`login local`). `transport input ssh` then closes telnet. Use `secret` rather than `password` everywhere you can; `service password-encryption` only hides what is left.',
  },
];
