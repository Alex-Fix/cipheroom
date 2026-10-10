import { InjectionToken } from '@angular/core';
import { IdbStore } from '../storage/indexed-db';
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

/** IndexedDB (database "cipheroom", store "host-keys"): survives reloads; gone if the user clears site data (that's
 * what the backup file is for). */
export class IndexedDbHostKeyStore implements HostKeyStore {
  private readonly db: IdbStore<HostKey>;

  constructor(idb?: () => IDBFactory | undefined, timeoutMs?: number) {
    this.db = new IdbStore<HostKey>({
      db: 'cipheroom',
      store: 'host-keys',
      keyPath: 'roomId',
      idb,
      timeoutMs,
    });
  }

  async list(): Promise<HostKey[]> {
    return (await this.db.getAll()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(roomId: string): Promise<HostKey | undefined> {
    return this.db.get(roomId);
  }

  put(hostKey: HostKey): Promise<void> {
    return this.db.put(hostKey);
  }

  delete(roomId: string): Promise<void> {
    return this.db.delete(roomId);
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
