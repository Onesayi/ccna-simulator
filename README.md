# CCNA Simulator

[![CI](https://github.com/Onesayi/ccna-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/Onesayi/ccna-simulator/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-live-2ea043)](https://onesayi.github.io/ccna-simulator/)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A browser-based network simulator for studying the Cisco CCNA 200-301 v2.0 exam. Build a topology, configure routers and switches from an IOS-style command line, and work through graded labs mapped to the exam blueprint. Everything runs client-side: no server, no install, no Cisco images.

**[Try the live demo →](https://onesayi.github.io/ccna-simulator/)**

![Opening a lab, configuring a router from its console, and watching every objective pass](docs/img/walkthrough.gif)

## Try it in two minutes

1. Open the [live demo](https://onesayi.github.io/ccna-simulator/). A two-site network loads on the canvas.
2. Click **PC1** and run `ping 192.168.30.10`. The first ping loses a couple of packets while ARP resolves on each hop, just like real gear. Run `tracert 192.168.30.10` to see both routers.
3. Click **R1** and type `enable`, then `show ip route`, `sh ip int br` or `?` for help.
4. Open the **Labs** tab and pick [Bring a router online](https://onesayi.github.io/ccna-simulator/#/labs/router-basics). Objectives tick off as you type; press **Check my work** to run the ping tests.

## Features

### Study mode

The **Labs** tab has 33 hands-on labs covering all five domains of the CCNA 200-301 v2.0 blueprint: guided labs, troubleshooting labs with planted faults, and open-ended challenges.

![The lab catalog grouped by blueprint domain, with progress saved in the browser](docs/img/catalog.png)

- **Automatic checking.** Each objective is a check run against the live engine state: VLANs, access and trunk ports, sub-interfaces, SVIs, addresses, gateways, routes in the routing table, configured floating statics, OSPF neighbors, router IDs and DR/BDR roles, DHCP pools and leases, NAT and ACL placement, IPv6 addresses and routes, spanning-tree roots and port roles, PortFast and BPDU guard, EtherChannel bundles, port security and secure MACs, and real pings, traceroutes and TCP connections. Configuration checks update as you type; traffic checks run when you press *Check my work*. A failed check says what it saw ("Gi0/1 is in VLAN 1"), not the answer.
- **Hints, quizzes and solutions.** Objectives carry optional hints, labs include multiple-choice questions on the theory behind them, and every lab has a model answer you can reveal.
- **Progress tracking.** Completion, checks and hints used are saved in your browser, and the catalog shows progress per blueprint domain.
- **Shareable links.** Each lab has its own URL, such as `#/labs/floating-static`.

![A router-on-a-stick lab in progress: the lab sheet grades objectives live while the learner types into R1's console](docs/img/lab.png)

<details>
<summary>All 33 labs</summary>

| Lab | Blueprint |
| --- | --- |
| Bring a router online | 1.3, 2.1.a |
| Address hosts from a VLSM plan | 1.3 |
| Separate two departments with VLANs | 2.2, 2.4 |
| Trunk VLANs between two switches | 2.1.b, 2.2 |
| Route between VLANs with router-on-a-stick | 2.1.a, 2.1.b |
| Route between VLANs on a Layer 3 switch | 2.1.d |
| Manage a switch from another subnet | 2.1.d, 2.4 |
| Connect two sites with static routes | 3.1, 3.2.b |
| Send a branch to the internet with a default route | 3.1, 3.2.a |
| Add a backup link with a floating static route | 3.2.b, 3.2.c, 3.2.d |
| Run single-area OSPF | 3.1, 3.3 |
| Choose the DR and BDR | 3.3.a, 3.3.c |
| Fix the OSPF adjacencies (troubleshooting) | 3.3.a, 3.3.b |
| Hand out addresses with DHCP | 1.6, 1.7 |
| Relay DHCP to a central server (troubleshooting) | 1.6, 1.7 |
| Share one public address with PAT | 4.3 |
| Publish a web server with static NAT | 4.3 |
| Keep guests off the servers with a standard ACL | 4.6 |
| Filter by port with a named extended ACL | 4.6 |
| Fix the ACLs that broke the WAN (troubleshooting) | 4.6, 3.3.a |
| Address a router for IPv6 | 1.4 |
| Route between IPv6 sites with statics | 3.1, 3.2.a, 3.2.b |
| Fix the IPv6 branch (troubleshooting) | 1.4, 2.4, 3.2 |
| Choose the root bridge per VLAN | 2.5.a, 2.5.b |
| Stop a rogue switch with BPDU guard | 2.5.c, 2.5.d |
| Bundle two links with LACP | 2.1.b, 2.1.c |
| Fix a port-channel that will not form (troubleshooting) | 2.1.c, 2.4 |
| Lock down access ports with port security | 4.7.e |
| Recover a port shut by port security (troubleshooting) | 4.7.e, 2.4 |
| Read the logs (troubleshooting) | 5.6 |
| Fix the office network (troubleshooting) | 1.6, 2.4, 3.2.b |
| Capstone: build two sites from scratch | 2.1, 2.2, 3.2.b |
| Capstone: branch to the internet | 1.7, 3.3, 4.3 |

</details>

### Simulation engine

![SW1 showing its VLANs and 802.1Q trunk from the IOS console](docs/img/vlan-cli.png)

- **Topology canvas**: add routers, switches and PCs, drag between devices to cable them, click a cable to remove it. Cables turn red and dashed while either end is down, orange and dotted where spanning tree blocks them, and thick when bundled into a port-channel. A demo network (two sites, router-on-a-stick, static routes) loads on start.
- **Routers**: GigabitEthernet ports that start shut down (a link only comes up when both ends are enabled), loopbacks, 802.1Q sub-interfaces for router-on-a-stick, connected and local routes, static routes by next hop and/or exit interface, default routes, floating statics (administrative distance), proxy ARP, TTL expiry and ICMP unreachables.
- **OSPFv2 (single area)**: hellos, neighbor states, DR/BDR election that never preempts, router and network LSAs, SPF with equal-cost paths, router ID selection, passive interfaces, point-to-point links, cost from bandwidth, `default-information originate`, and the log messages for adjacency changes, duplicate router IDs and area mismatches.
- **IP services**: a DHCP server with pools and excluded ranges, DHCP relay (`ip helper-address`), DHCP clients on PCs and router ports; static NAT, dynamic NAT and PAT; numbered and named standard and extended ACLs with per-line match counters; telnet and TCP port checks for testing filters; and a syslog buffer (`show logging`).
- **Switches**: VLAN-aware MAC learning and flooding, 802.1Q trunks with native and allowed VLANs, MAC aging, SVIs with autostate, `ip default-gateway`, and inter-VLAN routing with `ip routing`.
- **Spanning tree (PVST+ / Rapid PVST+)**: per-VLAN root election by bridge ID, root/designated/alternate/backup roles, path cost and port priority, `root primary/secondary`, PortFast, BPDU guard (err-disable) and root guard, with `show spanning-tree` output.
- **EtherChannel**: LACP (active/passive), PAgP (desirable/auto) and static `on` bundles, member suspension on mismatched settings, load sharing, and `show etherchannel summary`.
- **Port security**: maximum addresses, static, dynamic and sticky secure MACs, protect/restrict/shutdown violations, err-disabled ports and `show port-security`.
- **IPv6**: global, EUI-64 and link-local addresses, Neighbor Discovery, router advertisements and SLAAC on PCs, `ipv6 unicast-routing`, static routes (including link-local next hops), ping and traceroute.
- **PCs**: a Packet Tracer style command prompt with `ipconfig` (including `/renew`, `/release` and DHCP), `ipv6config` (static or SLAAC), `ping [-n count]`, `tracert`, `arp -a`, `telnet` and `curl`.
- **IOS CLI**: mode hierarchy with abbreviations (`conf t`, `sh ip int br`), `?` help, `do` from config mode, `interface`, `interface range`, `ip address`, `encapsulation dot1q`, `ip route`, `ip routing`, VLAN and switchport commands, `ping`, `traceroute`, and `show running-config`, `ip route`, `ip arp`, `ip interface brief`, `vlan brief`, `mac address-table`, `interfaces trunk`, `interfaces <if> switchport`, plus `router ospf`, `ip dhcp pool`, `ip nat`, `access-list` and `ip access-list`, `spanning-tree`, `channel-group`, `switchport port-security` and the `ipv6` commands, with their `show` and `clear` commands. Output follows real IOS formatting, including the `.!!!!` first ping while ARP resolves.
- A frame trace of every hop, ready for the packet capture panel.

See [docs/design.md](docs/design.md) for the full feature map and roadmap.

## How it works

```mermaid
flowchart LR
  subgraph web["apps/web (React)"]
    canvas["Topology canvas<br/>React Flow"]
    term["Console<br/>xterm.js"]
    lab["Lab sheet"]
  end
  subgraph engine["packages/engine (pure TypeScript, no DOM)"]
    cli["IOS CLI / PC shell"]
    dev["Devices<br/>Router · Switch · PC"]
    topo["Topology"]
    sched["Scheduler<br/>virtual clock"]
    grader["LabRun + checks"]
  end
  term --> cli --> dev
  dev -- "transmit(frame)" --> topo -- "schedule delivery" --> sched -- "receive(frame)" --> dev
  canvas --> topo
  lab --> grader -- "reads state, sends pings" --> dev
```

Devices never call each other. A device hands a frame to the `Topology`, which schedules its delivery on a virtual clock (`Scheduler`). Running the simulation drains that queue in time order. That keeps every run deterministic, makes the engine easy to test without a browser, and lets the UI replay traffic one hop at a time.

The engine is a separate package with no DOM or React imports, so the same code runs in the browser, in Vitest, and in the lab grader. The grader is mostly pure reads of engine state; only ping and traceroute checks send traffic.

Some decisions worth calling out:

- **Real IOS behaviour over shortcuts.** Router ports start shut down, links need both ends enabled, the first ping shows `.!!!!` while ARP resolves, SVIs follow autostate, and output follows real `show` formatting so study notes and simulator output match.
- **Labs graded by state, not by keystrokes.** Any valid configuration that produces the right network passes, so learners can use abbreviations, different orders, or alternative solutions.
- **Every lab is proven solvable.** The test suite types each lab's model answer through the real CLI and requires every objective to pass, so a broken lab fails CI.

## Testing

| Layer | Tool | What it covers |
| --- | --- | --- |
| Engine | Vitest | nearly 300 specs written as small labs: switching, trunks, spanning tree, EtherChannel, port security, IPv4 and IPv6 routing, the IOS CLI, the PC prompt, the scheduler, and every lab in the catalog. Coverage is enforced in CI (95% of lines). |
| App | Playwright | The production build in Chromium: the demo network, pinging across routers, the IOS console, adding and deleting devices, completing a lab end to end, hints, solutions and deep links. |

```bash
npm test              # engine unit tests
npm run coverage      # unit tests with a coverage report (fails under the thresholds)
npm run test:e2e      # build the app and run the Playwright suite
npm run screenshots -w @ccna-sim/web   # regenerate the README images and walkthrough GIF
```

CI runs typecheck, unit tests with coverage, the build and the end-to-end suite on every pull request, and deploys `main` to GitHub Pages.

## Getting started

```bash
npm install
npm run dev           # web app at http://localhost:5173
npm run build         # static build in apps/web/dist
```

Requires Node 20 or newer. The first `npm run test:e2e` needs a browser: `npx playwright install chromium`.

## Layout

```
packages/engine   Simulation engine: pure TypeScript, no DOM, fully unit-tested
  src/core        addressing, frames, discrete-event scheduler, topology
  src/devices     Device base class, IpDevice (shared IPv4 stack), Router, Switch, Pc
  src/cli         IOS command parser, show output formatters, PC command prompt
  src/labs        Lab format, grader checks, LabRun, progress tracking, and the lab catalog
  test/           Vitest specs, written as small labs
apps/web          React + Vite front end: canvas, console, lab catalog and lab sheet, state stores
  e2e/            Playwright specs and the screenshot generator
docs/             Design doc, architecture notes and README images
```

## Writing a lab

Labs live in `packages/engine/src/labs/catalog/` as typed objects: a briefing, a starting topology (devices, cables, and IOS commands to pre-configure them), objectives, and a model answer per device. Each objective pairs a sentence with a check, for example:

```ts
{ text: 'SW1 Gi0/8 trunks VLANs 10, 20, 99 with native VLAN 99',
  check: { type: 'trunk', device: 'SW1', interface: 'Gi0/8', nativeVlan: 99, allowed: [10, 20, 99] },
  hint: 'Verify with `show interfaces trunk`.' }
```

Add the lab's id to the order in `catalog/index.ts` and `npm test` will prove it can be solved.

## Roadmap

Next up: IPv6, Rapid PVST+, FHRP, EtherChannel, port security, DHCP snooping, NTP and SSH, plus the packet capture panel. See [docs/design.md](docs/design.md).

## License

MIT
