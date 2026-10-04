import { LightweightAp } from './ap';
import type { Device, DeviceKind } from './device';
import { Pc } from './pc';
import { Router } from './router';
import { Server } from './server';
import { Switch } from './switch';
import { WirelessController } from './wlc';

/** Builds a device of any kind with factory defaults. A wireless `pc` is a laptop with a Wi-Fi radio. */
export function createDevice(kind: DeviceKind, hostname: string, options: { wireless?: boolean } = {}): Device {
  switch (kind) {
    case 'router':
      return new Router(hostname);
    case 'switch':
      return new Switch(hostname);
    case 'server':
      return new Server(hostname);
    case 'wlc':
      return new WirelessController(hostname);
    case 'ap':
      return new LightweightAp(hostname);
    default:
      return new Pc(hostname, options);
  }
}
