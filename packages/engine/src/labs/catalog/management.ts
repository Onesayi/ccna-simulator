import type { LabDefinition, LabDeviceSpec } from '../types';

/** R1 and R2 on SW1 in 192.168.1.0/24, with a Linux server SRV and an ADMIN PC. */
const R1_IP = `conf t
  interface g0/0
  ip address 192.168.1.1 255.255.255.0
  no shutdown`;

const SSH = `ip domain-name ccna.lab
  crypto key generate rsa modulus 2048
  line vty 0 4
  login local
  transport input ssh
  exit`;

function office(extra: LabDeviceSpec[], r1: string, srv: string = ''): LabDeviceSpec[] {
  return [
    { hostname: 'R1', kind: 'router', at: [250, 0], config: r1 },
    { hostname: 'SW1', kind: 'switch', at: [250, 150] },
    { hostname: 'SRV', kind: 'server', at: [450, 280], ip: '192.168.1.100/24', gateway: '192.168.1.1', ...(srv ? { config: srv } : {}) },
    ...extra,
  ];
}

const OFFICE_LINKS: [string, string][] = [
  ['R1 Gi0/0', 'SW1 Gi0/1'],
  ['SRV Eth0', 'SW1 Gi0/2'],
];

const ADMIN: LabDeviceSpec = { hostname: 'ADMIN', kind: 'pc', at: [50, 280], ip: '192.168.1.10/24', gateway: '192.168.1.1' };

const PLAYBOOK = `---
- name: Standard router settings
  hosts: routers
  gather_facts: false
  tasks:
    - name: Loopback for management
      ios_config:
        lines:
          - ip address {{ loopback }} 255.255.255.255
        parents: interface Loopback0
    - name: Describe the LAN port
      ios_config:
        lines:
          - description Managed by Ansible
        parents: interface GigabitEthernet0/0
    - name: Check the result
      ios_command:
        commands: show ip interface brief
      register: brief
    - debug:
        var: brief.stdout_lines
`;

const INVENTORY = (connection: string) => `[routers]
R1 ansible_host=192.168.1.1 loopback=1.1.1.1
R2 ansible_host=192.168.1.2 loopback=2.2.2.2

[routers:vars]
ansible_user=admin
ansible_password=Cisco123
ansible_connection=${connection}
ansible_network_os=cisco.ios.ios
`;

export const managementLabs: LabDefinition[] = [
  {
    id: 'aaa-tacacs',
    title: 'Central logins with TACACS+',
    domain: '4.0',
    blueprint: ['4.1'],
    kind: 'guided',
    difficulty: 2,
    summary: 'aaa new-model, a TACACS+ server, method lists with a local fallback, exec authorization and accounting.',
    briefing: `Every admin has their own account on the TACACS+ server **SRV** (192.168.1.100), like Cisco ISE. R1 should check logins there, keep its local **backup** user for when the server is down, and let the server decide each user's privilege level.

On R1:

- \`aaa new-model\`
- A TACACS+ server named **ISE** at 192.168.1.100 with key **TacKey1** (\`tacacs server ISE\`, then \`address ipv4\` and \`key\`)
- Login authentication, default list: the TACACS+ group first, then the local database
- EXEC authorization, default list: the same order
- EXEC accounting, start-stop, to the TACACS+ group

SRV already has R1 as a client and the users **alice** (privilege 15, password **Wonder1**) and **bob** (privilege 1, **Builder1**). Then SSH in from ADMIN as alice: you should land straight in privileged EXEC. \`aaa log\` on SRV shows every request.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'TACACS+' },
      { device: 'ADMIN', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1' },
    ],
    topology: {
      devices: office([ADMIN], `${R1_IP}\nusername backup privilege 15 secret Backup1\n${SSH}`, 'aaa client add 192.168.1.1 TacKey1\naaa user add alice Wonder1 privilege 15\naaa user add bob Builder1'),
      links: [...OFFICE_LINKS, ['ADMIN Eth0', 'SW1 Gi0/3']],
    },
    objectives: [
      { text: 'R1 knows the TACACS+ server and its key', check: { type: 'aaaServer', device: 'R1', protocol: 'tacacs+', address: '192.168.1.100' }, hint: '`tacacs server ISE`, `address ipv4 192.168.1.100`, `key TacKey1`.' },
      { text: 'Logins try TACACS+ first, then local users', check: { type: 'aaaMethods', device: 'R1', list: 'login', methods: 'group tacacs+ local' }, hint: '`aaa authentication login default group tacacs+ local`.' },
      { text: 'The server sets the privilege level', check: { type: 'aaaMethods', device: 'R1', list: 'exec', methods: 'group tacacs+ local' }, hint: '`aaa authorization exec default group tacacs+ local`. Without it, every AAA login starts at level 1.' },
      { text: 'alice logs in at privilege 15', check: { type: 'aaaLogin', device: 'R1', username: 'alice', password: 'Wonder1', expect: 'success', privilege: 15 } },
      { text: 'bob logs in at privilege 1', check: { type: 'aaaLogin', device: 'R1', username: 'bob', password: 'Builder1', expect: 'success', privilege: 1 } },
      { text: 'ADMIN reaches R1 over SSH as alice', check: { type: 'remoteLogin', from: 'ADMIN', to: '192.168.1.1', protocol: 'ssh', username: 'alice', password: 'Wonder1', expect: 'success' } },
      {
        text: 'When local is used',
        check: {
          type: 'quiz',
          question: 'SRV is up and answers. Can the local user backup still log in?',
          options: ['Yes, local is always tried after the server', 'No: the server answered "fail" for an unknown user, and a fail ends the list. Local is only tried when the server does not answer', 'Only on the console', 'Only with telnet'],
          answer: 1,
          explain: 'A method list moves on only on an error (no answer). A reject is final. That is what makes the local account a true emergency fallback, usable only while the server is unreachable.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        aaa new-model
        tacacs server ISE
        address ipv4 192.168.1.100
        key TacKey1
        exit
        aaa authentication login default group tacacs+ local
        aaa authorization exec default group tacacs+ local
        aaa accounting exec default start-stop group tacacs+
        end`,
    },
    debrief: 'TACACS+ (TCP 49) separates authentication, authorization and accounting and encrypts the whole body, which is why it is the usual choice for device administration; RADIUS (UDP 1812/1813) combines authentication and authorization and hides only the password, and is the usual choice for network access (802.1X, VPN). Open the capture on the SRV cable to compare.',
  },
  {
    id: 'aaa-radius-troubleshoot',
    title: 'RADIUS logins that never work',
    domain: '4.0',
    blueprint: ['4.1'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'A wrong shared secret and a VTY line pointing at a list that does not exist.',
    briefing: `R1 was set up to check VTY logins against RADIUS on **SRV** (192.168.1.100), and nobody can log in. The account **netops** (password **NetOps1**) exists on the server.

Two faults. Tools that help on R1: \`show aaa servers\` (look at the timeouts), \`test aaa group radius netops NetOps1 legacy\`, \`show aaa method-lists all\` and \`show running-config\`. On SRV, \`aaa log\` and \`aaa show\` show what the server sees and expects.

The server's shared secret for R1 is **RadKey1**.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'RADIUS' },
    ],
    topology: {
      devices: office(
        [],
        `${R1_IP}
          aaa new-model
          radius server RAD1
          address ipv4 192.168.1.100 auth-port 1812 acct-port 1813
          key RadKey!
          exit
          aaa authentication login VTY_AUTH group radius local
          ${SSH}
          line vty 0 4
          login authentication VTY-AUTH`,
        'aaa client add 192.168.1.1 RadKey1\naaa user add netops NetOps1 privilege 15',
      ),
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'The VTY lines use the list that exists', check: { type: 'aaaMethods', device: 'R1', list: 'login', name: 'VTY_AUTH', methods: 'group radius local' } },
      { text: 'netops logs in through RADIUS', check: { type: 'aaaLogin', device: 'R1', username: 'netops', password: 'NetOps1', expect: 'success' }, hint: 'The lines reference VTY-AUTH (hyphen), the list is VTY_AUTH (underscore). And a key mismatch looks like a dead server: compare the key with `aaa show` on SRV.' },
      { text: 'A wrong password is refused', check: { type: 'aaaLogin', device: 'R1', username: 'netops', password: 'guess', expect: 'fail' } },
      {
        text: 'Wrong key',
        check: {
          type: 'quiz',
          question: 'Why did `show aaa servers` count timeouts rather than rejects?',
          options: ['The server was down', 'A RADIUS server silently drops requests it cannot authenticate with the shared secret', 'UDP 1812 was blocked', 'RADIUS never sends rejects'],
          answer: 1,
          explain: 'With the wrong secret the server cannot verify the request, so it drops it; the client sees no answer and moves to the next server or method. That is also why a key mismatch can quietly fall back to local accounts.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        radius server RAD1
        key RadKey1
        exit
        line vty 0 4
        login authentication VTY_AUTH
        end`,
    },
    debrief: 'Two classic AAA faults: a list name that does not exist on the line (IOS accepts it without complaint, and logins fail), and a shared secret mismatch that looks exactly like an unreachable server. `test aaa` checks the server on its own, without touching the lines.',
  },
  {
    id: 'snmp-v2c-traps',
    title: 'Monitor a router with SNMP',
    domain: '5.0',
    blueprint: ['5.4'],
    kind: 'guided',
    difficulty: 2,
    summary: 'A read-only community limited by an ACL, polling with snmpwalk, and linkDown traps to the NMS.',
    briefing: `The monitoring server **SRV** (192.168.1.100) should poll R1 and hear about link failures.

On R1:

- A standard ACL **10** that permits only the NMS, 192.168.1.100
- A read-only community **NetView** limited by ACL 10: \`snmp-server community NetView RO 10\`
- Location **HQ rack 3**, contact **noc@ccna.lab**
- Traps to 192.168.1.100 with version 2c and community NetView, and \`snmp-server enable traps\`

From SRV, poll it: \`snmpget -v 2c -c NetView 192.168.1.1 sysName.0 sysLocation.0\` and \`snmpwalk -v 2c -c NetView 192.168.1.1 ifDescr\`.

Finally make a trap happen: shut and re-enable R1's G0/1 (towards R2) and read \`cat /var/log/snmptrapd.log\` on SRV.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'R1', interface: 'Gi0/1', address: '10.0.12.1/30', note: 'To R2' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'NMS' },
    ],
    topology: {
      devices: office(
        [{ hostname: 'R2', kind: 'router', at: [500, 0], config: 'conf t\ninterface g0/0\nip address 10.0.12.2 255.255.255.252\nno shutdown' }],
        `${R1_IP}\ninterface g0/1\nip address 10.0.12.1 255.255.255.252\nno shutdown`,
      ),
      links: [...OFFICE_LINKS, ['R1 Gi0/1', 'R2 Gi0/0']],
    },
    objectives: [
      { text: 'A read-only community NetView, limited by ACL 10', check: { type: 'snmpCommunity', device: 'R1', community: 'NetView', access: 'ro', acl: '10' } },
      { text: 'SRV can poll R1', check: { type: 'snmpQuery', from: 'SRV', to: '192.168.1.1', community: 'NetView', expect: 'answer' }, hint: 'Does ACL 10 permit 192.168.1.100?' },
      { text: 'Traps go to SRV with v2c', check: { type: 'snmpHost', device: 'R1', address: '192.168.1.100', version: '2c' }, hint: '`snmp-server host 192.168.1.100 version 2c NetView` and `snmp-server enable traps`.' },
      { text: 'SRV received a linkDown trap from R1', check: { type: 'trapReceived', device: 'SRV', from: 'R1', trap: 'linkDown' }, hint: '`interface g0/1`, `shutdown`, `no shutdown`.' },
      {
        text: 'Ports and direction',
        check: {
          type: 'quiz',
          question: 'Which is right?',
          options: ['The NMS polls UDP 161 on the agent; the agent sends traps to UDP 162 on the NMS', 'Both use TCP 161', 'The agent polls the NMS on UDP 162', 'Traps need the NMS to ask first'],
          answer: 0,
          explain: 'Gets, get-nexts and sets go to the agent on UDP 161. Traps (and informs) are unsolicited and go to the manager on UDP 162. SNMPv2c sends the community in clear text, as the capture shows.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        access-list 10 permit host 192.168.1.100
        snmp-server community NetView RO 10
        snmp-server location HQ rack 3
        snmp-server contact noc@ccna.lab
        snmp-server host 192.168.1.100 version 2c NetView
        snmp-server enable traps
        interface g0/1
        shutdown
        no shutdown
        end`,
      SRV: 'snmpwalk -v 2c -c NetView 192.168.1.1 ifDescr',
    },
    debrief: 'Polling answers "what is the value now"; traps answer "tell me when it changes". A read-only community behind an ACL is the minimum for v2c, because the community travels in clear text. The next lab replaces it with SNMPv3.',
  },
  {
    id: 'snmpv3-secure',
    title: 'Replace SNMPv2c with SNMPv3',
    domain: '5.0',
    blueprint: ['5.4', '4.1'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'Remove the public and private communities and add an authPriv SNMPv3 user.',
    briefing: `An audit found R1 answering SNMP with the default communities **public** (RO) and **private** (RW). Anyone on the LAN can read, and even change, the configuration. Confirm it from SRV: \`snmpset -v 2c -c private 192.168.1.1 sysName.0 s HACKED\` would work.

Fix it:

- Remove both communities
- Create the v3 group **ADMINS** with security level **priv** (authentication and encryption)
- Create user **nms** in ADMINS with SHA authentication password **AuthPass1** and AES 128 privacy password **PrivPass1**

Then poll from SRV: \`snmpget -v 3 -l authPriv -u nms -a SHA -A AuthPass1 -x AES -X PrivPass1 192.168.1.1 sysName.0\`.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'NMS' },
    ],
    topology: {
      devices: office([], `${R1_IP}\nsnmp-server community public RO\nsnmp-server community private RW`),
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'public no longer answers', check: { type: 'snmpQuery', from: 'SRV', to: '192.168.1.1', community: 'public', expect: 'timeout' } },
      { text: 'private no longer answers', check: { type: 'snmpQuery', from: 'SRV', to: '192.168.1.1', community: 'private', expect: 'timeout' } },
      { text: 'nms is an authPriv SNMPv3 user', check: { type: 'snmpUser', device: 'R1', user: 'nms', level: 'priv' }, hint: '`snmp-server group ADMINS v3 priv`, then `snmp-server user nms ADMINS v3 auth sha AuthPass1 priv aes 128 PrivPass1`.' },
      {
        text: 'Security levels',
        check: {
          type: 'quiz',
          question: 'What does the SNMPv3 level authPriv give that authNoPriv does not?',
          options: ['Message authentication', 'Encryption of the PDU, so the values cannot be read on the wire', 'A community string', 'Traps'],
          answer: 1,
          explain: 'noAuthNoPriv: a user name only. authNoPriv: messages are authenticated (HMAC with MD5 or SHA). authPriv: authenticated and encrypted (DES or AES). Look at a v3 packet in the capture: the user name shows, the data does not.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        no snmp-server community public
        no snmp-server community private
        snmp-server group ADMINS v3 priv
        snmp-server user nms ADMINS v3 auth sha AuthPass1 priv aes 128 PrivPass1
        end`,
      SRV: 'snmpget -v 3 -l authPriv -u nms -a SHA -A AuthPass1 -x AES -X PrivPass1 192.168.1.1 sysName.0',
    },
    debrief: 'SNMPv3 replaces the shared community with users in groups, and the group sets the minimum security level. IOS hides v3 user passwords from the running-config (`show snmp user` lists them), so keep them in your password manager.',
  },
  {
    id: 'restconf-api',
    title: 'Read and change a router with RESTCONF',
    domain: '5.0',
    blueprint: ['5.3'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Turn on RESTCONF, then GET interfaces as YANG JSON and PATCH a description with curl.',
    briefing: `Instead of screen-scraping \`show\` output, automation tools read and write the device's YANG data over a REST API.

On R1:

- A local user **admin**, privilege **15**, secret **Cisco123** (RESTCONF needs privilege 15)
- \`ip http secure-server\` (RESTCONF runs over HTTPS) and \`ip http authentication local\`
- \`restconf\`

Then, from the automation server SRV, read the interfaces:

\`curl -k -u admin:Cisco123 https://192.168.1.1/restconf/data/ietf-interfaces:interfaces\`

and set G0/1's description with a PATCH (the slash in the interface name is URL-encoded as %2F):

\`curl -k -u admin:Cisco123 -X PATCH -d '{"ietf-interfaces:interface":{"description":"Uplink to ISP"}}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1\`

\`show running-config\` on R1 shows the change.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'Automation host' },
    ],
    topology: {
      devices: office([], R1_IP),
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'admin has privilege 15', check: { type: 'localUser', device: 'R1', username: 'admin', privilege: 15, secret: true } },
      { text: 'RESTCONF is enabled over HTTPS', check: { type: 'restconf', device: 'R1' }, hint: '`ip http secure-server`, then `restconf`.' },
      { text: 'G0/1 is described as Uplink to ISP', check: { type: 'description', device: 'R1', interface: 'Gi0/1', contains: 'Uplink to ISP' }, hint: 'The PATCH in the briefing. A 204 No Content is success (add -i to curl to see it).' },
      {
        text: 'HTTP verbs',
        check: {
          type: 'quiz',
          question: 'Which REST verb changes one leaf and leaves the rest of the interface as it is?',
          options: ['GET', 'PUT, which replaces the whole resource', 'PATCH, which merges the body into the resource', 'DELETE'],
          answer: 2,
          explain: 'GET reads, POST creates, PUT replaces, PATCH merges and DELETE removes. RESTCONF maps them onto YANG data (here ietf-interfaces), encoded as JSON or XML.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        username admin privilege 15 secret Cisco123
        ip http secure-server
        ip http authentication local
        restconf
        end`,
      SRV: `curl -k -u admin:Cisco123 https://192.168.1.1/restconf/data/ietf-interfaces:interfaces
        curl -k -u admin:Cisco123 -X PATCH -d '{"ietf-interfaces:interface":{"description":"Uplink to ISP"}}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F1`,
    },
    debrief: 'RESTCONF exposes the same YANG models as NETCONF over plain HTTPS, with JSON a script can parse directly. Controller-based networking (Catalyst Center, SD-WAN Manager) speaks to devices the same way and offers its own northbound REST API to your scripts.',
  },
  {
    id: 'ansible-playbook',
    title: 'Configure two routers with Ansible',
    domain: '5.0',
    blueprint: ['5.5', '5.3'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'An inventory with the wrong connection type and a router without SSH stop a playbook. Fix them and run it.',
    briefing: `SRV is the Ansible control node. Its Files tab (or \`ls\` and \`cat\`) holds an inventory, **hosts**, and a playbook, **site.yml**, that gives each router a Loopback0 address from its \`loopback\` host variable and a description on G0/0.

Run it: \`ansible-playbook -i hosts site.yml\`. It fails. Ansible is agentless and talks to IOS over SSH with the \`network_cli\` connection plugin, so look at:

- the connection type in the inventory: rewrite **hosts** with \`ansible_connection=ansible.netcommon.network_cli\` (edit it in the Files tab, or retype it with \`cat > hosts <<EOF\` ... \`EOF\`)
- whether each router accepts SSH

Then run the playbook until the recap shows no failures, and run it a second time: \`changed=0\` proves it is idempotent.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'Loopback0 1.1.1.1/32' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.1.2/24', note: 'Loopback0 2.2.2.2/32' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'Ansible control node' },
    ],
    topology: {
      devices: [
        ...office(
          [
            {
              hostname: 'R2',
              kind: 'router',
              at: [500, 0],
              config: 'conf t\ninterface g0/0\nip address 192.168.1.2 255.255.255.0\nno shutdown\nusername admin privilege 15 secret Cisco123\nip domain-name ccna.lab\ncrypto key generate rsa modulus 2048\nline vty 0 4\nlogin local\ntransport input telnet',
            },
          ],
          `${R1_IP}\nusername admin privilege 15 secret Cisco123\n${SSH}`,
        ).map((d) => (d.hostname === 'SRV' ? { ...d, files: { hosts: INVENTORY('ssh'), 'site.yml': PLAYBOOK } } : d)),
      ],
      links: [...OFFICE_LINKS, ['R2 Gi0/0', 'SW1 Gi0/3']],
    },
    objectives: [
      { text: 'R1 Loopback0 is 1.1.1.1/32', check: { type: 'interfaceIp', device: 'R1', interface: 'Loopback0', prefix: 32, address: '1.1.1.1' } },
      { text: 'R2 Loopback0 is 2.2.2.2/32', check: { type: 'interfaceIp', device: 'R2', interface: 'Loopback0', prefix: 32, address: '2.2.2.2' }, hint: 'R2 only accepts telnet on its VTY lines: `transport input ssh`.' },
      { text: 'Both LAN ports say Managed by Ansible', check: { type: 'description', device: 'R2', interface: 'Gi0/0', contains: 'Managed by Ansible' } },
      {
        text: 'Idempotency',
        check: {
          type: 'quiz',
          question: 'You run the same playbook again straight away. What does the recap show?',
          options: ['changed=2 for each router: every line is pushed again', 'changed=0: ios_config compares with the running-config and only sends what is missing', 'failed=1: the loopback already exists', 'unreachable: the SSH session is still open'],
          answer: 1,
          explain: 'Idempotent tasks describe the desired state; running them twice gives the same result and reports no change. Ansible is also agentless (SSH, nothing installed on the router) and push-based, unlike Puppet or Chef agents that pull.',
        },
      },
    ],
    solution: {
      R2: `enable
        conf t
        line vty 0 4
        transport input ssh
        end`,
      SRV: `cat > hosts <<EOF
${INVENTORY('ansible.netcommon.network_cli')}EOF
ansible-playbook -i hosts site.yml`,
    },
    debrief: 'An inventory says what to manage and how to reach it; a playbook says what state it should be in. For IOS, Ansible needs `network_cli` (SSH and the CLI) and `ansible_network_os`, and the device needs nothing but SSH and a privileged account.',
  },
];
