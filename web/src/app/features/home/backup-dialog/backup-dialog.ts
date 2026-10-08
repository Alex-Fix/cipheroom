import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
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
 * host it from another browser, and only possible now. Skipping asks once more, inside the same dialog (no stacked
 * dialogs). Esc goes one step back: form → "skip?" → form; it does nothing while encrypting. Presentational.
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
  /** Closed: backed up, or skipped after confirming. Either way the passphrases are already cleared. */
  readonly done = output();

  protected readonly passphrase = signal('');
  protected readonly confirmation = signal('');
  /** Asking "skip the backup?" instead of showing the form. */
  protected readonly confirmingSkip = signal(false);
  protected readonly strength = computed(() => passphraseStrength(this.passphrase()));
  protected readonly strengthText = computed(() => STRENGTH_TEXT[this.strength()]);
  protected readonly mismatch = computed(
    () => this.confirmation().length > 0 && this.confirmation() !== this.passphrase(),
  );
  protected readonly canSave = computed(
    () =>
      this.strength() !== 'too-short' && this.confirmation() === this.passphrase() && !this.busy(),
  );
  protected readonly title = computed(() =>
    this.saved()
      ? 'Backup saved'
      : this.confirmingSkip()
        ? 'Skip the backup?'
        : 'Back up your host key',
  );

  constructor() {
    // Every opening starts from the form.
    effect(() => {
      if (this.open()) this.confirmingSkip.set(false);
    });
  }

  protected submit(): void {
    if (this.canSave()) this.save.emit(this.passphrase());
  }

  /** Esc (and the system back gesture on phones). */
  protected back(): void {
    if (this.busy()) return;
    if (this.saved()) return this.finish();
    this.confirmingSkip.update((asking) => !asking);
  }

  protected finish(): void {
    this.passphrase.set('');
    this.confirmation.set('');
    this.confirmingSkip.set(false);
    this.done.emit();
  }
}
