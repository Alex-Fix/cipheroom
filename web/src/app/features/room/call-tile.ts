import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NzAvatarModule } from 'ng-zorro-antd/avatar';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { Tile } from '../../core/livekit/livekit.service';
import { avatarColor, initials } from '../../shared/avatar';
import { TrackDirective } from '../../shared/track.directive';

/** One participant camera or screen-share tile. Presentational: the tile comes in, nothing goes out. */
@Component({
  selector: 'app-call-tile',
  imports: [NzAvatarModule, NzIconModule, NzTagModule, TrackDirective],
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
      <nz-avatar
        class="avatar"
        [nzSize]="72"
        [nzText]="initials()"
        [style.background-color]="color()"
      />
    }
    @if (t.audio) {
      <audio [appTrack]="t.audio" autoplay></audio>
    }
    <div class="caption">
      @if (t.isScreen) {
        <nz-tag class="screen-tag" nzColor="blue">Screen</nz-tag>
      } @else if (t.micMuted) {
        <nz-icon class="mic-off" nzType="audio-muted" aria-label="Microphone off" />
      }
      <span class="name">{{ t.name }}</span>
    </div>
  `,
  styleUrl: './call-tile.scss',
})
export class CallTile {
  readonly tile = input.required<Tile>();

  protected readonly initials = computed(() => initials(this.tile().displayName));
  protected readonly color = computed(() => avatarColor(this.tile().displayName));
}
