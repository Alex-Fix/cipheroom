import { IndexedDbHostKeyStore, MemoryHostKeyStore } from './host-key-store';
import { HostKey } from './host-key';

const key = (roomId: string, createdAt: number) => ({ roomId, createdAt }) as HostKey;

describe('host key stores', () => {
  it('MemoryHostKeyStore lists newest first, gets, deletes', async () => {
    const store = new MemoryHostKeyStore();
    await store.put(key('a', 1));
    await store.put(key('b', 2));
    expect((await store.list()).map((k) => k.roomId)).toEqual(['b', 'a']);
    await store.delete('b');
    expect(await store.get('b')).toBeUndefined();
    expect((await store.get('a'))?.roomId).toBe('a');
  });

  it('IndexedDbHostKeyStore gives up on an IndexedDB that never answers (joining must not hang)', async () => {
    const silent = { open: () => ({}) } as unknown as IDBFactory;
    const store = new IndexedDbHostKeyStore(() => silent, 20);
    await expect(store.get('room')).rejects.toThrow('IndexedDB timed out.');
  });

  it('IndexedDbHostKeyStore reports a browser without IndexedDB', async () => {
    const store = new IndexedDbHostKeyStore(() => undefined);
    await expect(store.list()).rejects.toThrow('No IndexedDB.');
  });

  it('IndexedDbHostKeyStore gives up when another page blocks the database', async () => {
    const request = {} as IDBOpenDBRequest;
    const blocking = {
      open: () => (queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent)), request),
    } as unknown as IDBFactory;
    await expect(new IndexedDbHostKeyStore(() => blocking).list()).rejects.toThrow(
      'IndexedDB blocked.',
    );
  });
});
