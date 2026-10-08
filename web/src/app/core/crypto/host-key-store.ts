import { InjectionToken } from '@angular/core';
import { HostKey } from './host-key';

/**
 * Where this browser keeps its meetings' host keys. Keys are stored as non-extractable CryptoKeys (structured clone
 * keeps them non-extractable), never as bytes — nothing in storage can be read back as key material.
 */
export interface HostKeyStore {
  list(): Promise<HostKey[]>;
  get(roomId: string): Promise<HostKey | undefined>;
  put(hostKey: HostKey): Promise<void>;
  delete(roomId: string): Promise<void>;
}

const DB_NAME = 'cipheroom';
const STORE = 'host-keys';
/**
 * IndexedDB can stall without ever answering (seen when a page that was creating the database is left mid-way and
 * frozen in the back/forward cache; WebKit has had similar bugs). Joining must never hang on it: after this long the
 * store counts as unavailable — a guest joins as a guest, a host sees "can't keep keys".
 */
export const IDB_TIMEOUT_MS = 3000;

/** IndexedDB: survives reloads; gone if the user clears site data (that's what the backup file is for). */
export class IndexedDbHostKeyStore implements HostKeyStore {
  private db?: Promise<IDBDatabase>;

  constructor(
    private readonly idb: () => IDBFactory | undefined = () =>
      typeof indexedDB === 'undefined' ? undefined : indexedDB,
    private readonly timeoutMs = IDB_TIMEOUT_MS,
  ) {}

  async list(): Promise<HostKey[]> {
    const keys = await this.request<HostKey[]>('readonly', (s) => s.getAll());
    return keys.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(roomId: string): Promise<HostKey | undefined> {
    return this.request<HostKey | undefined>('readonly', (s) => s.get(roomId));
  }

  async put(hostKey: HostKey): Promise<void> {
    await this.request('readwrite', (s) => s.put(hostKey));
  }

  async delete(roomId: string): Promise<void> {
    await this.request('readwrite', (s) => s.delete(roomId));
  }

  private async request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return this.withTimeout(
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      }),
    );
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= this.withTimeout(
      new Promise<IDBDatabase>((resolve, reject) => {
        const idb = this.idb();
        if (!idb) return reject(new Error('No IndexedDB.'));
        const request = idb.open(DB_NAME, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore(STORE, { keyPath: 'roomId' });
        request.onblocked = () => reject(new Error('IndexedDB blocked.'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          // Never hold up another page (or a newer version of the app) that needs the database.
          db.onversionchange = () => this.close(db);
          globalThis.addEventListener?.('pagehide', () => this.close(db), { once: true });
          resolve(db);
        };
      }),
    );
    this.db.catch(() => (this.db = undefined));
    return this.db;
  }

  private close(db: IDBDatabase): void {
    db.close();
    this.db = undefined;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB timed out.')), this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/** In memory only (tests, and browsers without IndexedDB — those can't host). */
export class MemoryHostKeyStore implements HostKeyStore {
  private readonly keys = new Map<string, HostKey>();

  async list(): Promise<HostKey[]> {
    return [...this.keys.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(roomId: string): Promise<HostKey | undefined> {
    return this.keys.get(roomId);
  }

  async put(hostKey: HostKey): Promise<void> {
    this.keys.set(hostKey.roomId, hostKey);
  }

  async delete(roomId: string): Promise<void> {
    this.keys.delete(roomId);
  }
}

export const HOST_KEY_STORE = new InjectionToken<HostKeyStore>('HostKeyStore', {
  providedIn: 'root',
  factory: () => new IndexedDbHostKeyStore(),
});
