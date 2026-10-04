import type { Device, DeviceKind } from './device';
import { Pc } from './pc';
import { Router } from './router';
import { Server } from './server';
import { Switch } from './switch';

/** Builds a device of any kind with factory defaults. */
export function createDevice(kind: DeviceKind, hostname: string): Device {
  switch (kind) {
    case 'router':
      return new Router(hostname);
    case 'switch':
      return new Switch(hostname);
    case 'server':
      return new Server(hostname);
    default:
      return new Pc(hostname);
  }
}
