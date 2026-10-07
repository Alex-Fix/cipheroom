/**
 * Runs async jobs one at a time, in call order. The SFU requires mutations on one session (and a peer connection
 * requires offer/answer exchanges) not to overlap. A failed job rejects its own promise but doesn't block later jobs.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
