import { create } from 'zustand';
import { Pc, Switch, Topology, type Device } from '@ccna-sim/engine';

/** Starter topology: two PCs on one switch. Labs will replace this with their own starting state. */
function demoTopology(): Topology {
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const pc1 = net.add(new Pc('PC1'));
  const pc2 = net.add(new Pc('PC2'));
  net.connect(pc1.nic, sw.iface('Gi0/1'));
  net.connect(pc2.nic, sw.iface('Gi0/2'));
  pc1.configure('192.168.10.11', 24);
  pc2.configure('192.168.10.12', 24);
  return net;
}

interface NetworkState {
  topology: Topology;
  selected?: Device;
  /** Bumped after every simulation run so views re-read engine state. */
  version: number;
  select: (hostname: string) => void;
  run: () => void;
}

export const useNetwork = create<NetworkState>((set, get) => ({
  topology: demoTopology(),
  version: 0,
  select: (hostname) => set({ selected: get().topology.get(hostname) }),
  run: () => {
    get().topology.run();
    set((s) => ({ version: s.version + 1 }));
  },
}));
