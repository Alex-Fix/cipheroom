import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDropdownModule } from 'ng-zorro-antd/dropdown';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';

/** Bottom call control bar. Presentational: state in, intents out. */
@Component({
  selector: 'app-call-controls',
  imports: [NzButtonModule, NzDropdownModule, NzIconModule, NzMenuModule, NzTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      nz-button
      nzShape="circle"
      nzSize="large"
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
      nz-button
      nzShape="circle"
      nzSize="large"
      class="control camera"
      [class.off]="!cameraEnabled()"
      nz-tooltip
      [nzTooltipTitle]="cameraEnabled() ? 'Stop video' : 'Start video'"
      [attr.aria-label]="cameraEnabled() ? 'Stop video' : 'Start video'"
      [attr.aria-pressed]="!cameraEnabled()"
      (click)="toggleCamera.emit()"
    >
      <nz-icon nzType="video-camera" [class.slashed]="!cameraEnabled()" />
    </button>

    @if (canShareScreen()) {
      <button
        nz-button
        nzShape="circle"
        nzSize="large"
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
      nz-button
      nzShape="circle"
      nzSize="large"
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
      nz-button
      nzType="primary"
      nzDanger
      nzShape="round"
      nzSize="large"
      class="leave"
      (click)="leave.emit()"
    >
      <nz-icon nzType="logout" /> <span class="leave-label">Leave</span>
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
