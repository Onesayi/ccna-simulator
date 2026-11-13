import type { AddressingRow, LabDefinition, LabDeviceSpec } from '../types';

/**
 * QoS under real load: a softphone and a PC behind SW1 and R1, a WAN link to R2, and a server
 * behind R2. Every host has traffic generator flows, so `traffic run` shows what congestion does.
 */
const ADDRESSING = (wan: string): AddressingRow[] => [
  { device: 'PHONE', interface: 'Eth0', address: '192.168.1.10/24', gateway: '192.168.1.1', note: 'Softphone, marks EF (46)' },
  { device: 'PC2', interface: 'Eth0', address: '192.168.1.20/24', gateway: '192.168.1.1' },
  { device: 'R1', interface: 'Gi0/0', address: '192.168.1.1/24', note: 'LAN' },
  { device: 'R1', interface: 'Gi0/1', address: '10.0.0.1/30', note: wan },
  { device: 'R2', interface: 'Gi0/1', address: '10.0.0.2/30', note: wan },
  { device: 'SRV', interface: 'Eth0', address: '172.16.0.10/24', gateway: '172.16.0.1' },
];

const LINKS: [string, string][] = [
  ['PHONE Eth0', 'SW1 Gi0/1'],
  ['PC2 Eth0', 'SW1 Gi0/2'],
  ['R1 Gi0/0', 'SW1 Gi0/8'],
  ['R1 Gi0/1', 'R2 Gi0/1'],
  ['SRV Eth0', 'R2 Gi0/0'],
];

const r1Base = (speed: string) => `conf t
  int g0/0
  ip address 192.168.1.1 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.0.1 255.255.255.252
  ${speed}
  no shut
  exit
  ip route 0.0.0.0 0.0.0.0 10.0.0.2`;

const r2Base = (extra: string) => `conf t
  int g0/0
  ip address 172.16.0.1 255.255.255.0
  no shut
  int g0/1
  ip address 10.0.0.2 255.255.255.252
  no shut
  exit
  ip route 192.168.1.0 255.255.255.0 10.0.0.1
  ${extra}`;

function devices(r1: string, r2: string, phoneFlows: string[], pcFlows: string[], sw1?: string): LabDeviceSpec[] {
  return [
    { hostname: 'PHONE', kind: 'pc', at: [0, 320], ip: '192.168.1.10/24', gateway: '192.168.1.1', dscp: 46, flows: phoneFlows },
    { hostname: 'PC2', kind: 'pc', at: [200, 320], ip: '192.168.1.20/24', gateway: '192.168.1.1', flows: pcFlows },
    { hostname: 'SW1', kind: 'switch', at: [100, 170], config: sw1 },
    { hostname: 'R1', kind: 'router', at: [100, 20], config: r1 },
    { hostname: 'R2', kind: 'router', at: [380, 20], config: r2 },
    { hostname: 'SRV', kind: 'pc', at: [560, 20], ip: '172.16.0.10/24', gateway: '172.16.0.1' },
  ];
}

const VOICE = 'VOICE 172.16.0.10 rate 240 udp 16384 size 200';
const OFFICE = ['CRM 172.16.0.10 rate 2000 dscp af21 tcp 443', 'BACKUP 172.16.0.10 rate 12000 tcp 445'];

const WAN_QOS = `class-map match-any VOICE
  match dscp ef
  class-map match-any CRM
  match dscp af21
  policy-map WAN-QOS
  class VOICE
  priority 1000
  class CRM
  bandwidth 3000
  class class-default
  fair-queue`;

/** Domain 4.0: QoS queuing, shaping and policing under congestion (not a numbered v2.0 objective). */
export const qosCongestionLabs: LabDefinition[] = [
  {
    id: 'qos-congestion',
    title: 'Keep calls clear on a congested WAN',
    domain: '4.0',
    blueprint: ['4.0'],
    kind: 'guided',
    difficulty: 3,
    summary: 'A backup saturates the 10 Mbps WAN link. Measure the damage with the traffic generator, then fix it with LLQ and CBWFQ.',
    briefing: `The WAN link between R1 and R2 runs at **10 Mbps** (\`speed 10\`). Three flows share it, and they are already set up on the hosts (type \`traffic\` on PHONE or PC2 to list them):

- **VOICE** from PHONE: three calls, 240 kbps, marked EF
- **CRM** from PC2: the business app, 2 Mbps, marked AF21
- **BACKUP** from PC2: a file backup, 12 Mbps, unmarked

1. On PHONE, run \`traffic run\`. The link is offered 14.2 Mbps, so its FIFO queue overflows and every flow loses the same share. On R1, \`show interfaces g0/1\` shows the **txload** and the **output drops**.
2. On R1, build class maps **VOICE** (\`match dscp ef\`) and **CRM** (\`match dscp af21\`).
3. Build policy map **WAN-QOS**: class VOICE \`priority 1000\` (LLQ), class CRM \`bandwidth 3000\` (CBWFQ), class class-default \`fair-queue\`.
4. Attach it outbound on Gi0/1, run the traffic again, and read \`show policy-map interface g0/1\`.`,
    addressing: ADDRESSING('WAN, speed 10 (Mbps)'),
    topology: { devices: devices(r1Base('speed 10'), r2Base('int g0/1\nspeed 10'), [VOICE], OFFICE), links: LINKS },
    objectives: [
      {
        text: 'WAN-QOS gives voice a priority queue',
        check: { type: 'qosClass', device: 'R1', policy: 'WAN-QOS', class: 'VOICE', priority: true },
        hint: '`class-map match-any VOICE`, `match dscp ef`, then `policy-map WAN-QOS`, `class VOICE`, `priority 1000`.',
      },
      {
        text: 'WAN-QOS guarantees the CRM class bandwidth',
        check: { type: 'qosClass', device: 'R1', policy: 'WAN-QOS', class: 'CRM', bandwidth: true },
        hint: '`class-map match-any CRM`, `match dscp af21`, and in WAN-QOS `class CRM`, `bandwidth 3000`.',
      },
      { text: 'WAN-QOS is applied outbound on Gi0/1', check: { type: 'servicePolicy', device: 'R1', interface: 'Gi0/1', direction: 'output', policy: 'WAN-QOS' } },
      {
        text: 'Calls are clear while the backup runs',
        check: { type: 'trafficFlow', from: 'PHONE', flow: 'VOICE', voice: true },
        hint: 'Run `traffic run` on PHONE. If VOICE still loses packets, check that the VOICE class matches EF and that WAN-QOS is attached **output** on the WAN interface.',
      },
      {
        text: 'The CRM app loses nothing',
        check: { type: 'trafficFlow', from: 'PC2', flow: 'CRM', maxLossPct: 1 },
        hint: 'CRM offers 2 Mbps, so a 3000 kbps guarantee covers it. Without a class of its own it competes with the backup in class-default.',
      },
      {
        text: 'Who pays',
        check: {
          type: 'quiz',
          question: 'With WAN-QOS in place, the backup still loses about a third of its traffic. Why?',
          options: [
            'QoS cannot create bandwidth: 14.2 Mbps is offered to a 10 Mbps link, so something is dropped, and the policy decides it is the least important traffic',
            'fair-queue drops a third of every flow',
            'The priority queue always takes 1000 kbps even when voice uses less',
            'TCP traffic cannot be queued',
          ],
          answer: 0,
          explain: 'Queuing only decides the order of service and who is dropped when the link is full. VOICE and CRM get what they need; class-default takes whatever is left (and the unused part of the priority and CRM reservations), and the rest of the backup is tail-dropped.',
        },
      },
      {
        text: 'bandwidth vs speed',
        check: {
          type: 'quiz',
          question: 'An engineer sets `bandwidth 10000` on a 1 Gbps interface. What happens to the traffic on it?',
          options: [
            'It is limited to 10 Mbps',
            'Nothing: bandwidth only informs routing metrics, percentages in QoS policies and the load calculation; the port still sends at 1 Gbps',
            'The interface negotiates down to 10 Mbps',
            'Traffic over 10 Mbps is shaped',
          ],
          answer: 1,
          explain: 'The bandwidth command is a number other features read (OSPF cost, txload, `priority percent`). To really limit traffic, change the speed, or shape it with `shape average`.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        ${WAN_QOS}
        exit
        exit
        interface g0/1
        service-policy output WAN-QOS
        end`,
    },
    debrief: 'Congestion only happens where traffic arrives faster than a link can send it, usually at the WAN edge. LLQ (`priority`) sends voice first, so it sees almost no delay, and polices it to its rate during congestion so it cannot starve anything else. CBWFQ (`bandwidth`) guarantees each class a minimum share and lets it borrow what others leave idle. Whatever does not fit is dropped from the classes that matter least.',
  },
  {
    id: 'qos-shaping',
    title: "Shape to the provider's contract",
    domain: '4.0',
    blueprint: ['4.0'],
    kind: 'guided',
    difficulty: 3,
    summary: 'A 1 Gbps hand-off, a 5 Mbps contract and a provider policer that drops the excess. Shape on your side, with voice protected inside the shaper.',
    briefing: `The branch buys **5 Mbps** from its provider, delivered on a 1 Gbps Ethernet hand-off. R2 plays the provider: it polices everything arriving on Gi0/1 to 5 Mbps (\`show policy-map interface g0/1\` on R2). The flows are already set up:

- **VOICE** from PHONE: 160 kbps, marked EF
- **DATA** from PC2: 8 Mbps in bursts, 100 ms on and 100 ms off (4 Mbps on average)

On average the branch stays under its contract, but each burst is far over it, and the provider's policer drops whatever is over, voice included.

1. Run \`traffic run\` on PHONE and look at the drops on R2.
2. On R1, class map **VOICE** (\`match dscp ef\`), then a child policy **CHILD** with class VOICE \`priority 512\`. Everything else falls into class-default, a FIFO queue of 64 packets.
3. A parent policy **SHAPE-5M**: class class-default \`shape average 5000000\` and \`service-policy CHILD\`.
4. Attach SHAPE-5M outbound on Gi0/1 and run the traffic again. Compare the DATA delay before and after.`,
    addressing: ADDRESSING('Hand-off at 1 Gbps, contract 5 Mbps'),
    topology: {
      devices: devices(
        r1Base('speed auto'),
        r2Base(`policy-map ISP-CIR
          class class-default
          police 5000000 conform-action transmit exceed-action drop
          int g0/1
          service-policy input ISP-CIR`),
        ['VOICE 172.16.0.10 rate 160 udp 16384 size 200'],
        ['DATA 172.16.0.10 rate 8000 tcp 445 burst 100 100'],
      ),
      links: LINKS,
    },
    objectives: [
      {
        text: 'CHILD gives voice a priority queue',
        check: { type: 'qosClass', device: 'R1', policy: 'CHILD', class: 'VOICE', priority: true },
        hint: '`class-map match-any VOICE`, `match dscp ef`, `policy-map CHILD`, `class VOICE`, `priority 512`.',
      },
      {
        text: 'SHAPE-5M shapes to 5 Mbps with CHILD inside',
        check: { type: 'qosClass', device: 'R1', policy: 'SHAPE-5M', class: 'class-default', shape: true, child: 'CHILD' },
        hint: 'Build CHILD first. Then `policy-map SHAPE-5M`, `class class-default`, `shape average 5000000`, `service-policy CHILD`.',
      },
      { text: 'SHAPE-5M is applied outbound on Gi0/1', check: { type: 'servicePolicy', device: 'R1', interface: 'Gi0/1', direction: 'output', policy: 'SHAPE-5M' } },
      {
        text: 'Calls are clear',
        check: { type: 'trafficFlow', from: 'PHONE', flow: 'VOICE', voice: true },
        hint: 'Voice is only safe if R1 never sends more than the provider accepts, and if voice goes first inside the shaper.',
      },
      {
        text: 'The provider drops none of the data',
        check: { type: 'trafficFlow', from: 'PC2', flow: 'DATA', maxLossPct: 1 },
        hint: 'A shaper holds the bursts in its queue and sends them at 5 Mbps. If DATA still loses packets, check the shape rate.',
      },
      {
        text: 'Police or shape',
        check: {
          type: 'quiz',
          question: 'After shaping, DATA loses nothing but its delay goes up. Why?',
          options: [
            'A shaper queues traffic over the rate and sends it later, trading delay for loss; a policer drops (or re-marks) it straight away',
            'Shaping compresses the data',
            'The provider policer adds delay',
            'fair-queue always adds delay',
          ],
          answer: 0,
          explain: 'Shaping buffers bursts so they leave at the contracted rate, which is why it belongs on the customer side of a contract. Policing has no buffer: it suits the provider side, or traffic that would rather be dropped than delayed.',
        },
      },
    ],
    solution: {
      R1: `enable
        conf t
        class-map match-any VOICE
        match dscp ef
        policy-map CHILD
        class VOICE
        priority 512
        exit
        exit
        policy-map SHAPE-5M
        class class-default
        shape average 5000000
        service-policy CHILD
        exit
        exit
        interface g0/1
        service-policy output SHAPE-5M
        end`,
    },
    debrief: 'When the physical link is faster than the service you pay for, the congestion point moves into the provider\'s network, where you have no control. A hierarchical policy brings it back: the parent shaper creates the congestion on your router, at the contract rate, and the child policy decides who goes first inside it. The provider polices; the customer shapes.',
  },
  {
    id: 'qos-congestion-troubleshoot',
    title: 'Calls still break up with QoS on',
    domain: '4.0',
    blueprint: ['4.0'],
    kind: 'troubleshoot',
    difficulty: 3,
    summary: 'WAN-QOS is attached and has a priority queue, yet voice is dropped with the backup. Find the two faults.',
    briefing: `R1 has the policy from the congestion lab: **WAN-QOS** with a priority queue for voice, outbound on the 10 Mbps WAN link. The help desk still gets complaints about choppy calls whenever the backup runs.

Run \`traffic run\` on PHONE, then follow the voice traffic:

- \`show policy-map interface g0/1\` on R1: which class does the voice traffic land in, and where are the drops?
- \`show class-map\` on R1: what does VOICE really match?
- \`show mls qos interface g0/1\` on SW1: does the marking survive the switch?

There are two faults. Fix them without removing QoS from either device.`,
    addressing: ADDRESSING('WAN, speed 10 (Mbps)'),
    topology: {
      devices: devices(
        `${r1Base('speed 10')}
        class-map match-any VOICE
        match dscp af41
        class-map match-any CRM
        match dscp af21
        policy-map WAN-QOS
        class VOICE
        priority 1000
        class CRM
        bandwidth 3000
        class class-default
        fair-queue
        exit
        exit
        int g0/1
        service-policy output WAN-QOS`,
        r2Base('int g0/1\nspeed 10'),
        [VOICE],
        OFFICE,
        'conf t\nmls qos\nint g0/2\nmls qos trust dscp',
      ),
      links: LINKS,
    },
    objectives: [
      {
        text: "SW1 trusts the phone's marking",
        check: { type: 'qosTrust', device: 'SW1', interface: 'Gi0/1', trust: 'dscp' },
        hint: 'With `mls qos` on, Gi0/1 rewrites the phone\'s EF to 0 because it is not trusted. PC2\'s port is trusted, the phone\'s is not: `interface g0/1`, `mls qos trust dscp`.',
      },
      {
        text: 'Calls are clear while the backup runs',
        check: { type: 'trafficFlow', from: 'PHONE', flow: 'VOICE', voice: true },
        hint: 'Voice is EF (46), but class map VOICE matches AF41 (34), the usual video marking. `class-map match-any VOICE`, `no match dscp af41`, `match dscp ef`.',
      },
      {
        text: 'The CRM app loses nothing',
        check: { type: 'trafficFlow', from: 'PC2', flow: 'CRM', maxLossPct: 1 },
      },
      {
        text: 'Reading the counters',
        check: {
          type: 'quiz',
          question: 'Before the fixes, which line of `show policy-map interface` showed that voice was not being prioritized?',
          options: [
            'Class VOICE had 0 packets while class-default had drops',
            'The priority burst bytes',
            'The queue limit of class CRM',
            'The interface name',
          ],
          answer: 0,
          explain: 'A class that should see traffic but counts 0 packets points at classification: the match statements, or a marking lost before the router. The drops then show up in whichever class the traffic really landed in.',
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
        class-map match-any VOICE
        no match dscp af41
        match dscp ef
        end`,
    },
    debrief: 'A priority queue only helps the traffic that reaches it. Classification depends on the marking surviving every hop (trust boundaries on switches) and on the class map matching the right value. When QoS seems not to work, read the per-class packet counters first: they show where traffic really goes.',
  },
];
