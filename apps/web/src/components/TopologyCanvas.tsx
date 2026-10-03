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
import { shortName, type Device } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

const ICON: Record<Device['kind'], string> = { pc: '🖥️', switch: '🔀', router: '📡' };

type DeviceNode = Node<{ device: Device }, 'device'>;

function DeviceNodeView({ data, selected }: NodeProps<DeviceNode>) {
  const d = data.device;
  const addr = d.interfaces.find((i) => i.ip)?.ip;
  return (
    <div className={`device-node ${d.kind}${selected ? ' selected' : ''}`}>
      <Handle type="source" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <span className="icon">{ICON[d.kind]}</span>
      <span className="name">{d.hostname}</span>
      {d.kind === 'pc' && <span className="addr">{addr ? `${addr.address}/${addr.prefix}` : 'no IP'}</span>}
    </div>
  );
}

const nodeTypes = { device: DeviceNodeView };

/** Picks the handle pair that faces each other, so cables do not cross over their own nodes. */
function handles(a: { x: number; y: number }, b: { x: number; y: number }): [string, string] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? ['b', 't'] : ['t', 'b'];
  return dx > 0 ? ['r', 'l'] : ['l', 'r'];
}

export function TopologyCanvas() {
  const { topology, positions, version, selectedId, select, connect, disconnect, removeDevice, move } = useNetwork();

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
      const pa = positions.get(l.a.device.id) ?? { x: 0, y: 0 };
      const pb = positions.get(l.b.device.id) ?? { x: 0, y: 0 };
      const [sh, th] = handles(pa, pb);
      return {
        id: l.id,
        source: l.a.device.id,
        target: l.b.device.id,
        sourceHandle: sh,
        targetHandle: th,
        label: `${shortName(l.a.name)} – ${shortName(l.b.name)}`,
        className: up ? 'link-up' : 'link-down',
        data: { up },
      };
    });
    return { nodes, edges };
    // `version` is the signal that engine state changed underneath the same topology object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, positions, version, selectedId]);

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
      onEdgeClick={(_, e) => {
        if (window.confirm(`Remove the cable ${String(e.label)}?`)) disconnect(e.id);
      }}
      deleteKeyCode="Delete"
      fitView
      fitViewOptions={{ padding: 0.25 }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
