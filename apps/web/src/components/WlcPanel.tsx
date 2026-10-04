import { useState } from 'react';
import { wlanSecurity, type WirelessController } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

type Preset = 'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa2-enterprise';

const PRESET_LABEL: Record<Preset, string> = {
  open: 'Open',
  'wpa2-psk': 'WPA2-Personal (PSK)',
  'wpa3-sae': 'WPA3-Personal (SAE)',
  'wpa2-enterprise': 'WPA2-Enterprise (802.1X)',
};

/** The AireOS commands a new-WLAN form stands for: created WLANs start as WPA2 + 802.1X. */
function presetCommands(id: number, preset: Preset, key: string, radius: string): string[] {
  const c = (s: string) => `config wlan security wpa ${s} ${id}`;
  switch (preset) {
    case 'open':
      return [c('disable')];
    case 'wpa2-psk':
      return [c('akm 802.1x disable'), c('akm psk enable'), `config wlan security wpa akm psk set-key ascii ${key} ${id}`];
    case 'wpa3-sae':
      return [c('wpa3 enable'), c('wpa2 disable'), c('akm 802.1x disable'), c('akm sae enable'), `config wlan security wpa akm psk set-key ascii ${key} ${id}`];
    case 'wpa2-enterprise':
      return radius ? [`config wlan radius_server auth add ${id} ${radius}`] : [];
  }
}

/**
 * A controller's web GUI, cut down to the WLANs, APs and clients pages. Every change runs as the
 * equivalent CLI command, and the panel shows those commands so the two views teach each other.
 */
export function WlcPanel({ wlc }: { wlc: WirelessController }) {
  useNetwork((s) => s.version);
  const { shellFor, touch } = useNetwork.getState();
  const [log, setLog] = useState<{ cmd: string; out: string }[]>([]);
  const [form, setForm] = useState({ id: '', ssid: '', preset: 'wpa2-psk' as Preset, key: '', iface: 'management', radius: '' });

  const run = (cmds: string[]) => {
    const shell = shellFor(wlc);
    const results: { cmd: string; out: string }[] = [];
    for (const cmd of cmds) {
      const out = shell.execute(cmd);
      results.push({ cmd: cmd.replace(/(set-key ascii )\S+/, '$1****').replace(/(ascii )\S+$/, '$1****'), out });
      if (out) break;
    }
    setLog(results);
    touch();
  };

  const create = () => {
    const id = Number(form.id) || [...Array(16).keys()].map((n) => n + 1).find((n) => !wlc.wlans.has(n))!;
    const ssid = form.ssid.trim();
    if (!ssid || /\s/.test(ssid)) return setLog([{ cmd: 'New WLAN', out: 'Enter an SSID without spaces.' }]);
    run([
      `config wlan create ${id} ${ssid} ${ssid}`,
      ...(form.iface !== 'management' ? [`config wlan interface ${id} ${form.iface}`] : []),
      ...presetCommands(id, form.preset, form.key, form.radius),
      `config wlan enable ${id}`,
    ]);
  };

  const interfaces = wlc.wlcInterfaces();
  const wlans = [...wlc.wlans.values()].sort((a, b) => a.id - b.id);

  return (
    <div className="wlc-panel">
      <h3>WLANs</h3>
      <table>
        <thead>
          <tr><th>ID</th><th>SSID</th><th>Security</th><th>Interface</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {wlans.length === 0 && <tr><td colSpan={6} className="muted">No WLANs yet.</td></tr>}
          {wlans.map((w) => {
            const sec = wlanSecurity(w);
            return (
              <tr key={w.id}>
                <td>{w.id}</td>
                <td>{w.ssid}</td>
                <td>{typeof sec === 'string' ? PRESET_LABEL[sec] : <span className="bad">incomplete</span>}</td>
                <td>{w.interface} (VLAN {wlc.vlanOf(w) ?? '?'})</td>
                <td>{w.enabled ? 'Enabled' : 'Disabled'}</td>
                <td>
                  <button onClick={() => run([`config wlan ${w.enabled ? 'disable' : 'enable'} ${w.id}`])}>{w.enabled ? 'Disable' : 'Enable'}</button>
                  {!w.enabled && <button onClick={() => run([`config wlan delete ${w.id}`])}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <fieldset className="wlc-form">
        <legend>New WLAN</legend>
        <label>ID <input aria-label="WLAN ID" value={form.id} placeholder="auto" size={4} onChange={(e) => setForm({ ...form, id: e.target.value })} /></label>
        <label>SSID <input aria-label="SSID" value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} /></label>
        <label>
          Security{' '}
          <select aria-label="Security" value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value as Preset })}>
            {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
          </select>
        </label>
        {(form.preset === 'wpa2-psk' || form.preset === 'wpa3-sae') && (
          <label>Passphrase <input aria-label="Passphrase" type="password" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></label>
        )}
        {form.preset === 'wpa2-enterprise' && (
          <label>
            RADIUS{' '}
            <select aria-label="RADIUS server" value={form.radius} onChange={(e) => setForm({ ...form, radius: e.target.value })}>
              <option value="">all servers</option>
              {[...wlc.aaa.servers].filter(([, srv]) => srv.protocol === 'radius').map(([index, srv]) => <option key={index} value={index}>{index}: {srv.address}</option>)}
            </select>
          </label>
        )}
        <label>
          Interface{' '}
          <select aria-label="Interface" value={form.iface} onChange={(e) => setForm({ ...form, iface: e.target.value })}>
            {interfaces.map((i) => <option key={i.name} value={i.name}>{i.name} (VLAN {i.vlan})</option>)}
          </select>
        </label>
        <button onClick={create}>Apply</button>
      </fieldset>

      {log.length > 0 && (
        <pre className="wlc-log" aria-label="Equivalent CLI">
          {log.map((l) => `(${wlc.hostname}) >${l.cmd}${l.out ? `\n${l.out}` : ''}`).join('\n')}
        </pre>
      )}

      <h3>Access points</h3>
      <table>
        <thead>
          <tr><th>AP</th><th>IP</th><th>2.4 GHz</th><th>5 GHz</th></tr>
        </thead>
        <tbody>
          {wlc.aps.size === 0 && <tr><td colSpan={4} className="muted">No APs joined.</td></tr>}
          {[...wlc.aps.values()].map((ap) => {
            const [b, a] = wlc.assigned.get(ap.name) ?? [];
            return <tr key={ap.name}><td>{ap.name}</td><td>{ap.address}</td><td>{b ? `ch ${b}` : ''}</td><td>{a ? `ch ${a}` : ''}</td></tr>;
          })}
        </tbody>
      </table>

      <h3>Clients</h3>
      <table>
        <thead>
          <tr><th>MAC</th><th>AP</th><th>WLAN</th><th>State</th><th>IP</th></tr>
        </thead>
        <tbody>
          {wlc.clients.size === 0 && <tr><td colSpan={5} className="muted">No clients.</td></tr>}
          {[...wlc.clients.values()].map((c) => (
            <tr key={c.mac}><td>{c.mac}</td><td>{c.ap}</td><td>{c.wlan}</td><td>{c.state}</td><td>{c.ip ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
