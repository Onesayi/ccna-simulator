import { describe, expect, it } from 'vitest';
import { Pc, Router, Scheduler, Switch, Topology, resetMacAllocator } from '../src';
import { ios } from './helpers';

function net() {
  resetMacAllocator();
  const t = new Topology();
  const sw = t.add(new Switch('SW1'));
  const pc1 = t.add(new Pc('PC1'));
  const pc2 = t.add(new Pc('PC2'));
  pc1.configure('10.0.0.1', 24);
  pc2.configure('10.0.0.2', 24);
  return { t, sw, pc1, pc2 };
}

describe('Topology', () => {
  it('finds devices by hostname (any case) or id', () => {
    const { t, sw } = net();
    expect(t.get('sw1')).toBe(sw);
    expect(t.get(sw.id)).toBe(sw);
    expect(t.find('nope')).toBeUndefined();
    expect(() => t.get('nope')).toThrow(/No device named nope/);
  });

  it('refuses duplicate hostnames', () => {
    const { t } = net();
    expect(() => t.add(new Router('pc1'))).toThrow(/Duplicate hostname/);
  });

  it('validates cables', () => {
    const { t, sw, pc1 } = net();
    const r1 = t.add(new Router('R1'));
    t.connect(pc1.nic, sw.iface('Gi0/1'));
    expect(() => t.connect(pc1.nic, sw.iface('Gi0/2'))).toThrow(/already cabled/);
    expect(() => t.connect(sw.iface('Gi0/3'), sw.iface('Gi0/4'))).toThrow(/to itself/);
    ios(r1, 'conf t\ninterface loopback0\nend');
    expect(() => t.connect(r1.iface('Loopback0'), sw.iface('Gi0/5'))).toThrow(/Only physical ports/);
  });

  it('records every frame on the wire in the trace', () => {
    const { t, sw, pc1, pc2 } = net();
    t.connect(pc1.nic, sw.iface('Gi0/1'));
    t.connect(pc2.nic, sw.iface('Gi0/2'));
    const [result] = pc1.ping('10.0.0.2', 1);
    t.run();
    expect(result!.success).toBe(true);
    expect(t.trace.length).toBeGreaterThanOrEqual(4);
    expect(t.trace[0]!.from).toBe('PC1 Eth0');
    expect(t.trace.map((e) => e.at)).toEqual([...t.trace.map((e) => e.at)].sort((a, b) => a - b));
  });

  it('drops traffic once a cable is pulled', () => {
    const { t, sw, pc1, pc2 } = net();
    const link = t.connect(pc1.nic, sw.iface('Gi0/1'));
    t.connect(pc2.nic, sw.iface('Gi0/2'));
    t.disconnect(link);
    t.disconnect(link); // a second pull is a no-op
    expect(pc1.nic.link).toBeUndefined();
    const results = pc1.ping('10.0.0.2', 1);
    t.run();
    expect(results[0]!.success).toBe(false);
  });

  it('removes a device together with its cables', () => {
    const { t, sw, pc1, pc2 } = net();
    t.connect(pc1.nic, sw.iface('Gi0/1'));
    t.connect(pc2.nic, sw.iface('Gi0/2'));
    t.remove(pc2);
    expect(t.links).toHaveLength(1);
    expect(sw.iface('Gi0/2').link).toBeUndefined();
    expect(t.find('PC2')).toBeUndefined();
  });

  it('runs the same scenario to the same trace every time', () => {
    const run = () => {
      const { t, sw, pc1, pc2 } = net();
      t.connect(pc1.nic, sw.iface('Gi0/1'));
      t.connect(pc2.nic, sw.iface('Gi0/2'));
      pc1.ping('10.0.0.2', 2);
      t.run();
      return t.trace.map((e) => `${e.at} ${e.from} -> ${e.to}`);
    };
    expect(run()).toEqual(run());
  });
});

describe('Scheduler', () => {
  it('runs events in time order and FIFO within a tick', () => {
    const s = new Scheduler();
    const order: string[] = [];
    s.schedule(5, 'late', () => order.push('late'));
    s.schedule(1, 'first', () => order.push('first'));
    s.schedule(1, 'second', () => {
      order.push('second');
      s.schedule(1, 'chained', () => order.push('chained'));
    });
    s.runUntilIdle();
    expect(order).toEqual(['first', 'second', 'chained', 'late']);
    expect(s.now).toBe(5);
  });
});
