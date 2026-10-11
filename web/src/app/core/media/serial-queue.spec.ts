import { SerialQueue } from './serial-queue';

describe('SerialQueue', () => {
  it('runs jobs one at a time in call order', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });

    const results = await Promise.all([queue.run(job('a', 20)), queue.run(job('b', 1))]);

    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps going after a failed job', async () => {
    const queue = new SerialQueue();

    const failed = queue.run(() => Promise.reject(new Error('boom')));
    const next = queue.run(() => Promise.resolve('ok'));

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('runs runFirst jobs ahead of queued ones, after the running one, in their own order', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
    };

    await Promise.all([
      queue.run(job('running')),
      queue.run(job('queued')),
      queue.runFirst(job('first-1')),
      queue.runFirst(job('first-2')),
    ]);

    expect(log).toEqual([
      'start running', 'end running',
      'start first-1', 'end first-1',
      'start first-2', 'end first-2',
      'start queued', 'end queued',
    ]);
  });

  it('never starts a job inside the call that queued it', () => {
    const queue = new SerialQueue();
    let started = false;
    void queue.run(async () => {
      started = true;
    });
    expect(started).toBe(false);
  });
});
