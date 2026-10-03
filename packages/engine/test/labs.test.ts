import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, LABS, LabRun, Pc, Progress, Switch, createShell, isComplete, parseProgress, resetMacAllocator, summarise } from '../src';

describe('lab catalog', () => {
  beforeEach(() => resetMacAllocator());

  it('has unique ids', () => {
    expect(new Set(LABS.map((l) => l.id)).size).toBe(LABS.length);
  });

  for (const lab of LABS) {
    describe(lab.id, () => {
      it('starts with work to do', () => {
        const results = new LabRun(lab).grade({ probes: true });
        const network = results.filter((r) => r.objective.check.type !== 'quiz');
        expect(network.some((r) => r.status === 'fail')).toBe(true);
      });

      it('is solved by its model answer', () => {
        const run = new LabRun(lab);
        run.applySolution();
        const results = run.grade({ probes: true });
        const failed = results.filter((r) => r.status !== 'pass').map((r) => `${r.objective.text}: ${r.detail}`);
        expect(failed).toEqual([]);
        expect(isComplete(results)).toBe(true);
      });

      it('leaves probes untested during live grading', () => {
        const run = new LabRun(lab);
        run.applySolution();
        for (const r of run.grade()) {
          if (r.objective.check.type === 'ping' || r.objective.check.type === 'traceroute') expect(r.status).toBe('untested');
        }
      });

      it('has valid quiz answers', () => {
        for (const o of lab.objectives) {
          if (o.check.type === 'quiz') expect(o.check.options[o.check.answer]).toBeDefined();
        }
      });
    });
  }
});

describe('grading', () => {
  it('keeps grading a device after it is renamed', () => {
    const run = new LabRun(LABS.find((l) => l.id === 'router-basics')!);
    const cli = new CliSession(run.device('Router'));
    for (const line of ['enable', 'conf t', 'hostname R1']) cli.execute(line);
    const [hostname] = run.grade();
    expect(hostname!.status).toBe('pass');
    expect(run.device('Router').hostname).toBe('R1');
  });

  it('explains what it saw when a check fails', () => {
    const run = new LabRun(LABS.find((l) => l.id === 'vlans-basic')!);
    const results = run.grade();
    expect(results[0]!.detail).toBe('VLAN 10 does not exist on SW1');
    expect(results[2]!.detail).toBe('GigabitEthernet0/1 is in VLAN 1');
  });

  it('grades quiz answers', () => {
    const lab = LABS.find((l) => l.id === 'router-basics')!;
    const run = new LabRun(lab);
    const quiz = lab.objectives.findIndex((o) => o.check.type === 'quiz');
    expect(run.grade()[quiz]!.status).toBe('untested');
    run.answers.set(quiz, 0);
    expect(run.grade()[quiz]!.status).toBe('fail');
    run.answers.set(quiz, 1);
    expect(run.grade()[quiz]!.status).toBe('pass');
  });

  it('rejects a network or broadcast address as a host address', () => {
    const lab = LABS.find((l) => l.id === 'subnetting-hosts')!;
    const run = new LabRun({
      ...lab,
      objectives: [{ text: 'any host', check: { type: 'interfaceIp', device: 'PC1', interface: 'Eth0', network: '192.168.50.0', prefix: 26 } }],
    });
    const shell = run.device('PC1');
    (shell as import('../src').Pc).configure('192.168.50.63', 26);
    expect(run.grade()[0]!.detail).toMatch(/broadcast/);
    (shell as import('../src').Pc).configure('192.168.50.20', 26);
    expect(run.grade()[0]!.status).toBe('pass');
  });

  it('fails over to the floating static route when the primary link goes down', () => {
    const run = new LabRun(LABS.find((l) => l.id === 'floating-static')!);
    run.applySolution();
    const cli = new CliSession(run.device('R1'));
    for (const line of ['enable', 'conf t', 'int g0/1', 'shutdown', 'end']) cli.execute(line);
    expect(cli.execute('show ip route')).toMatch(/S\s+192\.168\.2\.0\/24 \[5\/0\] via 10\.0\.21\.2/);
    const pc = run.device('PC1') as import('../src').Pc;
    pc.ping('192.168.2.100', 4);
    run.topology.run();
    const final = pc.ping('192.168.2.100', 2);
    run.topology.run();
    expect(final.every((r) => r.success)).toBe(true);
  });
});

describe('Layer 2 and IPv6 labs', () => {
  beforeEach(() => resetMacAllocator());
  const lab = (id: string) => new LabRun(LABS.find((l) => l.id === id)!);
  const type = (run: LabRun, device: string, lines: string) => {
    const shell = createShell(run.device(device));
    return lines.split('\n').map((l) => shell.execute(l.trim()));
  };

  it('starts the BPDU guard lab with the rogue switch as root', () => {
    const run = lab('stp-portfast-bpduguard');
    const sw1 = run.device('SW1') as Switch;
    expect(sw1.stp.vlans.get(1)!.root.priority).toBe(1);
    expect(type(run, 'SW1', 'enable\nshow spanning-tree').at(-1)).toMatch(/Root ID\s+Priority\s+1\n/);
  });

  it('err-disables the port when the learner pings before fixing port security', () => {
    const run = lab('port-security-errdisable');
    expect(type(run, 'PC1', 'ping 192.168.10.100').at(-1)).toContain('Request timed out.');
    const sw1 = run.device('SW1') as Switch;
    expect(sw1.iface('g0/1').errDisabled).toBe('psecure-violation');
    expect(run.grade().find((r) => r.objective.check.type === 'errDisabled')!.detail).toMatch(/err-disabled/);
    run.applySolution();
    expect(isComplete(run.grade({ probes: true }))).toBe(true);
  });

  it('gives the SLAAC host an address as soon as the router advertises again', () => {
    const run = lab('ipv6-troubleshoot');
    const pc2 = run.device('PC2') as Pc;
    expect(pc2.ipv6.globals(pc2.nic)).toHaveLength(0);
    type(run, 'R2', 'enable\nconf t\nipv6 unicast-routing');
    expect(pc2.ipv6.globals(pc2.nic)[0]!.address).toMatch(/^2001:db8:2:0:/);
  });

  it('explains what the new checks saw', () => {
    const run = lab('etherchannel-troubleshoot');
    const details = run.grade().map((r) => r.detail);
    expect(details[0]).toBe('Port-channel1 has 0 of 3 ports bundled');
    const ec = lab('etherchannel-lacp').grade();
    expect(ec[0]!.detail).toBe('Port-channel1 does not exist on SW1');
    const root = lab('stp-root-bridge').grade();
    expect(root[0]!.detail).toBe('SW1 runs pvst');
    expect(root[3]!.detail).toMatch(/The root bridge for VLAN 10 is aabb\.cc00\./);
    expect(root[5]!.detail).toMatch(/Gi.*0\/2 is a designated port in VLAN 10/);
    const v6 = lab('ipv6-addressing').grade();
    expect(v6[0]!.detail).toBe('IPv6 unicast routing is off on R1');
    expect(v6[1]!.detail).toBe('GigabitEthernet0/0 has no global IPv6 address');
    expect(v6[2]!.detail).toBe('IPv6 is not enabled on GigabitEthernet0/0');
    const st = lab('ipv6-static-routing').grade();
    expect(st[0]!.detail).toBe('No route to 2001:DB8:2::/64 via 2001:DB8:12::2 in the IPv6 routing table');
    const ps = lab('port-security').grade();
    expect(ps[0]!.detail).toBe('Port security is off on GigabitEthernet0/1');
    expect(ps[4]!.detail).toBe('GigabitEthernet0/1 has 0 sticky addresses');
    const bg = lab('stp-portfast-bpduguard').grade();
    expect(bg[0]!.detail).toBe('PortFast is off on GigabitEthernet0/1');
    expect(bg[2]!.detail).toBe('BPDU guard is off on GigabitEthernet0/3');
    expect(bg[3]!.detail).toBe('GigabitEthernet0/3 is not err-disabled');
  });

  it('checks the details of IPv6 addresses and port security settings', () => {
    const run = lab('ipv6-addressing');
    type(run, 'R1', 'enable\nconf t\nint g0/1\nipv6 address 2001:db8:acad:2::1/64\nint g0/0\nipv6 address 2001:db8:acad:1::1/80');
    const r = run.grade();
    expect(r[1]!.detail).toBe('GigabitEthernet0/0 has 2001:DB8:ACAD:1::1/80');
    expect(r[3]!.detail).toMatch(/typed in full rather than built with EUI-64/);
    type(run, 'PC2', 'ipv6config 2001:db8:acad:2::99/64');
    expect(run.grade()[7]!.detail).toMatch(/static, not learned with SLAAC/);
    type(run, 'PC2', 'ipv6config 2001:db8:acad:3::99/64');
    expect(run.grade()[7]!.detail).toBe('Ethernet0 has 2001:DB8:ACAD:3::99/64');

    const ps = lab('port-security');
    type(ps, 'SW1', 'enable\nconf t\nint g0/1\nswitchport port-security');
    expect(ps.grade()[0]!.detail).toBe('GigabitEthernet0/1 allows 1 MAC address');
    type(ps, 'SW1', 'enable\nconf t\nint g0/1\nswitchport port-security maximum 2');
    expect(ps.grade()[0]!.detail).toBe('The violation mode on GigabitEthernet0/1 is shutdown');
    type(ps, 'SW1', 'enable\nconf t\nint g0/1\nswitchport port-security violation restrict');
    expect(ps.grade()[0]!.detail).toBe('Sticky learning is off on GigabitEthernet0/1');

    const ec = lab('etherchannel-lacp');
    type(ec, 'SW1', 'enable\nconf t\nint range g0/1 - 2\nchannel-group 1 mode desirable');
    expect(ec.grade()[0]!.detail).toBe('Port-channel1 uses PAGP');
    expect(lab('stp-root-bridge').grade()[5]!.status).toBe('fail');
  });
});

describe('progress', () => {
  it('records checks, completion and hints', () => {
    let store = Progress.start({}, 'vlans-basic', 1000);
    store = Progress.check(store, 'vlans-basic', 3, 6, 2000);
    expect(store['vlans-basic']).toMatchObject({ checks: 1, bestScore: 3, completedAt: undefined });
    store = Progress.hint(store, 'vlans-basic');
    store = Progress.check(store, 'vlans-basic', 6, 6, 3000);
    store = Progress.check(store, 'vlans-basic', 4, 6, 4000);
    expect(store['vlans-basic']).toMatchObject({ checks: 3, bestScore: 6, completedAt: 3000, hintsUsed: 1 });
    expect(Progress.reset(store, 'vlans-basic')).toEqual({});
  });

  it('summarises completion per blueprint domain', () => {
    const store = Progress.check({}, 'vlans-basic', 6, 6, 1);
    const switching = summarise(store, LABS).find((s) => s.domain === '2.0')!;
    expect(switching.done).toBe(1);
    expect(switching.total).toBe(LABS.filter((l) => l.domain === '2.0').length);
    expect(switching.covered).toContain('2.2.a');
  });

  it('survives corrupt storage', () => {
    expect(parseProgress('not json')).toEqual({});
    expect(parseProgress('[1,2]')).toEqual({});
    expect(parseProgress('{"a":{"startedAt":5,"checks":"x"},"b":7}')).toEqual({
      a: { startedAt: 5, completedAt: undefined, checks: 0, bestScore: 0, hintsUsed: 0, solutionViewed: false },
    });
  });
});
