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
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { CryptoService } from '../../core/crypto/crypto.service';
import { LobbyClosedError, LobbyService } from '../../core/lobby/lobby.service';
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
import { LobbyScreen, LobbyScreenState } from './lobby-screen/lobby-screen';
import { UsageBanner } from './usage-banner/usage-banner';
import { isCallsPaused, resetDate, videoBlockedReason } from './usage-text';
import { participantChanges } from './participant-changes';
import { ParticipantAction, ParticipantsPanel } from './participants-panel/participants-panel';

/**
 * Call screen container: owns the lobby → join → leave lifecycle and is the only place that talks to MediaService
 * and LobbyService.
 */
@Component({
  selector: 'app-room',
  imports: [
    CallControls,
    CallHeader,
    CallTile,
    ElementSizeDirective,
    LobbyScreen,
    NzButtonModule,
    NzIconModule,
    NzModalModule,
    ParticipantsPanel,
    UsageBanner,
  ],
  providers: [MediaService, CryptoService, LobbyService],
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
  private readonly modal = inject(NzModalService);
  protected readonly media = inject(MediaService);
  protected readonly crypto = inject(CryptoService);
  protected readonly lobby = inject(LobbyService);

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
  /** Calls are paused by the usage guard (refused, or ended at the limit): the day they can start again. */
  protected readonly pausedUntil = signal<string | undefined>(undefined);
  /** Why camera and screen share are off right now (usage guard), if they are. */
  protected readonly videoBlockedReason = computed(() =>
    videoBlockedReason(this.signaling.usage()),
  );
  protected readonly usage = this.signaling.usage;
  /** Instead of the call: waiting in the lobby, or turned away / removed / call ended / calls paused. */
  protected readonly lobbyScreen = computed<LobbyScreenState | undefined>(() => {
    if (this.pausedUntil()) return 'paused';
    const state = this.lobby.state();
    return state === 'waiting' || state === 'denied' || state === 'removed' || state === 'ended'
      ? state
      : undefined;
  });
  /** Someone who can let us in is in the call (as the server says — only used for the waiting text). */
  protected readonly hostHere = computed(
    () => (this.signaling.authority()?.admitters.length ?? 0) > 0,
  );
  /** After being turned away the server makes us wait before asking again. */
  protected readonly canAskAgain = signal(true);

  private baseline?: readonly CallParticipant[];
  private noticeId = 0;
  /** Last safety code seen in this call (kept across rejoins: a code that differs afterwards did change). */
  private lastSafetyCode?: string;
  private seenMuteRequests = 0;
  /** Microphone and camera as the user wants them (kept across rejoins). */
  private wanted: Devices = { microphone: true, camera: true };
  /** Bumped by every join and teardown: a join that isn't the current one stops. */
  private joinRun = 0;
  private knownGuests = new Set<string>();

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

    // Usage guard: audio-only turns our camera and screen share off (they come back when the month resets, on request);
    // paused ends the call for good (the server already did). Waiting in a lobby, either means we won't get in: the
    // server sent the lobby away.
    effect(() => {
      const usage = this.signaling.usage();
      const waiting = this.lobby.state() === 'waiting';
      if (!usage || (!this.joined() && !waiting)) return;
      untracked(() => {
        if (usage.level === 'paused' || (waiting && usage.level === 'audio-only')) {
          if (waiting) this.lobby.cancel();
          return void this.pauseCalls();
        }
        if (usage.level !== 'audio-only') return;
        if (this.media.cameraEnabled()) void this.setDevice('camera', false);
        if (this.media.screenShareEnabled()) void this.setDevice('screen', false);
      });
    });

    // Removed, or the host ended the call: leave for good (no automatic rejoin).
    effect(() => {
      const state = this.lobby.state();
      if (state === 'removed' || state === 'ended') untracked(() => void this.teardown());
    });

    // A host or co-host asked us to mute (verified by LobbyService): mute, and say so. We may unmute.
    effect(() => {
      const requests = this.lobby.muteRequests();
      if (requests <= this.seenMuteRequests) return;
      this.seenMuteRequests = requests;
      untracked(() => {
        if (!this.media.micEnabled()) return;
        void this.toggleDevice('microphone', false);
        this.notify('The host muted you');
      });
    });

    // Someone knocked (admitters only): say who. Names go through interpolation only.
    effect(() => {
      const guests = this.lobby.guests();
      untracked(() => {
        guests
          .filter((g) => !this.knownGuests.has(g.id))
          .forEach((g) => this.notify(`${g.name} wants to join`));
        this.knownGuests = new Set(guests.map((g) => g.id));
      });
    });

    // Lost the media connection (ICE restarts gave up) or the signaling connection: rejoin from scratch.
    effect(() => {
      if (!this.joined() || this.lobby.state() !== 'admitted') return;
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

  /** The user turns a device on or off: remembered, so a rejoin brings back what they chose. */
  protected async toggleDevice(device: Device, enabled: boolean): Promise<void> {
    // Usage guard: no video while it's audio-only (the buttons are disabled; this covers a race).
    if (enabled && device !== 'microphone' && !this.media.videoAllowed()) return;
    if (device !== 'screen') this.wanted = { ...this.wanted, [device]: enabled };
    await this.setDevice(device, enabled);
  }

  /**
   * Turns a device on or off; failures (permission denied, no device) become a toast instead of vanishing — unless
   * they belong to a join that was abandoned meanwhile (`run`): its connection is gone, so they mean nothing.
   */
  private async setDevice(device: Device, enabled: boolean, run?: number): Promise<void> {
    try {
      if (device === 'microphone') await this.media.setMicrophone(enabled);
      else if (device === 'camera') await this.media.setCamera(enabled);
      else await this.media.setScreenShare(enabled);
    } catch (e) {
      if (run !== undefined && run !== this.joinRun) return;
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

  /** Stop waiting in the lobby. */
  protected cancelWaiting(): void {
    this.lobby.cancel();
    this.leave();
  }

  /** Knock again after being turned away (same connection: the server's cooldown applies). */
  protected async askAgain(): Promise<void> {
    this.lobby.reset();
    await this.join();
  }

  protected async admit(guestId: string): Promise<void> {
    await this.hostAction(() => this.lobby.admit(guestId));
  }

  protected async deny(guestId: string): Promise<void> {
    await this.hostAction(() => this.lobby.deny(guestId));
  }

  protected async admitAll(): Promise<void> {
    await this.hostAction(() => this.lobby.admitAll());
  }

  protected async setAutoAdmit(autoAdmit: boolean): Promise<void> {
    await this.hostAction(() => this.lobby.setAutoAdmit(autoAdmit));
  }

  protected act({
    action,
    participantId,
  }: {
    action: ParticipantAction;
    participantId: string;
  }): void {
    if (action === 'make-cohost') void this.hostAction(() => this.lobby.makeCoHost(participantId));
    else if (action === 'ask-to-mute')
      void this.hostAction(() => this.lobby.askToMute(participantId));
    else
      this.confirm(
        'Remove this person from the call?',
        'They won’t be able to rejoin this call.',
        'Remove',
        () => this.hostAction(() => this.lobby.remove(participantId)),
      );
  }

  protected endCall(): void {
    this.confirm(
      'End the call for everyone?',
      'Everyone in the call and the lobby will be sent away.',
      'End Call',
      () => this.hostAction(() => this.lobby.endCall()),
    );
  }

  /**
   * Constant text only: nz-modal renders content as HTML. Centered, and Cancel has the focus: a destructive choice is
   * never what Enter does.
   */
  private confirm(title: string, content: string, ok: string, onOk: () => Promise<void>): void {
    this.modal.confirm({
      nzTitle: title,
      nzContent: content,
      nzOkText: ok,
      nzOkDanger: true,
      nzCentered: true,
      nzAutofocus: 'cancel',
      nzOnOk: onOk,
    });
  }

  private async hostAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (e) {
      // Ending the call: "call ended" reaches us before the server's reply, and leaving closes the connection under
      // the pending call. That's success, not an error.
      const state = this.lobby.state();
      if (state === 'ended' || state === 'removed') return;
      console.warn('[cipheroom] host action failed', e);
      this.message.error('That didn’t work. Try again.');
    }
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

  /**
   * Lobby → keys → media → our tracks → others' tracks. A teardown (rejoin, leaving) abandons a join that is still
   * running: every step checks it's still the current one, so a stale join never touches the next connection.
   */
  private async join(devices: Devices = this.wanted): Promise<void> {
    const run = ++this.joinRun;
    const stale = () => run !== this.joinRun;
    this.wanted = { ...devices };
    this.error.set(undefined);
    try {
      const displayName = loadDisplayName();
      const roomId = this.roomId();
      // Host proof, ticket or the lobby. Fails before joining when this browser can't encrypt: nobody ever sees us
      // join unencrypted.
      const { selfId } = await this.lobby.enter(roomId, displayName, this.media.decodableCodecs);
      if (stale()) return;
      const frames = await this.crypto.start(roomId, selfId, displayName);
      if (stale()) return;
      const config = await this.signaling.getRtcConfig();
      if (stale()) return;
      this.media.connect(config, { id: selfId, displayName }, frames);
      this.joined.set(true);
      await this.publishOwnTracks(devices, run);
      if (stale()) return;
      this.media.startReceiving();
      // What actually came on (a denied camera stays off on rejoin instead of failing again).
      this.wanted = { microphone: this.media.micEnabled(), camera: this.media.cameraEnabled() };
    } catch (e) {
      if (stale()) return;
      if (isCallsPaused(e)) return this.pauseCalls();
      if (e instanceof LobbyClosedError) {
        // Turned away: stay connected, so asking again goes through the server's cooldown.
        if (e.reason === 'denied') return this.allowAskingAgainLater();
        if (e.reason === 'cancelled') return;
        return this.teardown();
      }
      // Leave at once (e.g. encryption couldn't start): others must not see us half-joined.
      await this.teardown();
      // Shown via interpolation only — never through nz-message (renders HTML).
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** The usage guard paused calls: leave, and say until when. */
  private async pauseCalls(): Promise<void> {
    const usage = this.signaling.usage();
    this.pausedUntil.set(usage ? resetDate(usage) : 'next month');
    await this.teardown();
  }

  private allowAskingAgainLater(): void {
    this.canAskAgain.set(false);
    setTimeout(() => this.canAskAgain.set(true), ASK_AGAIN_DELAY_MS);
  }

  /**
   * Publishes our microphone and camera before we receive anyone else's tracks: iOS Safari can't add them once the
   * connection began by answering the SFU. Devices that should be off are still published — the microphone muted,
   * the camera as muted placeholder frames — so turning them on later never needs a new negotiation.
   */
  private async publishOwnTracks(devices: Devices, run: number): Promise<void> {
    await Promise.all([
      this.setDevice('microphone', true, run).then(() =>
        devices.microphone || !this.media.micEnabled() || run !== this.joinRun
          ? undefined
          : this.setDevice('microphone', false, run),
      ),
      // Usage guard: no camera while it's audio-only (its slot is reserved below, so it can come back later).
      devices.camera && this.media.videoAllowed() ? this.setDevice('camera', true, run) : undefined,
    ]);
    // Camera off, denied or missing: reserve its slot anyway.
    if (run === this.joinRun && !this.media.cameraEnabled()) {
      await this.media.reserveCamera().catch(() => undefined);
    }
  }

  /**
   * The devices the user wants (not what happens to be on: a camera still starting would otherwise come back off);
   * gives up (Try Again screen) after a few attempts in a row.
   */
  private async rejoin(): Promise<void> {
    if (this.rejoining()) return;
    if (++this.rejoinAttempts > MAX_REJOINS) {
      await this.teardown();
      this.error.set('Connection lost.');
      return;
    }
    this.rejoining.set(true);
    const devices = { ...this.wanted };
    try {
      await this.teardown();
      await new Promise((resolve) => setTimeout(resolve, REJOIN_DELAY_MS));
      await this.join(devices);
    } finally {
      this.rejoining.set(false);
    }
  }

  private async teardown(): Promise<void> {
    this.joinRun++; // abandons a join still in progress
    this.joined.set(false);
    await this.media.disconnect();
    this.crypto.stop();
    await this.signaling.leave();
  }
}

type Devices = { microphone: boolean; camera: boolean };

const MAX_REJOINS = 3;
/** The server's cooldown after being turned away (Room.DenyCooldown) plus a little. */
const ASK_AGAIN_DELAY_MS = 31_000;
const REJOIN_DELAY_MS = 1000;
