/**
 * Runs async jobs one at a time, in call order. The SFU requires mutations on one session (and a peer connection
 * requires offer/answer exchanges) not to overlap. A failed job rejects its own promise but doesn't block later jobs.
 * `runFirst` jobs go ahead of every job that hasn't started yet (still after the one running, never overlapping it).
 */
export class SerialQueue {
  private readonly waiting: Entry[] = [];
  private running = false;

  run<T>(job: () => Promise<T>): Promise<T> {
    return this.add(job, false);
  }

  /** Ahead of queued jobs (after earlier `runFirst` ones): for work a user is waiting on, like a file transfer. */
  runFirst<T>(job: () => Promise<T>): Promise<T> {
    return this.add(job, true);
  }

  private add<T>(job: () => Promise<T>, first: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { job, resolve: resolve as (value: unknown) => void, reject, first };
      const at = first ? this.waiting.filter((e) => e.first).length : this.waiting.length;
      this.waiting.splice(at, 0, entry);
      this.next();
    });
  }

  private next(): void {
    if (this.running || !this.waiting.length) return;
    this.running = true;
    const entry = this.waiting.shift()!;
    // Always asynchronously, as a job never starts inside the call that queued it.
    void Promise.resolve()
      .then(entry.job)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.running = false;
        this.next();
      });
  }
}

interface Entry {
  job: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  first: boolean;
}
