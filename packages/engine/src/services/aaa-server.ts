import type { Ipv4Address } from '../core/addressing';
import type { RadiusMessage, TacacsMessage } from '../core/frames';

/**
 * An AAA server (a stand-in for Cisco ISE or FreeRADIUS/tac_plus): network devices registered as
 * clients with a shared secret, a user database with privilege levels, and a live log.
 */

export interface AaaUserEntry {
  name: string;
  password: string;
  /** Sent as `shell:priv-lvl` (RADIUS Cisco-AVPair, or TACACS+ authorization). */
  privilege: number;
}

/** A network device (NAS) allowed to ask this server, and the secret it must use. */
export interface AaaNas {
  address: Ipv4Address;
  key: string;
}

export class AaaServerService {
  readonly users = new Map<string, AaaUserEntry>();
  readonly clients = new Map<Ipv4Address, AaaNas>();
  /** Authentication, authorization and accounting events, newest last. */
  readonly log: string[] = [];

  constructor(private readonly now: () => number) {}

  private stamp(line: string): void {
    const s = Math.floor(this.now() / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    this.log.push(`${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}  ${line}`);
  }

  /** Checks the client and its key. Unknown clients and bad keys get no reply at all, as on ISE. */
  private nas(src: Ipv4Address, key: string, protocol: string): boolean {
    const nas = this.clients.get(src);
    if (!nas) {
      this.stamp(`${protocol}: request from unknown network device ${src} dropped`);
      return false;
    }
    if (nas.key !== key) {
      this.stamp(`${protocol}: request from ${src} dropped: shared secret mismatch`);
      return false;
    }
    return true;
  }

  private check(username: string | undefined, password: string | undefined): AaaUserEntry | undefined {
    const u = username !== undefined ? this.users.get(username) : undefined;
    return u && u.password === password ? u : undefined;
  }

  radius(src: Ipv4Address, msg: RadiusMessage): RadiusMessage | undefined {
    if (!this.nas(src, msg.key, 'RADIUS')) return undefined;
    const base = { id: msg.id, key: msg.key };
    if (msg.code === 'accounting-request') {
      this.stamp(`RADIUS accounting ${msg.record ?? ''} for ${msg.username ?? '?'} from ${src}`);
      return { ...base, code: 'accounting-response' };
    }
    if (msg.code !== 'access-request') return undefined;
    const u = this.check(msg.username, msg.password);
    const how = msg.portType === 'Wireless-802.11' ? '802.1X (wireless)' : 'device login';
    this.stamp(`RADIUS ${u ? 'Passed' : 'Failed'} authentication: ${msg.username ?? '?'} from ${src}, ${how}`);
    return u ? { ...base, code: 'access-accept', privilege: u.privilege } : { ...base, code: 'access-reject' };
  }

  tacacs(src: Ipv4Address, msg: TacacsMessage): TacacsMessage | undefined {
    if (!this.nas(src, msg.key, 'TACACS+')) return undefined;
    const base = { type: msg.type, session: msg.session, key: msg.key };
    if (msg.type === 'authen') {
      const u = this.check(msg.username, msg.password);
      this.stamp(`TACACS+ ${u ? 'Passed' : 'Failed'} authentication: ${msg.username ?? '?'} from ${src}`);
      return { ...base, status: u ? 'pass' : 'fail' };
    }
    if (msg.type === 'author') {
      const u = msg.username !== undefined ? this.users.get(msg.username) : undefined;
      this.stamp(`TACACS+ ${u ? 'Passed' : 'Failed'} authorization: ${msg.username ?? '?'} shell priv-lvl=${u?.privilege ?? '-'} from ${src}`);
      return u ? { ...base, status: 'pass', privilege: u.privilege } : { ...base, status: 'fail' };
    }
    this.stamp(`TACACS+ accounting ${msg.record ?? ''} for ${msg.username ?? '?'} from ${src}`);
    return { ...base, status: 'success' };
  }
}
