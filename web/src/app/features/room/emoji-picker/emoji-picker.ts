import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { EMOJI_CATEGORIES } from '../../../core/chat/emoji';
import { loadRecentEmoji, rememberEmoji } from '../../../core/settings/recent-emoji';

/**
 * Our curated emoji, by category, with this browser's recently used ones first (remembered in localStorage only).
 * `quick`: a row of one-tap choices above everything (reactions). Shown inside a popover.
 */
@Component({
  selector: 'app-emoji-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './emoji-picker.html',
  styleUrl: './emoji-picker.less',
})
export class EmojiPicker {
  readonly quick = input<readonly string[]>([]);
  readonly picked = output<string>();

  protected readonly categories = EMOJI_CATEGORIES;
  protected readonly recent = signal(loadRecentEmoji());

  protected pick(emoji: string): void {
    this.recent.set(rememberEmoji(emoji));
    this.picked.emit(emoji);
  }
}
