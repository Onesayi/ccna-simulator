import type { LabDefinition } from '../types';
import { OFFICE_LINKS, R1_IP, office } from './management';

/** NETCONF-YANG: XML over SSH (TCP 830), on the same YANG models RESTCONF serves as JSON. */

const IETF_IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const NATIVE = 'http://cisco.com/ns/yang/Cisco-IOS-XE-native';

const LOOPBACK_XML = `<config>
  <interfaces xmlns="${IETF_IF}">
    <interface>
      <name>Loopback0</name>
      <description>Managed by NETCONF</description>
      <type xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">ianaift:softwareLoopback</type>
      <enabled>true</enabled>
      <ipv4 xmlns="urn:ietf:params:xml:ns:yang:ietf-ip">
        <address>
          <ip>10.0.0.1</ip>
          <netmask>255.255.255.255</netmask>
        </address>
      </ipv4>
    </interface>
  </interfaces>
</config>
`;

const hostnameXml = (ns: string) => `<config>
  <native xmlns="${ns}">
    <hostname>HQ-R1</hostname>
  </native>
</config>
`;

const NETCONF_AAA = `aaa new-model
  aaa authentication login default local`;

export const netconfLabs: LabDefinition[] = [
  {
    id: 'netconf-yang',
    title: 'Read and change a router with NETCONF',
    domain: '5.0',
    blueprint: ['5.3'],
    kind: 'guided',
    difficulty: 2,
    summary: 'Turn on NETCONF-YANG, exchange hellos, read an interface with get-config and add a loopback with edit-config.',
    briefing: `NETCONF is the older sibling of RESTCONF: the same YANG models, encoded as XML and carried over SSH on TCP **830**. A client and the device first swap \`<hello>\` messages listing their capabilities, then the client sends \`<rpc>\` operations such as \`<get-config>\` and \`<edit-config>\`.

On R1 (IOS XE checks NETCONF logins through AAA, and needs privilege 15):

- A local user **admin**, privilege **15**, secret **Cisco123**
- \`aaa new-model\`, \`aaa authentication login default local\` and \`aaa authorization exec default local\`
- \`netconf-yang\`

Then, from the automation server SRV:

- \`netconf-console --host 192.168.1.1 -u admin -p Cisco123 --hello\` shows R1's capabilities, the YANG models it supports.
- Read G0/0 with an XPath filter: \`netconf-console --host 192.168.1.1 -u admin -p Cisco123 --get-config -x "/interfaces/interface[name='GigabitEthernet0/0']"\`
- SRV already holds **loopback.xml** (see the Files tab or \`cat loopback.xml\`). Push it: \`netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config loopback.xml\`. An \`<ok/>\` reply means R1 applied it.

\`show running-config\` and \`show logging\` on R1 show the change and who made it. For the raw protocol, try \`ssh admin@192.168.1.1 -p 830 -s netconf\`.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'Loopback0 10.0.0.1/32 comes from NETCONF' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'Automation host' },
    ],
    topology: {
      devices: office([], R1_IP).map((d) => (d.hostname === 'SRV' ? { ...d, files: { 'loopback.xml': LOOPBACK_XML } } : d)),
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'admin logs in through AAA at privilege 15', check: { type: 'aaaLogin', device: 'R1', username: 'admin', password: 'Cisco123', expect: 'success', privilege: 15 }, hint: 'Without `aaa authorization exec default local`, AAA starts every login at privilege 1.' },
      { text: 'NETCONF-YANG is enabled', check: { type: 'netconf', device: 'R1' }, hint: '`netconf-yang` in global configuration mode. `show netconf-yang status` confirms the port.' },
      { text: 'SRV read the configuration with <get-config>', check: { type: 'netconfRpc', device: 'R1', rpc: 'get-config' } },
      { text: 'Loopback0 is 10.0.0.1/32', check: { type: 'interfaceIp', device: 'R1', interface: 'Loopback0', prefix: 32, address: '10.0.0.1' }, hint: 'Push loopback.xml with --edit-config.' },
      { text: 'Loopback0 is described as Managed by NETCONF', check: { type: 'description', device: 'R1', interface: 'Loopback0', contains: 'Managed by NETCONF' } },
      {
        text: 'NETCONF transport',
        check: {
          type: 'quiz',
          question: 'How does a NETCONF client reach an IOS XE device?',
          options: ['HTTPS on TCP 443, with JSON', 'SSH on TCP 830, with XML', 'SNMP on UDP 161, with BER', 'Telnet on TCP 23, with CLI text'],
          answer: 1,
          explain: 'NETCONF runs as an SSH subsystem on port 830 and encodes YANG data as XML. RESTCONF serves the same models over HTTPS as JSON or XML.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        username admin privilege 15 secret Cisco123
        ${NETCONF_AAA}
        aaa authorization exec default local
        netconf-yang
        end`,
      SRV: `netconf-console --host 192.168.1.1 -u admin -p Cisco123 --hello
        netconf-console --host 192.168.1.1 -u admin -p Cisco123 --get-config -x "/interfaces/interface[name='GigabitEthernet0/0']"
        netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config loopback.xml`,
    },
    debrief: 'NETCONF separates configuration (get-config, edit-config on a datastore) from state (get), validates a whole change before applying it, and rolls back if any part fails. Controllers such as Catalyst Center use it as a southbound interface, and Python scripts reach it with the ncclient library.',
  },
  {
    id: 'netconf-troubleshoot',
    title: 'NETCONF that never connects',
    domain: '5.0',
    blueprint: ['5.3'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'A filter, a missing AAA line and a bad namespace stop a NETCONF hostname change. Find all three.',
    briefing: `The automation team wants R1 renamed **HQ-R1** through NETCONF, never by hand. Their file **hostname.xml** is on SRV, and the command is:

\`netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config hostname.xml\`

It fails. Work through the layers and fix each fault, then run it again:

- Can SRV reach TCP 830 at all? (A timeout and a refusal mean different things.)
- Does admin get the privilege NETCONF needs once logged in?
- Does the XML name the right YANG model? Compare its namespace with the capabilities R1 lists in \`--hello\`. Rewrite the file with \`cat > hostname.xml <<EOF\` ... \`EOF\`, or edit it in the Files tab.

R1's hostname must change through NETCONF: renaming it at the CLI does not count.`,
    addressing: [
      { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24' },
      { device: 'SRV', interface: 'Eth0', address: '192.168.1.100/24', gateway: '192.168.1.1', note: 'Automation host' },
    ],
    topology: {
      devices: office(
        [],
        `${R1_IP}
        ip access-group MGMT-IN in
        exit
        ip access-list extended MGMT-IN
        deny tcp any any eq 830
        permit ip any any
        exit
        username admin privilege 15 secret Cisco123
        ${NETCONF_AAA}
        aaa authentication login CONSOLE none
        line con 0
        login authentication CONSOLE
        exit
        netconf-yang
        end`,
      ).map((d) => (d.hostname === 'SRV' ? { ...d, files: { 'hostname.xml': hostnameXml('http://cisco.com/ns/yang/Cisco-IOS-XE-natve') } } : d)),
      links: OFFICE_LINKS,
    },
    objectives: [
      { text: 'SRV can reach R1 on TCP 830', check: { type: 'connect', from: 'SRV', to: '192.168.1.1', port: 830, expect: 'open' }, hint: '`show access-lists` on R1: an inbound ACL on G0/0 drops port 830. Remove that entry.' },
      { text: 'admin gets privilege 15 through AAA', check: { type: 'aaaLogin', device: 'R1', username: 'admin', password: 'Cisco123', expect: 'success', privilege: 15 }, hint: 'Without an EXEC authorization list, AAA starts every login at privilege 1: `aaa authorization exec default local`.' },
      { text: 'R1 accepted an <edit-config>', check: { type: 'netconfRpc', device: 'R1', rpc: 'edit-config' }, hint: 'An unknown-namespace error means the xmlns does not match any model R1 advertises: Cisco-IOS-XE-native.' },
      { text: 'R1 is now HQ-R1', check: { type: 'hostname', device: 'R1', name: 'HQ-R1' } },
      {
        text: 'Reading the error',
        check: {
          type: 'quiz',
          question: 'An <edit-config> comes back with error-tag unknown-namespace. What does that tell you?',
          options: ['The user is not privilege 15', 'The XML uses a namespace that matches no YANG model the device supports', 'The device is locked by another session', 'Port 830 is filtered'],
          answer: 1,
          explain: 'Every top-level element in <config> must carry the namespace of a model listed in the server hello. Access problems show as access-denied, a held lock as in-use, and a filter as a timeout before any XML is exchanged.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ip access-list extended MGMT-IN
        no deny tcp any any eq 830
        exit
        aaa authorization exec default local
        end`,
      SRV: `cat > hostname.xml <<EOF
${hostnameXml(NATIVE)}EOF
netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config hostname.xml`,
    },
    debrief: 'Model-driven automation fails in layers: reachability (ACLs, routing, the port), then the session (SSH login and AAA authorization), then the payload (namespaces and YANG structure). NETCONF reports the last kind precisely in <rpc-error>, with a tag, a message and the offending element.',
  },
];
