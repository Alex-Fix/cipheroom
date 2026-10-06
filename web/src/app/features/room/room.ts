import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LiveKitService } from '../../core/livekit/livekit.service';
import { SignalingService } from '../../core/signaling/signaling.service';
import { loadDisplayName } from '../home/home';
import { CallTile } from './call-tile';

@Component({
  selector: 'app-room',
  imports: [CallTile],
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
  protected readonly livekit = inject(LiveKitService);

  protected readonly error = signal<string | undefined>(undefined);
  protected readonly showDiagnostics = signal(true);
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
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async ngOnDestroy(): Promise<void> {
    await this.livekit.disconnect();
    await this.signaling.leave();
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
