import { InjectionToken } from '@angular/core';
import { IdbStore } from '../storage/indexed-db';
import { DeviceKey } from './device-key';

/** Where this browser keeps its device key: a non-extractable CryptoKey (structured clone keeps it so), never bytes. */
export interface DeviceKeyStore {
  get(): Promise<DeviceKey | undefined>;
  put(deviceKey: DeviceKey): Promise<void>;
  delete(): Promise<void>;
}

/** IndexedDB (database "cipheroom-device"): survives reloads; gone if site data is cleared (the backup restores it). */
export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  private readonly db: IdbStore<DeviceKey>;

  constructor(idb?: () => IDBFactory | undefined, timeoutMs?: number) {
    this.db = new IdbStore<DeviceKey>({
      db: 'cipheroom-device',
      store: 'device',
      keyPath: 'id',
      idb,
      timeoutMs,
    });
  }

  get(): Promise<DeviceKey | undefined> {
    return this.db.get('device');
  }

  put(deviceKey: DeviceKey): Promise<void> {
    return this.db.put(deviceKey);
  }

  delete(): Promise<void> {
    return this.db.delete('device');
  }
}

/** In memory only (tests). */
export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private key?: DeviceKey;

  async get(): Promise<DeviceKey | undefined> {
    return this.key;
  }

  async put(deviceKey: DeviceKey): Promise<void> {
    this.key = deviceKey;
  }

  async delete(): Promise<void> {
    this.key = undefined;
  }
}

export const DEVICE_KEY_STORE = new InjectionToken<DeviceKeyStore>('DeviceKeyStore', {
  providedIn: 'root',
  factory: () => new IndexedDbDeviceKeyStore(),
});
