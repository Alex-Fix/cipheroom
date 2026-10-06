import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';

/** Bottom call control bar. Presentational: state in, intents out. */
@Component({
  selector: 'app-call-controls',
  imports: [NzDropdownModule, NzIconModule, NzMenuModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'glass' },
  template: `
    <button
      type="button"
      class="control mic"
      [class.off]="!micEnabled()"
      nz-tooltip
      [nzTooltipTitle]="micEnabled() ? 'Mute' : 'Unmute'"
      [attr.aria-label]="micEnabled() ? 'Mute' : 'Unmute'"
      [attr.aria-pressed]="!micEnabled()"
      (click)="toggleMic.emit()"
    >
      <nz-icon [nzType]="micEnabled() ? 'audio' : 'audio-muted'" />
    </button>

    <button
      type="button"
      class="control camera"
      [class.off]="!cameraEnabled()"
      nz-tooltip
      [nzTooltipTitle]="cameraEnabled() ? 'Turn camera off' : 'Turn camera on'"
      [attr.aria-label]="cameraEnabled() ? 'Turn camera off' : 'Turn camera on'"
      [attr.aria-pressed]="!cameraEnabled()"
      (click)="toggleCamera.emit()"
    >
      <nz-icon nzType="video-camera" [class.slashed]="!cameraEnabled()" />
    </button>

    @if (canShareScreen()) {
      <button
        type="button"
        class="control screen"
        [class.active]="screenShareEnabled()"
        nz-tooltip
        [nzTooltipTitle]="screenShareEnabled() ? 'Stop sharing' : 'Share screen'"
        [attr.aria-label]="screenShareEnabled() ? 'Stop sharing' : 'Share screen'"
        [attr.aria-pressed]="screenShareEnabled()"
        (click)="toggleScreenShare.emit()"
      >
        <nz-icon nzType="desktop" />
      </button>
    }

    <button
      type="button"
      class="control more"
      nz-dropdown
      [nzDropdownMenu]="moreMenu"
      nzTrigger="click"
      nzPlacement="topCenter"
      aria-label="More options"
    >
      <nz-icon nzType="more" />
    </button>
    <nz-dropdown-menu #moreMenu="nzDropdownMenu">
      <ul nz-menu>
        <li nz-menu-item class="diagnostics-item" (click)="openDiagnostics.emit()">
          <nz-icon nzType="info-circle" /> Connection diagnostics
        </li>
      </ul>
    </nz-dropdown-menu>

    <button
      type="button"
      class="control leave"
      nz-tooltip
      nzTooltipTitle="Leave call"
      aria-label="Leave call"
      (click)="leave.emit()"
    >
      <nz-icon nzType="close" />
    </button>
  `,
  styleUrl: './call-controls.scss',
})
export class CallControls {
  readonly micEnabled = input.required<boolean>();
  readonly cameraEnabled = input.required<boolean>();
  readonly screenShareEnabled = input.required<boolean>();
  /** Phones have no getDisplayMedia — hide the button instead of failing. */
  readonly canShareScreen = input(true);

  readonly toggleMic = output();
  readonly toggleCamera = output();
  readonly toggleScreenShare = output();
  readonly openDiagnostics = output();
  readonly leave = output();
}
