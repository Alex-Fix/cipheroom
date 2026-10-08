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

/** Host key backups are small JSON files; anything bigger isn't one. */
const MAX_FILE_BYTES = 16 * 1024;

/**
 * Restore a meeting from its host key backup file and passphrase. Every opening starts empty; an error from the
 * container is shown until the file or passphrase changes. Presentational.
 */
@Component({
  selector: 'app-import-dialog',
  imports: [FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzModalModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-dialog.html',
  styleUrl: './import-dialog.less',
})
export class ImportDialog {
  readonly open = input.required<boolean>();
  readonly busy = input(false);
  /** Constant message from the container (never file contents). */
  readonly error = input<string>();

  readonly unlock = output<{ contents: string; passphrase: string }>();
  readonly closed = output();

  protected readonly contents = signal<string | undefined>(undefined);
  protected readonly fileError = signal<string | undefined>(undefined);
  protected readonly passphrase = signal('');
  /** The file or passphrase changed since the last attempt: the container's error no longer applies. */
  protected readonly edited = signal(false);
  protected readonly shownError = computed(
    () => this.fileError() ?? (this.edited() ? undefined : this.error()),
  );
  /** Bumped on every opening: re-creates the file input, so no file from before stays picked. */
  protected readonly generation = signal(0);
  protected readonly canUnlock = computed(
    () => !!this.contents() && this.passphrase().length > 0 && !this.busy(),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      this.contents.set(undefined);
      this.passphrase.set('');
      this.fileError.set(undefined);
      this.edited.set(true);
      this.generation.update((n) => n + 1);
    });
  }

  protected setPassphrase(value: string): void {
    this.passphrase.set(value);
    this.edited.set(true);
  }

  protected async pick(event: Event): Promise<void> {
    this.edited.set(true);
    const file = (event.target as HTMLInputElement).files?.[0];
    this.contents.set(undefined);
    this.fileError.set(undefined);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      this.fileError.set("This isn't a Cipheroom host key backup.");
      return;
    }
    this.contents.set(await file.text());
  }

  protected submit(): void {
    const contents = this.contents();
    if (!contents || !this.canUnlock()) return;
    this.edited.set(false);
    this.unlock.emit({ contents, passphrase: this.passphrase() });
  }

  protected close(): void {
    if (this.busy()) return;
    this.contents.set(undefined);
    this.passphrase.set('');
    this.fileError.set(undefined);
    this.closed.emit();
  }
}
