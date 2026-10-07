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
});
