import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NzMessageService } from 'ng-zorro-antd/message';
import { LiveKitService } from '../../core/livekit/livekit.service';
import { SignalingService } from '../../core/signaling/signaling.service';
import { loadDisplayName } from '../home/home';
import { CallControls } from './call-controls';
import { CallTile } from './call-tile';
import { Device, deviceErrorMessage } from './device-error';

@Component({
  selector: 'app-room',
  imports: [CallControls, CallTile],
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
  protected readonly copied = signal(false);

  async ngOnInit(): Promise<void> {
    const name = loadDisplayName();
    if (!name) {
      void this.router.navigate(['/'], { queryParams: { room: this.roomId() } });
      return;
    }
    try {
      await this.signaling.joinRoom(this.roomId(), name);
      await this.livekit.connect(await this.signaling.getRtcConfig());
      await Promise.all([this.setDevice('microphone', true), this.setDevice('camera', true)]);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async ngOnDestroy(): Promise<void> {
    await this.livekit.disconnect();
    await this.signaling.leave();
  }

  protected readonly canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

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
    await navigator.clipboard.writeText(location.href);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected leave(): void {
    void this.router.navigate(['/']);
  }
}
