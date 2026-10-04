import { DOMAINS, type DomainId } from '../labs/types';
import type { DomainScore, Exam, ExamAnswers, ExamItem, ExamQuestion, ExamResult } from './types';

/** Share of the exam each domain gets, from the 200-301 v2.0 exam topics. */
export const DOMAIN_WEIGHTS: Record<DomainId, number> = { '1.0': 0.25, '2.0': 0.25, '3.0': 0.2, '4.0': 0.2, '5.0': 0.1 };

/**
 * Cisco does not publish the cut score and it moves between exam forms. 825 of 1000 is the
 * figure most often quoted, so the practice exam uses it as its pass mark.
 */
export const PASS_SCORE = 825;

/** The real exam allows 120 minutes for roughly 100 questions, so each preset keeps that pace. */
export const SECONDS_PER_QUESTION = 72;

export const EXAM_LENGTHS = [
  { id: 'quick', label: 'Quick', questions: 20 },
  { id: 'half', label: 'Half exam', questions: 50 },
  { id: 'full', label: 'Full exam', questions: 100 },
] as const;

/** A small seeded generator (mulberry32), so an exam can be rebuilt from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Splits `count` questions across domains by blueprint weight (largest remainder), capped by what each domain has. */
export function allocate(count: number, available: Record<DomainId, number>): Record<DomainId, number> {
  const domains = Object.keys(DOMAIN_WEIGHTS) as DomainId[];
  const want = domains.map((d) => ({ d, exact: count * DOMAIN_WEIGHTS[d] }));
  const out = Object.fromEntries(want.map(({ d, exact }) => [d, Math.min(Math.floor(exact), available[d])])) as Record<DomainId, number>;
  let left = count - domains.reduce((n, d) => n + out[d], 0);
  // Hand out the rest by largest remainder, then round again to any domain with questions to spare.
  const order = [...want].sort((a, b) => (b.exact % 1) - (a.exact % 1)).map((w) => w.d);
  while (left > 0 && order.some((d) => out[d] < available[d])) {
    for (const d of order) {
      if (left > 0 && out[d] < available[d]) {
        out[d]++;
        left--;
      }
    }
  }
  return out;
}

function toItem(question: ExamQuestion, random: () => number): ExamItem {
  const options = shuffle([...question.correct, ...question.wrong], random);
  const answer = question.correct.map((c) => options.indexOf(c)).sort((a, b) => a - b);
  return { question, options, answer };
}

export interface ExamOptions {
  questions: number;
  seed?: number;
  /** Draw only from one domain. */
  domain?: DomainId;
  /** Time allowed; defaults to the real exam's pace. */
  seconds?: number;
}

/** Draws an exam from the bank: weighted by domain like the real thing, with questions and options shuffled. */
export function buildExam(bank: readonly ExamQuestion[], opts: ExamOptions): Exam {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = seededRandom(seed);
  const pool = opts.domain ? bank.filter((q) => q.domain === opts.domain) : bank;
  const byDomain = Object.fromEntries((Object.keys(DOMAINS) as DomainId[]).map((d) => [d, shuffle(pool.filter((q) => q.domain === d), random)])) as Record<
    DomainId,
    ExamQuestion[]
  >;
  const count = Math.min(opts.questions, pool.length);
  const picked = opts.domain
    ? byDomain[opts.domain].slice(0, count)
    : Object.entries(allocate(count, Object.fromEntries(Object.entries(byDomain).map(([d, qs]) => [d, qs.length])) as Record<DomainId, number>)).flatMap(
        ([d, n]) => byDomain[d as DomainId].slice(0, n),
      );
  const items = shuffle(picked, random).map((q) => toItem(q, random));
  return { seed, items, seconds: opts.seconds ?? items.length * SECONDS_PER_QUESTION, domain: opts.domain };
}

export function isCorrect(item: ExamItem, chosen: readonly number[] | undefined): boolean {
  if (!chosen || chosen.length !== item.answer.length) return false;
  const sorted = [...chosen].sort((a, b) => a - b);
  return sorted.every((c, i) => c === item.answer[i]);
}

/** Marks an exam: overall, per domain, and which items were missed. Unanswered counts as wrong. */
export function scoreExam(exam: Exam, answers: ExamAnswers): ExamResult {
  const tally = new Map<DomainId, DomainScore>();
  const missed: number[] = [];
  exam.items.forEach((item, i) => {
    const d = item.question.domain;
    const s = tally.get(d) ?? { domain: d, name: DOMAINS[d], correct: 0, total: 0 };
    s.total++;
    if (isCorrect(item, answers[i])) s.correct++;
    else missed.push(i);
    tally.set(d, s);
  });
  const total = exam.items.length;
  const correct = total - missed.length;
  const score = total ? Math.round((correct / total) * 1000) : 0;
  const domains = (Object.keys(DOMAINS) as DomainId[]).flatMap((d) => (tally.has(d) ? [tally.get(d)!] : []));
  return { correct, total, score, passed: score >= PASS_SCORE, domains, missed };
}

/** Labs that practise what was missed, most-missed first. */
export function labsToPractise(exam: Exam, missed: readonly number[]): { lab: string; missed: number }[] {
  const counts = new Map<string, number>();
  for (const i of missed) {
    for (const lab of exam.items[i]?.question.labs ?? []) counts.set(lab, (counts.get(lab) ?? 0) + 1);
  }
  return [...counts].map(([lab, n]) => ({ lab, missed: n })).sort((a, b) => b.missed - a.missed || a.lab.localeCompare(b.lab));
}

/** One finished attempt, as the history keeps it. */
export interface ExamAttempt {
  at: number;
  score: number;
  correct: number;
  total: number;
  domain?: DomainId;
  domains: { domain: DomainId; correct: number; total: number }[];
}

const HISTORY_LIMIT = 20;

/** Adds an attempt to the front of the history, keeping the most recent few. */
export function recordAttempt(history: readonly ExamAttempt[], exam: Exam, result: ExamResult, now = Date.now()): ExamAttempt[] {
  const attempt: ExamAttempt = {
    at: now,
    score: result.score,
    correct: result.correct,
    total: result.total,
    ...(exam.domain ? { domain: exam.domain } : {}),
    domains: result.domains.map(({ domain, correct, total }) => ({ domain, correct, total })),
  };
  return [attempt, ...history].slice(0, HISTORY_LIMIT);
}

/** Parses stored JSON defensively: anything malformed is dropped. */
export function parseExamHistory(json: string | null | undefined): ExamAttempt[] {
  if (!json) return [];
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (a): a is ExamAttempt =>
        typeof a === 'object' &&
        a !== null &&
        typeof a.at === 'number' &&
        typeof a.score === 'number' &&
        typeof a.correct === 'number' &&
        typeof a.total === 'number' &&
        Array.isArray(a.domains),
    );
  } catch {
    return [];
  }
}
