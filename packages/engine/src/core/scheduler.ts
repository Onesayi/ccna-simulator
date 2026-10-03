/**
 * Discrete-event scheduler with a virtual clock. Devices never call each other directly;
 * they schedule deliveries here. That keeps runs deterministic and lets the UI step
 * through a simulation one event at a time (the packet view).
 */
export interface ScheduledEvent {
  at: number;
  seq: number;
  label: string;
  run: () => void;
}

export class Scheduler {
  private queue: ScheduledEvent[] = [];
  private seq = 0;
  now = 0;

  schedule(delayMs: number, label: string, run: () => void): void {
    this.queue.push({ at: this.now + delayMs, seq: this.seq++, label, run });
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /** Runs the next event. Returns false when the queue is empty. */
  step(): boolean {
    const next = this.queue.shift();
    if (!next) return false;
    this.now = next.at;
    next.run();
    return true;
  }

  /** Runs until idle or until the safety limit is hit (guards against forwarding loops). */
  runUntilIdle(maxEvents = 10_000): number {
    let count = 0;
    while (count < maxEvents && this.step()) count++;
    return count;
  }

  get pending(): number {
    return this.queue.length;
  }
}
