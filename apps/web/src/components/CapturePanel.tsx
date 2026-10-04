import { useMemo, useState } from 'react';
import { compileFilter, dissect, isKeepalive, shortName, summarize, type FramePredicate, type Link, type TraceEntry } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

/** Rows drawn at most; older matches scroll off the top, like a live Wireshark capture. */
const MAX_ROWS = 400;

function linkName(l: Link): string {
  return `${l.a.device.hostname} ${shortName(l.a.name)} ↔ ${l.b.device.hostname} ${shortName(l.b.name)}`;
}

/**
 * A Wireshark-style view of the frames crossing one cable (or every cable): a list with
 * protocol, addresses and info, a display filter, and a layer-by-layer detail pane.
 */
export function CapturePanel({ canEdit }: { canEdit: boolean }) {
  const { topology, version, capture, openCapture, closeCapture, disconnect } = useNetwork();
  const [filterText, setFilterText] = useState('');
  const [hideKeepalives, setHideKeepalives] = useState(true);
  /** Frames numbered at or below this were cleared from view. */
  const [clearedAt, setClearedAt] = useState(0);
  const [selectedNo, setSelectedNo] = useState<number>();

  const { predicate, filterError } = useMemo(() => {
    try {
      return { predicate: compileFilter(filterText), filterError: undefined };
    } catch (err) {
      return { predicate: (() => true) as FramePredicate, filterError: (err as Error).message };
    }
  }, [filterText]);

  const rows = useMemo(() => {
    const out: TraceEntry[] = [];
    for (const e of topology.trace) {
      if (e.no <= clearedAt) continue;
      if (capture.link && e.link !== capture.link) continue;
      if (hideKeepalives && isKeepalive(e.frame)) continue;
      if (!predicate(e.frame)) continue;
      out.push(e);
    }
    return out.slice(-MAX_ROWS);
    // `version` signals new frames in the same trace array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, version, capture.link, hideKeepalives, predicate, clearedAt]);

  const selected = rows.find((e) => e.no === selectedNo);
  const t0 = rows[0]?.at ?? 0;
  const link = topology.links.find((l) => l.id === capture.link);

  return (
    <section className="capture" aria-label="Packet capture">
      <div className="capture-bar">
        <strong>Capture</strong>
        <select aria-label="Cable" value={capture.link ?? ''} onChange={(e) => openCapture(e.target.value || undefined)}>
          <option value="">All cables</option>
          {topology.links.map((l) => (
            <option key={l.id} value={l.id}>
              {linkName(l)}
            </option>
          ))}
        </select>
        <input
          aria-label="Display filter"
          className={filterError ? 'filter invalid' : 'filter'}
          placeholder="Filter: icmp, arp, dhcp, ip.addr == 10.0.0.1, vlan == 10, !stp"
          title={filterError}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <label className="small">
          <input type="checkbox" checked={hideKeepalives} onChange={(e) => setHideKeepalives(e.target.checked)} /> Hide keepalives
        </label>
        <button onClick={() => setClearedAt(topology.trace.at(-1)?.no ?? 0)}>Clear</button>
        {canEdit && link && <button onClick={() => window.confirm(`Remove the cable ${linkName(link)}?`) && disconnect(link.id)}>Remove cable</button>}
        <button aria-label="Close capture" onClick={closeCapture}>
          ✕
        </button>
      </div>
      <div className="capture-body">
        <div className="capture-list">
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>Time</th>
                <th>From → To</th>
                <th>Source</th>
                <th>Destination</th>
                <th>Protocol</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const s = summarize(e.frame);
                return (
                  <tr key={e.no} className={`proto-${s.protocol.toLowerCase()}${e.no === selectedNo ? ' selected' : ''}`} onClick={() => setSelectedNo(e.no)}>
                    <td>{e.no}</td>
                    <td>{((e.at - t0) / 1000).toFixed(3)}</td>
                    <td>
                      {e.from} → {e.to}
                    </td>
                    <td>{s.source}</td>
                    <td>{s.destination}</td>
                    <td>{s.protocol}</td>
                    <td>{s.info}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="muted small capture-empty">No frames yet. Send some traffic (a ping, a DHCP renew) and it shows up here.</p>}
        </div>
        <div className="capture-detail">
          {selected ? (
            dissect(selected.frame).map((layer) => (
              <details key={layer.title} open>
                <summary>{layer.title}</summary>
                <dl>
                  {layer.fields.map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}:</dt> <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ))
          ) : (
            <p className="muted small">Click a frame to see its headers, layer by layer.</p>
          )}
        </div>
      </div>
    </section>
  );
}
