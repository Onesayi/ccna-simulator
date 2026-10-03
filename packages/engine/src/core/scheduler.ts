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

  schedule(delayMs: number, label: string, run: () => void): ScheduledEvent {
    const event = { at: this.now + delayMs, seq: this.seq++, label, run };
    this.queue.push(event);
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return event;
  }

  /** Removes an event that has not run yet (a timer that is no longer needed). */
  cancel(event: ScheduledEvent): void {
    const i = this.queue.indexOf(event);
    if (i >= 0) this.queue.splice(i, 1);
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
