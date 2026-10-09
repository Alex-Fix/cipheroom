import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { Camera } from '../../../core/media/cameras';
import { VideoCodec } from '../../../core/media/codecs';
import { VideoQuality } from '../../../core/media/quality';

const QUALITY_LABELS: Record<VideoQuality, string> = {
  auto: 'Auto',
  '2160p': '4K',
  '1080p': '1080p',
  '720p': '720p',
};

const CODEC_NAMES: Record<VideoCodec, string> = { vp9: 'VP9', vp8: 'VP8' };

/** Bottom call control bar. Presentational: state in, intents out. */
@Component({
  selector: 'app-call-controls',
  imports: [NzDropdownModule, NzIconModule, NzMenuModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'glass' },
  templateUrl: './call-controls.html',
  styleUrl: './call-controls.less',
})
export class CallControls {
  readonly micEnabled = input.required<boolean>();
  readonly cameraEnabled = input.required<boolean>();
  readonly screenShareEnabled = input.required<boolean>();
  /** Phones have no getDisplayMedia — hide the button instead of failing. */
  readonly canShareScreen = input(true);
  /** Video inputs for the ⋯ menu picker (shown when there's more than one). */
  readonly cameras = input<Camera[]>([]);
  readonly activeCameraId = input<string | undefined>(undefined);
  /** Phone/tablet with a rear camera: show the front ⇄ rear button. */
  readonly canFlip = input(false);
  /** Camera send quality: the qualities this camera supports, and the chosen one. */
  readonly qualities = input<VideoQuality[]>(['auto']);
  readonly quality = input<VideoQuality>('auto');
  /** Video codecs this browser can send, the chosen one, and the one actually sent (a fallback when someone in
   * the call can't decode the chosen one). */
  readonly codecs = input<readonly VideoCodec[]>([]);
  readonly codec = input<VideoCodec>('vp9');
  readonly sendingCodec = input<VideoCodec | undefined>(undefined);
  /** Set while the usage guard allows no video: camera and screen share are disabled with this explanation. */
  readonly videoBlockedReason = input<string | undefined>(undefined);
  /** Chat messages that arrived while the chat panel was closed. */
  readonly unreadChats = input(0);

  readonly toggleMic = output();
  readonly toggleCamera = output();
  readonly toggleScreenShare = output();
  readonly flipCamera = output();
  readonly selectCamera = output<string>();
  readonly selectQuality = output<VideoQuality>();
  readonly selectCodec = output<VideoCodec>();
  readonly openChat = output();
  readonly leave = output();

  protected readonly qualityLabels = QUALITY_LABELS;
  protected readonly codecNames = CODEC_NAMES;
}
