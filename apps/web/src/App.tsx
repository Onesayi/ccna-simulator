import { TopologyCanvas } from './components/TopologyCanvas';
import { DeviceTerminal } from './components/DeviceTerminal';
import { useNetwork } from './state/network';

export function App() {
  // Subscribing to `version` re-renders the header and console bar after CLI changes (hostname etc).
  const { topology, selectedId, error, addDevice, removeDevice, loadDemo, clear } = useNetwork();
  useNetwork((s) => s.version);
  const selected = selectedId ? topology.devices.get(selectedId) : undefined;
  return (
    <div className="layout">
      <header>
        <h1>CCNA Simulator</h1>
        <div className="toolbar" role="toolbar" aria-label="Topology">
          <button onClick={() => addDevice('router')}>+ Router</button>
          <button onClick={() => addDevice('switch')}>+ Switch</button>
          <button onClick={() => addDevice('pc')}>+ PC</button>
          <span className="sep" />
          <button onClick={loadDemo}>Load demo</button>
          <button onClick={() => window.confirm('Start from an empty canvas?') && clear()}>Clear</button>
        </div>
        <span className="hint">{error ?? 'Drag between devices to cable them. Click a device to open its console. Click a cable to remove it.'}</span>
      </header>
      <main className="canvas">
        <TopologyCanvas />
      </main>
      <aside className="console">
        {selected ? (
          <>
            <div className="console-bar">
              <span>
                {selected.hostname} <small>{selected.kind}</small>
              </span>
              <button onClick={() => removeDevice(selected.id)}>Delete device</button>
            </div>
            <DeviceTerminal key={selected.id} device={selected} />
          </>
        ) : (
          <div className="empty">
            <p>No device selected.</p>
            <p>Try the demo: open <b>PC1</b> and run <code>ping 192.168.30.10</code> or <code>tracert 192.168.30.10</code>, then open <b>R1</b> and run <code>enable</code> and <code>show ip route</code>.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
