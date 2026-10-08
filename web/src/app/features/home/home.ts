import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { BackupError } from '../../core/crypto/host-key-backup';
import { HostKeysService } from '../../core/crypto/host-keys.service';
import { E2EE_UNSUPPORTED, e2eeSupported } from '../../core/crypto/support';
import { loadDisplayName, saveDisplayName } from '../../core/settings/display-name';
import { BackupDialog } from './backup-dialog/backup-dialog';
import { ImportDialog } from './import-dialog/import-dialog';
import { downloadText } from './passphrase';
import { parseRoomLink, shortRoomId } from './room-link';

const IMPORT_ERRORS = {
  locked: 'Wrong passphrase, or the file was changed.',
  malformed: "This isn't a Cipheroom host key backup.",
  mismatch: "This isn't a Cipheroom host key backup.",
} as const;

/**
 * Start screen: your name, a new meeting (this browser becomes its host), joining by link, and the meetings this
 * browser hosts (open, copy link, forget, import a backup).
 */
@Component({
  selector: 'app-home',
  imports: [
    BackupDialog,
    FormsModule,
    ImportDialog,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.less',
})
export class Home {
  private readonly router = inject(Router);
  private readonly message = inject(NzMessageService);
  private readonly modal = inject(NzModalService);
  protected readonly hostKeys = inject(HostKeysService);

  protected readonly name = signal(loadDisplayName());
  protected readonly link = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('room') ?? '');
  protected readonly roomId = computed(() => parseRoomLink(this.link()));
  /** Calls are always end-to-end encrypted: browsers that can't do that can't join. */
  protected readonly supported = signal(true);
  protected readonly unsupportedMessage = E2EE_UNSUPPORTED;
  protected readonly creating = signal(false);

  /** The meeting just created, while its backup dialog is open. */
  protected readonly backupFor = signal<string | undefined>(undefined);
  protected readonly backingUp = signal(false);
  protected readonly backupSaved = signal(false);

  protected readonly importing = signal(false);
  protected readonly importBusy = signal(false);
  protected readonly importError = signal<string | undefined>(undefined);

  protected readonly short = shortRoomId;

  constructor() {
    void e2eeSupported().then((ok) => this.supported.set(ok));
    void this.hostKeys.refresh();
  }

  protected hasName(): boolean {
    return this.name().trim().length > 0;
  }

  protected join(): void {
    const roomId = this.roomId();
    if (roomId) this.open(roomId);
  }

  protected async newMeeting(): Promise<void> {
    if (!this.hasName() || !this.supported() || this.creating()) return;
    this.creating.set(true);
    try {
      const roomId = await this.hostKeys.create();
      this.backupSaved.set(false);
      this.backupFor.set(roomId);
    } catch (e) {
      console.warn('[cipheroom] creating a meeting failed', e);
      this.message.error(
        "This browser can't host meetings (it can't keep keys). You can still join.",
      );
    } finally {
      this.creating.set(false);
    }
  }

  protected async saveBackup(passphrase: string): Promise<void> {
    const roomId = this.backupFor();
    if (!roomId) return;
    this.backingUp.set(true);
    try {
      const file = await this.hostKeys.backup(roomId, passphrase);
      downloadText(file.fileName, file.contents);
      this.backupSaved.set(true);
    } catch (e) {
      console.warn('[cipheroom] backup failed', e);
      this.message.error('The backup couldn’t be made.');
    } finally {
      this.backingUp.set(false);
    }
  }

  protected finishBackup(): void {
    const roomId = this.backupFor();
    this.hostKeys.discardPendingBackup();
    this.backupFor.set(undefined);
    if (roomId) this.open(roomId);
  }

  protected async importBackup({
    contents,
    passphrase,
  }: {
    contents: string;
    passphrase: string;
  }): Promise<void> {
    this.importBusy.set(true);
    this.importError.set(undefined);
    try {
      await this.hostKeys.import(contents, passphrase);
      this.importing.set(false);
      this.message.success('Meeting imported');
    } catch (e) {
      this.importError.set(
        e instanceof BackupError ? IMPORT_ERRORS[e.problem] : "This browser can't keep host keys.",
      );
    } finally {
      this.importBusy.set(false);
    }
  }

  protected async copyLink(roomId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(new URL(`/r/${roomId}`, location.origin).href);
      this.message.success('Invite link copied');
    } catch {
      this.message.error('Couldn’t copy the link.');
    }
  }

  protected forget(roomId: string): void {
    this.modal.confirm({
      nzTitle: 'Forget this meeting?',
      nzContent: 'This browser won’t be its host anymore. A backup file still works.',
      nzOkText: 'Forget',
      nzOkDanger: true,
      nzCentered: true,
      // A destructive choice is never the default: Enter doesn't forget.
      nzAutofocus: 'cancel',
      nzOnOk: () => this.hostKeys.delete(roomId),
    });
  }

  protected open(roomId: string): void {
    const name = this.name().trim();
    if (!name || !this.supported()) return;
    saveDisplayName(name);
    void this.router.navigate(['/r', roomId]);
  }
}
