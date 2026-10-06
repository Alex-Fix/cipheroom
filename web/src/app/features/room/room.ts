import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzResultModule } from 'ng-zorro-antd/result';
import { LiveKitService } from '../../core/livekit/livekit.service';
import { SignalingService } from '../../core/signaling/signaling.service';
import { loadDisplayName } from '../home/home';
import { CallControls } from './call-controls';
import { CallHeader, callStatus } from './call-header';
import { CallTile } from './call-tile';
import { Device, deviceErrorMessage } from './device-error';
import { DiagnosticsDrawer } from './diagnostics-drawer';

/** Call screen container: owns the join/leave lifecycle and is the only place that talks to LiveKitService. */
@Component({
  selector: 'app-room',
  imports: [
    CallControls,
    CallHeader,
    CallTile,
    DiagnosticsDrawer,
    NzAlertModule,
    NzButtonModule,
    NzResultModule,
  ],
  providers: [LiveKitService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room.html',
  styleUrl: './room.scss',
})
export class Room implements OnInit, OnDestroy {
  /** Bound from the :roomId route param. */
  readonly roomId = input.required<string>();

  private readonly router = inject(Router);
  private readonly signaling = inject(SignalingService);
  private readonly message = inject(NzMessageService);
  protected readonly livekit = inject(LiveKitService);

  protected readonly error = signal<string | undefined>(undefined);
  protected readonly showDiagnostics = signal(false);
  protected readonly manualCopy = signal(false);
  private readonly joined = signal(false);

  protected readonly link = location.href;
  protected readonly canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  protected readonly status = computed(() => callStatus(this.livekit.state(), this.joined()));
  protected readonly participants = computed(
    () => this.livekit.tiles().filter((t) => !t.isScreen).length,
  );

  async ngOnInit(): Promise<void> {
    if (!loadDisplayName()) {
      void this.router.navigate(['/'], { queryParams: { room: this.roomId() } });
      return;
    }
    await this.join();
  }

  async ngOnDestroy(): Promise<void> {
    await this.teardown();
  }

  /** Tears down whatever is left of the previous attempt and joins again. */
  protected async retry(): Promise<void> {
    await this.teardown();
    await this.join();
  }

  /** Toggles a device; failures (permission denied, no device) become a toast instead of vanishing. */
  protected async setDevice(device: Device, enabled: boolean): Promise<void> {
    try {
      if (device === 'microphone') await this.livekit.setMicrophone(enabled);
      else if (device === 'camera') await this.livekit.setCamera(enabled);
      else await this.livekit.setScreenShare(enabled);
    } catch (e) {
      this.message.error(deviceErrorMessage(device, e));
    }
  }

  protected async copyLink(): Promise<void> {
    try {
      // navigator.clipboard is undefined on plain-HTTP LAN origins.
      await navigator.clipboard.writeText(this.link);
      this.message.success('Invite link copied');
    } catch {
      this.manualCopy.set(true);
    }
  }

  protected leave(): void {
    void this.router.navigate(['/']);
  }

  private async join(): Promise<void> {
    this.error.set(undefined);
    try {
      await this.signaling.joinRoom(this.roomId(), loadDisplayName());
      await this.livekit.connect(await this.signaling.getRtcConfig());
      this.joined.set(true);
      await Promise.all([this.setDevice('microphone', true), this.setDevice('camera', true)]);
    } catch (e) {
      // Shown via interpolation only — never through nz-message (renders HTML).
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  private async teardown(): Promise<void> {
    this.joined.set(false);
    await this.livekit.disconnect();
    await this.signaling.leave();
  }
}
