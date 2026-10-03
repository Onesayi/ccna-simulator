import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { shortName } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

const ICON: Record<string, string> = { pc: '🖥️', switch: '🔀', router: '📡' };

export function TopologyCanvas() {
  const { topology, select } = useNetwork();

  const { nodes, edges } = useMemo(() => {
    const devices = [...topology.devices.values()];
    const nodes: Node[] = devices.map((d, i) => ({
      id: d.hostname,
      position: d.kind === 'switch' ? { x: 170, y: 40 } : { x: (i - 1) * 340, y: 260 },
      data: { label: `${ICON[d.kind] ?? ''} ${d.hostname}` },
    }));
    const edges: Edge[] = topology.links.map((l) => {
      // Draw cables top-down: the switch end is the source so edges leave its bottom handle.
      const [up, down] = l.b.device.kind === 'switch' ? [l.b, l.a] : [l.a, l.b];
      return {
        id: l.id,
        source: up.device.hostname,
        target: down.device.hostname,
        label: `${shortName(up.name)} – ${shortName(down.name)}`,
      };
    });
    return { nodes, edges };
  }, [topology]);

  return (
    <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, n) => select(n.id)} fitView>
      <Background />
      <Controls />
    </ReactFlow>
  );
}
