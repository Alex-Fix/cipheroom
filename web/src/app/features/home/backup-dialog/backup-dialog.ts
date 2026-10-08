import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { MIN_PASSPHRASE_LENGTH } from '../../../core/crypto/host-key-backup';
import { PassphraseStrength, passphraseStrength } from '../passphrase';

const STRENGTH_TEXT: Record<PassphraseStrength, string> = {
  'too-short': `At least ${MIN_PASSPHRASE_LENGTH} characters`,
  weak: 'Weak — a longer passphrase is much safer',
  good: 'Good',
  strong: 'Strong',
};

/**
 * Right after creating a meeting: protect its host key with a passphrase and download the backup — the only way to
 * host it from another browser, and only possible now. Skippable. Presentational.
 */
@Component({
  selector: 'app-backup-dialog',
  imports: [FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzModalModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './backup-dialog.html',
  styleUrl: './backup-dialog.less',
})
export class BackupDialog {
  readonly open = input.required<boolean>();
  /** Encrypting (600k PBKDF2 iterations take a moment). */
  readonly busy = input(false);
  /** The backup was downloaded. */
  readonly saved = input(false);

  readonly save = output<string>();
  readonly skip = output();
  readonly done = output();

  protected readonly passphrase = signal('');
  protected readonly confirmation = signal('');
  protected readonly strength = computed(() => passphraseStrength(this.passphrase()));
  protected readonly strengthText = computed(() => STRENGTH_TEXT[this.strength()]);
  protected readonly mismatch = computed(
    () => this.confirmation().length > 0 && this.confirmation() !== this.passphrase(),
  );
  protected readonly canSave = computed(
    () =>
      this.strength() !== 'too-short' && this.confirmation() === this.passphrase() && !this.busy(),
  );

  protected submit(): void {
    if (this.canSave()) this.save.emit(this.passphrase());
  }

  protected finish(): void {
    this.passphrase.set('');
    this.confirmation.set('');
    this.done.emit();
  }
}
