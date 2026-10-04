import { describe, expect, it } from 'vitest';
import {
  DOMAINS,
  DOMAIN_WEIGHTS,
  EXAM_LENGTHS,
  PASS_SCORE,
  QUESTION_BANK,
  SECONDS_PER_QUESTION,
  allocate,
  buildExam,
  findLab,
  isCorrect,
  labsToPractise,
  parseExamHistory,
  recordAttempt,
  scoreExam,
  seededRandom,
  type DomainId,
  type ExamAnswers,
  type ExamQuestion,
} from '../src';

const domains = Object.keys(DOMAINS) as DomainId[];
const countBy = (qs: { domain: DomainId }[]) => Object.fromEntries(domains.map((d) => [d, qs.filter((q) => q.domain === d).length])) as Record<DomainId, number>;

describe('question bank', () => {
  it('has unique ids', () => {
    expect(new Set(QUESTION_BANK.map((q) => q.id)).size).toBe(QUESTION_BANK.length);
  });

  it('has enough questions in every domain for a full exam', () => {
    const full = EXAM_LENGTHS.find((l) => l.id === 'full')!.questions;
    const have = countBy(QUESTION_BANK);
    for (const d of domains) expect(have[d]).toBeGreaterThanOrEqual(full * DOMAIN_WEIGHTS[d]);
  });

  for (const q of QUESTION_BANK) {
    it(`${q.id} is well formed`, () => {
      expect(domains).toContain(q.domain);
      expect(q.objective.startsWith(q.domain[0]!)).toBe(true);
      expect(q.correct.length).toBeGreaterThan(0);
      expect(q.wrong.length).toBeGreaterThan(0);
      const options = [...q.correct, ...q.wrong];
      expect(new Set(options).size).toBe(options.length);
      if (q.correct.length > 1) expect(q.prompt).toMatch(new RegExp(`Choose ${['', '', 'two', 'three'][q.correct.length]}`, 'i'));
      expect(q.explain.length).toBeGreaterThan(20);
      for (const lab of q.labs ?? []) expect(findLab(lab), `lab ${lab}`).toBeDefined();
    });
  }
});

describe('weights add up', () => {
  it('to the whole exam', () => {
    expect(Object.values(DOMAIN_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe('allocate', () => {
  const plenty = { '1.0': 50, '2.0': 50, '3.0': 50, '4.0': 50, '5.0': 50 } as const;

  it('follows the blueprint weights', () => {
    expect(allocate(100, plenty)).toEqual({ '1.0': 25, '2.0': 25, '3.0': 20, '4.0': 20, '5.0': 10 });
  });

  it('hands out remainders and always totals the requested count', () => {
    for (const n of [1, 7, 20, 33, 50]) {
      const a = allocate(n, plenty);
      expect(Object.values(a).reduce((x, y) => x + y, 0)).toBe(n);
    }
    expect(allocate(20, plenty)).toEqual({ '1.0': 5, '2.0': 5, '3.0': 4, '4.0': 4, '5.0': 2 });
  });

  it('borrows from other domains when one runs short', () => {
    const a = allocate(20, { '1.0': 1, '2.0': 50, '3.0': 50, '4.0': 50, '5.0': 0 });
    expect(a['1.0']).toBe(1);
    expect(a['5.0']).toBe(0);
    expect(Object.values(a).reduce((x, y) => x + y, 0)).toBe(20);
  });

  it('stops when there is nothing left to give', () => {
    const a = allocate(10, { '1.0': 1, '2.0': 2, '3.0': 0, '4.0': 0, '5.0': 0 });
    expect(a).toEqual({ '1.0': 1, '2.0': 2, '3.0': 0, '4.0': 0, '5.0': 0 });
  });
});

describe('buildExam', () => {
  it('is repeatable from its seed', () => {
    const a = buildExam(QUESTION_BANK, { questions: 20, seed: 42 });
    const b = buildExam(QUESTION_BANK, { questions: 20, seed: 42 });
    expect(b.items.map((i) => [i.question.id, i.options])).toEqual(a.items.map((i) => [i.question.id, i.options]));
    expect(buildExam(QUESTION_BANK, { questions: 20, seed: 43 }).items.map((i) => i.question.id)).not.toEqual(a.items.map((i) => i.question.id));
  });

  it('weights a full exam like the blueprint, with no repeats', () => {
    const exam = buildExam(QUESTION_BANK, { questions: 100, seed: 7 });
    expect(exam.items).toHaveLength(100);
    expect(new Set(exam.items.map((i) => i.question.id)).size).toBe(100);
    expect(countBy(exam.items.map((i) => i.question))).toEqual({ '1.0': 25, '2.0': 25, '3.0': 20, '4.0': 20, '5.0': 10 });
    expect(exam.seconds).toBe(100 * SECONDS_PER_QUESTION);
  });

  it('shuffles options but keeps the answer pointing at the correct text', () => {
    const exam = buildExam(QUESTION_BANK, { questions: 50, seed: 3 });
    for (const item of exam.items) {
      expect(item.options).toHaveLength(item.question.correct.length + item.question.wrong.length);
      expect(item.answer.map((i) => item.options[i]).sort()).toEqual([...item.question.correct].sort());
    }
    // With 50 questions, the correct option cannot always land first.
    expect(exam.items.some((i) => i.answer[0] !== 0)).toBe(true);
  });

  it('can focus on one domain and caps at what the bank has', () => {
    const exam = buildExam(QUESTION_BANK, { questions: 500, seed: 1, domain: '5.0', seconds: 600 });
    expect(exam.domain).toBe('5.0');
    expect(exam.seconds).toBe(600);
    expect(exam.items.every((i) => i.question.domain === '5.0')).toBe(true);
    expect(exam.items).toHaveLength(QUESTION_BANK.filter((q) => q.domain === '5.0').length);
  });

  it('picks a random seed when none is given', () => {
    const exam = buildExam(QUESTION_BANK, { questions: 5 });
    expect(Number.isInteger(exam.seed)).toBe(true);
    expect(exam.items).toHaveLength(5);
  });
});

describe('seededRandom', () => {
  it('stays in [0, 1)', () => {
    const r = seededRandom(9);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('scoring', () => {
  const multi: ExamQuestion = {
    id: 'multi',
    domain: '2.0',
    objective: '2.5',
    prompt: 'Pick both. (Choose two.)',
    correct: ['a', 'b'],
    wrong: ['c', 'd'],
    explain: 'Both a and b are right, as the test says.',
    labs: ['stp-root-bridge', 'vlans-basic'],
  };
  const single: ExamQuestion = { ...multi, id: 'single', domain: '4.0', objective: '4.6', prompt: 'Pick a.', correct: ['a'], wrong: ['b', 'c'], labs: ['vlans-basic'] };
  const exam = buildExam([multi, single], { questions: 2, seed: 5 });
  const iMulti = exam.items.findIndex((i) => i.question.id === 'multi');
  const iSingle = 1 - iMulti;

  it('marks choose-N questions all or nothing, in any order', () => {
    const item = exam.items[iMulti]!;
    expect(isCorrect(item, [...item.answer].reverse())).toBe(true);
    expect(isCorrect(item, item.answer.slice(0, 1))).toBe(false);
    expect(isCorrect(item, undefined)).toBe(false);
    const wrong = [0, 1, 2, 3].filter((i) => !item.answer.includes(i));
    expect(isCorrect(item, [item.answer[0]!, wrong[0]!])).toBe(false);
  });

  it('scores per domain and lists what was missed', () => {
    const answers: ExamAnswers = { [iMulti]: exam.items[iMulti]!.answer };
    const result = scoreExam(exam, answers);
    expect(result).toMatchObject({ correct: 1, total: 2, score: 500, passed: false, missed: [iSingle] });
    expect(result.domains).toEqual([
      { domain: '2.0', name: DOMAINS['2.0'], correct: 1, total: 1 },
      { domain: '4.0', name: DOMAINS['4.0'], correct: 0, total: 1 },
    ]);
  });

  it('passes at the pass mark', () => {
    const all: ExamAnswers = Object.fromEntries(exam.items.map((item, i) => [i, item.answer]));
    const result = scoreExam(exam, all);
    expect(result.score).toBe(1000);
    expect(result.score).toBeGreaterThanOrEqual(PASS_SCORE);
    expect(result.passed).toBe(true);
    expect(result.missed).toEqual([]);
  });

  it('scores an empty exam as zero', () => {
    expect(scoreExam({ seed: 0, items: [], seconds: 0 }, {})).toMatchObject({ score: 0, total: 0, passed: false });
  });

  it('suggests the labs behind the most missed questions first', () => {
    expect(labsToPractise(exam, [0, 1])).toEqual([
      { lab: 'vlans-basic', missed: 2 },
      { lab: 'stp-root-bridge', missed: 1 },
    ]);
    expect(labsToPractise(exam, [])).toEqual([]);
  });
});

describe('history', () => {
  const exam = buildExam(QUESTION_BANK, { questions: 10, seed: 11, domain: '3.0' });
  const result = scoreExam(exam, {});

  it('records attempts newest first and keeps the last 20', () => {
    let history = recordAttempt([], exam, result, 1000);
    expect(history[0]).toMatchObject({ at: 1000, score: 0, correct: 0, total: 10, domain: '3.0' });
    expect(history[0]!.domains).toEqual([{ domain: '3.0', correct: 0, total: 10 }]);
    for (let i = 0; i < 25; i++) history = recordAttempt(history, exam, result, 2000 + i);
    expect(history).toHaveLength(20);
    expect(history[0]!.at).toBe(2024);
  });

  it('leaves out the domain for a mixed exam', () => {
    const mixed = buildExam(QUESTION_BANK, { questions: 10, seed: 1 });
    expect(recordAttempt([], mixed, scoreExam(mixed, {}))[0]).not.toHaveProperty('domain');
  });

  it('parses stored history defensively', () => {
    const good = recordAttempt([], exam, result, 5);
    expect(parseExamHistory(JSON.stringify(good))).toEqual(good);
    expect(parseExamHistory(null)).toEqual([]);
    expect(parseExamHistory('not json')).toEqual([]);
    expect(parseExamHistory('{"a":1}')).toEqual([]);
    expect(parseExamHistory(JSON.stringify([null, { at: 1 }, ...good]))).toEqual(good);
  });
});
