import type { Device } from '../devices/device';
import { Pc } from '../devices/pc';
import { Server } from '../devices/server';
import { PcShell } from './pc-shell';
import type { Shell } from './remote';
import { ServerShell } from './server-shell';
import { CliSession } from './session';

/** The right terminal for a device: a Linux prompt for servers, a command prompt for PCs, the IOS CLI for the rest. */
export function createShell(device: Device): Shell {
  if (device instanceof Server) return new ServerShell(device);
  if (device instanceof Pc) return new PcShell(device);
  return new CliSession(device);
}
