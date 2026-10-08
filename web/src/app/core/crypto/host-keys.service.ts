import { Injectable, inject, signal } from '@angular/core';
import { HostKeyMaterial, createHostKey, wipe } from './host-key';
import { backupFileName, exportBackup, importBackup } from './host-key-backup';
import { HOST_KEY_STORE } from './host-key-store';

/** A meeting this browser hosts (it holds the host key). Public data only. */
export interface Meeting {
  roomId: string;
  createdAt: number;
}

/** A backup ready to download: the passphrase-encrypted host key, as text. */
export interface BackupFile {
  fileName: string;
  contents: string;
}

/**
 * The meetings this browser hosts: creating them, the one-time passphrase backup, importing a backup, deleting.
 * The boundary for host keys — components only ever see room ids and the already-encrypted backup file. Design:
 * docs/plans/2026-10-08-lobby-admission-design.md.
 */
@Injectable({ providedIn: 'root' })
export class HostKeysService {
  private readonly store = inject(HOST_KEY_STORE);

  readonly meetings = signal<Meeting[]>([]);
  /** False when this browser can't keep keys (no IndexedDB, e.g. some private modes): it can still join as a guest. */
  readonly canHost = signal(true);

  /** The exportable copy of a just-created meeting's keys, kept only until it's backed up or skipped. */
  private pending?: { roomId: string; material: HostKeyMaterial };

  async refresh(): Promise<void> {
    try {
      const keys = await this.store.list();
      this.meetings.set(keys.map(({ roomId, createdAt }) => ({ roomId, createdAt })));
      this.canHost.set(true);
    } catch {
      this.meetings.set([]);
      this.canHost.set(false);
    }
  }

  /** A new meeting: host keys created and stored non-extractable in this browser. Returns its room id. */
  async create(): Promise<string> {
    this.discardPendingBackup();
    const { hostKey, material } = await createHostKey();
    try {
      await this.store.put(hostKey);
    } catch (e) {
      wipe(material);
      this.canHost.set(false);
      throw e;
    }
    this.pending = { roomId: hostKey.roomId, material };
    await this.refresh();
    return hostKey.roomId;
  }

  /** Whether the just-created meeting can still be backed up. */
  canBackUp(roomId: string): boolean {
    return this.pending?.roomId === roomId;
  }

  /**
   * The passphrase-encrypted backup of a meeting created just now. Only possible once: afterwards the browser keeps
   * the key non-extractable only.
   */
  async backup(roomId: string, passphrase: string): Promise<BackupFile> {
    const pending = this.pending;
    const hostKey = await this.store.get(roomId);
    if (!pending || pending.roomId !== roomId || !hostKey)
      throw new Error('This meeting can no longer be backed up.');
    const contents = await exportBackup(hostKey, pending.material, passphrase);
    this.discardPendingBackup();
    return { fileName: backupFileName(roomId), contents };
  }

  /** Forget the exportable copy (backup done or skipped). */
  discardPendingBackup(): void {
    if (this.pending) wipe(this.pending.material);
    this.pending = undefined;
  }

  /** Restores a meeting from its backup file. Returns its room id; throws BackupError. */
  async import(contents: string, passphrase: string): Promise<string> {
    const hostKey = await importBackup(contents, passphrase);
    await this.store.put(hostKey);
    await this.refresh();
    return hostKey.roomId;
  }

  /** Forgets a meeting's host key in this browser (a backup elsewhere still works). */
  async delete(roomId: string): Promise<void> {
    await this.store.delete(roomId);
    await this.refresh();
  }
}
