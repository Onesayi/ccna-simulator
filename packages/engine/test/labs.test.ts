import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, LABS, LabRun, Progress, isComplete, parseProgress, resetMacAllocator, summarise } from '../src';

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
