import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { Camera } from '../../../core/livekit/cameras';

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

  readonly toggleMic = output();
  readonly toggleCamera = output();
  readonly toggleScreenShare = output();
  readonly flipCamera = output();
  readonly selectCamera = output<string>();
  readonly openDiagnostics = output();
  readonly leave = output();
}
