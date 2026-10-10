import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { SharedFile } from '../../../core/files/file-transfer.service';

/**
 * One shared file in chat: an image inline once we have it (a preview until then), anything else as a card with
 * name, size and the action that fits its state. Never renders anything but a decoded raster image: other files
 * are only ever saved.
 */
@Component({
  selector: 'app-file-card',
  imports: [NgTemplateOutlet, NzIconModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './file-card.html',
  styleUrl: './file-card.less',
})
export class FileCard {
  readonly file = input.required<SharedFile>();

  readonly download = output();
  readonly cancel = output();
  readonly view = output();

  /** The browser couldn't decode the "image": show it as a plain file instead. */
  protected readonly broken = signal(false);
  protected readonly inline = computed(() => this.file().image && !!this.file().url && !this.broken());
  protected readonly preview = computed(() => this.file().image && !!this.file().thumbUrl && !this.inline() && !this.broken());
  protected readonly percent = computed(() => Math.floor(this.file().progress * 100));
  protected readonly size = computed(() => formatBytes(this.file().size));
}

/** 1,234 → "1.2 KB"; decimal units, one decimal below 10. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
