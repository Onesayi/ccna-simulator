import { useEffect, useState } from 'react';
import { findLab } from '@ccna-sim/engine';
import { TopologyCanvas } from './components/TopologyCanvas';
import { DeviceTerminal } from './components/DeviceTerminal';
import { LabCatalog } from './components/LabCatalog';
import { LabPanel } from './components/LabPanel';
import { CapturePanel } from './components/CapturePanel';
import { useNetwork } from './state/network';
import { useStudy } from './state/study';

/** Routes: "" is the sandbox, "#/labs" the catalog, "#/labs/<id>" one lab. Links can be shared. */
type Route = { view: 'sandbox' } | { view: 'catalog' } | { view: 'lab'; id: string };

function parseHash(hash: string): Route {
  const m = /^#\/labs(?:\/([\w-]+))?/.exec(hash);
  if (!m) return { view: 'sandbox' };
  return m[1] ? { view: 'lab', id: m[1] } : { view: 'catalog' };
}

function go(hash: string) {
  window.location.hash = hash;
}

export function App() {
  // Subscribing to `version` re-renders the header and console bar after CLI changes (hostname etc).
  const { topology, selectedId, error, capture, addDevice, removeDevice, loadDemo, clear, openCapture, closeCapture } = useNetwork();
  useNetwork((s) => s.version);
  const { run, start, exit } = useStudy();
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Keep the engine in step with the URL: open the lab it names, or hand the canvas back to the sandbox.
  useEffect(() => {
    if (route.view === 'lab') {
      if (!findLab(route.id)) go('#/labs');
      else if (run?.lab.id !== route.id) start(route.id);
    } else if (run) {
      exit();
    }
  }, [route, run, start, exit]);

  const selected = selectedId ? topology.devices.get(selectedId) : undefined;
  const inLab = route.view === 'lab' && run;
  const tab = route.view === 'sandbox' ? 'sandbox' : 'labs';

  return (
    <div className={`layout ${route.view}`}>
      <header>
        <h1>CCNA Simulator</h1>
        <nav className="tabs" aria-label="Mode">
          <button className={tab === 'sandbox' ? 'active' : ''} aria-current={tab === 'sandbox'} onClick={() => go('#/')}>
            Sandbox
          </button>
          <button className={tab === 'labs' ? 'active' : ''} aria-current={tab === 'labs'} onClick={() => go('#/labs')}>
            Labs
          </button>
        </nav>
        {route.view === 'sandbox' && (
          <div className="toolbar" role="toolbar" aria-label="Topology">
            <button onClick={() => addDevice('router')}>+ Router</button>
            <button onClick={() => addDevice('switch')}>+ Switch</button>
            <button onClick={() => addDevice('pc')}>+ PC</button>
            <span className="sep" />
            <button onClick={loadDemo}>Load demo</button>
            <button onClick={() => window.confirm('Start from an empty canvas?') && clear()}>Clear</button>
          </div>
        )}
        {route.view !== 'catalog' && (
          <button className={capture.open ? 'active' : ''} aria-pressed={capture.open} onClick={() => (capture.open ? closeCapture() : openCapture(capture.link))}>
            Capture
          </button>
        )}
        {route.view !== 'catalog' && (
          <span className="hint">
            {error ??
              (inLab
                ? 'Click a device to open its console, or a cable to capture its traffic. Objectives update as you type.'
                : 'Drag between devices to cable them. Click a device to open its console, or a cable to capture its traffic.')}
          </span>
        )}
      </header>

      {route.view === 'catalog' ? (
        <main className="catalog-wrap">
          <LabCatalog onOpen={(id) => go(`#/labs/${id}`)} />
        </main>
      ) : (
        <>
          {inLab && (
            <aside className="lab-panel">
              <LabPanel onBack={() => go('#/labs')} onOpen={(id) => go(`#/labs/${id}`)} />
            </aside>
          )}
          <main className="canvas">
            <div className="flow">
              <TopologyCanvas key={inLab ? run.lab.id : 'sandbox'} />
            </div>
            {capture.open && <CapturePanel canEdit={!inLab} />}
          </main>
          <aside className="console">
            {selected ? (
              <>
                <div className="console-bar">
                  <span>
                    {selected.hostname} <small>{selected.kind}</small>
                  </span>
                  {!inLab && <button onClick={() => removeDevice(selected.id)}>Delete device</button>}
                </div>
                <DeviceTerminal key={selected.id} device={selected} />
              </>
            ) : inLab ? (
              <div className="empty">
                <p>No device selected.</p>
                <p>Click a device on the canvas to open its console, then work through the objectives in the lab sheet.</p>
              </div>
            ) : (
              <div className="empty">
                <p>No device selected.</p>
                <p>
                  Try the demo: open <b>PC1</b> and run <code>ping 192.168.30.10</code> or <code>tracert 192.168.30.10</code>, then open <b>R1</b> and run{' '}
                  <code>enable</code> and <code>show ip route</code>.
                </p>
                <p>
                  Ready for guided practice? Open the <a href="#/labs">Labs</a> tab.
                </p>
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
