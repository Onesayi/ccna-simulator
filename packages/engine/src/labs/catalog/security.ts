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

/** Domain 4.0: Layer 2 security, port security (blueprint 4.7.e). */
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
];
