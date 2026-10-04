import { LightweightAp } from '../devices/ap';
import type { Device } from '../devices/device';
import { Pc } from '../devices/pc';
import { Server } from '../devices/server';
import { WirelessController } from '../devices/wlc';
import { ApShell } from './ap-shell';
import { PcShell } from './pc-shell';
import type { Shell } from './remote';
import { ServerShell } from './server-shell';
import { CliSession } from './session';
import { WlcShell } from './wlc-shell';

/** The right terminal for a device: a Linux prompt for servers, a command prompt for PCs, the IOS CLI for the rest. */
export function createShell(device: Device): Shell {
  if (device instanceof Server) return new ServerShell(device);
  if (device instanceof LightweightAp) return new ApShell(device);
  if (device instanceof Pc) return new PcShell(device);
  if (device instanceof WirelessController) return new WlcShell(device);
  return new CliSession(device);
}
