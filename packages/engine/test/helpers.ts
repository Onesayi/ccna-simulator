import { CliSession, type Device, type IpDevice } from '../src';

/** Runs IOS commands on a device from privileged EXEC and returns the output of the last one. */
export function ios(device: Device, commands: string): string {
  const cli = new CliSession(device);
  cli.execute('enable');
  let out = '';
  for (const line of commands.trim().split('\n')) {
    out = cli.execute(line.trim());
    if (out.startsWith('% ') && !out.startsWith('% Access VLAN')) throw new Error(`${device.hostname}: "${line.trim()}" -> ${out}`);
  }
  return out;
}

/** Pings until ARP has resolved on every hop, so the next ping measures a warm path. */
export function warmUp(from: IpDevice, dst: string): void {
  from.ping(dst, 3);
  from.network!.run();
}
