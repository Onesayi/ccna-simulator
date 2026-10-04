import type { DomainId } from '../labs/types';

/**
 * One multiple-choice question in the practice exam bank. Options are written with the
 * correct answers in `correct` and the distractors in `wrong`; the exam builder shuffles them.
 * More than one correct answer makes it a "choose N" question, scored all or nothing.
 */
export interface ExamQuestion {
  id: string;
  domain: DomainId;
  /** The v2.0 blueprint objective it tests, such as "1.3" or "4.7". */
  objective: string;
  prompt: string;
  /** Monospaced text shown under the prompt: command output, a routing table, a config. */
  exhibit?: string;
  correct: string[];
  wrong: string[];
  /** Why the answer is right, shown when reviewing a missed question. */
  explain: string;
  /** Labs that practise the topic, by lab id. */
  labs?: string[];
}

/** A question as it appears in one exam: options shuffled, answers as option indices. */
export interface ExamItem {
  question: ExamQuestion;
  options: string[];
  /** Indices into `options`, ascending. */
  answer: number[];
}

export interface Exam {
  seed: number;
  items: ExamItem[];
  /** Time allowed, in seconds. */
  seconds: number;
  /** Set when the exam was limited to one domain. */
  domain?: DomainId;
}

/** The candidate's chosen option indices, by item index. A missing entry is unanswered. */
export type ExamAnswers = Record<number, number[]>;

export interface DomainScore {
  domain: DomainId;
  name: string;
  correct: number;
  total: number;
}

export interface ExamResult {
  correct: number;
  total: number;
  /** 0 to 1000, the scale Cisco reports on. */
  score: number;
  passed: boolean;
  domains: DomainScore[];
  /** Item indices answered wrongly or left blank, in exam order. */
  missed: number[];
}
