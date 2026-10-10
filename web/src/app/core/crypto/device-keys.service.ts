import { Injectable, inject, signal } from '@angular/core';
import { DeviceKeyMaterial, createDeviceKey, wipeDeviceMaterial } from './device-key';
import { deviceBackupFileName, exportDeviceBackup, importDeviceBackup } from './device-key-backup';
import { DEVICE_KEY_STORE } from './device-key-store';
import { BackupFile } from './host-keys.service';

/** This browser's identity as far as the UI goes: public data only. */
export type DeviceIdentityStatus = 'unknown' | 'none' | 'ready' | 'unavailable';

/**
 * This browser's device key (docs/plans/2026-10-10-contacts-tofu-design.md): setting it up, the one-time passphrase
 * backup, restoring a backup, starting over. The boundary for the device key — components only see its status and
 * the already-encrypted backup file.
 */
@Injectable({ providedIn: 'root' })
export class DeviceKeysService {
  private readonly store = inject(DEVICE_KEY_STORE);

  /** `unavailable`: this browser can't keep keys (no IndexedDB, e.g. some private modes). */
  readonly status = signal<DeviceIdentityStatus>('unknown');
  /** Our device key (public, base64url), when set up. */
  readonly pub = signal<string | undefined>(undefined);

  /** The exportable copy of a just-created key, kept only until it's backed up or skipped. */
  private pending?: DeviceKeyMaterial;

  async refresh(): Promise<void> {
    try {
      const key = await this.store.get();
      this.pub.set(key?.pub);
      this.status.set(key ? 'ready' : 'none');
    } catch {
      this.pub.set(undefined);
      this.status.set('unavailable');
    }
  }

  /** A new device key, stored non-extractable; replaces any earlier one (people who knew it will see a new key). */
  async setUp(): Promise<void> {
    this.discardPendingBackup();
    const { deviceKey, material } = await createDeviceKey();
    try {
      await this.store.put(deviceKey);
    } catch (e) {
      wipeDeviceMaterial(material);
      this.status.set('unavailable');
      throw e;
    }
    this.pending = material;
    await this.refresh();
  }

  /** Whether the just-created key can still be backed up. */
  canBackUp(): boolean {
    return !!this.pending;
  }

  /** The passphrase-encrypted backup of the key created just now; only possible once. */
  async backup(passphrase: string): Promise<BackupFile> {
    const pending = this.pending;
    const key = await this.store.get();
    if (!pending || !key) throw new Error('This identity can no longer be backed up.');
    const contents = await exportDeviceBackup(key, pending, passphrase);
    this.discardPendingBackup();
    return { fileName: deviceBackupFileName(key.pub), contents };
  }

  discardPendingBackup(): void {
    if (this.pending) wipeDeviceMaterial(this.pending);
    this.pending = undefined;
  }

  /** Restores an identity from its backup file (replacing this browser's). Throws BackupError. */
  async restore(contents: string, passphrase: string): Promise<void> {
    const key = await importDeviceBackup(contents, passphrase);
    this.discardPendingBackup();
    await this.store.put(key);
    await this.refresh();
  }

  /** Forgets this browser's identity (a backup elsewhere still restores it). */
  async remove(): Promise<void> {
    this.discardPendingBackup();
    await this.store.delete();
    await this.refresh();
  }
}
