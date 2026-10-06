import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Tile } from '../../core/livekit/livekit.service';
import { initials } from '../../shared/avatar';
import { TrackDirective } from '../../shared/track.directive';

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
  template: `
    @let t = tile();
    @if (t.video) {
      <video
        [appTrack]="t.video"
        autoplay
        playsinline
        [muted]="true"
        [class.mirror]="t.isLocal && !t.isScreen"
      ></video>
    } @else {
      <div class="monogram" aria-hidden="true">{{ initials() }}</div>
    }
    @if (t.audio) {
      <audio [appTrack]="t.audio" autoplay></audio>
    }
    <div class="caption">
      @if (t.isScreen) {
        <span class="screen-tag">Screen</span>
      } @else if (t.micMuted) {
        <span class="mic-off" role="img" aria-label="Microphone off"
          ><nz-icon nzType="audio-muted"
        /></span>
      }
      <span class="name">{{ t.name }}</span>
    </div>
  `,
  styleUrl: './call-tile.scss',
})
export class CallTile {
  readonly tile = input.required<Tile>();

  protected readonly initials = computed(() => initials(this.tile().displayName));
}
