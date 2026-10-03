import { TopologyCanvas } from './components/TopologyCanvas';
import { DeviceTerminal } from './components/DeviceTerminal';
import { useNetwork } from './state/network';

export function App() {
  const selected = useNetwork((s) => s.selected);
  return (
    <div className="layout">
      <header>
        <h1>CCNA Simulator</h1>
        <span className="hint">Click a device to open its console</span>
      </header>
      <main className="canvas">
        <TopologyCanvas />
      </main>
      <aside className="console">
        {selected ? <DeviceTerminal key={selected.hostname} device={selected} /> : <p className="empty">No device selected</p>}
      </aside>
    </div>
  );
}
