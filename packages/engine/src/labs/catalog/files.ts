import type { LabDefinition } from '../types';

/** A router and a switch on one LAN with a Linux file server (TFTP always on; FTP and SCP/SFTP need an account). */
const SERVER_SETUP = 'adduser backup Cisco123';

/** Domain 4.0 blueprint 4.2: moving configuration files with TFTP, FTP, SCP and SFTP. */
export const fileLabs: LabDefinition[] = [
  {
    id: 'config-backup',
    title: 'Back up the configurations',
    domain: '4.0',
    blueprint: ['4.2'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Save the configs to NVRAM, then copy them to a server: R1 over TFTP, SW1 over SCP.',
    briefing: `Nothing on this network has been saved or backed up. Fix that before something reboots:

- Save the running configuration of **R1** and **SW1** to their startup configs (\`copy running-config startup-config\`)
- Back up R1's configuration to the server **192.168.1.100** over **TFTP**, as \`r1-confg\` (the default name it suggests)
- Back up SW1's configuration over **SCP**, as \`sw1-confg\`: SCP runs over SSH, so it needs an account. The server has user **backup** with password **Cisco123**.

\`copy\` asks for the server, the user name and the file name; press Enter to take the default in brackets. Check the result with \`ls\` and \`cat /var/log/xferlog\` on the server, and open a capture on a cable to compare a TFTP transfer with an SCP one.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SW1', interface: 'VLAN 1', address: '192.168.1.2/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'TFTP, FTP, SCP, SFTP' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [250, 0], config: 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut' },
        { hostname: 'SW1', kind: 'switch', at: [250, 150], config: 'conf t\nint vlan 1\nip address 192.168.1.2 255.255.255.0\nno shut' },
        { hostname: 'SRV', kind: 'server', at: [450, 300], ip: '192.168.1.100/24', gateway: '192.168.1.1', config: SERVER_SETUP },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/8'],
        ['SRV Eth0', 'SW1 Gi0/2'],
      ],
    },
    objectives: [
      {
        text: "R1's configuration is saved",
        check: { type: 'startupConfig', device: 'R1', contains: 'hostname R1' },
        hint: '`copy running-config startup-config` (or `write memory`) from privileged EXEC.',
      },
      { text: "SW1's configuration is saved", check: { type: 'startupConfig', device: 'SW1', contains: 'hostname SW1' } },
      {
        text: 'R1 is backed up to the server over TFTP',
        check: { type: 'fileOnServer', device: 'SRV', file: 'r1-confg', contains: 'hostname R1', via: 'tftp' },
        hint: '`copy running-config tftp:`, then 192.168.1.100 and Enter for the file name.',
      },
      {
        text: 'SW1 is backed up to the server over SCP',
        check: { type: 'fileOnServer', device: 'SRV', file: 'sw1-confg', contains: 'hostname SW1', via: 'scp' },
        hint: '`copy running-config scp:`, then 192.168.1.100, user backup, Enter for the file name, and the password Cisco123.',
      },
      {
        text: 'TFTP',
        check: {
          type: 'quiz',
          question: 'Why is SCP a better choice than TFTP for configuration backups?',
          options: [
            'TFTP cannot copy text files',
            'TFTP (UDP 69) has no login and no encryption; SCP authenticates the user and encrypts the file inside SSH',
            'SCP is faster because it uses UDP',
            'TFTP only works between Cisco devices',
          ],
          answer: 1,
          explain: 'TFTP is simple and handy for lab work and booting, but anyone who can reach the server can read or overwrite files, and the configuration (with its passwords) crosses the network in clear text.',
        },
      },
      {
        text: 'Ports',
        check: {
          type: 'quiz',
          question: 'Which transport and port does each protocol use?',
          options: ['TFTP TCP 69, FTP UDP 21, SCP TCP 22', 'TFTP UDP 69, FTP TCP 21, SCP and SFTP TCP 22', 'All of them use TCP 21', 'TFTP UDP 69, FTP TCP 20 only, SCP TCP 443'],
          answer: 1,
          explain: 'TFTP is UDP 69. FTP uses TCP 21 for its control connection (and 20 or a passive port for data). SCP and SFTP both run inside SSH on TCP 22.',
        },
      },
    ],
    solution: {
      R1: `enable
        copy running-config startup-config

        copy running-config tftp:
        192.168.1.100
        r1-confg`,
      SW1: `enable
        copy running-config startup-config

        copy running-config scp:
        192.168.1.100
        backup

        Cisco123`,
    },
    debrief: '`copy <source> <destination>` moves files between the running config, NVRAM (startup-config), flash and servers. TFTP needs no account and is fine in a lab; FTP adds a login but sends it in clear text (configure it with `ip ftp username` and `ip ftp password`); SCP and SFTP add encryption by running inside SSH. Remember that copying a file into running-config merges it with what is there instead of replacing it.',
  },
  {
    id: 'ftp-restore',
    title: 'Restore the branch router from its FTP backup',
    domain: '4.0',
    blueprint: ['4.2', '5.6'],
    kind: 'troubleshoot',
    difficulty: 2,
    summary: 'The branch router lost its configuration and the FTP restore fails with a login error.',
    briefing: `The branch router R2 was replaced, and only its LAN address and FTP client settings were typed in. Its full configuration is on the server **192.168.1.100** as \`branch-confg\`. Restore it with \`copy ftp: running-config\`, then save it so it survives a reload.

The copy fails at the moment. The FTP account on the server is user **backup**, password **Cisco123**. Find out why R2 cannot log in (\`show running-config | include ftp\` is a good start) and fix it, keeping the FTP client settings in R2's configuration rather than typing them into a URL.

When the restore works, R2 is named **BRANCH**, has a Loopback0 address and a default route.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'Gateway' },
      { device: 'R2', interface: 'Gi0/0', address: '192.168.1.20/24' },
      { device: 'R2', interface: 'Loopback0', address: '10.255.0.2/32', note: 'From the backup' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'FTP' },
    ],
    topology: {
      devices: [
        { hostname: 'R1', kind: 'router', at: [100, 0], config: 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut' },
        { hostname: 'SW1', kind: 'switch', at: [250, 150] },
        { hostname: 'R2', kind: 'router', at: [400, 0], config: 'conf t\nint g0/0\nip address 192.168.1.20 255.255.255.0\nno shut\nexit\nip ftp username backup\nip ftp password cisco123' },
        {
          hostname: 'SRV',
          kind: 'server',
          at: [450, 300],
          ip: '192.168.1.100/24',
          gateway: '192.168.1.1',
          config: SERVER_SETUP,
          files: {
            'branch-confg': `
!
hostname BRANCH
!
interface Loopback0
 description Router ID and management
 ip address 10.255.0.2 255.255.255.255
!
interface GigabitEthernet0/0
 description LAN to SW1
 ip address 192.168.1.20 255.255.255.0
!
ip route 0.0.0.0 0.0.0.0 192.168.1.1
!
end
`,
          },
        },
      ],
      links: [
        ['R1 Gi0/0', 'SW1 Gi0/1'],
        ['R2 Gi0/0', 'SW1 Gi0/2'],
        ['SRV Eth0', 'SW1 Gi0/3'],
      ],
    },
    objectives: [
      {
        text: 'R2 is restored: hostname BRANCH',
        check: { type: 'hostname', device: 'R2', name: 'BRANCH' },
        hint: 'The copy reports `Incorrect Login/Password`. Compare `ip ftp password` with the account on the server.',
      },
      { text: 'Loopback0 is restored', check: { type: 'interfaceIp', device: 'R2', interface: 'Loopback0', address: '10.255.0.2', prefix: 32 } },
      { text: 'The default route is restored', check: { type: 'route', device: 'R2', network: '0.0.0.0', prefix: 0, code: 'S', nextHop: '192.168.1.1' } },
      {
        text: 'The restored configuration is saved',
        check: { type: 'startupConfig', device: 'R2', contains: 'hostname BRANCH' },
        hint: '`copy running-config startup-config` after the restore.',
      },
      {
        text: 'FTP security',
        check: {
          type: 'quiz',
          question: 'You open a capture on R2\'s cable during the copy. What can you read?',
          options: [
            'Nothing: FTP encrypts the session',
            'The user name, the password and the file, all in clear text',
            'Only the file name',
            'Only that a TCP connection to port 22 was made',
          ],
          answer: 1,
          explain: 'FTP sends USER, PASS and the data unencrypted. Use SCP or SFTP (inside SSH) when the network between the device and the server is not trusted.',
        },
      },
    ],
    solution: {
      R2: `enable
        conf t
        ip ftp password Cisco123
        end
        copy ftp: running-config
        192.168.1.100
        branch-confg

        write memory`,
    },
    debrief: 'IOS takes the FTP login from the URL (`ftp://user:password@host/file`) or from `ip ftp username` and `ip ftp password`; without either it tries anonymous. A copy into running-config merges line by line, so the restored file adds to what is there: on a real router you would also check that interfaces in the file are not left shut down.',
  },
];
