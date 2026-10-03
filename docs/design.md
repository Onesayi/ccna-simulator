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

## Lab format (draft)

See `labs/01-vlans-basic.json`. A lab has a briefing, a starting topology, and objectives. Each objective is a check the grader runs against engine state, tagged with the blueprint objective it covers.
