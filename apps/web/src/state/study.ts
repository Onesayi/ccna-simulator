import { create } from 'zustand';
import {
  LabRun,
  PROBE_CHECKS,
  Progress,
  findLab,
  isComplete,
  parseProgress,
  type ObjectiveResult,
  type ProgressStore,
  type Topology,
} from '@ccna-sim/engine';
import { useNetwork, type XY } from './network';

const STORAGE_KEY = 'ccna-sim:progress:v1';

function loadProgress(): ProgressStore {
  try {
    return parseProgress(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function saveProgress(progress: ProgressStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Private windows and blocked storage: progress lasts for this visit only.
  }
}

/** The sandbox network, parked while a lab borrows the canvas. */
let parked: { topology: Topology; positions: Map<string, XY> } | undefined;

interface StudyState {
  run?: LabRun;
  results: ObjectiveResult[];
  /** Probe results from the last "Check my work", valid until the network changes. */
  probes: Map<number, ObjectiveResult>;
  probesAt?: number;
  /** True right after a check that passed every objective. */
  completed: boolean;
  progress: ProgressStore;
  hints: Set<number>;
  showSolution: boolean;
  start: (labId: string) => void;
  exit: () => void;
  reset: () => void;
  check: () => void;
  answer: (index: number, option: number) => void;
  revealHint: (index: number) => void;
  revealSolution: () => void;
  forgetProgress: () => void;
  regrade: () => void;
}

export const useStudy = create<StudyState>((set, get) => ({
  results: [],
  probes: new Map(),
  completed: false,
  progress: loadProgress(),
  hints: new Set(),
  showSolution: false,

  start: (labId) => {
    const lab = findLab(labId);
    if (!lab) return;
    const net = useNetwork.getState();
    if (!get().run) parked = { topology: net.topology, positions: net.positions };
    const run = new LabRun(lab);
    const progress = Progress.start(get().progress, lab.id);
    saveProgress(progress);
    set({ run, progress, probes: new Map(), probesAt: undefined, completed: false, hints: new Set(), showSolution: false });
    net.load(run.topology, run.positions);
    get().regrade();
  },

  exit: () => {
    if (!get().run) return;
    set({ run: undefined, results: [], probes: new Map(), probesAt: undefined, completed: false });
    if (parked) useNetwork.getState().load(parked.topology, parked.positions);
    parked = undefined;
  },

  reset: () => {
    const { run } = get();
    if (!run) return;
    const fresh = new LabRun(run.lab);
    set({ run: fresh, probes: new Map(), probesAt: undefined, completed: false, showSolution: false });
    useNetwork.getState().load(fresh.topology, fresh.positions);
    get().regrade();
  },

  check: () => {
    const { run } = get();
    if (!run) return;
    const results = run.grade({ probes: true });
    const probes = new Map<number, ObjectiveResult>();
    results.forEach((r, i) => {
      if (PROBE_CHECKS.includes(r.objective.check.type)) probes.set(i, r);
    });
    const passed = results.filter((r) => r.status === 'pass').length;
    const progress = Progress.check(get().progress, run.lab.id, passed, results.length);
    saveProgress(progress);
    // Pings ran on the virtual clock: redraw, but do not invalidate the probe results just taken.
    useNetwork.getState().touch(false);
    set({ results, probes, probesAt: useNetwork.getState().configVersion, progress, completed: isComplete(results) });
  },

  answer: (index, option) => {
    get().run?.answers.set(index, option);
    get().regrade();
  },

  revealHint: (index) => {
    const { run, hints } = get();
    if (!run || hints.has(index)) return;
    const progress = Progress.hint(get().progress, run.lab.id);
    saveProgress(progress);
    set({ hints: new Set([...hints, index]), progress });
  },

  revealSolution: () => {
    const { run } = get();
    if (!run) return;
    const progress = Progress.solution(get().progress, run.lab.id);
    saveProgress(progress);
    set({ showSolution: true, progress });
  },

  forgetProgress: () => {
    saveProgress({});
    set({ progress: {} });
  },

  regrade: () => {
    const { run, probes, probesAt } = get();
    if (!run) return;
    const fresh = probesAt === useNetwork.getState().configVersion;
    const results = run.grade().map((r, i) => (fresh && probes.has(i) ? probes.get(i)! : r));
    set({ results, completed: get().completed && isComplete(results) });
  },
}));

// Re-grade the cheap checks after every command or cabling change.
useNetwork.subscribe((s, prev) => {
  if (s.configVersion !== prev.configVersion) useStudy.getState().regrade();
});
