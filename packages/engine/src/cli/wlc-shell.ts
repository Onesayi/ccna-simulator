import { isValidIp, parsePrefix, prefixToMask } from '../core/addressing';
import { WirelessController, wlanSecurity, type Wlan } from '../devices/wlc';
import { Interaction, type Shell } from './remote';

const SECURITY_NAMES = { open: 'None', 'wpa2-psk': '[WPA2][Auth(PSK)]', 'wpa3-sae': '[WPA3][Auth(SAE)]', 'wpa2-enterprise': '[WPA2][Auth(802.1X)]' } as const;

interface WlcCommand {
  syntax: string;
  help: string;
  run(shell: WlcShell, args: string[]): string | void;
}

const INCORRECT = 'Incorrect input! Use \'help\' to list commands.';

function wlanId(s: string | undefined): number {
  const id = Number(s);
  if (!Number.isInteger(id) || id < 1 || id > 512) throw new Error('Incorrect input! WLAN identifier must be 1 to 512.');
  return id;
}

function ip(s: string | undefined): string {
  if (!s || !isValidIp(s)) throw new Error(`Incorrect input! ${s ?? ''} is not a valid IP address.`);
  return s;
}

function vlanId(s: string | undefined): number {
  const v = Number(s);
  if (!Number.isInteger(v) || v < 0 || v > 4094) throw new Error('Incorrect input! VLAN identifier must be 0 (untagged) to 4094.');
  return v;
}

function onOff(s: string | undefined): boolean {
  if (s === 'enable') return true;
  if (s === 'disable') return false;
  throw new Error(INCORRECT);
}

const COMMANDS: WlcCommand[] = [
  // ---- show
  { syntax: 'show sysinfo', help: 'System name, version and management address', run: (sh) => sh.sysinfo() },
  { syntax: 'show interface summary', help: 'Controller interfaces', run: (sh) => sh.interfaceSummary() },
  { syntax: 'show wlan summary', help: 'Configured WLANs', run: (sh) => sh.wlanSummary() },
  { syntax: 'show wlan <id>', help: 'One WLAN in detail', run: (sh, [id]) => sh.wlanDetail(wlanId(id)) },
  { syntax: 'show ap summary', help: 'Joined access points', run: (sh) => sh.apSummary() },
  { syntax: 'show client summary', help: 'Wireless clients', run: (sh) => sh.clientSummary() },
  { syntax: 'show radius summary', help: 'RADIUS authentication servers', run: (sh) => sh.radiusSummary() },
  { syntax: 'show advanced 802.11b summary', help: '2.4 GHz channels per AP', run: (sh) => sh.channelSummary('b') },
  { syntax: 'show advanced 802.11a summary', help: '5 GHz channels per AP', run: (sh) => sh.channelSummary('a') },
  { syntax: 'show msglog', help: 'Controller event log', run: (sh) => sh.wlc.msglog.join('\n') || 'No messages.' },
  { syntax: 'show run-config commands', help: 'The configuration as commands', run: (sh) => sh.config().join('\n') },
  // ---- system and interfaces
  { syntax: 'config sysname <name>', help: 'Controller name', run: (sh, [name]) => void (sh.wlc.hostname = name!) },
  { syntax: 'config interface address management <ip> <mask> <gateway>', help: 'Management address', run: (sh, [a, m, g]) => sh.wlc.setInterfaceAddress('management', ip(a), parsePrefix(m!), ip(g)) },
  { syntax: 'config interface vlan <name> <vlan>', help: 'VLAN of an interface (0 = untagged)', run: (sh, [name, v]) => {
    const i = sh.wlc.findIface(name!);
    if (!i || i.kind !== 'subinterface') throw new Error(`Request failed - interface ${name} does not exist.`);
    sh.wlc.setVlan(i, vlanId(v));
  } },
  { syntax: 'config interface create <name> <vlan>', help: 'Dynamic interface for client traffic', run: (sh, [name, v]) => void sh.wlc.addWlcInterface(name!, vlanId(v)) },
  { syntax: 'config interface address dynamic-interface <name> <ip> <mask> <gateway>', help: 'Address of a dynamic interface', run: (sh, [name, a, m, g]) => sh.wlc.setInterfaceAddress(name!, ip(a), parsePrefix(m!), ip(g)) },
  { syntax: 'config interface delete <name>', help: 'Remove a dynamic interface', run: (sh, [name]) => sh.wlc.deleteWlcInterface(name!) },
  // ---- WLANs
  { syntax: 'config wlan create <id> <profile> <ssid>', help: 'New WLAN (disabled, WPA2 + 802.1X)', run: (sh, [id, p, s]) => void sh.wlc.createWlan(wlanId(id), p!, s!) },
  { syntax: 'config wlan delete <id>', help: 'Remove a WLAN', run: (sh, [id]) => {
    const w = sh.disabledWlan(id);
    sh.wlc.wlans.delete(w.id);
  } },
  { syntax: 'config wlan enable <id>', help: 'Start broadcasting a WLAN', run: (sh, [id]) => {
    const w = sh.wlan(id);
    const security = wlanSecurity(w);
    if (typeof security !== 'string') throw new Error(`Request failed - ${security.error}`);
    if (!sh.wlc.findIface(w.interface)?.ip) throw new Error(`Request failed - interface ${w.interface} has no address.`);
    w.enabled = true;
  } },
  { syntax: 'config wlan disable <id>', help: 'Stop a WLAN', run: (sh, [id]) => sh.wlc.disableWlan(sh.wlan(id)) },
  { syntax: 'config wlan interface <id> <name>', help: 'Map a WLAN to an interface (its VLAN)', run: (sh, [id, name]) => {
    const w = sh.disabledWlan(id);
    const i = sh.wlc.findIface(name!);
    if (!i || i.kind !== 'subinterface') throw new Error(`Request failed - interface ${name} does not exist.`);
    w.interface = i.name;
  } },
  { syntax: 'config wlan security wpa <state> <id>', help: 'enable|disable WPA (disable = open)', run: (sh, [st, id]) => void (sh.disabledWlan(id).wpa = onOff(st)) },
  { syntax: 'config wlan security wpa wpa2 <state> <id>', help: 'enable|disable WPA2', run: (sh, [st, id]) => void (sh.disabledWlan(id).wpa2 = onOff(st)) },
  { syntax: 'config wlan security wpa wpa3 <state> <id>', help: 'enable|disable WPA3', run: (sh, [st, id]) => void (sh.disabledWlan(id).wpa3 = onOff(st)) },
  { syntax: 'config wlan security wpa akm psk <state> <id>', help: 'enable|disable PSK (WPA2-Personal)', run: (sh, [st, id]) => void (sh.disabledWlan(id).akm.psk = onOff(st)) },
  { syntax: 'config wlan security wpa akm sae <state> <id>', help: 'enable|disable SAE (WPA3-Personal)', run: (sh, [st, id]) => void (sh.disabledWlan(id).akm.sae = onOff(st)) },
  { syntax: 'config wlan security wpa akm 802.1x <state> <id>', help: 'enable|disable 802.1X (Enterprise)', run: (sh, [st, id]) => void (sh.disabledWlan(id).akm.dot1x = onOff(st)) },
  { syntax: 'config wlan security wpa akm psk set-key ascii <key> <id>', help: 'Passphrase, 8 to 63 characters', run: (sh, [key, id]) => {
    if (key!.length < 8 || key!.length > 63) throw new Error('Request failed - the PSK must be 8 to 63 characters.');
    sh.disabledWlan(id).psk = key;
  } },
  { syntax: 'config wlan radius_server auth add <id> <index>', help: 'Use a RADIUS server for this WLAN', run: (sh, [id, index]) => {
    const w = sh.disabledWlan(id);
    const n = Number(index);
    if (!sh.wlc.radiusServer(n)) throw new Error(`Request failed - RADIUS server ${index} is not configured.`);
    if (!w.radius.includes(n)) w.radius.push(n);
  } },
  // ---- RADIUS
  { syntax: 'config radius auth add <index> <ip> <port> ascii <secret>', help: 'RADIUS authentication server', run: (sh, [index, a, port, secret]) => {
    const n = Number(index);
    const p = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 32 || !Number.isInteger(p) || p < 1 || p > 65535) throw new Error(INCORRECT);
    if (sh.wlc.radiusServer(n)) throw new Error(`Request failed - server index ${n} is in use.`);
    sh.wlc.addRadiusServer(n, ip(a), p, secret!);
  } },
  { syntax: 'config radius auth delete <index>', help: 'Remove a RADIUS server', run: (sh, [index]) => {
    if (!sh.wlc.aaa.servers.delete(String(Number(index)))) throw new Error(`Request failed - server ${index} is not configured.`);
    for (const w of sh.wlc.wlans.values()) w.radius = w.radius.filter((r) => r !== Number(index));
  } },
  // ---- radios
  { syntax: 'config 802.11b channel ap <ap> <channel>', help: '2.4 GHz channel (1-11) or global (DCA)', run: (sh, [ap, ch]) => sh.setChannel('b', ap!, ch!) },
  { syntax: 'config 802.11a channel ap <ap> <channel>', help: '5 GHz channel (36-165) or global (DCA)', run: (sh, [ap, ch]) => sh.setChannel('a', ap!, ch!) },
  { syntax: 'config 802.11b channel global auto', help: 'Run DCA again for every AP not set by hand', run: (sh) => sh.wlc.rerunDca() },
  // ---- clients and tools
  { syntax: 'config client deauthenticate <mac>', help: 'Disconnect a client', run: (sh, [mac]) => {
    if (!sh.wlc.deauthenticate(mac!.toLowerCase())) throw new Error(`Request failed - client ${mac} not found.`);
  } },
  { syntax: 'ping <ip>', help: 'Ping from the management interface', run: (sh, [a]) => sh.ping(ip(a)) },
  { syntax: 'save config', help: 'Save the configuration', run: () => 'Configuration Saved!' },
];

function matches(syntax: string, tokens: string[]): string[] | undefined {
  const words = syntax.split(' ');
  if (words.length !== tokens.length) return undefined;
  const args: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const t = tokens[k]!;
    if (w.startsWith('<')) args.push(t);
    else if (w !== t.toLowerCase() && !(t.length >= 3 && w.startsWith(t.toLowerCase()))) return undefined;
  }
  return args;
}

/**
 * The AireOS controller CLI: `show` and `config` commands from a single prompt, the way a 3504 or
 * a vWLC behaves. The same settings drive the web panel.
 */
export class WlcShell implements Shell {
  readonly io = new Interaction();

  constructor(readonly wlc: WirelessController) {}

  get prompt(): string {
    return this.io.prompt ?? `(${this.wlc.hostname}) >`;
  }

  execute(line: string): string {
    const out = this.run(line.trim());
    this.wlc.network?.converge();
    return out;
  }

  private run(line: string): string {
    if (!line) return '';
    if (line === 'help' || line === '?') return COMMANDS.map((c) => `${c.syntax.padEnd(62)} ${c.help}`).join('\n');
    const tokens = line.split(/\s+/);
    // Literal words are tried first, so `show wlan summary` does not read "summary" as an id.
    const candidates = COMMANDS.map((c) => ({ c, args: matches(c.syntax, tokens) })).filter((m) => m.args !== undefined);
    candidates.sort((a, b) => a.args!.length - b.args!.length);
    const hit = candidates[0];
    if (!hit) return INCORRECT;
    try {
      return hit.c.run(this, hit.args!) ?? '';
    } catch (err) {
      return (err as Error).message;
    }
  }

  wlan(id: string | undefined): Wlan {
    const w = this.wlc.wlans.get(wlanId(id));
    if (!w) throw new Error(`Request failed - WLAN ${id} does not exist.`);
    return w;
  }

  /** AireOS refuses most WLAN changes while the WLAN is enabled. */
  disabledWlan(id: string | undefined): Wlan {
    const w = this.wlan(id);
    if (w.enabled) throw new Error(`Request failed - WLAN ${w.id} must be disabled first: config wlan disable ${w.id}`);
    return w;
  }

  setChannel(band: 'a' | 'b', ap: string, ch: string): void {
    const cfg = { ...this.wlc.radioConfig.get(ap) };
    if (ch === 'global') delete cfg[band];
    else {
      const n = Number(ch);
      const ok = band === 'b' ? Number.isInteger(n) && n >= 1 && n <= 11 : [36, 40, 44, 48, 52, 56, 60, 64, 149, 153, 157, 161, 165].includes(n);
      if (!ok) throw new Error(`Request failed - ${ch} is not a valid 802.11${band} channel.`);
      cfg[band] = n;
    }
    this.wlc.radioConfig.set(ap, cfg);
    this.wlc.assigned.delete(ap);
    this.wlc.channelsFor(ap);
  }

  ping(dst: string): string {
    const results = this.wlc.ping(dst, 3);
    this.wlc.network?.run();
    const ok = results.filter((r) => r.success).length;
    return `Send count=3, Receive count=${ok} from ${dst}`;
  }

  // ---------------------------------------------------------------- show output

  sysinfo(): string {
    const m = this.wlc.management;
    return [
      'Manufacturer\'s Name.............................. Cisco Systems Inc.',
      'Product Name..................................... Cisco Controller',
      'Product Version.................................. 8.10.185.0',
      `System Name...................................... ${this.wlc.hostname}`,
      `IP Address....................................... ${m.ip?.address ?? '0.0.0.0'}`,
      `Number of WLANs.................................. ${this.wlc.wlans.size}`,
      `Number of Active Clients......................... ${[...this.wlc.clients.values()].filter((c) => c.state === 'RUN').length}`,
    ].join('\n');
  }

  interfaceSummary(): string {
    const rows = this.wlc.wlcInterfaces();
    const lines = [`Number of Interfaces.......................... ${rows.length}`, '', 'Interface Name                   Port Vlan Id  IP Address      Type    Ap Mgr Guest', '-------------------------------- ---- -------- --------------- ------- ------ -----'];
    for (const r of rows) {
      lines.push(`${r.name.padEnd(33)}1    ${(r.vlan === 0 ? 'untagged' : String(r.vlan)).padEnd(9)}${(r.address ?? '0.0.0.0').padEnd(16)}${(r.name === 'management' ? 'Static' : 'Dynamic').padEnd(8)}${(r.name === 'management' ? 'Yes' : 'No').padEnd(7)}No`);
    }
    return lines.join('\n');
  }

  wlanSummary(): string {
    const lines = [`Number of WLANs.................................. ${this.wlc.wlans.size}`, '', 'WLAN ID  WLAN Profile Name / SSID               Status    Interface Name        PMIPv6 Mobility', '-------  -------------------------------------  --------  --------------------  ---------------'];
    for (const w of [...this.wlc.wlans.values()].sort((a, b) => a.id - b.id)) {
      lines.push(`${String(w.id).padEnd(9)}${`${w.profile} / ${w.ssid}`.padEnd(39)}${(w.enabled ? 'Enabled' : 'Disabled').padEnd(10)}${w.interface.padEnd(22)}none`);
    }
    return lines.join('\n');
  }

  wlanDetail(id: number): string {
    const w = this.wlc.wlans.get(id);
    if (!w) return `WLAN Identifier ${id} does not exist.`;
    const security = wlanSecurity(w);
    const yes = (b: boolean) => (b ? 'Enabled' : 'Disabled');
    const lines = [
      `WLAN Identifier.................................. ${w.id}`,
      `Profile Name..................................... ${w.profile}`,
      `Network Name (SSID).............................. ${w.ssid}`,
      `Status........................................... ${yes(w.enabled)}`,
      `Interface........................................ ${w.interface}`,
      `VLAN............................................. ${this.wlc.vlanOf(w) === 0 ? 'untagged' : this.wlc.vlanOf(w) ?? 'unknown'}`,
      'Security',
      `   Wi-Fi Protected Access (WPA/WPA2/WPA3)........ ${yes(w.wpa)}`,
    ];
    if (w.wpa) {
      lines.push(
        `      WPA2 (RSN IE).............................. ${yes(w.wpa2)}`,
        `      WPA3 (RSN IE).............................. ${yes(w.wpa3)}`,
        '      Auth Key Management',
        `         802.1x.................................. ${yes(w.akm.dot1x)}`,
        `         PSK..................................... ${yes(w.akm.psk)}`,
        `         SAE..................................... ${yes(w.akm.sae)}`,
        `      PSK Key.................................... ${w.psk ? 'configured' : 'not configured'}`,
      );
    }
    lines.push(`   Radius Servers................................ ${w.radius.length ? w.radius.join(', ') : 'Global Servers'}`);
    lines.push(`Result........................................... ${typeof security === 'string' ? SECURITY_NAMES[security] : `Invalid: ${security.error}`}`);
    return lines.join('\n');
  }

  apSummary(): string {
    const lines = [`Number of APs.................................... ${this.wlc.aps.size}`, '', 'AP Name             Slots  AP Model              Ethernet MAC       IP Address       Clients', '------------------  -----  --------------------  -----------------  ---------------  -------'];
    for (const ap of this.wlc.aps.values()) {
      const dev = this.wlc.network?.find(ap.name);
      const mac = dev?.interfaces[0]?.mac ?? '';
      const clients = [...this.wlc.clients.values()].filter((c) => c.ap === ap.name).length;
      lines.push(`${ap.name.padEnd(20)}2      AIR-AP3802I-B-K9      ${mac.padEnd(19)}${ap.address.padEnd(17)}${clients}`);
    }
    return lines.join('\n');
  }

  clientSummary(): string {
    const all = [...this.wlc.clients.values()];
    const lines = [`Number of Clients................................ ${all.length}`, '', 'MAC Address       AP Name             WLAN  State      Protocol  User Name        IP Address', '----------------- ------------------- ----  ---------  --------  ---------------  ---------------'];
    for (const c of all) {
      lines.push(`${c.mac.padEnd(18)}${c.ap.padEnd(20)}${String(c.wlan).padEnd(6)}${c.state.padEnd(11)}802.11ac  ${(c.username ?? 'N/A').padEnd(17)}${c.ip ?? 'Unknown'}`);
    }
    return lines.join('\n');
  }

  radiusSummary(): string {
    const lines = ['Authentication Servers', '', 'Idx  Server Address   Port   State    Requests  Accepts  Rejects  Timeouts', '---  ---------------  -----  -------  --------  -------  -------  --------'];
    for (const s of [...this.wlc.aaa.servers.values()].sort((a, b) => Number(a.name) - Number(b.name))) {
      lines.push(`${s.name.padEnd(5)}${(s.address ?? '').padEnd(17)}${String(s.authPort).padEnd(7)}Enabled  ${String(s.stats.requests).padEnd(10)}${String(s.stats.accepts).padEnd(9)}${String(s.stats.rejects).padEnd(9)}${s.stats.timeouts}`);
    }
    return lines.join('\n');
  }

  channelSummary(band: 'a' | 'b'): string {
    const idx = band === 'b' ? 0 : 1;
    const rows = [...this.wlc.aps.keys()].map((ap) => ({ ap, ch: this.wlc.channelsFor(ap)[idx], fixed: this.wlc.radioConfig.get(ap)?.[band] !== undefined }));
    const lines = [`Member RRM Information (802.11${band === 'b' ? 'b/g/n, 2.4 GHz' : 'a/n/ac, 5 GHz'})`, '', 'AP Name             Channel  Assignment  Interference', '------------------  -------  ----------  ------------'];
    for (const r of rows) {
      const others = rows.filter((o) => o !== r);
      const same = others.filter((o) => o.ch === r.ch).map((o) => o.ap);
      const near = band === 'b' ? others.filter((o) => o.ch !== r.ch && WirelessController.overlaps24(o.ch, r.ch)).map((o) => o.ap) : [];
      const note = [...(same.length ? [`co-channel with ${same.join(', ')}`] : []), ...(near.length ? [`overlapping with ${near.join(', ')}`] : [])].join('; ') || 'none';
      lines.push(`${r.ap.padEnd(20)}${String(r.ch).padEnd(9)}${(r.fixed ? 'Static' : 'DCA').padEnd(12)}${note}`);
    }
    return lines.join('\n');
  }

  /** `show run-config commands`. */
  config(): string[] {
    const w = this.wlc;
    const out = [`config sysname ${w.hostname}`];
    for (const i of w.wlcInterfaces()) {
      if (i.name !== 'management') out.push(`config interface create ${i.name} ${i.vlan}`);
      else if (i.vlan !== 0) out.push(`config interface vlan management ${i.vlan}`);
      if (i.address) out.push(`config interface address ${i.name === 'management' ? 'management' : `dynamic-interface ${i.name}`} ${i.address} ${prefixToMask(i.prefix!)} ${i.gateway}`);
    }
    for (const s of w.aaa.servers.values()) out.push(`config radius auth add ${s.name} ${s.address} ${s.authPort} ascii ****`);
    for (const wl of [...w.wlans.values()].sort((a, b) => a.id - b.id)) {
      out.push(`config wlan create ${wl.id} ${wl.profile} ${wl.ssid}`);
      if (wl.interface !== 'management') out.push(`config wlan interface ${wl.id} ${wl.interface}`);
      if (!wl.wpa) out.push(`config wlan security wpa disable ${wl.id}`);
      else {
        if (wl.wpa3) out.push(`config wlan security wpa wpa3 enable ${wl.id}`);
        if (!wl.wpa2) out.push(`config wlan security wpa wpa2 disable ${wl.id}`);
        if (!wl.akm.dot1x) out.push(`config wlan security wpa akm 802.1x disable ${wl.id}`);
        if (wl.akm.psk) out.push(`config wlan security wpa akm psk enable ${wl.id}`);
        if (wl.akm.sae) out.push(`config wlan security wpa akm sae enable ${wl.id}`);
        if (wl.psk) out.push(`config wlan security wpa akm psk set-key ascii **** ${wl.id}`);
      }
      for (const r of wl.radius) out.push(`config wlan radius_server auth add ${wl.id} ${r}`);
      if (wl.enabled) out.push(`config wlan enable ${wl.id}`);
    }
    for (const [ap, cfg] of w.radioConfig) {
      if (cfg.b !== undefined) out.push(`config 802.11b channel ap ${ap} ${cfg.b}`);
      if (cfg.a !== undefined) out.push(`config 802.11a channel ap ${ap} ${cfg.a}`);
    }
    return out;
  }
}
