import { useMemo } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { LightweightAp, Pc, Switch, WirelessController, shortName, type Device, type Interface } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

const ICON: Record<Device['kind'], string> = { pc: '🖥️', server: '🗄️', switch: '🔀', router: '📡', wlc: '🎛️', ap: '📶' };

function icon(d: Device): string {
  return d instanceof Pc && d.wifi ? '💻' : ICON[d.kind];
}

/** The small grey line under a node's name. */
function subtitle(d: Device): string | undefined {
  if (d instanceof LightweightAp) return d.controller ? `joined ${d.controller.name}` : d.nic.ip && !d.apipa ? 'not joined' : 'no IP';
  if (d instanceof WirelessController) return d.management.ip ? d.management.ip.address : 'no mgmt IP';
  if (d instanceof Pc) {
    const addr = d.nic.ip;
    const v6 = d.nic.ipv6?.addresses[0];
    if (d.wifi && !d.wifi.connected) return 'Wi-Fi off';
    return addr ? `${addr.address}/${addr.prefix}` : v6 ? `${v6.address}/${v6.prefix}` : 'no IP';
  }
  return undefined;
}

type DeviceNode = Node<{ device: Device }, 'device'>;

function DeviceNodeView({ data, selected }: NodeProps<DeviceNode>) {
  const d = data.device;
  const sub = subtitle(d);
  return (
    <div className={`device-node ${d.kind}${selected ? ' selected' : ''}`}>
      <Handle type="source" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <span className="icon">{icon(d)}</span>
      <span className="name">{d.hostname}</span>
      {sub && <span className="addr">{sub}</span>}
    </div>
  );
}

const nodeTypes = { device: DeviceNodeView };

/** VLANs spanning tree discards in on this end of a cable. */
function blockedVlans(i: Interface): number[] {
  const d = i.device;
  return d instanceof Switch ? d.stp.blockedVlans(d.logicalOf(i)) : [];
}

/** "Po1" when the port is bundled into an EtherChannel. */
function channel(i: Interface): string | undefined {
  return i.bundled && i.channelGroup ? `Po${i.channelGroup.id}` : undefined;
}

/** Picks the handle pair that faces each other, so cables do not cross over their own nodes. */
function handles(a: { x: number; y: number }, b: { x: number; y: number }): [string, string] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? ['b', 't'] : ['t', 'b'];
  return dx > 0 ? ['r', 'l'] : ['l', 'r'];
}

export function TopologyCanvas() {
  const { topology, positions, version, selectedId, capture, select, connect, disconnect, removeDevice, move, openCapture } = useNetwork();

  const { nodes, edges } = useMemo(() => {
    const nodes: DeviceNode[] = [...topology.devices.values()].map((d) => ({
      id: d.id,
      type: 'device',
      position: positions.get(d.id) ?? { x: 0, y: 0 },
      data: { device: d },
      selected: d.id === selectedId,
    }));
    const edges: Edge[] = topology.links.map((l) => {
      const up = l.a.isUp && l.b.isUp;
      const vlans = up ? [...new Set([...blockedVlans(l.a), ...blockedVlans(l.b)])].sort((x, y) => x - y) : [];
      const blocked = vlans.length > 0;
      const po = channel(l.a) ?? channel(l.b);
      const errDisabled = l.a.errDisabled ?? l.b.errDisabled;
      const pa = positions.get(l.a.device.id) ?? { x: 0, y: 0 };
      const pb = positions.get(l.b.device.id) ?? { x: 0, y: 0 };
      const [sh, th] = handles(pa, pb);
      return {
        id: l.id,
        source: l.a.device.id,
        target: l.b.device.id,
        sourceHandle: sh,
        targetHandle: th,
        label: [`${shortName(l.a.name)} – ${shortName(l.b.name)}`, po, blocked && `STP blocks VLAN ${vlans.join(', ')}`, errDisabled && 'err-disabled'].filter(Boolean).join(' · '),
        className: [!up ? 'link-down' : blocked ? 'link-blocked' : po ? 'link-up link-bundled' : 'link-up', capture.open && capture.link === l.id && 'link-captured'].filter(Boolean).join(' '),
        data: { up, blocked },
      };
    });
    // Wi-Fi: a dashed line from each associated laptop to its AP. Clicking it captures that AP's air.
    for (const d of topology.devices.values()) {
      const bss = d instanceof Pc && d.wifi?.connected ? d.wifi.bss : undefined;
      if (!bss) continue;
      const ap = bss.radio.device;
      const [sh, th] = handles(positions.get(d.id) ?? { x: 0, y: 0 }, positions.get(ap.id) ?? { x: 0, y: 0 });
      edges.push({
        id: `air:${ap.id}:${d.id}`,
        source: d.id,
        target: ap.id,
        sourceHandle: sh,
        targetHandle: th,
        label: `${bss.wlan.ssid} · ch ${bss.channel}`,
        className: ['link-air', capture.open && capture.link === `air:${ap.id}` && 'link-captured'].filter(Boolean).join(' '),
        deletable: false,
      });
    }
    return { nodes, edges };
    // `version` is the signal that engine state changed underneath the same topology object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, positions, version, selectedId, capture]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      connectionMode={ConnectionMode.Loose}
      onNodeClick={(_, n) => select(n.id)}
      onPaneClick={() => select(undefined)}
      onNodesChange={(changes) => {
        for (const c of changes) {
          if (c.type === 'position' && c.position) move(c.id, c.position);
        }
        if (changes.some((c) => c.type === 'position')) useNetwork.getState().touch(false);
      }}
      onConnect={(c) => connect(c.source, c.target)}
      onNodesDelete={(ns) => ns.forEach((n) => removeDevice(n.id))}
      onEdgeClick={(_, e) => openCapture(e.id.startsWith('air:') ? e.id.split(':').slice(0, 2).join(':') : e.id)}
      onEdgesDelete={(es) => es.forEach((e) => disconnect(e.id))}
      deleteKeyCode="Delete"
      fitView
      fitViewOptions={{ padding: 0.25 }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
