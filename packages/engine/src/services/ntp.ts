import type { Ipv4Address } from '../core/addressing';
import type { NtpMessage } from '../core/frames';
import type { ScheduledEvent } from '../core/scheduler';

/** A device boots believing it is midnight on 1 March 1993, like an IOS box with no calendar. */
export const BOOT_TIME = Date.UTC(1993, 2, 1);
/** An unanswered NTP request is sent once more within the round, after the path has had time to ARP. */
const NTP_RETRY_MS = 1_000;

export interface NtpHooks {
  now(): number;
  log: string[];
  /** Sends an NTP request to a server; false when there is no route to it. */
  request(server: Ipv4Address, msg: NtpMessage): boolean;
  schedule(delayMs: number, label: string, run: () => void): ScheduledEvent | undefined;
}

export interface NtpSync {
  server: Ipv4Address;
  stratum: number;
  reference: string;
  at: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The device clock and NTP. The clock is the virtual time plus an offset; `clock set` or an NTP
 * reply moves the offset. Each round a client asks its servers for the time and takes the first
 * answer, so it synchronizes within one round instead of the minutes real NTP takes. A device
 * answers requests once it is a master or is itself synchronized, one stratum further down.
 */
export class NtpClock {
  /** Device time = BOOT_TIME + virtual time + offset. */
  offset = 0;
  /** Set by `clock set`: the time is believed, though not synchronized. */
  userSet = false;
  timezone = { name: 'UTC', hours: 0, minutes: 0 };
  /** `ntp master [stratum]`. */
  master?: number;
  readonly servers: Ipv4Address[] = [];
  sync?: NtpSync;
  private answered = false;
  /** A new server was synced to this round. */
  private resynced = false;

  constructor(private readonly hooks: NtpHooks) {}

  /** UTC milliseconds since 1970. */
  get time(): number {
    return BOOT_TIME + this.hooks.now() + this.offset;
  }

  set(utc: number): void {
    this.offset = utc - BOOT_TIME - this.hooks.now();
    this.userSet = true;
  }

  get configured(): boolean {
    return this.master !== undefined || this.servers.length > 0;
  }

  /** The stratum we serve time at, or undefined when we have no time worth giving. */
  get stratum(): number | undefined {
    if (this.master !== undefined) return this.master;
    return this.sync ? this.sync.stratum : undefined;
  }

  get synchronized(): boolean {
    return this.master !== undefined || this.sync !== undefined;
  }

  tick(): void {
    this.answered = false;
    this.resynced = false;
    if (this.master !== undefined || !this.servers.length) return;
    for (const server of this.servers) this.hooks.request(server, { mode: 'client' });
    this.hooks.schedule(NTP_RETRY_MS, 'ntp retry', () => {
      if (this.answered) return;
      for (const server of this.servers) this.hooks.request(server, { mode: 'client' });
    });
  }

  /** Handles a request (returns the reply) or a reply from one of our servers. */
  receive(src: Ipv4Address, msg: NtpMessage): NtpMessage | undefined {
    if (msg.mode === 'client') {
      const stratum = this.stratum;
      if (stratum === undefined || stratum >= 15) return undefined;
      return { mode: 'server', stratum, time: this.time, reference: this.master !== undefined ? '127.127.1.1' : this.sync!.server };
    }
    if (this.answered || this.master !== undefined || !this.servers.includes(src) || msg.time === undefined || msg.stratum === undefined) return undefined;
    this.answered = true;
    this.offset = msg.time - BOOT_TIME - this.hooks.now();
    const fresh = this.sync?.server !== src;
    this.sync = { server: src, stratum: msg.stratum + 1, reference: msg.reference ?? src, at: this.hooks.now() };
    this.resynced = fresh;
    if (fresh) this.hooks.log.push(`%NTP-5-PEERSYNC: NTP synced to peer ${src}`);
    return undefined;
  }

  /** A client that heard nothing this round loses synchronization (but keeps its time). */
  settle(): boolean {
    if (this.master !== undefined) {
      const changed = this.sync !== undefined;
      this.sync = undefined;
      return changed;
    }
    if (this.sync && (!this.answered || !this.servers.includes(this.sync.server))) {
      this.hooks.log.push(`%NTP-4-PEERUNREACH: Peer ${this.sync.server} is unreachable`);
      this.sync = undefined;
      return true;
    }
    return this.resynced;
  }

  /** `show clock`: "*10:15:02.123 UTC Sat Oct 3 2026". The star means the time is not authoritative. */
  showClock(detail = false): string {
    const local = new Date(this.time + (this.timezone.hours * 60 + Math.sign(this.timezone.hours || 1) * this.timezone.minutes) * 60_000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const hms = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}`;
    const flag = this.synchronized || this.userSet ? '' : '*';
    const line = `${flag}${hms} ${this.timezone.name} ${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ${local.getUTCFullYear()}`;
    if (!detail) return line;
    const source = this.synchronized ? 'Time source is NTP' : this.userSet ? 'Time source is user configuration' : 'No time source';
    return `${line}\n${source}`;
  }

  showStatus(): string {
    if (!this.configured) return '%NTP is not enabled.';
    if (!this.synchronized) return 'Clock is unsynchronized, stratum 16, no reference clock\nnominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**10';
    const ref = this.master !== undefined ? '127.127.1.1' : this.sync!.server;
    return [
      `Clock is synchronized, stratum ${this.stratum}, reference is ${ref}`,
      'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**10',
      'clock offset is 0.0000 msec, root delay is 0.00 msec',
      'root dispersion is 0.02 msec, peer dispersion is 0.02 msec',
    ].join('\n');
  }

  showAssociations(): string {
    if (!this.configured) return '%NTP is not enabled.';
    const rows: string[] = [];
    if (this.master !== undefined) rows.push(`*~127.127.1.1     .LOCL.          ${String(this.master - 1).padStart(2)}      0     16   377  0.000   0.000  0.240`);
    for (const s of this.servers) {
      const synced = this.sync?.server === s;
      const head = `${synced ? '*' : ' '}~${s.padEnd(16)}`;
      rows.push(
        synced
          ? `${head}${this.sync!.reference.padEnd(16)}${String(this.sync!.stratum - 1).padStart(2)}      1     64   377  0.000   0.000  0.020`
          : `${head}${'.INIT.'.padEnd(16)}16      -     64     0  0.000   0.000 15937.`,
      );
    }
    return [
      '  address         ref clock       st   when   poll reach  delay  offset   disp',
      ...rows,
      ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
    ].join('\n');
  }

  config(): string[] {
    const out: string[] = [];
    if (this.timezone.name !== 'UTC' || this.timezone.hours || this.timezone.minutes) out.push(`clock timezone ${this.timezone.name} ${this.timezone.hours} ${this.timezone.minutes}`);
    if (this.master !== undefined) out.push(this.master === 8 ? 'ntp master' : `ntp master ${this.master}`);
    for (const s of this.servers) out.push(`ntp server ${s}`);
    return out;
  }
}

/** Parses `clock set 10:00:00 3 Oct 2026` (day and month in either order) to UTC milliseconds. */
export function parseClockSet(time: string, a: string, b: string, year: string, tz: NtpClock['timezone']): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time);
  const day = Number(/^\d+$/.test(a) ? a : b);
  const monthWord = (/^\d+$/.test(a) ? b : a).toLowerCase();
  const month = MONTHS.findIndex((x) => monthWord.length >= 3 && x.toLowerCase().startsWith(monthWord.slice(0, 3)));
  const y = Number(year);
  if (!m || month < 0 || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(y) || y < 1993 || y > 2035) throw new Error(`Invalid input detected at '^' marker.`);
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h > 23 || min > 59 || s > 59) throw new Error(`Invalid input detected at '^' marker.`);
  // The time is typed in local time; the clock runs in UTC.
  const zone = (tz.hours * 60 + Math.sign(tz.hours || 1) * tz.minutes) * 60_000;
  return Date.UTC(y, month, day, h, min, s) - zone;
}
