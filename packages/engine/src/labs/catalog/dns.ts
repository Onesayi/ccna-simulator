import type { LabDefinition, LabDeviceSpec } from '../types';
import { OFFICE_LINKS, R1_IP, office } from './management';

/** DNS: zone records on a Linux BIND server, DHCP handing out the server, and name lookup on IOS. */

const SOA = `$TTL 3600
@     IN SOA ns1.ccna.lab. admin.ccna.lab. (
            2026111301 ; serial
            3600 600 86400 300 )
      IN NS  ns1
ns1   IN A   192.168.1.100
srv   IN A   192.168.1.100
`;

const REVERSE = (ptr: string) => `$TTL 3600
@     IN SOA ns1.ccna.lab. admin.ccna.lab. 2026111301 3600 600 86400 300
      IN NS  ns1.ccna.lab.
1     IN PTR r1.ccna.lab.
100   IN PTR ${ptr}
`;

const POOL = (dns: string) => `${R1_IP}
  exit
  ip dhcp excluded-address 192.168.1.1 192.168.1.199
  ip dhcp pool LAN
  network 192.168.1.0 255.255.255.0
  default-router 192.168.1.1${dns}
  end`;

const PC1: LabDeviceSpec = { hostname: 'PC1', kind: 'pc', at: [50, 280], ip: 'dhcp' };
const LINKS: [string, string][] = [...OFFICE_LINKS, ['PC1 Eth0', 'SW1 Gi0/3']];
const ADDRESSING = [
  { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'DHCP server for the LAN' },
  { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'DNS server (BIND), ns1.ccna.lab' },
  { device: 'PC1', interface: 'Eth0', address: 'DHCP (192.168.1.200 and up)' },
];

const RECORDS = `www   IN A     192.168.1.100
shop  IN CNAME www
mail  IN A     192.168.1.25
@     IN MX    10 mail`;

const FIXED_ZONE = `${SOA}${RECORDS}
`;

export const dnsLabs: LabDefinition[] = [
  {
    id: 'dns-records',
    title: 'Names for the office: DNS records',
    domain: '4.0',
    blueprint: ['4.4'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Add A, CNAME and MX records to a BIND zone, hand the server out by DHCP, and resolve names from a PC and a router.',
    briefing: `SRV runs BIND and is authoritative for **ccna.lab**. Its zone file **ccna.lab.zone** (see the Files tab, or \`cat ccna.lab.zone\`) so far names only the server itself. Nobody can use it yet: R1's DHCP pool does not tell clients about it.

On SRV, add four records to the zone (\`cat >> ccna.lab.zone <<EOF\`, then the lines, then \`EOF\`; or edit it in the Files tab):

- **www** A 192.168.1.100 (the web site runs on SRV)
- **shop** as an alias (CNAME) of www
- **mail** A 192.168.1.25
- An **MX** record for the domain itself (\`@\`) pointing at mail, preference 10

Check the file with \`named-checkzone ccna.lab ccna.lab.zone\`. Names written without a trailing dot get **ccna.lab** appended.

On R1, add \`dns-server 192.168.1.100\` and \`domain-name ccna.lab\` to the **LAN** pool. PC1 only learns them with its next lease: \`ipconfig /renew\`, then \`ipconfig /all\`, \`nslookup shop\` and \`ping www\`.

R1 resolves names too: \`ip domain name ccna.lab\` and \`ip name-server 192.168.1.100\`, then \`ping srv\` (R1 adds the domain name to a single word) and \`show hosts\`.`,
    addressing: ADDRESSING,
    topology: {
      devices: [...office([PC1], POOL('')).map((d) => (d.hostname === 'SRV' ? { ...d, files: { 'ccna.lab.zone': SOA, 'db.1.168.192.in-addr.arpa': REVERSE('srv.ccna.lab.') } } : d))],
      links: LINKS,
    },
    objectives: [
      { text: 'www.ccna.lab is 192.168.1.100', check: { type: 'dnsRecord', device: 'SRV', name: 'www.ccna.lab', rtype: 'A', value: '192.168.1.100' }, hint: '`www IN A 192.168.1.100` in ccna.lab.zone.' },
      { text: 'shop.ccna.lab is an alias of www', check: { type: 'dnsRecord', device: 'SRV', name: 'shop.ccna.lab', rtype: 'CNAME', value: 'www.ccna.lab' }, hint: '`shop IN CNAME www`. Without a trailing dot, www becomes www.ccna.lab.' },
      { text: 'Mail for ccna.lab goes to mail.ccna.lab', check: { type: 'dnsRecord', device: 'SRV', name: 'ccna.lab', rtype: 'MX', value: 'mail.ccna.lab' }, hint: '`@ IN MX 10 mail`: @ is the zone itself.' },
      { text: 'mail.ccna.lab is 192.168.1.25', check: { type: 'dnsRecord', device: 'SRV', name: 'mail.ccna.lab', rtype: 'A', value: '192.168.1.25' }, hint: 'An MX names a host, and that host needs its own A record.' },
      { text: 'PC1 learned its DNS server from DHCP', check: { type: 'nameServer', device: 'PC1', address: '192.168.1.100' }, hint: 'Add `dns-server 192.168.1.100` to the pool on R1, then `ipconfig /renew` on PC1.' },
      { text: 'PC1 resolves shop to 192.168.1.100', check: { type: 'dnsResolve', from: 'PC1', name: 'shop', expect: '192.168.1.100' }, hint: 'PC1 adds its DNS suffix to "shop" only if DHCP gave it one: `domain-name ccna.lab` in the pool.' },
      { text: 'R1 asks SRV for names', check: { type: 'nameServer', device: 'R1', address: '192.168.1.100' }, hint: '`ip name-server 192.168.1.100` in global configuration mode.' },
      { text: 'R1 resolves srv to 192.168.1.100', check: { type: 'dnsResolve', from: 'R1', name: 'srv', expect: '192.168.1.100' }, hint: 'R1 appends its `ip domain name` to a name without a dot.' },
      {
        text: 'Following an alias',
        check: {
          type: 'quiz',
          question: 'PC1 asks for shop.ccna.lab, which is a CNAME. What does the server send back?',
          options: ['Only the CNAME; PC1 must send a second query', 'The CNAME record and the A record of www.ccna.lab', 'A referral to the server for www', 'An error: aliases cannot be looked up by A query'],
          answer: 1,
          explain: 'A server that owns both names follows the alias itself and answers with the CNAME plus the A record of its target. `nslookup shop` shows the result as Name www.ccna.lab with Aliases shop.ccna.lab.',
        },
      },
    ],
    solution: {
      SRV: `cat >> ccna.lab.zone <<EOF
${RECORDS}
EOF
named-checkzone ccna.lab ccna.lab.zone`,
      R1: `enable
        conf t
        ip dhcp pool LAN
        dns-server 192.168.1.100
        domain-name ccna.lab
        exit
        ip domain name ccna.lab
        ip name-server 192.168.1.100
        end
        ping srv`,
      PC1: `ipconfig /renew
        nslookup shop
        ping www`,
    },
    debrief: 'A records map names to IPv4 addresses (AAAA for IPv6), a CNAME makes one name an alias of another, MX tells mail servers where a domain\'s mail goes, NS names the authoritative servers, and PTR records in in-addr.arpa answer reverse lookups. Hosts usually learn their DNS server from DHCP (option 6) along with a domain suffix (option 15). Open the capture on the PC1 cable to see each query and response on UDP 53.',
  },
  {
    id: 'dns-troubleshoot',
    title: 'Names that will not resolve',
    domain: '4.0',
    blueprint: ['4.4', '4.3'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'A wrong DHCP option and three zone file mistakes break web, mail and reverse lookups by name. Find all four.',
    briefing: `Everything answers a ping by address, but nothing works by name. The help desk has three tickets:

- PC1 cannot open **shop.ccna.lab** (the shop is an alias of www, 192.168.1.100).
- Other companies' mail for **@ccna.lab** bounces: their servers cannot find the mail exchanger's address (it should be **mail.ccna.lab**, 192.168.1.25).
- The server logs show client addresses, but a reverse lookup of **192.168.1.100** names the wrong host: it should be **srv.ccna.lab**.

Work from the client outwards: \`ipconfig /all\` and \`nslookup\` on PC1, the DHCP pool on R1, then the zone files on SRV (\`named-checkzone ccna.lab ccna.lab.zone\`, \`cat /var/log/named.log\`). Rewrite a zone with \`cat > ccna.lab.zone <<EOF\` ... \`EOF\`, or edit it in the Files tab.`,
    addressing: ADDRESSING,
    topology: {
      devices: [
        ...office([PC1], POOL(`\n  dns-server 192.168.1.1\n  domain-name ccna.lab`)).map((d) =>
          d.hostname === 'SRV'
            ? {
                ...d,
                files: {
                  'ccna.lab.zone': `${SOA}www   IN A     192.168.1.100\nshop  IN CNAME www.ccna.lab\nmial  IN A     192.168.1.25\n@     IN MX    10 mail\n`,
                  'db.1.168.192.in-addr.arpa': REVERSE('printer.ccna.lab.'),
                },
              }
            : d,
        ),
      ],
      links: LINKS,
    },
    objectives: [
      { text: 'PC1 uses SRV as its DNS server', check: { type: 'nameServer', device: 'PC1', address: '192.168.1.100' }, hint: '`ipconfig /all` on PC1 shows the DNS server DHCP handed out. R1 is not a DNS server: fix `dns-server` in the pool, then `ipconfig /renew`.' },
      { text: 'shop.ccna.lab resolves to 192.168.1.100', check: { type: 'dnsRecord', device: 'SRV', name: 'shop.ccna.lab', rtype: 'A', value: '192.168.1.100' }, hint: '`nslookup -type=cname shop` shows where the alias points. A name without a trailing dot gets the origin appended: www.ccna.lab becomes www.ccna.lab.ccna.lab.' },
      { text: 'The mail exchanger has an address', check: { type: 'dnsRecord', device: 'SRV', name: 'mail.ccna.lab', rtype: 'A', value: '192.168.1.25' }, hint: '`named-checkzone ccna.lab ccna.lab.zone` warns about the MX target. Compare the MX record with the A records.' },
      { text: '192.168.1.100 reverses to srv.ccna.lab', check: { type: 'dnsRecord', device: 'SRV', name: '100.1.168.192.in-addr.arpa', rtype: 'PTR', value: 'srv.ccna.lab' }, hint: 'Reverse lookups use PTR records in db.1.168.192.in-addr.arpa: `nslookup 192.168.1.100`.' },
      { text: 'PC1 resolves shop.ccna.lab', check: { type: 'dnsResolve', from: 'PC1', name: 'shop.ccna.lab', expect: '192.168.1.100' } },
      {
        text: 'Reading nslookup',
        check: {
          type: 'quiz',
          question: 'nslookup on a PC prints "DNS request timed out" for every name, while ping by address works. What is the most likely cause?',
          options: ['The name does not exist in the zone', 'The PC is asking a host that does not run a DNS server, or UDP 53 is blocked', 'The zone has no PTR records', 'The A record has a short TTL'],
          answer: 1,
          explain: 'A missing name comes back quickly as "Non-existent domain". Silence means the query got no answer at all: the wrong server address (often from DHCP), no DNS service there, or a filter on UDP 53.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip dhcp pool LAN
        dns-server 192.168.1.100
        end`,
      PC1: `ipconfig /renew`,
      SRV: `named-checkzone ccna.lab ccna.lab.zone
cat > ccna.lab.zone <<EOF
${FIXED_ZONE}EOF
cat > db.1.168.192.in-addr.arpa <<EOF
${REVERSE('srv.ccna.lab.')}EOF
rndc reload`,
    },
    debrief: 'DNS faults show up as different nslookup messages: a timeout means no server answered (wrong address or a filter), "Non-existent domain" means the server answered that the name does not exist, and a wrong answer means the record itself is wrong. In BIND zone files, a missing trailing dot is the most common mistake of all, and an MX or NS must point at a name that has its own A or AAAA record, never at a CNAME or a bare address.',
  },
];
