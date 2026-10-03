import { isValidIp } from '../core/addressing';
import type { InterfaceOspfConfig } from '../devices/device';
import {
  OspfProcess,
  parseArea,
  showIpOspf,
  showIpProtocols,
  showOspfDatabase,
  showOspfInterface,
  showOspfInterfaceBrief,
  showOspfNeighbor,
} from '../routing/ospf';
import { EXEC, IF_MODES, INVALID, abbrev, iface, int, ip, requireRouter, type Command, type Session } from './common';

function proc(s: Session): OspfProcess {
  return s.currentOspf!;
}

function area(text: string | undefined): number {
  if (!text || !(/^\d+$/.test(text) || isValidIp(text))) throw new Error(INVALID);
  return parseArea(text);
}

function setOspf(s: Session, patch: Partial<InterfaceOspfConfig>): void {
  const i = iface(s);
  i.ospf = { ...i.ospf, ...patch };
  for (const k of Object.keys(patch) as (keyof InterfaceOspfConfig)[]) if (patch[k] === undefined) delete i.ospf[k];
}

function processes(s: Session): OspfProcess[] {
  return [...requireRouter(s).ospf.values()];
}

/** Single-area OSPFv2: `router ospf`, interface settings, and the show and clear commands. */
export const OSPF_COMMANDS: Command[] = [
  { syntax: 'router ospf <pid>', modes: ['config', 'config-router'], help: 'Start an OSPF routing process', run: (s, [pid]) => {
    s.currentOspf = requireRouter(s).ospfProcess(int(pid, 1, 65535));
    s.mode = 'config-router';
  } },
  { syntax: 'no router ospf <pid>', modes: ['config'], help: 'Remove an OSPF process', run: (s, [pid]) => {
    const r = requireRouter(s);
    const p = r.ospf.get(int(pid, 1, 65535));
    p?.reset();
    r.ospf.delete(int(pid, 1, 65535));
  } },
  { syntax: 'router-id <ip>', modes: ['config-router'], help: 'Set the OSPF router ID', run: (s, [rid]) => proc(s).setRouterId(ip(rid)) },
  { syntax: 'no router-id', modes: ['config-router'], help: 'Choose the router ID automatically', run: (s) => proc(s).setRouterId(undefined) },
  { syntax: 'network <ip> <wildcard> area <area>', modes: ['config-router'], help: 'Enable OSPF on interfaces matching the address and wildcard', run: (s, [addr, wc, a]) => {
    const p = proc(s);
    const st = { address: ip(addr), wildcard: ip(wc), area: area(a) };
    if (!p.networks.some((n) => n.address === st.address && n.wildcard === st.wildcard)) p.networks.push(st);
  } },
  { syntax: 'no network <ip> <wildcard> area <area>', modes: ['config-router'], help: 'Remove a network statement', run: (s, [addr, wc]) => {
    const p = proc(s);
    const k = p.networks.findIndex((n) => n.address === addr && n.wildcard === wc);
    if (k >= 0) p.networks.splice(k, 1);
  } },
  { syntax: 'passive-interface <name...>', modes: ['config-router'], help: 'Advertise the network but send no hellos (or "default")', run: (s, [name]) => {
    const p = proc(s);
    if (abbrev(name, 'default')) {
      p.passiveDefault = true;
      p.active.clear();
      return;
    }
    const n = s.device.iface(name!).name.toLowerCase();
    if (p.passiveDefault) p.active.delete(n);
    else p.passive.add(n);
  } },
  { syntax: 'no passive-interface <name...>', modes: ['config-router'], help: 'Send hellos on the interface again', run: (s, [name]) => {
    const p = proc(s);
    if (abbrev(name, 'default')) {
      p.passiveDefault = false;
      p.passive.clear();
      return;
    }
    const n = s.device.iface(name!).name.toLowerCase();
    if (p.passiveDefault) p.active.add(n);
    else p.passive.delete(n);
  } },
  { syntax: 'default-information originate', modes: ['config-router'], help: 'Advertise our default route into OSPF', run: (s) => void (proc(s).defaultOriginate = true) },
  { syntax: 'no default-information originate', modes: ['config-router'], help: 'Stop advertising the default route', run: (s) => void (proc(s).defaultOriginate = false) },
  { syntax: 'auto-cost reference-bandwidth <mbps>', modes: ['config-router'], help: 'Bandwidth that gets cost 1, in Mbps', run: (s, [mbps]) => {
    proc(s).referenceBandwidth = int(mbps, 1, 4294967);
    return '% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.';
  } },
  { syntax: 'no auto-cost reference-bandwidth', modes: ['config-router'], help: 'Back to 100 Mbps', run: (s) => void (proc(s).referenceBandwidth = 100) },

  // Interface settings
  { syntax: 'ip ospf <pid> area <area>', modes: IF_MODES, help: 'Enable OSPF on this interface', run: (s, [pid, a]) => {
    const n = int(pid, 1, 65535);
    requireRouter(s).ospfProcess(n);
    setOspf(s, { process: { pid: n, area: area(a) } });
  } },
  { syntax: 'no ip ospf <pid> area <area>', modes: IF_MODES, help: 'Disable OSPF on this interface', run: (s) => setOspf(s, { process: undefined }) },
  { syntax: 'ip ospf cost <cost>', modes: IF_MODES, help: 'Interface cost', run: (s, [c]) => setOspf(s, { cost: int(c, 1, 65535) }) },
  { syntax: 'no ip ospf cost', modes: IF_MODES, help: 'Cost from bandwidth', run: (s) => setOspf(s, { cost: undefined }) },
  { syntax: 'ip ospf priority <0-255>', modes: IF_MODES, help: 'DR election priority (0 = never DR)', run: (s, [p]) => setOspf(s, { priority: int(p, 0, 255) }) },
  { syntax: 'no ip ospf priority', modes: IF_MODES, help: 'Priority 1', run: (s) => setOspf(s, { priority: undefined }) },
  { syntax: 'ip ospf hello-interval <seconds>', modes: IF_MODES, help: 'Seconds between hellos', run: (s, [n]) => setOspf(s, { helloInterval: int(n, 1, 65535) }) },
  { syntax: 'no ip ospf hello-interval', modes: IF_MODES, help: 'Hello every 10 seconds', run: (s) => setOspf(s, { helloInterval: undefined }) },
  { syntax: 'ip ospf dead-interval <seconds>', modes: IF_MODES, help: 'Seconds before a silent neighbor is declared down', run: (s, [n]) => setOspf(s, { deadInterval: int(n, 1, 65535) }) },
  { syntax: 'no ip ospf dead-interval', modes: IF_MODES, help: 'Four hello intervals', run: (s) => setOspf(s, { deadInterval: undefined }) },
  { syntax: 'ip ospf network <type>', modes: IF_MODES, help: 'broadcast | point-to-point', run: (s, [t]) => {
    if (abbrev(t, 'point-to-point')) setOspf(s, { network: 'point-to-point' });
    else if (abbrev(t, 'broadcast')) setOspf(s, { network: 'broadcast' });
    else throw new Error(INVALID);
  } },
  { syntax: 'no ip ospf network', modes: IF_MODES, help: 'Network type from the interface', run: (s) => setOspf(s, { network: undefined }) },
  { syntax: 'bandwidth <kbps>', modes: IF_MODES, help: 'Bandwidth in kbps (used for the OSPF cost)', run: (s, [k]) => void (iface(s).bandwidth = int(k, 1, 10_000_000)) },
  { syntax: 'no bandwidth', modes: IF_MODES, help: 'Bandwidth from the port speed', run: (s) => void (iface(s).bandwidth = undefined) },

  // Show and clear
  { syntax: 'show ip ospf', modes: EXEC, help: 'OSPF process summary', run: (s) => processes(s).map(showIpOspf).join('\n\n') },
  { syntax: 'show ip ospf neighbor', modes: EXEC, help: 'OSPF neighbors and adjacency state', run: (s) => showOspfNeighbor(processes(s)) },
  { syntax: 'show ip ospf interface', modes: EXEC, help: 'OSPF settings per interface', run: (s) =>
    processes(s).flatMap((p) => [...p.ifaces.keys()].map((i) => showOspfInterface(p, i))).join('\n') },
  { syntax: 'show ip ospf interface <name...>', modes: EXEC, help: 'brief | <interface>', run: (s, [name]) => {
    if (abbrev(name, 'brief')) return showOspfInterfaceBrief(processes(s));
    const i = s.device.iface(name!);
    const p = processes(s).find((x) => x.ifaces.has(i)) ?? processes(s)[0];
    if (!p) return '';
    return showOspfInterface(p, i);
  } },
  { syntax: 'show ip ospf database', modes: EXEC, help: 'Link-state database', run: (s) => {
    const now = s.device.network?.scheduler.now ?? 0;
    return processes(s).map((p) => showOspfDatabase(p, now)).join('\n');
  } },
  { syntax: 'show ip protocols', modes: EXEC, help: 'Routing protocol settings', run: (s) => showIpProtocols(processes(s)) },
  { syntax: 'clear ip ospf process', modes: ['privileged'], help: 'Restart OSPF (new router ID, new DR election)', run: (s) => {
    for (const p of processes(s)) p.reset();
    return 'Reset ALL OSPF processes? [no]: yes';
  } },
];
