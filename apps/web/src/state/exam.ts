import { create } from 'zustand';
import {
  QUESTION_BANK,
  buildExam,
  parseExamHistory,
  recordAttempt,
  scoreExam,
  type DomainId,
  type Exam,
  type ExamAnswers,
  type ExamAttempt,
  type ExamResult,
} from '@ccna-sim/engine';

const HISTORY_KEY = 'ccna-sim:exam-history:v1';
const SESSION_KEY = 'ccna-sim:exam-session:v1';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the exam still works, it just is not remembered.
  }
}

/** What is saved while an exam runs, so a reload picks up where it left off. The exam itself is rebuilt from its seed. */
interface SavedSession {
  seed: number;
  questions: number;
  domain?: DomainId;
  seconds: number;
  startedAt: number;
  answers: ExamAnswers;
  flagged: number[];
}

export interface StartOptions {
  questions: number;
  domain?: DomainId;
  seed?: number;
}

interface ExamState {
  exam?: Exam;
  answers: ExamAnswers;
  flagged: Set<number>;
  current: number;
  startedAt: number;
  /** Set once the exam is marked. */
  result?: ExamResult;
  finishedAt?: number;
  history: ExamAttempt[];
  start: (opts: StartOptions) => void;
  choose: (item: number, option: number) => void;
  toggleFlag: (item: number) => void;
  goTo: (item: number) => void;
  finish: () => void;
  /** Back to the setup screen, dropping any exam in progress. */
  leave: () => void;
  clearHistory: () => void;
}

function save(s: Pick<ExamState, 'exam' | 'answers' | 'flagged' | 'startedAt'>): void {
  if (!s.exam) return write(SESSION_KEY, null);
  const session: SavedSession = {
    seed: s.exam.seed,
    questions: s.exam.items.length,
    domain: s.exam.domain,
    seconds: s.exam.seconds,
    startedAt: s.startedAt,
    answers: s.answers,
    flagged: [...s.flagged],
  };
  write(SESSION_KEY, JSON.stringify(session));
}

function resume(): Partial<ExamState> {
  try {
    const s = JSON.parse(read(SESSION_KEY) ?? 'null') as SavedSession | null;
    if (!s || typeof s.seed !== 'number' || typeof s.startedAt !== 'number') return {};
    const exam = buildExam(QUESTION_BANK, { questions: s.questions, seed: s.seed, domain: s.domain, seconds: s.seconds });
    return { exam, answers: s.answers ?? {}, flagged: new Set(s.flagged ?? []), startedAt: s.startedAt, current: 0 };
  } catch {
    return {};
  }
}

export const useExam = create<ExamState>((set, get) => ({
  answers: {},
  flagged: new Set(),
  current: 0,
  startedAt: 0,
  history: parseExamHistory(read(HISTORY_KEY)),
  ...resume(),

  start: ({ questions, domain, seed }) => {
    const exam = buildExam(QUESTION_BANK, { questions, domain, seed });
    const next = { exam, answers: {}, flagged: new Set<number>(), current: 0, startedAt: Date.now(), result: undefined, finishedAt: undefined };
    set(next);
    save(next);
  },

  choose: (item, option) => {
    const { exam, answers } = get();
    if (!exam || get().result) return;
    const multi = exam.items[item]!.answer.length > 1;
    const had = answers[item] ?? [];
    const picked = multi ? (had.includes(option) ? had.filter((o) => o !== option) : [...had, option]) : [option];
    set({ answers: { ...answers, [item]: picked } });
    save(get());
  },

  toggleFlag: (item) => {
    const flagged = new Set(get().flagged);
    if (flagged.has(item)) flagged.delete(item);
    else flagged.add(item);
    set({ flagged });
    save(get());
  },

  goTo: (item) => {
    const { exam } = get();
    if (exam && item >= 0 && item < exam.items.length) set({ current: item });
  },

  finish: () => {
    const { exam, answers, result } = get();
    if (!exam || result) return;
    const marked = scoreExam(exam, answers);
    const history = recordAttempt(get().history, exam, marked);
    write(HISTORY_KEY, JSON.stringify(history));
    write(SESSION_KEY, null);
    set({ result: marked, finishedAt: Date.now(), history });
  },

  leave: () => {
    write(SESSION_KEY, null);
    set({ exam: undefined, answers: {}, flagged: new Set(), current: 0, result: undefined, finishedAt: undefined });
  },

  clearHistory: () => {
    write(HISTORY_KEY, null);
    set({ history: [] });
  },
}));
