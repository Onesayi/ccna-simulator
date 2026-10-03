import { DOMAINS, type DomainId, type LabDefinition } from './types';

/** What the study tracker remembers about one lab. Times are epoch milliseconds. */
export interface LabProgress {
  startedAt: number;
  completedAt?: number;
  /** Times "Check my work" was pressed. */
  checks: number;
  /** Best number of objectives passed in one check. */
  bestScore: number;
  hintsUsed: number;
  solutionViewed: boolean;
}

export type ProgressStore = Record<string, LabProgress>;

function entry(store: ProgressStore, labId: string, now: number): LabProgress {
  return store[labId] ?? { startedAt: now, checks: 0, bestScore: 0, hintsUsed: 0, solutionViewed: false };
}

/** The pure state transitions behind progress tracking. Each returns a new store. */
export const Progress = {
  start(store: ProgressStore, labId: string, now = Date.now()): ProgressStore {
    return { ...store, [labId]: entry(store, labId, now) };
  },

  check(store: ProgressStore, labId: string, passed: number, total: number, now = Date.now()): ProgressStore {
    const e = entry(store, labId, now);
    const done = passed === total;
    return {
      ...store,
      [labId]: { ...e, checks: e.checks + 1, bestScore: Math.max(e.bestScore, passed), completedAt: e.completedAt ?? (done ? now : undefined) },
    };
  },

  hint(store: ProgressStore, labId: string, now = Date.now()): ProgressStore {
    const e = entry(store, labId, now);
    return { ...store, [labId]: { ...e, hintsUsed: e.hintsUsed + 1 } };
  },

  solution(store: ProgressStore, labId: string, now = Date.now()): ProgressStore {
    return { ...store, [labId]: { ...entry(store, labId, now), solutionViewed: true } };
  },

  reset(store: ProgressStore, labId: string): ProgressStore {
    const { [labId]: _gone, ...rest } = store;
    return rest;
  },
};

export interface DomainSummary {
  domain: DomainId;
  name: string;
  done: number;
  total: number;
  /** Blueprint objectives that at least one completed lab covers. */
  covered: string[];
}

/** Completion per blueprint domain, for the catalog's progress bars. Domains without labs are left out. */
export function summarise(store: ProgressStore, labs: LabDefinition[]): DomainSummary[] {
  return (Object.keys(DOMAINS) as DomainId[])
    .map((domain) => {
      const inDomain = labs.filter((l) => l.domain === domain);
      const done = inDomain.filter((l) => store[l.id]?.completedAt);
      return {
        domain,
        name: DOMAINS[domain],
        done: done.length,
        total: inDomain.length,
        covered: [...new Set(done.flatMap((l) => l.blueprint))].sort(),
      };
    })
    .filter((s) => s.total > 0);
}

/** Parses stored JSON defensively: anything malformed becomes an empty store. */
export function parseProgress(json: string | null | undefined): ProgressStore {
  if (!json) return {};
  try {
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: ProgressStore = {};
    for (const [id, v] of Object.entries(data as Record<string, Partial<LabProgress>>)) {
      if (!v || typeof v !== 'object' || typeof v.startedAt !== 'number') continue;
      out[id] = {
        startedAt: v.startedAt,
        completedAt: typeof v.completedAt === 'number' ? v.completedAt : undefined,
        checks: Number(v.checks) || 0,
        bestScore: Number(v.bestScore) || 0,
        hintsUsed: Number(v.hintsUsed) || 0,
        solutionViewed: v.solutionViewed === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}
