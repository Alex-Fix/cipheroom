import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Tile } from '../../../core/livekit/livekit.service';
import { initials } from '../../../shared/initials';
import { TrackDirective } from '../../../shared/track.directive';

/** One participant camera or screen-share tile. Presentational: the tile comes in, nothing goes out. */
@Component({
  selector: 'app-call-tile',
  imports: [NzIconModule, TrackDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tile',
    '[class.speaking]': 'tile().isSpeaking',
    '[class.screen]': 'tile().isScreen',
  },
  templateUrl: './call-tile.html',
  styleUrl: './call-tile.less',
})
export class CallTile {
  readonly tile = input.required<Tile>();

  protected readonly initials = computed(() => initials(this.tile().displayName));
}
