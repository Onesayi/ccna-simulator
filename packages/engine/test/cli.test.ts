import { describe, expect, it } from 'vitest';
import { CliSession, Switch, Topology } from '../src';

function session() {
  const net = new Topology();
  return new CliSession(net.add(new Switch('SW1')));
}

describe('IOS CLI', () => {
  it('walks the mode hierarchy with abbreviations', () => {
    const s = session();
    expect(s.prompt).toBe('SW1>');
    s.execute('en');
    expect(s.prompt).toBe('SW1#');
    s.execute('conf t');
    expect(s.prompt).toBe('SW1(config)#');
    s.execute('int gi0/3');
    expect(s.prompt).toBe('SW1(config-if)#');
    s.execute('exit');
    expect(s.prompt).toBe('SW1(config)#');
    s.execute('end');
    expect(s.prompt).toBe('SW1#');
  });

  it('rejects config commands outside config mode', () => {
    expect(session().execute('hostname CORE')).toMatch(/Invalid input/);
  });

  it('renames the device', () => {
    const s = session();
    ['enable', 'configure terminal', 'hostname CORE1'].forEach((c) => s.execute(c));
    expect(s.prompt).toBe('CORE1(config)#');
  });

  it('lists VLANs and their access ports', () => {
    const s = session();
    ['en', 'conf t', 'vlan 10', 'name SALES', 'int g0/2', 'sw acc vlan 10', 'end'].forEach((c) => s.execute(c));
    const out = s.execute('sh vlan br');
    expect(out).toMatch(/10\s+SALES\s+active\s+Gi0\/2/);
  });

  it('shows context help with ?', () => {
    const s = session();
    s.execute('en');
    expect(s.execute('show ?')).toContain('show vlan brief');
  });
});
