import { create } from 'zustand';
import { CliSession, Pc, Router, Switch, Topology, createDevice, createShell, type Device, type Shell } from '@ccna-sim/engine';

export type DeviceKind = Device['kind'];
/** What the toolbar can add: every device kind, plus a laptop (a PC with Wi-Fi). */
export type PaletteKind = DeviceKind | 'laptop';
export interface XY {
  x: number;
  y: number;
}

/** Runs IOS commands from privileged EXEC, used to script the demo topology. */
function script(device: Device, commands: string): void {
  const cli = new CliSession(device, { loggedIn: true });
  cli.execute('enable');
  for (const line of commands.trim().split('\n')) cli.execute(line.trim());
}

/**
 * Demo: two sites joined by R1 and R2 with static routes. Site A uses router-on-a-stick for
 * VLAN 10 and 20; site B is a single LAN. Everything is configured through the CLI, so
 * `show running-config` on any device shows how it was built.
 */
function demoTopology(): { topology: Topology; positions: Map<string, XY> } {
  const net = new Topology();
  const r1 = net.add(new Router('R1'));
  const r2 = net.add(new Router('R2'));
  const sw1 = net.add(new Switch('SW1'));
  const sw2 = net.add(new Switch('SW2'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  const pc3 = net.add(new Pc('PC3'));
  net.connect(r1.iface('g0/1'), r2.iface('g0/1'));
  net.connect(r1.iface('g0/0'), sw1.iface('g0/8'));
  net.connect(r2.iface('g0/0'), sw2.iface('g0/8'));
  net.connect(pc1.nic, sw1.iface('g0/1'));
  net.connect(pc2.nic, sw1.iface('g0/2'));
  net.connect(pc3.nic, sw2.iface('g0/1'));

  script(r1, `conf t
    int g0/0
    no shut
    int g0/0.10
    encapsulation dot1q 10
    ip address 192.168.10.1 255.255.255.0
    int g0/0.20
    encapsulation dot1q 20
    ip address 192.168.20.1 255.255.255.0
    int g0/1
    description Link to R2
    ip address 10.0.12.1 255.255.255.252
    no shut
    exit
    ip route 192.168.30.0 255.255.255.0 10.0.12.2`);
  script(r2, `conf t
    int g0/0
    ip address 192.168.30.1 255.255.255.0
    no shut
    int g0/1
    description Link to R1
    ip address 10.0.12.2 255.255.255.252
    no shut
    exit
    ip route 192.168.10.0 255.255.255.0 10.0.12.1
    ip route 192.168.20.0 255.255.255.0 10.0.12.1`);
  script(sw1, `conf t
    vlan 10
    name SALES
    vlan 20
    name ENG
    int g0/1
    switchport mode access
    switchport access vlan 10
    int g0/2
    switchport mode access
    switchport access vlan 20
    int g0/8
    switchport mode trunk`);
  pc1.configure('192.168.10.10', 24, '192.168.10.1');
  pc2.configure('192.168.20.10', 24, '192.168.20.1');
  pc3.configure('192.168.30.10', 24, '192.168.30.1');

  const positions = new Map<string, XY>([
    [r1.id, { x: 0, y: 0 }],
    [r2.id, { x: 420, y: 0 }],
    [sw1.id, { x: 0, y: 160 }],
    [sw2.id, { x: 420, y: 160 }],
    [pc1.id, { x: -120, y: 320 }],
    [pc2.id, { x: 120, y: 320 }],
    [pc3.id, { x: 420, y: 320 }],
  ]);
  return { topology: net, positions };
}

const PREFIX: Record<PaletteKind, string> = { router: 'R', switch: 'SW', pc: 'PC', laptop: 'LAPTOP', server: 'SRV', wlc: 'WLC', ap: 'AP' };

function nextHostname(topology: Topology, kind: PaletteKind): string {
  for (let n = 1; ; n++) if (!topology.find(`${PREFIX[kind]}${n}`)) return `${PREFIX[kind]}${n}`;
}

interface NetworkState {
  topology: Topology;
  positions: Map<string, XY>;
  /** One shell per device so the CLI mode survives switching between consoles. */
  shells: Map<string, Shell>;
  selectedId?: string;
  /** Bumped after anything changes engine state or the canvas so views re-read it. */
  version: number;
  /** Bumped only when the network itself may have changed (commands, cabling), not when a node is dragged. */
  configVersion: number;
  error?: string;
  /** The packet capture panel: open or not, and the cable it shows (all cables when unset). */
  capture: { open: boolean; link?: string };
  openCapture: (link?: string) => void;
  closeCapture: () => void;
  select: (id: string | undefined) => void;
  shellFor: (device: Device) => Shell;
  /** Call after running a command: the engine may have changed. Pass `false` for cosmetic changes. */
  touch: (config?: boolean) => void;
  /** Swaps in another network, such as a lab's. */
  load: (topology: Topology, positions: Map<string, XY>) => void;
  addDevice: (kind: PaletteKind, at?: XY) => void;
  removeDevice: (id: string) => void;
  connect: (aId: string, bId: string) => void;
  disconnect: (linkId: string) => void;
  move: (id: string, at: XY) => void;
  loadDemo: () => void;
  clear: () => void;
}

export const useNetwork = create<NetworkState>((set, get) => ({
  ...demoTopology(),
  shells: new Map(),
  version: 0,
  configVersion: 0,
  capture: { open: false },
  openCapture: (link) => set({ capture: { open: true, link } }),
  closeCapture: () => set((s) => ({ capture: { ...s.capture, open: false } })),
  select: (id) => set({ selectedId: id }),
  shellFor: (device) => {
    const { shells } = get();
    let shell = shells.get(device.id);
    if (!shell) shells.set(device.id, (shell = createShell(device)));
    return shell;
  },
  touch: (config = true) => set((s) => ({ version: s.version + 1, configVersion: s.configVersion + (config ? 1 : 0) })),
  load: (topology, positions) =>
    set((s) => ({
      topology,
      positions,
      shells: new Map(),
      selectedId: undefined,
      error: undefined,
      capture: { open: s.capture.open },
      version: s.version + 1,
      configVersion: s.configVersion + 1,
    })),
  addDevice: (kind, at) => {
    const { topology, positions } = get();
    const hostname = nextHostname(topology, kind);
    const device = topology.add(kind === 'laptop' ? createDevice('pc', hostname, { wireless: true }) : createDevice(kind, hostname));
    topology.converge();
    const n = topology.devices.size;
    positions.set(device.id, at ?? { x: 60 + (n % 5) * 140, y: 480 + Math.floor(n / 5) * 120 });
    set((s) => ({ version: s.version + 1, configVersion: s.configVersion + 1, selectedId: device.id, error: undefined }));
  },
  removeDevice: (id) => {
    const { topology, positions, shells, selectedId } = get();
    const device = topology.devices.get(id);
    if (!device) return;
    topology.remove(device);
    topology.converge();
    positions.delete(id);
    shells.delete(id);
    set((s) => ({ version: s.version + 1, configVersion: s.configVersion + 1, selectedId: selectedId === id ? undefined : selectedId }));
  },
  connect: (aId, bId) => {
    const { topology } = get();
    const a = topology.devices.get(aId);
    const b = topology.devices.get(bId);
    if (!a || !b || a === b) return;
    const [pa] = a.freePorts();
    const [pb] = b.freePorts();
    const wireless = [a, b].find((d) => d instanceof Pc && d.wifi);
    if (wireless) return set({ error: `${wireless.hostname} has no cable port: open its console and join a WLAN with netsh wlan connect` });
    if (!pa || !pb) return set({ error: `${!pa ? a.hostname : b.hostname} has no free ports` });
    topology.connect(pa, pb);
    topology.converge();
    set((s) => ({ version: s.version + 1, configVersion: s.configVersion + 1, error: undefined }));
  },
  disconnect: (linkId) => {
    const { topology } = get();
    const link = topology.links.find((l) => l.id === linkId);
    if (link) topology.disconnect(link);
    topology.converge();
    set((s) => ({ version: s.version + 1, configVersion: s.configVersion + 1, capture: s.capture.link === linkId ? { open: s.capture.open } : s.capture }));
  },
  move: (id, at) => {
    get().positions.set(id, at);
  },
  loadDemo: () => {
    const { topology, positions } = demoTopology();
    get().load(topology, positions);
  },
  clear: () => get().load(new Topology(), new Map()),
}));
