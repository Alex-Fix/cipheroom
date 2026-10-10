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
import { DeviceKeysService } from '../../core/crypto/device-keys.service';
import { backupKind } from '../../core/crypto/device-key-backup';
import { ContactsService } from '../../core/contacts/contacts.service';
import { ContactsList } from './contacts-list/contacts-list';
import { IdentityCard } from './identity-card/identity-card';
import { E2EE_UNSUPPORTED, e2eeSupported } from '../../core/crypto/support';
import { loadDisplayName, saveDisplayName } from '../../core/settings/display-name';
import { BackupDialog, BackupKind } from './backup-dialog/backup-dialog';
import { ImportDialog } from './import-dialog/import-dialog';
import { downloadText } from './passphrase';
import { parseRoomLink, shortRoomId } from './room-link';

const IMPORT_ERRORS = {
  locked: 'Wrong passphrase, or the file was changed.',
  malformed: "This isn't a Cipheroom backup.",
  mismatch: "This isn't a Cipheroom backup.",
} as const;

/**
 * Start screen: your name, a new meeting (this browser becomes its host), joining by link, and the meetings this
 * browser hosts (open, copy link, forget, import a backup).
 */
@Component({
  selector: 'app-home',
  imports: [
    ContactsList,
    IdentityCard,
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
  protected readonly deviceKeys = inject(DeviceKeysService);
  protected readonly contacts = inject(ContactsService);
  protected readonly contactList = computed(() => [...this.contacts.contacts().values()]);
  /** Setting up the identity (creating the key). */
  protected readonly settingUp = signal(false);
  /** The identity's one-time backup is being offered. */
  protected readonly identityBackup = signal(false);
  protected readonly backupKind = computed<BackupKind>(() =>
    this.identityBackup() ? 'identity' : 'meeting',
  );

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
    void this.deviceKeys.refresh();
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
    const identity = this.identityBackup();
    if (!roomId && !identity) return;
    this.backingUp.set(true);
    try {
      const file = identity
        ? await this.deviceKeys.backup(passphrase)
        : await this.hostKeys.backup(roomId!, passphrase);
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
    if (this.identityBackup()) {
      this.deviceKeys.discardPendingBackup();
      this.identityBackup.set(false);
      return;
    }
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
      if (backupKind(contents) === 'device') {
        await this.deviceKeys.restore(contents, passphrase);
        this.importing.set(false);
        this.message.success('Identity restored');
      } else {
        await this.hostKeys.import(contents, passphrase);
        this.importing.set(false);
        this.message.success('Meeting imported');
      }
    } catch (e) {
      this.importError.set(
        e instanceof BackupError ? IMPORT_ERRORS[e.problem] : "This browser can't keep keys.",
      );
    } finally {
      this.importBusy.set(false);
    }
  }

  /** A new identity (device key), then its one-time backup. */
  protected async setUpIdentity(): Promise<void> {
    if (this.settingUp()) return;
    this.settingUp.set(true);
    try {
      await this.deviceKeys.setUp();
      this.backupSaved.set(false);
      this.identityBackup.set(true);
    } catch (e) {
      console.warn('[cipheroom] setting up an identity failed', e);
      this.message.error("This browser can't keep an identity. You can still join.");
    } finally {
      this.settingUp.set(false);
    }
  }

  protected startOver(): void {
    this.modal.confirm({
      nzTitle: 'Start over with a new identity?',
      nzContent:
        'People who verified you will see a warning until they verify you again. A backup of this ' +
        'identity still restores it.',
      nzOkText: 'Start Over',
      nzOkDanger: true,
      nzCentered: true,
      nzAutofocus: 'cancel',
      nzOnOk: () => this.deviceKeys.remove(),
    });
  }

  protected unverify(devicePub: string): void {
    void this.contacts.setVerified(devicePub, false);
  }

  protected forgetContact(devicePub: string): void {
    void this.contacts.forget(devicePub);
  }

  protected forgetAllContacts(): void {
    this.modal.confirm({
      nzTitle: 'Forget everyone?',
      nzContent: 'Nobody will be recognised or marked verified in your next calls.',
      nzOkText: 'Forget Everyone',
      nzOkDanger: true,
      nzCentered: true,
      nzAutofocus: 'cancel',
      nzOnOk: () => this.contacts.forgetAll(),
    });
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
