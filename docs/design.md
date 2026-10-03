# Design

The full scope and design doc lives in the project's Claude Doc "CCNA Simulator: Scope and Design". Summary:

- **Goal:** a CCNA 200-301 v2.0 study tool that also works as a portfolio demo (static site, no server).
- **Stack:** TypeScript monorepo; pure engine package; React + Vite UI; React Flow canvas; xterm.js console; Zustand; Vitest and Playwright; GitHub Pages.
- **Phases:** 1 core engine (switching, VLANs, trunks, SVIs, static routing, ping/traceroute, CDP/LLDP, show commands, capture panel) · 2 study mode (labs, grader, progress) · 3 portfolio polish · 4 protocol expansion (IPv6, DHCP, Rapid PVST+, OSPF, FHRP, NAT, ACLs, DNS, EtherChannel) · 5 security and operations.

## Engine rules

1. The engine has no DOM or React imports. Anything the UI shows comes from engine state.
2. Devices talk only through `Topology.transmit`; delivery is a scheduled event.
3. Every protocol feature ships with a Vitest spec written as a tiny lab.
4. CLI output mirrors real IOS formatting closely enough that study notes and real show output match.

## Study mode

- **Lab format:** `packages/engine/src/labs/types.ts`. A lab has a briefing, an optional addressing table, a starting topology, objectives, a model answer per device and a debrief. It is tagged with its blueprint domain and objectives.
- **Grader:** `LabRun` builds the lab's topology and keeps devices keyed by their lab hostname, so a learner renaming a device does not break grading. Checks are pure reads of engine state, except `ping` and `traceroute`, which send traffic and so only run on "Check my work". Quiz objectives are graded from the learner's answer.
- **Progress:** `Progress` holds pure state transitions (start, check, hint, solution); the web app persists the store in `localStorage` under `ccna-sim:progress:v1`.
- **Tests:** every lab must start unsolved and be fully solved by typing its model answer into the real CLI.
- **Gaps:** labs for domains 4.0 and 5.0 wait on the Phase 4 and 5 protocols. Lab state is not saved mid-attempt; leaving a lab resets it.
