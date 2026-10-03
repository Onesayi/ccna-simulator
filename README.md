# CCNA Simulator

A browser-based network simulator for studying the Cisco CCNA 200-301 v2.0 exam. Build a topology, configure devices from an IOS-style command line, watch frames cross each link, and work through graded labs mapped to the exam blueprint.

![PC1 pinging and tracing a route across two routers in the demo network](docs/img/ping.png)

## Status

Phase 1 (core engine) is in. What works today:

- **Topology canvas**: add routers, switches and PCs, drag between devices to cable them, click a cable to remove it. Cables turn red and dashed while either end is down. A demo network (two sites, router-on-a-stick, static routes) loads on start.
- **Routers**: GigabitEthernet ports that start shut down, loopbacks, 802.1Q sub-interfaces for router-on-a-stick, connected and local routes, static routes by next hop and/or exit interface, default routes, floating statics (administrative distance), proxy ARP, TTL expiry and ICMP unreachables.
- **Switches**: VLAN-aware MAC learning and flooding, 802.1Q trunks with native and allowed VLANs, MAC aging, SVIs with autostate, `ip default-gateway`, and inter-VLAN routing with `ip routing`.
- **PCs**: a Packet Tracer style command prompt with `ipconfig`, `ping [-n count]`, `tracert` and `arp -a`.
- **IOS CLI**: mode hierarchy with abbreviations (`conf t`, `sh ip int br`), `?` help, `do` from config mode, `interface`, `ip address`, `encapsulation dot1q`, `ip route`, `ip routing`, VLAN and switchport commands, `ping`, `traceroute`, and `show running-config`, `ip route`, `ip arp`, `ip interface brief`, `vlan brief`, `mac address-table`, `interfaces trunk`, `interfaces <if> switchport`. Output follows real IOS formatting, including the `.!!!!` first ping while ARP resolves.
- A frame trace of every hop, ready for the packet capture panel.

See [docs/design.md](docs/design.md) for the full feature map and roadmap.

## Getting started

```bash
npm install
npm test          # engine unit tests (Vitest)
npm run dev       # web app at http://localhost:5173
npm run build     # static build in apps/web/dist
```

Requires Node 20 or newer.

## Layout

```
packages/engine   Simulation engine: pure TypeScript, no DOM, fully unit-tested
  src/core        addressing, frames, discrete-event scheduler, topology
  src/devices     Device base class, IpDevice (shared IPv4 stack), Router, Switch, Pc
  src/cli         IOS command parser, show output formatters, PC command prompt
  test/           Vitest specs, written as small labs
apps/web          React + Vite front end: canvas, console, state store
labs/             Lab definitions (JSON), graded against engine state
docs/             Design doc and architecture notes
```

## How it works

Devices never call each other. A device hands a frame to the `Topology`, which schedules its delivery on a virtual clock (`Scheduler`). Running the simulation drains that queue in time order. This keeps every run deterministic, makes the engine easy to test, and lets the UI replay traffic one hop at a time.

## License

MIT
