/**
 * IndexedDB can stall without ever answering (seen when a page that was creating the database is left mid-way and
 * frozen in the back/forward cache; WebKit has had similar bugs). Nothing may hang on it: after this long the store
 * counts as unavailable.
 */
export const IDB_TIMEOUT_MS = 3000;

export interface IdbStoreOptions {
  /** Database name; each store here owns its own database (version 1), so stores never need each other's upgrades. */
  db: string;
  store: string;
  keyPath: string;
  idb?: () => IDBFactory | undefined;
  timeoutMs?: number;
}

/**
 * One object store in its own IndexedDB database, with the app's rules: every request times out, the connection is
 * closed on `versionchange` and `pagehide` (never holding up another page), and a failed open is retried next time.
 * Values go through structured clone, so non-extractable CryptoKeys stay non-extractable.
 */
export class IdbStore<T> {
  private connection?: Promise<IDBDatabase>;
  private readonly idb: () => IDBFactory | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: IdbStoreOptions) {
    this.idb = options.idb ?? (() => (typeof indexedDB === 'undefined' ? undefined : indexedDB));
    this.timeoutMs = options.timeoutMs ?? IDB_TIMEOUT_MS;
  }

  getAll(): Promise<T[]> {
    return this.request<T[]>('readonly', (s) => s.getAll());
  }

  get(key: IDBValidKey): Promise<T | undefined> {
    return this.request<T | undefined>('readonly', (s) => s.get(key));
  }

  async put(value: T): Promise<void> {
    await this.request('readwrite', (s) => s.put(value));
  }

  async delete(key: IDBValidKey): Promise<void> {
    await this.request('readwrite', (s) => s.delete(key));
  }

  async clear(): Promise<void> {
    await this.request('readwrite', (s) => s.clear());
  }

  private async request<R>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<R> {
    const db = await this.open();
    return this.withTimeout(
      new Promise<R>((resolve, reject) => {
        const request = run(
          db.transaction(this.options.store, mode).objectStore(this.options.store),
        );
        request.onsuccess = () => resolve(request.result as R);
        request.onerror = () => reject(request.error);
      }),
    );
  }

  private open(): Promise<IDBDatabase> {
    this.connection ??= this.withTimeout(
      new Promise<IDBDatabase>((resolve, reject) => {
        const idb = this.idb();
        if (!idb) return reject(new Error('No IndexedDB.'));
        const request = idb.open(this.options.db, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore(this.options.store, { keyPath: this.options.keyPath });
        request.onblocked = () => reject(new Error('IndexedDB blocked.'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => this.close(db);
          globalThis.addEventListener?.('pagehide', () => this.close(db), { once: true });
          resolve(db);
        };
      }),
    );
    this.connection.catch(() => (this.connection = undefined));
    return this.connection;
  }

  private close(db: IDBDatabase): void {
    db.close();
    this.connection = undefined;
  }

  private withTimeout<R>(promise: Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
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
