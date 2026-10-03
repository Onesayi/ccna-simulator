# Design

The full scope and design doc lives in the project's Claude Doc "CCNA Simulator: Scope and Design". Summary:

- **Goal:** a CCNA 200-301 v2.0 study tool that also works as a portfolio demo (static site, no server).
- **Stack:** TypeScript monorepo; pure engine package; React + Vite UI; React Flow canvas; xterm.js console; Zustand; Vitest and Playwright; GitHub Pages.
- **Phases:** 1 core engine (switching, VLANs, trunks, SVIs, static routing, ping/traceroute, CDP/LLDP, show commands, capture panel) · 2 study mode (labs, grader, progress) · 3 portfolio polish · 4 protocol expansion (OSPF, DHCP, NAT and ACLs done; IPv6, Rapid PVST+, FHRP, DNS, EtherChannel to come) · 5 security and operations.

## Engine rules

1. The engine has no DOM or React imports. Anything the UI shows comes from engine state.
2. Devices talk only through `Topology.transmit`; delivery is a scheduled event.
3. Every protocol feature ships with a Vitest spec written as a tiny lab.
4. CLI output mirrors real IOS formatting closely enough that study notes and real show output match.

## Study mode

- **Lab format:** `packages/engine/src/labs/types.ts`. A lab has a briefing, an optional addressing table, a starting topology, objectives, a model answer per device and a debrief. It is tagged with its blueprint domain and objectives.
- **Grader:** `LabRun` builds the lab's topology and keeps devices keyed by their lab hostname, so a learner renaming a device does not break grading. Checks are pure reads of engine state, except `ping`, `traceroute` and `connect`, which send traffic and so only run on "Check my work". Quiz objectives are graded from the learner's answer.
- **Progress:** `Progress` holds pure state transitions (start, check, hint, solution); the web app persists the store in `localStorage` under `ccna-sim:progress:v1`.
- **Tests:** every lab must start unsolved and be fully solved by typing its model answer into the real CLI.
- **Gaps:** Lab state is not saved mid-attempt; leaving a lab resets it. Domain 5.0 has one lab so far (syslog); port security, DHCP snooping, SSH and AAA need engine support first.

## Protocols (Phase 4, first pass)

- **Convergence:** `Topology.converge()` runs after every CLI command, cabling change and lab setup. It runs rounds of `tick()` (send hellos, retry DHCP) then `settle()` (expire neighbors, elect, originate LSAs, run SPF) until nothing changes. One round stands for one hello interval, so the simulator shows the converged state straight away instead of making learners wait 40 seconds.
- **OSPF:** single-area OSPFv2 (`packages/engine/src/routing/ospf.ts`). A neighbor not heard in a round is dead. Database exchange is simplified: a DBD carries full LSAs and the adjacency goes straight to FULL, so EXCHANGE and LOADING are not visible. LSAs do not age; a flush leaves a tombstone so stale copies cannot come back. Timer and mask mismatches are silent, as on IOS; area mismatches and duplicate router IDs are logged.
- **DHCP, NAT, ACLs** (`packages/engine/src/services`): DHCP runs DORA with retransmits (routers drop the packet that triggers ARP, as on IOS), relays through `ip helper-address` using giaddr, and gives PCs an APIPA address when no server answers. NAT handles static, pool and overload (PAT, keyed on ICMP id or TCP port) and answers ARP for its global addresses. ACLs are evaluated inbound before routing and outbound after; a deny returns an ICMP unreachable, and outbound ACLs never filter the router's own traffic.
- **IP pipeline:** receive, ARP and DHCP, ACL in, OSPF, NAT outside-to-inside, then local delivery or forwarding (TTL, route lookup, NAT inside-to-outside, ACL out).
