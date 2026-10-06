import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { CallParticipant, LiveKitService } from '../../core/livekit/livekit.service';
import { SignalingService } from '../../core/signaling/signaling.service';
import { ThemeService } from '../../core/ui/theme.service';
import { loadDisplayName } from '../../core/settings/display-name';
import { CallControls } from './call-controls';
import { CallHeader } from './call-header';
import { callStatus } from './call-status';
import { CallTile } from './call-tile';
import { Device, deviceErrorMessage } from './device-error';
import { DiagnosticsDrawer } from './diagnostics-drawer';
import { participantChanges } from './participant-changes';
import { ParticipantsPanel } from './participants-panel';

/** Call screen container: owns the join/leave lifecycle and is the only place that talks to LiveKitService. */
@Component({
  selector: 'app-room',
  imports: [
    CallControls,
    CallHeader,
    CallTile,
    DiagnosticsDrawer,
    NzButtonModule,
    NzIconModule,
    ParticipantsPanel,
  ],
  providers: [LiveKitService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room.html',
  styleUrl: './room.less',
})
export class Room implements OnInit, OnDestroy {
  /** Bound from the :roomId route param. */
  readonly roomId = input.required<string>();

  private readonly router = inject(Router);
  private readonly signaling = inject(SignalingService);
  private readonly message = inject(NzMessageService);
  private readonly theme = inject(ThemeService);
  protected readonly livekit = inject(LiveKitService);

  protected readonly error = signal<string | undefined>(undefined);
  protected readonly showDiagnostics = signal(false);
  protected readonly showParticipants = signal(false);
  /** "Bob joined" / "Bob left". Rendered by interpolation only — names never go through nz-message (HTML). */
  protected readonly notices = signal<{ id: number; text: string }[]>([]);
  protected readonly manualCopy = signal(false);
  private readonly joined = signal(false);

  protected readonly link = location.href;
  protected readonly canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  protected readonly status = computed(() =>
    callStatus(this.livekit.state(), this.joined(), !!this.error()),
  );
  protected readonly participantCount = computed(() => this.livekit.participants().length);

  private baseline?: readonly CallParticipant[];
  private noticeId = 0;

  constructor() {
    // Every join and leave is announced (ghost-participant defence, docs/architecture.md). The first snapshot after
    // joining is the baseline — people already in the room aren't "joining".
    effect(() => {
      const participants = this.livekit.participants();
      if (!this.joined()) {
        this.baseline = undefined;
        return;
      }
      if (this.baseline) {
        const { joined, left } = participantChanges(this.baseline, participants);
        joined.forEach((p) => this.notify(`${p.name} joined`));
        left.forEach((p) => this.notify(`${p.name} left`));
      }
      this.baseline = participants;
    });
  }

  async ngOnInit(): Promise<void> {
    this.theme.setForcedDark(true);
    if (!loadDisplayName()) {
      void this.router.navigate(['/'], { queryParams: { room: this.roomId() } });
      return;
    }
    await this.join();
  }

  async ngOnDestroy(): Promise<void> {
    this.theme.setForcedDark(false);
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

  /** Flip front ⇄ rear, or pick a specific camera. Failures (camera busy, gone) become a toast. */
  protected async switchCamera(deviceId?: string): Promise<void> {
    try {
      if (deviceId) await this.livekit.selectCamera(deviceId);
      else await this.livekit.flipCamera();
    } catch (e) {
      this.message.error(deviceErrorMessage('camera', e));
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

  private notify(text: string): void {
    const id = ++this.noticeId;
    this.notices.update((list) => [...list, { id, text }].slice(-3));
    setTimeout(() => this.notices.update((list) => list.filter((n) => n.id !== id)), 4000);
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
