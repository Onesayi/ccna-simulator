import type { MacAddress } from '../core/addressing';
import type { Dot11Frame, WlanAdvert, WlanSecurity } from '../core/frames';
import type { Interface } from '../devices/device';

/**
 * The key material both ends derive from a passphrase. Real WPA2 runs PBKDF2 over the passphrase
 * and SSID and proves it with a MIC; here a short hash stands in, so a wrong key gives a different
 * MIC and the 4-way handshake fails exactly where it would on real gear.
 */
export function deriveMic(ssid: string, secret: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${ssid}\u0000${secret}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The AKM a client offers for each kind of WLAN. */
export const AKM_FOR: Record<WlanSecurity, NonNullable<Dot11Frame['akm']>> = {
  open: 'none',
  'wpa2-psk': 'psk',
  'wpa3-sae': 'sae',
  'wpa2-enterprise': '802.1x',
};

/** How Windows names each kind of WLAN in `netsh wlan show networks`. */
export const SECURITY_LABEL: Record<WlanSecurity, { auth: string; cipher: string }> = {
  open: { auth: 'Open', cipher: 'None' },
  'wpa2-psk': { auth: 'WPA2-Personal', cipher: 'CCMP' },
  'wpa3-sae': { auth: 'WPA3-Personal', cipher: 'CCMP' },
  'wpa2-enterprise': { auth: 'WPA2-Enterprise', cipher: 'CCMP' },
};

/** A WLAN an AP radio is beaconing right now. */
export interface Beacon {
  /** The AP's radio: its MAC is the BSSID. */
  radio: Interface;
  apName: string;
  wlan: WlanAdvert;
  channel: number;
}

/** Devices that beacon WLANs (lightweight APs). Clients scan every one in the topology. */
export interface Beaconing {
  beacons(): Beacon[];
}

export function isBeaconing(d: unknown): d is Beaconing {
  return typeof (d as Partial<Beaconing>).beacons === 'function';
}

export interface WifiProfile {
  ssid: string;
  /** WPA2-Personal / WPA3-Personal passphrase. */
  key?: string;
  /** WPA2-Enterprise (PEAP) credentials. */
  username?: string;
  password?: string;
}

export type WifiState = 'disconnected' | 'authenticating' | 'associating' | '802.1x' | 'handshake' | 'connected';

export interface WifiHooks {
  /** The client's own radio. */
  radio: Interface;
  /** Every beacon in range. */
  scan(): Beacon[];
  /** Sends an 802.11 management or EAPOL frame to an AP radio. */
  transmit(to: Interface, frame: Dot11Frame): void;
  connected(): void;
  disconnected(): void;
}

/**
 * The supplicant on a wireless client: open, WPA2-Personal and WPA3-Personal (SAE) association,
 * the 4-way handshake, and WPA2-Enterprise with PEAP-style credentials. Frames go to the AP, which
 * tunnels them to the controller over CAPWAP; the controller makes every decision.
 */
export class WifiClient {
  state: WifiState = 'disconnected';
  /** The profile in use, kept after a drop so the client can reconnect on its own. */
  profile?: WifiProfile;
  /** The AP radio we are talking to; its MAC is the BSSID. */
  bss?: Beacon;
  /** Why the last attempt failed or the connection dropped, in Windows' words. */
  reason?: string;

  constructor(private readonly hooks: WifiHooks) {}

  get connected(): boolean {
    return this.state === 'connected';
  }

  get bssid(): MacAddress | undefined {
    return this.bss?.radio.mac;
  }

  /** Every beacon in range, for `netsh wlan show networks`. */
  scanAll(): Beacon[] {
    return this.hooks.scan();
  }

  /** Starts an association. Run the network, then read `state` and `reason`. */
  connect(profile: WifiProfile): void {
    if (this.state !== 'disconnected') this.disconnect();
    this.profile = profile;
    this.reason = undefined;
    const bss = this.hooks
      .scan()
      .filter((b) => b.wlan.ssid === profile.ssid)
      // The first AP by name, on 5 GHz when it can (band select steers clients there).
      .sort((a, b) => a.apName.localeCompare(b.apName) || b.channel - a.channel)[0];
    if (!bss) {
      this.reason = `There is no profile "${profile.ssid}" network in range.`;
      return;
    }
    this.bss = bss;
    const security = bss.wlan.security;
    if ((security === 'wpa2-psk' || security === 'wpa3-sae') && !profile.key) {
      this.reason = 'The network security key is required for this network.';
      return;
    }
    if (security === 'wpa2-enterprise' && (!profile.username || profile.password === undefined)) {
      this.reason = 'This network needs a user name and password (WPA2-Enterprise).';
      return;
    }
    this.state = 'authenticating';
    const sae = security === 'wpa3-sae';
    this.send({ kind: 'dot11', subtype: 'auth', algorithm: sae ? 'sae' : 'open', ssid: profile.ssid, ...(sae ? { mic: deriveMic(profile.ssid, profile.key!) } : {}) });
  }

  /** Leaves the network and forgets the profile, so it does not reconnect. */
  disconnect(): void {
    if (this.bss && this.state !== 'disconnected') this.send({ kind: 'dot11', subtype: 'deauth', reason: 'Deauthenticated because sending station is leaving' });
    this.profile = undefined;
    this.drop(undefined);
  }

  /** An 802.11 frame from the AP we are talking to. */
  receive(f: Dot11Frame, from: Interface): void {
    if (!this.bss || from !== this.bss.radio || !this.profile) return;
    const p = this.profile;
    switch (f.subtype) {
      case 'auth':
        if (this.state !== 'authenticating') return;
        // 15 is a failed SAE exchange (a wrong password); anything else means try again later.
        if (f.status === 15) return this.fail(f.reason ?? 'The network security key isn\'t correct.');
        if (f.status !== 0) return this.drop(f.reason ?? 'The network is not available.');
        this.state = 'associating';
        return this.send({ kind: 'dot11', subtype: 'assoc-request', ssid: p.ssid, akm: AKM_FOR[this.bss.wlan.security] });
      case 'assoc-response':
        if (this.state !== 'associating') return;
        if (f.status !== 0) return this.fail(f.reason ?? 'The association was refused.');
        if (this.bss.wlan.security === 'open') return this.up();
        this.state = this.bss.wlan.security === 'wpa2-enterprise' ? '802.1x' : 'handshake';
        return;
      case 'eap':
        if (this.state !== '802.1x') return;
        if (f.eap === 'request-identity') return this.send({ kind: 'dot11', subtype: 'eap', eap: 'credentials', identity: p.username, password: p.password });
        if (f.eap === 'success') this.state = 'handshake';
        else if (f.eap === 'failure') this.fail(f.reason ?? 'The credentials were rejected by the authentication server.');
        return;
      case 'eapol-key': {
        if (this.state !== 'handshake') return;
        const secret = this.bss.wlan.security === 'wpa2-enterprise' ? `802.1x:${p.username}` : p.key!;
        if (f.message === 1) return this.send({ kind: 'dot11', subtype: 'eapol-key', message: 2, mic: deriveMic(p.ssid, secret) });
        if (f.message === 3) {
          this.send({ kind: 'dot11', subtype: 'eapol-key', message: 4 });
          return this.up();
        }
        return;
      }
      case 'deauth':
        return this.state === 'connected' ? this.drop(f.reason ?? 'The connection was lost.') : this.fail(f.reason ?? 'The network security key isn\'t correct.');
      default:
    }
  }

  /** The AP went away (it lost its controller, or was removed). */
  lost(): void {
    if (this.state !== 'disconnected') this.drop('The connection was lost: the access point stopped responding.');
  }

  private up(): void {
    this.state = 'connected';
    this.hooks.connected();
  }

  /** An attempt that never connected: forget the profile so it is not retried with a bad key. */
  private fail(reason: string): void {
    this.profile = undefined;
    this.drop(reason);
  }

  private drop(reason: string | undefined): void {
    const was = this.state;
    this.state = 'disconnected';
    this.bss = undefined;
    if (reason) this.reason = reason;
    if (was === 'connected') this.hooks.disconnected();
  }

  private send(frame: Dot11Frame): void {
    if (this.bss) this.hooks.transmit(this.bss.radio, frame);
  }
}
