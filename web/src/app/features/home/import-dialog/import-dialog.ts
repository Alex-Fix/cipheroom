import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule } from 'ng-zorro-antd/modal';

/** Host key backups are small JSON files; anything bigger isn't one. */
const MAX_FILE_BYTES = 16 * 1024;

/** Restore a meeting from its host key backup file and passphrase. Presentational. */
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
  protected readonly canUnlock = computed(
    () => !!this.contents() && this.passphrase().length > 0 && !this.busy(),
  );

  protected async pick(event: Event): Promise<void> {
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
    if (contents && this.canUnlock()) this.unlock.emit({ contents, passphrase: this.passphrase() });
  }

  protected close(): void {
    this.contents.set(undefined);
    this.passphrase.set('');
    this.fileError.set(undefined);
    this.closed.emit();
  }
}
