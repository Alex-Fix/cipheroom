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
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { CryptoService } from '../../core/crypto/crypto.service';
import { MediaService } from '../../core/media/media.service';
import { VideoCodec } from '../../core/media/codecs';
import { CallParticipant } from '../../core/media/media.types';
import { VideoQuality } from '../../core/media/quality';
import { SignalingService } from '../../core/signaling/signaling.service';
import { ThemeService } from '../../core/ui/theme.service';
import { loadDisplayName } from '../../core/settings/display-name';
import { CallControls } from './call-controls/call-controls';
import { CallHeader } from './call-header/call-header';
import { callStatus } from './call-status';
import { CallTile } from './call-tile/call-tile';
import { Device, deviceErrorMessage } from './device-error';
import { ElementSizeDirective } from '../../shared/element-size.directive';
import { participantChanges } from './participant-changes';
import { ParticipantsPanel } from './participants-panel/participants-panel';

/** Call screen container: owns the join/leave lifecycle and is the only place that talks to MediaService. */
@Component({
  selector: 'app-room',
  imports: [
    CallControls,
    CallHeader,
    CallTile,
    ElementSizeDirective,
    NzButtonModule,
    NzIconModule,
    ParticipantsPanel,
  ],
  providers: [MediaService, CryptoService],
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
  protected readonly media = inject(MediaService);
  protected readonly crypto = inject(CryptoService);

  protected readonly error = signal<string | undefined>(undefined);
  protected readonly showParticipants = signal(false);
  /** "Bob joined" / "Bob left". Rendered by interpolation only — names never go through nz-message (HTML). */
  protected readonly notices = signal<{ id: number; text: string }[]>([]);
  protected readonly manualCopy = signal(false);
  private readonly joined = signal(false);
  /** Automatic rejoin after the connection was lost (shown as "Reconnecting…"). */
  private readonly rejoining = signal(false);
  private rejoinAttempts = 0;

  protected readonly link = location.href;
  protected readonly canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  protected readonly status = computed(() =>
    this.rejoining()
      ? 'reconnecting'
      : callStatus(this.media.state(), this.joined(), !!this.error()),
  );
  protected readonly participantCount = computed(() => this.media.participants().length);

  private baseline?: readonly CallParticipant[];
  private noticeId = 0;
  /** Last safety code seen in this call (kept across rejoins: a code that differs afterwards did change). */
  private lastSafetyCode?: string;

  constructor() {
    // Every join and leave is announced (ghost-participant defence, docs/architecture.md). The first snapshot after
    // joining is the baseline — people already in the room aren't "joining".
    effect(() => {
      const participants = this.media.participants();
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

    // A new safety code means the set of keys in the call changed: invite everyone to compare again.
    effect(() => {
      const code = this.crypto.safetyCode();
      if (!code) return;
      const current = `${code.emoji.map((e) => e.symbol).join('')} ${code.digits}`;
      if (this.lastSafetyCode && current !== this.lastSafetyCode) {
        untracked(() => this.notify('Safety code changed — compare it again'));
      }
      this.lastSafetyCode = current;
    });

    // Someone joined who can't decode the codec we send: rejoin, which picks one everyone can play.
    effect(() => {
      if (this.joined() && this.media.codecUnsupported()) untracked(() => void this.rejoin());
    });

    // Lost the media connection (ICE restarts gave up) or the signaling connection: rejoin from scratch.
    effect(() => {
      if (!this.joined()) return;
      if (this.media.state() === 'connected') this.rejoinAttempts = 0;
      const lost = this.media.state() === 'disconnected' || !this.signaling.connected();
      if (lost) untracked(() => void this.rejoin());
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
    this.rejoinAttempts = 0;
    await this.teardown();
    await this.join();
  }

  /** Toggles a device; failures (permission denied, no device) become a toast instead of vanishing. */
  protected async setDevice(device: Device, enabled: boolean): Promise<void> {
    try {
      if (device === 'microphone') await this.media.setMicrophone(enabled);
      else if (device === 'camera') await this.media.setCamera(enabled);
      else await this.media.setScreenShare(enabled);
    } catch (e) {
      this.deviceFailed(device, e);
    }
  }

  /** Flip front ⇄ rear, or pick a specific camera. Failures (camera busy, gone) become a toast. */
  protected async switchCamera(deviceId?: string): Promise<void> {
    try {
      if (deviceId) await this.media.selectCamera(deviceId);
      else await this.media.flipCamera();
    } catch (e) {
      this.deviceFailed('camera', e);
    }
  }

  protected async setQuality(quality: VideoQuality): Promise<void> {
    try {
      await this.media.setVideoQuality(quality);
    } catch (e) {
      this.deviceFailed('camera', e);
    }
  }

  /** A different codec takes effect by rejoining: Cloudflare can't switch codecs on a published track. */
  protected async setCodec(codec: VideoCodec): Promise<void> {
    if (!this.media.setVideoCodec(codec)) return;
    this.rejoinAttempts = 0;
    await this.rejoin();
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

  /**
   * Constant toast for the user; the browser's actual error goes to this device's console only (Safari Web
   * Inspector / devtools) — it can contain SDP and never leaves the browser.
   */
  private deviceFailed(device: Device, error: unknown): void {
    console.warn(`[cipheroom] ${device} failed`, error);
    this.message.error(deviceErrorMessage(device, error));
  }

  private notify(text: string): void {
    const id = ++this.noticeId;
    this.notices.update((list) => [...list, { id, text }].slice(-3));
    setTimeout(() => this.notices.update((list) => list.filter((n) => n.id !== id)), 4000);
  }

  private async join(devices = { microphone: true, camera: true }): Promise<void> {
    this.error.set(undefined);
    try {
      const displayName = loadDisplayName();
      const roomId = this.roomId();
      // Fails before joining when this browser can't encrypt: nobody ever sees us join unencrypted.
      const identity = await this.crypto.identityBundle(roomId);
      const { selfId } = await this.signaling.joinRoom(
        roomId,
        displayName,
        identity,
        this.media.decodableCodecs,
      );
      const frames = await this.crypto.start(roomId, selfId);
      this.media.connect(await this.signaling.getRtcConfig(), { id: selfId, displayName }, frames);
      this.joined.set(true);
      await this.publishOwnTracks(devices);
      this.media.startReceiving();
    } catch (e) {
      // Leave at once (e.g. encryption couldn't start): others must not see us half-joined.
      await this.teardown();
      // Shown via interpolation only — never through nz-message (renders HTML).
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Publishes our microphone and camera before we receive anyone else's tracks: iOS Safari can't add them once the
   * connection began by answering the SFU. Devices that should be off are still published — the microphone muted,
   * the camera as muted placeholder frames — so turning them on later never needs a new negotiation.
   */
  private async publishOwnTracks(devices: { microphone: boolean; camera: boolean }): Promise<void> {
    await Promise.all([
      this.setDevice('microphone', true).then(() =>
        devices.microphone || !this.media.micEnabled()
          ? undefined
          : this.setDevice('microphone', false),
      ),
      devices.camera ? this.setDevice('camera', true) : undefined,
    ]);
    // Camera off, denied or missing: reserve its slot anyway.
    if (!this.media.cameraEnabled()) await this.media.reserveCamera().catch(() => undefined);
  }

  /** Same devices as before; gives up (Try Again screen) after a few attempts in a row. */
  private async rejoin(): Promise<void> {
    if (this.rejoining()) return;
    if (++this.rejoinAttempts > MAX_REJOINS) {
      await this.teardown();
      this.error.set('Connection lost.');
      return;
    }
    this.rejoining.set(true);
    const devices = { microphone: this.media.micEnabled(), camera: this.media.cameraEnabled() };
    try {
      await this.teardown();
      await new Promise((resolve) => setTimeout(resolve, REJOIN_DELAY_MS));
      await this.join(devices);
    } finally {
      this.rejoining.set(false);
    }
  }

  private async teardown(): Promise<void> {
    this.joined.set(false);
    await this.media.disconnect();
    this.crypto.stop();
    await this.signaling.leave();
  }
}

const MAX_REJOINS = 3;
const REJOIN_DELAY_MS = 1000;
