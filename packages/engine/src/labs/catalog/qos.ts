import type { AddressingRow, LabDeviceSpec, LabDefinition } from '../types';

/** A softphone and a PC behind SW1 and R1, a 10 Mbps WAN link to R2, and a server behind R2. */
const ADDRESSING: AddressingRow[] = [
  { device: 'PHONE', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1', note: 'Softphone, marks EF (46)' },
  { device: 'PC2', interface: 'Eth0', address: '192.168.1.20/24', gateway: '192.168.1.1' },
  { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'LAN' },
  { device: 'R1', interface: 'Gi0/1', address: '10.0.0.1/30', note: 'WAN, bandwidth 10000 kbps' },
  { device: 'R2', interface: 'Gi0/1', address: '10.0.0.2/30', note: 'WAN' },
  { device: 'SRV', interface: 'Eth0', address: '172.16.0.10/24', gateway: '172.16.0.1' },
];

const R1_BASE = `conf t
  int g0/0
  ip address 192.168.1.1 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.0.1 255.255.255.252
  bandwidth 10000
  no shut
  exit
  ip route 0.0.0.0 0.0.0.0 10.0.0.2`;

const DEVICES = (r1: string, sw1?: string): LabDeviceSpec[] => [
  { hostname: 'PHONE', kind: 'pc', at: [0, 320], ip: '192.168.1.10/24', gateway: '192.168.1.1', dscp: 46 },
  { hostname: 'PC2', kind: 'pc', at: [200, 320], ip: '192.168.1.20/24', gateway: '192.168.1.1' },
  { hostname: 'SW1', kind: 'switch', at: [100, 170], config: sw1 },
  { hostname: 'R1', kind: 'router', at: [100, 20], config: r1 },
  {
    hostname: 'R2',
    kind: 'router',
    at: [380, 20],
    config: `conf t
      int g0/0
      ip address 172.16.0.1 255.255.255.0
      no shut
      int g0/1
      ip address 10.0.0.2 255.255.255.252
      no shut
      exit
      ip route 192.168.1.0 255.255.255.0 10.0.0.1`,
  },
  { hostname: 'SRV', kind: 'pc', at: [560, 20], ip: '172.16.0.10/24', gateway: '172.16.0.1' },
];

const LINKS: [string, string][] = [
  ['PHONE Eth0', 'SW1 Gi0/1'],
  ['PC2 Eth0', 'SW1 Gi0/2'],
  ['R1 Gi0/0', 'SW1 Gi0/8'],
  ['R1 Gi0/1', 'R2 Gi0/1'],
  ['SRV Eth0', 'R2 Gi0/0'],
];

const CLASS_MAPS = `class-map match-any VOICE
  match dscp ef
  class-map match-any ICMP
  match protocol icmp`;

/** Domain 4.0: QoS classification, marking, queuing and trust boundaries (not a numbered v2.0 objective). */
export const qosLabs: LabDefinition[] = [
  {
    id: 'qos-marking',
    title: 'Mark and prioritize voice across the WAN',
    domain: '4.0',
    blueprint: ['4.0'],
    kind: 'guided',
    difficulty: 3,
    summary: 'Class maps, a marking policy on the LAN side and a low-latency queue on the 10 Mbps WAN link.',
    briefing: `Calls from the softphone break up whenever the WAN link is busy. Use the **Modular QoS CLI** on R1 to classify the traffic, mark it, and give voice a priority queue on the way out to the WAN.

1. Class maps: \`class-map match-any VOICE\` matching **dscp ef**, and \`class-map match-any ICMP\` matching **protocol icmp** (the monitoring pings)
2. Policy map **MARK-IN**: class VOICE \`set dscp ef\`, class ICMP \`set dscp af21\`. Attach it **inbound** on Gi0/0 (\`service-policy input MARK-IN\`). The order of the classes matters: the softphone's test pings are ICMP too, and the first matching class wins.
3. Policy map **WAN-OUT**: class VOICE \`priority percent 30\` (a low-latency queue), class class-default \`fair-queue\`. Attach it **outbound** on Gi0/1.

Ping the server from PHONE and PC2, then look at \`show policy-map interface\` on R1. Open a capture on the WAN cable and filter on \`ip.dsfield.dscp == 18\` to see the marked pings.`,
    addressing: ADDRESSING,
    topology: { devices: DEVICES(R1_BASE), links: LINKS },
    objectives: [
      {
        text: 'MARK-IN marks voice EF',
        check: { type: 'qosClass', device: 'R1', policy: 'MARK-IN', class: 'VOICE', setDscp: 46 },
        hint: '`class-map match-any VOICE`, `match dscp ef`, then `policy-map MARK-IN`, `class VOICE`, `set dscp ef`.',
      },
      {
        text: 'MARK-IN marks ICMP AF21',
        check: { type: 'qosClass', device: 'R1', policy: 'MARK-IN', class: 'ICMP', setDscp: 18 },
        hint: '`class-map match-any ICMP`, `match protocol icmp`, and in MARK-IN `class ICMP`, `set dscp af21`.',
      },
      { text: 'MARK-IN is applied inbound on Gi0/0', check: { type: 'servicePolicy', device: 'R1', interface: 'Gi0/0', direction: 'input', policy: 'MARK-IN' } },
      {
        text: 'WAN-OUT gives voice a priority queue',
        check: { type: 'qosClass', device: 'R1', policy: 'WAN-OUT', class: 'VOICE', priority: true },
        hint: '`policy-map WAN-OUT`, `class VOICE`, `priority percent 30`.',
      },
      { text: 'WAN-OUT is applied outbound on Gi0/1', check: { type: 'servicePolicy', device: 'R1', interface: 'Gi0/1', direction: 'output', policy: 'WAN-OUT' } },
      { text: "PHONE's traffic arrives marked EF", check: { type: 'dscpReceived', from: 'PHONE', to: '172.16.0.10', dscp: 46 } },
      { text: "PC2's pings arrive marked AF21", check: { type: 'dscpReceived', from: 'PC2', to: '172.16.0.10', dscp: 18 } },
      {
        text: 'Queuing',
        check: {
          type: 'quiz',
          question: 'What does `priority percent 30` give the VOICE class?',
          options: [
            'At least 30% of the link, shared fairly with other classes',
            'A strict priority queue (LLQ), sent first but policed to 30% when the link is congested',
            'A drop of 30% of voice packets',
            'DSCP 30',
          ],
          answer: 1,
          explain: 'LLQ serves the priority queue before anything else, which keeps delay and jitter low for voice. To stop it starving the other classes, it is limited to its rate during congestion. `bandwidth` gives a guaranteed minimum (CBWFQ) instead.',
        },
      },
      {
        text: 'Values',
        check: {
          type: 'quiz',
          question: 'Which DSCP value is the standard marking for voice payload?',
          options: ['AF41 (34)', 'CS3 (24)', 'EF (46)', 'CS6 (48)'],
          answer: 2,
          explain: 'Expedited Forwarding (46) is for voice. AF41 is the usual marking for video, CS3 for call signaling and CS6 for routing protocols.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ${CLASS_MAPS}
        policy-map MARK-IN
        class VOICE
        set dscp ef
        class ICMP
        set dscp af21
        exit
        exit
        policy-map WAN-OUT
        class VOICE
        priority percent 30
        class class-default
        fair-queue
        exit
        exit
        interface g0/0
        service-policy input MARK-IN
        interface g0/1
        service-policy output WAN-OUT
        end`,
    },
    debrief: 'MQC has three steps: classify with class maps (DSCP, ACLs, protocols), decide what to do per class in a policy map (mark, police, shape, queue), and attach the policy to an interface in one direction. Mark as close to the source as you can and queue where the link is slowest; in this simulator links never congest, so `show policy-map interface` shows the classification and markings rather than real queue drops.',
  },
  {
    id: 'qos-trust-boundary',
    title: 'Find where the voice marking gets lost',
    domain: '4.0',
    blueprint: ['4.0', '5.6'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'The softphone marks EF, but its packets reach the server with DSCP 0; the monitoring pings are not marked either.',
    briefing: `The softphone marks its traffic **EF (46)**, and R1 has a policy map **MARK-IN** that should keep voice at EF and mark the monitoring pings **AF21 (18)** as they enter from the LAN. A capture at the server shows something else: everything arrives with DSCP 0.

Two devices are involved. Find both faults:

- On SW1, \`show mls qos\` and \`show mls qos interface g0/1\` show what the switch does with the markings it receives
- On R1, \`show policy-map interface\` shows where MARK-IN is attached and what it matched

Fix them without turning QoS off on the switch: the trust boundary belongs at the phone's port.`,
    addressing: ADDRESSING,
    topology: {
      devices: DEVICES(
        `${R1_BASE}
        ${CLASS_MAPS}
        policy-map MARK-IN
        class VOICE
        set dscp ef
        class ICMP
        set dscp af21
        exit
        exit
        int g0/0
        service-policy output MARK-IN`,
        'conf t\nmls qos',
      ),
      links: LINKS,
    },
    objectives: [
      {
        text: "SW1 trusts the phone's DSCP on Gi0/1",
        check: { type: 'qosTrust', device: 'SW1', interface: 'Gi0/1', trust: 'dscp' },
        hint: 'With `mls qos` on, untrusted ports rewrite DSCP to 0. On Gi0/1: `mls qos trust dscp` (the phone port is an access port, so there is no CoS to trust).',
      },
      {
        text: 'MARK-IN classifies traffic entering from the LAN',
        check: { type: 'servicePolicy', device: 'R1', interface: 'Gi0/0', direction: 'input', policy: 'MARK-IN' },
        hint: 'MARK-IN is attached outbound, so it only sees replies going back to the LAN. `no service-policy output MARK-IN`, then `service-policy input MARK-IN`.',
      },
      { text: "PHONE's traffic arrives marked EF", check: { type: 'dscpReceived', from: 'PHONE', to: '172.16.0.10', dscp: 46 } },
      { text: "PC2's pings arrive marked AF21", check: { type: 'dscpReceived', from: 'PC2', to: '172.16.0.10', dscp: 18 } },
      {
        text: 'Trust',
        check: {
          type: 'quiz',
          question: 'Why did `mls qos trust cos` on Gi0/1 not fix the phone\'s marking?',
          options: [
            'CoS only exists in the 802.1Q tag, and an access port carries untagged frames, so the switch has no CoS to trust and marks DSCP 0',
            'CoS and DSCP cannot be used on the same switch',
            'The command needs a reload',
            'CoS is only used on routers',
          ],
          answer: 0,
          explain: 'CoS is three bits in the 802.1Q header. An IP phone on a voice VLAN tags its frames, so trusting CoS works there; a softphone on an access port sends untagged frames, so trust DSCP (in the IP header) instead.',
        },
      },
    ],
    solution: {
      SW1: `enable
        conf t
        interface g0/1
        mls qos trust dscp
        end`,
      R1: `enable
        conf t
        interface g0/0
        no service-policy output MARK-IN
        service-policy input MARK-IN
        end`,
    },
    debrief: 'Once `mls qos` is on, a Catalyst switch trusts nothing: every port rewrites DSCP to 0 unless it is configured to trust. The trust boundary is the point where you start believing markings, ideally the phone port itself. Policies are also directional: a marking policy for traffic arriving from the LAN belongs inbound on the LAN interface.',
  },
];
