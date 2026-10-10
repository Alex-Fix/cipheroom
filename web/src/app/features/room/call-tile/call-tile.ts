import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Tile } from '../../../core/media/media.types';
import { initials } from '../../../shared/initials';
import { TrackDirective } from '../../../shared/track.directive';

/**
 * One participant camera or screen-share tile, with a pin button (on hover; on touch screens a tap on the tile shows
 * it for a few seconds). Presentational: the tile comes in, the pin intent goes out.
 */
@Component({
  selector: 'app-call-tile',
  imports: [NzIconModule, TrackDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tile',
    '[class.speaking]': 'tile().isSpeaking',
    '[class.screen]': 'tile().isScreen',
    '[class.revealed]': 'revealed()',
    '[class.pill]': 'floating() && collapsed()',
    '(click)': 'reveal()',
  },
  templateUrl: './call-tile.html',
  styleUrl: './call-tile.less',
})
export class CallTile {
  readonly tile = input.required<Tile>();
  readonly pinned = input(false);
  /** Hidden and floating tiles don't offer pinning. */
  readonly canPin = input(true);
  readonly pin = output();
  /** The floating self-view: offers collapsing to a pill (and back). */
  readonly floating = input(false);
  readonly collapsed = input(false);
  readonly toggleCollapse = output();

  /** Touch: the tile's buttons are showing after a tap. */
  protected readonly revealed = signal(false);
  private revealTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.revealTimer));
  }

  protected reveal(): void {
    clearTimeout(this.revealTimer);
    this.revealed.set(true);
    this.revealTimer = setTimeout(() => this.revealed.set(false), REVEAL_MS);
  }

  protected collapse(event: Event): void {
    event.stopPropagation();
    this.toggleCollapse.emit();
  }

  protected togglePin(event: Event): void {
    event.stopPropagation();
    this.pin.emit();
  }

  protected readonly initials = computed(() => initials(this.tile().displayName));
}

/** How long a tap keeps the tile's buttons visible on touch screens. */
const REVEAL_MS = 3000;
