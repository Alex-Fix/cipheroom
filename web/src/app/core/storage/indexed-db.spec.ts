import { IdbStore } from './indexed-db';

const options = { db: 'test', store: 'items', keyPath: 'id' };

describe('IdbStore', () => {
  it('gives up on an IndexedDB that never answers (nothing may hang on it)', async () => {
    const silent = { open: () => ({}) } as unknown as IDBFactory;
    const store = new IdbStore({ ...options, idb: () => silent, timeoutMs: 20 });
    await expect(store.get('x')).rejects.toThrow('IndexedDB timed out.');
  });

  it('reports a browser without IndexedDB', async () => {
    await expect(new IdbStore({ ...options, idb: () => undefined }).getAll()).rejects.toThrow(
      'No IndexedDB.',
    );
  });

  it('gives up when another page blocks the database, and tries again next time', async () => {
    const request = {} as IDBOpenDBRequest;
    const open = vi.fn(
      () => (queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent)), request),
    );
    const store = new IdbStore({ ...options, idb: () => ({ open }) as unknown as IDBFactory });
    await expect(store.getAll()).rejects.toThrow('IndexedDB blocked.');
    await expect(store.getAll()).rejects.toThrow('IndexedDB blocked.');
    expect(open).toHaveBeenCalledTimes(2);
  });
});
