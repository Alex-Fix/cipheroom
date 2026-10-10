import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { CryptoService } from '../crypto/crypto.service';
import { MediaKind } from '../crypto/frame-codec';
import { FrameCrypto } from '../crypto/frame-transforms';
import { Camera, CameraFacing, cameraFacing, hasRearCamera } from './cameras';
import { StatsSnapshot, callStats, statsSnapshot } from './call-stats';
import {
  ConnectionReport,
  HealthContext,
  HealthSnapshot,
  PoorStreak,
  connectionReport,
  healthSnapshot,
} from './connection-health';
import { StatsLike } from './ice-path';
import { callPlatform } from './platform';
import { loadVideoCodec, saveVideoCodec } from '../settings/video-codec';
import { loadVideoQuality, saveVideoQuality } from '../settings/video-quality';
import { SignalingService } from '../signaling/signaling.service';
import {
  E2eeStatsDto,
  ParticipantDto,
  RtcConfig,
  TrackRefDto,
  TrackSource,
  VideoLayer,
} from '../signaling/signaling.types';
import { AudioPlayback } from './audio-playback';
import {
  CodecCapability,
  VIDEO_CODECS,
  VideoCodec,
  codecPreferences,
  decodableCodecs,
  encodableCodecs,
  sendCodec,
  simulcastScalabilityMode,
} from './codecs';
import { receiveLayer } from './layers';
import { CallParticipant, MediaState, Tile } from './media.types';
import {
  VideoQuality,
  cameraEncodings,
  captureConstraints,
  supportedQualities,
  closestQuality,
  qualityHeight,
} from './quality';
import { SerialQueue } from './serial-queue';
import { SpeakingDetector, sameMembers } from './speaking';
import { TrackKey, participantOf, subscriptionDiff, trackKey } from './subscriptions';

/** Who we are in the room (from JoinRoom). */
export interface Self {
  id: string;
  displayName: string;
}

/**
 * Owns the call's single RTCPeerConnection to the SFU (Cloudflare Realtime SFU, negotiated through
 * SignalingService). Provided per room route, so it lives exactly as long as the call.
 *
 * - Publishing happens on first use of a device. After that, turning a device off or on never renegotiates: the
 *   track is disabled or swapped (placeholder frames keep the SFU track alive) and others learn it from TrackMuted.
 * - Subscriptions follow `SignalingService.participants`: newly published tracks are pulled, gone ones dropped.
 * - Every SFU/peer-connection mutation runs through one queue: negotiations must never overlap.
 * - Negotiation order: our own tracks are published before we receive anyone else's (`startReceiving`). iOS Safari
 *   can't add a camera once the connection began by answering the SFU's offer; the camera transceiver is therefore
 *   always negotiated up front (`reserveCamera`), and later device changes only swap tracks.
 * - Quality: we send the camera at the chosen quality (`videoQuality`: 4K, Full HD by default, or 720p; a camera
 *   that can't do it sends the best it has below) as f/h/q simulcast, and receive the layer that matches each camera tile's size (`q` when hidden).
 * - Codec: chosen when we connect (`sendingCodec`, from `videoCodec` and what everyone in the call can decode — see
 *   codecs.ts). Cloudflare doesn't forward a codec change on a published track, so a different codec means
 *   rejoining: `codecUnsupported` tells the room when someone who joined can't play ours.
 * - Recovery: ICE restart on connection loss; after two failed attempts `state` becomes 'disconnected' and the
 *   room rejoins.
 * - E2EE: every sender and receiver gets CryptoService's frame transform as it's created, before any frame flows
 *   (`FrameCrypto`, passed to `connect`). Media is never sent or played unencrypted; remote tiles show `securing`
 *   until that participant's key arrived.
 */
@Injectable()
export class MediaService implements OnDestroy {
  private readonly signaling = inject(SignalingService);
  private readonly audioPlayback = inject(AudioPlayback);
  private readonly queue = new SerialQueue();
  private readonly speakingDetector = new SpeakingDetector();

  private pc?: RTCPeerConnection;
  private readonly crypto = inject(CryptoService);
  /** CryptoService's frame transforms for this connection. */
  private frames?: FrameCrypto;
  private statsTimer?: ReturnType<typeof setInterval>;
  private statsTicks = 0;
  /** Baseline for the next call-quality report (ReportCallStats). */
  private lastReport?: { snapshot: StatsSnapshot; e2ee: E2eeStatsDto };
  /** Previous reading for the Connection drawer, and the chip's streak. */
  private health?: HealthSnapshot;
  private readonly poorStreak = new PoorStreak();
  private forceRelay = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private restartAttempts = 0;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private pullFailures = 0;
  /** Rendered width of remote camera tiles (0 = off screen), and the layer last requested for each. */
  private readonly tileWidths = new Map<TrackKey, number>();
  private readonly layers = new Map<TrackKey, VideoLayer>();
  private readonly layerTimers = new Map<TrackKey, ReturnType<typeof setTimeout>>();
  private readonly onVisibilityChange = () =>
    this.subscriptions.forEach((_, key) => key.endsWith(':camera') && this.scheduleLayer(key));
  /** Our transceivers by source, kept for the whole call. */
  private readonly senders = new Map<TrackSource, RTCRtpTransceiver>();
  /** Remote tracks we receive or have requested → receiving mid (undefined while the request is in flight). */
  private readonly subscriptions = new Map<TrackKey, string | undefined>();
  private readonly midToKey = new Map<string, TrackKey>();
  /** Placeholder tracks currently sent instead of a stopped camera / screen. */
  private readonly placeholders = new Map<TrackSource, MediaStreamTrack>();

  private readonly self = signal<Self | undefined>(undefined);
  /** Pulling others' tracks starts only after our own publishes (see class docs). */
  private readonly receiving = signal(false);
  /** Real local capture tracks (not placeholders), by source. */
  private readonly localTracks = signal<Partial<Record<TrackSource, MediaStreamTrack>>>({});
  private readonly remoteTracks = signal<ReadonlyMap<TrackKey, MediaStreamTrack>>(new Map());
  /** Participant ids currently speaking (ours included). */
  private readonly speaking = signal<ReadonlySet<string>>(new Set(), { equal: sameMembers });

  readonly state = signal<MediaState>('disconnected');
  readonly micEnabled = signal(false);
  readonly cameraEnabled = signal(false);
  readonly screenShareEnabled = signal(false);
  readonly canPlaybackAudio = computed(() => !this.audioPlayback.blocked());
  /** Our own link to the SFU, every 2 s (docs/plans/2026-10-10-connection-diagnostics-design.md). */
  readonly connection = signal<ConnectionReport | undefined>(undefined);
  /** The connection has been poor for a while (the header's chip). */
  readonly poorConnection = signal(false);

  /** Local video inputs. Labels only appear once camera permission is granted. Never leave the browser. */
  readonly cameras = signal<Camera[]>([]);
  readonly activeCameraId = signal<string | undefined>(undefined);
  readonly cameraFacing = signal<CameraFacing | undefined>(undefined);
  /** Phones/tablets: offer front ⇄ rear flipping. */
  readonly canFlip = computed(() => hasRearCamera(this.cameras()));
  /** Camera send quality; remembered in this browser. */
  readonly videoQuality = signal<VideoQuality>(loadVideoQuality());
  /** Qualities the current camera can actually capture (4K / 1080p only when supported). */
  readonly availableQualities = signal<VideoQuality[]>(supportedQualities(undefined));
  /** The usage guard's level (server-wide; see docs/plans/2026-10-09-usage-guard-design.md). */
  readonly usageLevel = computed(() => this.signaling.usage()?.level ?? 'normal');
  /** Saving bandwidth: we send at most 720p (the api already holds what we receive at the half layer). */
  readonly qualityCapped = computed(() => this.usageLevel() === 'saving');
  /** Audio-only or paused: no camera, no screen share, no video received. */
  readonly videoAllowed = computed(
    () => this.usageLevel() === 'normal' || this.usageLevel() === 'saving',
  );
  /** What we ask the camera for: the chosen quality, or 720p while saving. */
  private readonly captureQuality = computed<VideoQuality>(() =>
    this.qualityCapped() ? CAPPED_QUALITY : this.videoQuality(),
  );
  /** What the quality picker offers right now. */
  readonly offeredQualities = computed<VideoQuality[]>(() =>
    this.qualityCapped() ? [CAPPED_QUALITY] : this.availableQualities(),
  );
  /** What we actually send (the picker's tick): Full HD on a 720p camera is 720p. */
  readonly effectiveQuality = computed<VideoQuality>(() =>
    closestQuality(this.captureQuality(), this.offeredQualities()),
  );
  /** Video codec the user chose; remembered in this browser. */
  readonly videoCodec = signal<VideoCodec>(loadVideoCodec());
  /** Codecs this browser can send (the picker offers only these). */
  readonly availableCodecs: readonly VideoCodec[] = VIDEO_CODECS.filter((c) =>
    encodableCodecs().includes(c),
  );
  /** Codecs this browser can decode (sent with JoinLobby). */
  readonly decodableCodecs: readonly string[] = decodableCodecs();
  /** Codec we send in this call (may be a fallback from `videoCodec`); unset while not connected. */
  readonly sendingCodec = signal<VideoCodec | undefined>(undefined);
  /** Someone in the call can't decode what we send (they joined after us): rejoin to pick another codec. */
  readonly codecUnsupported = computed(() => {
    const codec = this.sendingCodec();
    return !!codec && this.signaling.participants().some((p) => !p.videoCodecs.includes(codec));
  });

  readonly participants = computed<CallParticipant[]>(() => {
    const self = this.self();
    if (!self) return [];
    const me: CallParticipant = {
      identity: self.id,
      name: self.displayName,
      role: this.crypto.isHost() ? 'host' : this.crypto.canAdmit() ? 'cohost' : 'guest',
      isLocal: true,
      isSpeaking: this.speaking().has(self.id),
      micMuted: !this.micEnabled(),
      cameraOn: this.cameraEnabled(),
      sharingScreen: this.screenShareEnabled(),
    };
    const speaking = this.speaking();
    const names = this.crypto.names();
    return [
      me,
      ...this.signaling
        .participants()
        .map((p) =>
          remoteParticipant(
            p,
            nameOf(names, p.id),
            this.crypto.roleOf(p.identity.ed25519Pub),
            speaking,
          ),
        ),
    ];
  });

  readonly tiles = computed<Tile[]>(() => {
    const self = this.self();
    if (!self) return [];
    const local = this.localTracks();
    const name = `${self.displayName} (you)`;
    const tiles: Tile[] = [
      {
        key: `${self.id}:camera`,
        participantId: self.id,
        name,
        displayName: self.displayName,
        isLocal: true,
        isScreen: false,
        isSpeaking: this.speaking().has(self.id),
        video: this.cameraEnabled() ? local.camera : undefined,
        // Never play our own microphone back.
        micMuted: !this.micEnabled(),
        mirror: this.cameraFacing() !== 'environment',
        securing: false,
      },
    ];
    if (this.screenShareEnabled() && local.screen) {
      tiles.push(screenTile(self.id, name, self.displayName, true, local.screen));
    }
    const remote = this.remoteTracks();
    const speaking = this.speaking();
    const secured = this.crypto.secured();
    const names = this.crypto.names();
    for (const p of this.signaling.participants()) {
      tiles.push(...remoteTiles(p, nameOf(names, p.id), remote, speaking, !secured.has(p.id)));
    }
    return tiles;
  });

  constructor() {
    // Follow the room: pull newly published tracks, drop ones that went away (and, audio-only, all video).
    effect(() => {
      const participants = this.signaling.participants();
      const videoAllowed = this.videoAllowed();
      if (this.self() && this.receiving()) {
        untracked(() =>
          this.syncSubscriptions(videoAllowed ? participants : audioOnly(participants)),
        );
      }
    });

    // Saving bandwidth started or ended: a live camera is re-captured at the new cap.
    let capped = this.qualityCapped();
    effect(() => {
      const now = this.qualityCapped();
      if (now === capped) return;
      capped = now;
      untracked(() => {
        if (!this.cameraEnabled()) return;
        const deviceId = this.activeCameraId();
        void this.switchCamera(deviceId ? { deviceId: { exact: deviceId } } : {}).catch(
          () => undefined,
        );
      });
    });
  }

  /**
   * Opens the peer connection for a joined participant, with `frames` (from CryptoService.start) on every sender and
   * receiver. Media is published later, per device.
   */
  connect(config: RtcConfig, self: Self, frames: FrameCrypto): void {
    this.frames = frames;
    const pc = new RTCPeerConnection({
      // Empty list (local dev): the SFU's own candidates are enough without TURN.
      ...(config.iceServers.length ? { iceServers: config.iceServers } : {}),
      iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      ...frames.peerConnectionConfig,
    });
    this.pc = pc;
    pc.ontrack = (event) => this.onRemoteTrack(event);
    pc.onconnectionstatechange = () => this.onConnectionStateChange(pc);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.forceRelay = config.forceRelay;
    this.state.set(mediaState(pc.connectionState));
    this.sendingCodec.set(this.codecFor(this.videoCodec()));
    this.self.set(self);
    this.statsTimer = setInterval(() => void this.collectStats(), STATS_INTERVAL_MS);
  }

  /**
   * Rendered width (CSS px) of a tile, 0 when it's not on screen. Remote camera tiles then receive the matching
   * simulcast layer (debounced, so resizing doesn't flood the SFU).
   */
  setTileSize(tileKey: string, width: number): void {
    const key = tileKey as TrackKey;
    if (!key.endsWith(':camera')) return;
    this.tileWidths.set(key, width);
    this.scheduleLayer(key);
  }

  /** Starts receiving the room's tracks. Call once our own devices have been published (or failed to). */
  startReceiving(): void {
    this.receiving.set(true);
  }

  /**
   * Publishes the camera without capturing (placeholder frames, muted) when it isn't on, so turning it on later is a
   * track swap rather than a new negotiation after we've started receiving.
   */
  async reserveCamera(): Promise<void> {
    if (this.senders.has('camera')) return;
    const placeholder = blankVideoTrack();
    if (!placeholder) return;
    await this.publish('camera', placeholder, { placeholder: true });
    await this.signaling.setTrackMuted('camera', true);
  }

  /** Rejects with the browser's DOMException (e.g. NotAllowedError) when the device can't be used. */
  async setMicrophone(enabled: boolean): Promise<void> {
    const track = this.localTracks().microphone;
    if (enabled && !track) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await this.publish('microphone', stream.getAudioTracks()[0]);
    } else if (track) {
      // A disabled audio track keeps sending silence, so the SFU track stays alive.
      track.enabled = enabled;
      await this.signaling.setTrackMuted('microphone', !enabled);
    }
    this.micEnabled.set(enabled && !!this.localTracks().microphone);
  }

  async setCamera(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.stopSource('camera');
      this.cameraEnabled.set(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: this.cameraConstraints() });
    await this.useTrack('camera', stream.getVideoTracks()[0]);
    this.cameraEnabled.set(true);
    // First time on, permission was just granted: device labels are now readable.
    await this.refreshCameras();
  }

  /** Front ⇄ rear. Others see a brief cut; the published track stays the same. */
  async flipCamera(): Promise<void> {
    const next: CameraFacing = this.cameraFacing() === 'environment' ? 'user' : 'environment';
    await this.switchCamera({ facingMode: { exact: next } });
  }

  async selectCamera(deviceId: string): Promise<void> {
    await this.switchCamera({ deviceId: { exact: deviceId } });
  }

  /**
   * Remembers the video codec to send. Returns true when the call must be rejoined for it to take effect (the codec
   * we'd now send differs from the one we're sending).
   */
  setVideoCodec(codec: VideoCodec): boolean {
    this.videoCodec.set(codec);
    saveVideoCodec(codec);
    const sending = this.sendingCodec();
    return !!sending && this.codecFor(codec) !== sending;
  }

  /** Changes the camera send quality; a live camera is re-captured in place (others see a brief cut). */
  async setVideoQuality(quality: VideoQuality): Promise<void> {
    this.videoQuality.set(quality);
    saveVideoQuality(quality);
    const deviceId = this.activeCameraId();
    await this.switchCamera(deviceId ? { deviceId: { exact: deviceId } } : {});
  }

  async setScreenShare(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.stopSource('screen');
      this.screenShareEnabled.set(false);
      return;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    // The browser's own "Stop sharing" button.
    track.addEventListener('ended', () => void this.setScreenShare(false));
    await this.useTrack('screen', track);
    this.screenShareEnabled.set(true);
  }

  /** Must be called from a user gesture when the browser blocked autoplay. */
  startAudio(): Promise<void> {
    return this.audioPlayback.resume();
  }

  async disconnect(): Promise<void> {
    clearInterval(this.statsTimer);
    this.lastReport = undefined;
    this.statsTicks = 0;
    this.health = undefined;
    this.poorStreak.update('unknown');
    this.connection.set(undefined);
    this.poorConnection.set(false);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    this.pullFailures = 0;
    this.layerTimers.forEach((t) => clearTimeout(t));
    this.layerTimers.clear();
    this.tileWidths.clear();
    this.layers.clear();
    this.restartAttempts = 0;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.pc?.close();
    this.pc = undefined;
    // The worker belongs to CryptoService (stopped with the call's keys).
    this.frames = undefined;
    Object.values(this.localTracks()).forEach((t) => t?.stop());
    this.placeholders.forEach((t) => t.stop());
    this.placeholders.clear();
    this.senders.clear();
    this.subscriptions.clear();
    this.midToKey.clear();
    this.self.set(undefined);
    this.receiving.set(false);
    this.localTracks.set({});
    this.remoteTracks.set(new Map());
    this.speaking.set(new Set());
    this.state.set('disconnected');
    this.sendingCodec.set(undefined);
    this.micEnabled.set(false);
    this.cameraEnabled.set(false);
    this.screenShareEnabled.set(false);
    this.cameras.set([]);
    this.activeCameraId.set(undefined);
    this.cameraFacing.set(undefined);
  }

  ngOnDestroy(): void {
    void this.disconnect();
  }

  /** Puts a capture track on the source's transceiver: publishes on first use, otherwise swaps and unmutes. */
  private async useTrack(source: TrackSource, track: MediaStreamTrack): Promise<void> {
    const transceiver = this.senders.get(source);
    if (!transceiver) {
      await this.publish(source, track);
      if (source === 'camera') this.updateCameraInfo();
      return;
    }
    const previous = this.localTracks()[source];
    await transceiver.sender.replaceTrack(track);
    if (source === 'camera')
      await updateBitrates(transceiver.sender, captureHeight(track), this.requireCodec());
    previous?.stop();
    this.placeholders.get(source)?.stop();
    this.placeholders.delete(source);
    this.setLocalTrack(source, track);
    if (source === 'camera') this.updateCameraInfo();
    await this.signaling.setTrackMuted(source, false);
  }

  /** Stops capturing (camera light off) while keeping the published SFU track alive with placeholder frames. */
  private async stopSource(source: TrackSource): Promise<void> {
    const track = this.localTracks()[source];
    const transceiver = this.senders.get(source);
    if (!track) return;
    const placeholder = blankVideoTrack();
    if (placeholder) this.placeholders.set(source, placeholder);
    await transceiver?.sender.replaceTrack(placeholder);
    track.stop();
    this.setLocalTrack(source, undefined);
    if (transceiver) await this.signaling.setTrackMuted(source, true);
  }

  private async switchCamera(constraints: MediaTrackConstraints): Promise<void> {
    if (!this.localTracks().camera) return;
    // Phones can't open two cameras at once: release the current one first.
    this.localTracks().camera?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: this.cameraConstraints(constraints),
      });
      await this.useTrack('camera', stream.getVideoTracks()[0]);
    } catch (e) {
      await this.setCamera(false);
      throw e;
    }
  }

  /** `placeholder`: the track is placeholder frames, not a capture (kept in `placeholders`, not shown locally). */
  private publish(
    source: TrackSource,
    track: MediaStreamTrack,
    { placeholder = false } = {},
  ): Promise<void> {
    return this.queue.run(async () => {
      const pc = this.requirePc();
      const codec = this.requireCodec();
      const capabilities = sendCapabilities();
      const transceiver = addSendTransceiver(pc, track, source, codec);
      const kind = track.kind as MediaKind;
      // Before the first frame leaves: frames are only ever sent encrypted.
      this.requireFrames().attachSender(
        transceiver.sender,
        kind,
        kind === 'video' ? codec : undefined,
      );
      if (kind === 'video') preferCodec(transceiver, capabilities, codec);
      try {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await this.signaling.publishTracks(pc.localDescription!.sdp, [
          { mid: transceiver.mid!, source },
        ]);
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (e) {
        // Leave the connection ready for the next negotiation.
        if (pc.signalingState === 'have-local-offer')
          await pc.setLocalDescription({ type: 'rollback' });
        transceiver.stop();
        track.stop();
        throw e;
      }
      this.senders.set(source, transceiver);
      if (placeholder) this.placeholders.set(source, track);
      else this.setLocalTrack(source, track);
    });
  }

  private syncSubscriptions(participants: readonly ParticipantDto[]): void {
    if (!this.pc) return;
    const { subscribe, drop } = subscriptionDiff(participants, new Set(this.subscriptions.keys()));

    if (drop.length) {
      const mids = drop.flatMap((key) => this.forget(key));
      if (mids.length)
        void this.queue.run(() => this.signaling.unsubscribeTracks(mids)).catch(() => {});
    }
    if (subscribe.length) {
      subscribe.forEach((t) =>
        this.subscriptions.set(trackKey(t.participantId, t.source), undefined),
      );
      void this.queue.run(() => this.pull(subscribe)).catch(() => this.retryLater(subscribe));
    }
  }

  private async pull(tracks: TrackRefDto[]): Promise<void> {
    const pc = this.requirePc();
    const result = await this.signaling.subscribeTracks(tracks);

    // Map mids before applying the offer: ontrack fires during setRemoteDescription.
    const stale: string[] = [];
    const received = new Set(result.tracks.map((t) => trackKey(t.participantId, t.source)));
    for (const t of result.tracks) {
      const key = trackKey(t.participantId, t.source);
      if (this.subscriptions.has(key)) {
        this.subscriptions.set(key, t.mid);
        this.midToKey.set(t.mid, key);
      } else {
        stale.push(t.mid); // dropped while the request was in flight
      }
    }

    if (result.offerSdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: result.offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signaling.renegotiate(answer.sdp!);
      this.tagReceivers(pc);
    }
    if (stale.length) await this.signaling.unsubscribeTracks(stale);

    // The SFU leaves out tracks it couldn't add yet (no media flowing yet, publisher just left): try again later.
    const missing = tracks.filter((t) => !received.has(trackKey(t.participantId, t.source)));
    if (missing.length) this.retryLater(missing);
    else this.pullFailures = 0;

    // Tiles may have reported their size before the track arrived.
    for (const t of result.tracks) {
      const key = trackKey(t.participantId, t.source);
      if (this.tileWidths.has(key)) this.scheduleLayer(key);
    }
  }

  /**
   * Forgets tracks we couldn't receive and re-syncs with the room after a growing delay (1 s, 2 s, 4 s … 15 s).
   * Tracks whose publisher is gone by then simply aren't requested again.
   */
  private retryLater(tracks: TrackRefDto[]): void {
    tracks.forEach((t) => this.subscriptions.delete(trackKey(t.participantId, t.source)));
    if (this.resyncTimer) return;
    const delay = Math.min(PULL_RETRY_BASE_MS * 2 ** this.pullFailures++, PULL_RETRY_MAX_MS);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined;
      const participants = this.signaling.participants();
      this.syncSubscriptions(this.videoAllowed() ? participants : audioOnly(participants));
    }, delay);
  }

  private scheduleLayer(key: TrackKey): void {
    clearTimeout(this.layerTimers.get(key));
    this.layerTimers.set(
      key,
      setTimeout(() => {
        this.layerTimers.delete(key);
        void this.applyLayer(key);
      }, LAYER_DEBOUNCE_MS),
    );
  }

  private async applyLayer(key: TrackKey): Promise<void> {
    const mid = this.subscriptions.get(key);
    if (!mid) return;
    const layer = receiveLayer(
      this.tileWidths.get(key),
      window.devicePixelRatio,
      document.visibilityState !== 'hidden',
    );
    // Subscriptions start at the full layer (see the SFU adapter).
    if ((this.layers.get(key) ?? 'f') === layer) return;
    this.layers.set(key, layer);
    try {
      await this.queue.run(() => this.signaling.selectVideoLayer(mid, layer));
    } catch {
      this.layers.delete(key); // retried on the next change
    }
  }

  private onConnectionStateChange(pc: RTCPeerConnection): void {
    clearTimeout(this.recoveryTimer);
    switch (pc.connectionState) {
      case 'connected':
        this.restartAttempts = 0;
        this.state.set('connected');
        break;
      case 'disconnected':
        // Often recovers by itself (brief network blip); restart ICE if it doesn't.
        this.state.set('reconnecting');
        this.recoveryTimer = setTimeout(() => void this.restartIce(), ICE_GRACE_MS);
        break;
      case 'failed':
        this.state.set('reconnecting');
        void this.restartIce();
        break;
      default:
        this.state.set(mediaState(pc.connectionState));
    }
  }

  /**
   * Client-initiated ICE restart (new network path, same SFU session — Cloudflare keeps it for 30 s). Gives up after
   * MAX_ICE_RESTARTS: `state` becomes 'disconnected' and the room rejoins from scratch.
   */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState === 'connected') return;
    if (this.restartAttempts++ >= MAX_ICE_RESTARTS) {
      this.state.set('disconnected');
      return;
    }
    try {
      await this.queue.run(async () => {
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
        const answer = await this.signaling.restartIce(pc.localDescription!.sdp);
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      });
      // If ICE hasn't recovered by then, try again (or give up).
      this.recoveryTimer = setTimeout(() => void this.restartIce(), ICE_RESTART_TIMEOUT_MS);
    } catch {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
      }
      if (this.pc === pc) this.state.set('disconnected');
    }
  }

  /** Drops a remote track locally; returns its mid if it had one. */
  private forget(key: TrackKey): string[] {
    const mid = this.subscriptions.get(key);
    this.subscriptions.delete(key);
    clearTimeout(this.layerTimers.get(key));
    this.layerTimers.delete(key);
    this.tileWidths.delete(key);
    this.layers.delete(key);
    if (mid) this.midToKey.delete(mid);
    this.remoteTracks.update((tracks) => {
      const next = new Map(tracks);
      next.delete(key);
      return next;
    });
    return mid ? [mid] : [];
  }

  private onRemoteTrack(event: RTCTrackEvent): void {
    const key = event.transceiver.mid ? this.midToKey.get(event.transceiver.mid) : undefined;
    // Before the first frame is decoded; untagged receivers drop frames until they're assigned.
    this.frames?.attachReceiver(
      event.receiver,
      event.track.kind as MediaKind,
      key && participantOf(key),
    );
    if (!key) return;
    this.remoteTracks.update((tracks) => new Map(tracks).set(key, event.track));
  }

  /**
   * Tags every receiving transceiver with the participant whose track it now carries: the SFU may reuse a receiver
   * for another participant's track without a new `ontrack`.
   */
  private tagReceivers(pc: RTCPeerConnection): void {
    if (!this.frames) return;
    for (const t of pc.getTransceivers()) {
      const key = t.mid ? this.midToKey.get(t.mid) : undefined;
      if (key)
        this.frames.attachReceiver(
          t.receiver,
          t.receiver.track.kind as MediaKind,
          participantOf(key),
        );
    }
  }

  private setLocalTrack(source: TrackSource, track: MediaStreamTrack | undefined): void {
    this.localTracks.update((tracks) => ({ ...tracks, [source]: track }));
  }

  private requireFrames(): FrameCrypto {
    // Never send a frame we can't encrypt.
    if (!this.frames) throw new Error('Not connected.');
    return this.frames;
  }

  private requireCodec(): VideoCodec {
    const codec = this.sendingCodec();
    if (!codec) throw new Error('Not connected.');
    return codec;
  }

  /** What we'd send with `chosen`, given what everyone in the call can decode. */
  private codecFor(chosen: VideoCodec): VideoCodec {
    return sendCodec(
      chosen,
      this.availableCodecs,
      this.signaling.participants().map((p) => p.videoCodecs),
    );
  }

  private requirePc(): RTCPeerConnection {
    if (!this.pc) throw new Error('Not connected.');
    return this.pc;
  }

  private cameraConstraints(extra: MediaTrackConstraints = {}): MediaTrackConstraints {
    return { ...captureConstraints(this.captureQuality()), ...extra };
  }

  private updateCameraInfo(): void {
    const track = this.localTracks().camera;
    const settings = track?.getSettings();
    const label = this.cameras().find((c) => c.id === settings?.deviceId)?.label ?? track?.label;
    this.activeCameraId.set(settings?.deviceId);
    if (track)
      this.availableQualities.set(supportedQualities(track.getCapabilities?.().height?.max));
    this.cameraFacing.set(track ? cameraFacing(settings?.facingMode, label) : undefined);
  }

  private async refreshCameras(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    this.cameras.set(
      devices
        .filter((d) => d.kind === 'videoinput' && d.deviceId) // empty before permission is granted
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
    );
    this.updateCameraInfo();
  }

  private async collectStats(): Promise<void> {
    const pc = this.pc;
    const self = this.self();
    const report = await pc?.getStats().catch(() => undefined);
    if (!report || !self || pc !== this.pc) return;

    // Who is speaking: inbound audio levels per remote microphone, and our own microphone's level.
    const owners = new Map<string, string>();
    this.remoteTracks().forEach((track, key) => {
      if (key.endsWith(':microphone')) owners.set(track.id, key.slice(0, key.indexOf(':')));
    });
    const levels = new Map<string, number>();
    report.forEach(
      (stat: { type: string; kind?: string; audioLevel?: number; trackIdentifier?: string }) => {
        if (stat.kind !== 'audio' || typeof stat.audioLevel !== 'number') return;
        if (stat.type === 'inbound-rtp') {
          const owner = owners.get(stat.trackIdentifier ?? '');
          if (owner) levels.set(owner, stat.audioLevel);
        } else if (stat.type === 'media-source' && this.micEnabled()) {
          levels.set(self.id, stat.audioLevel);
        }
      },
    );
    this.speaking.set(this.speakingDetector.update(levels, Date.now()));

    if (this.statsTicks++ % CONNECTION_EVERY_TICKS === 0) this.updateConnection(report);
    // Baseline on the first tick, then one report per interval.
    if (this.statsTicks % REPORT_EVERY_TICKS === 1) this.reportCallStats(report);
  }

  private updateConnection(report: StatsLike): void {
    const next = healthSnapshot(report, performance.now());
    const prev = this.health;
    this.health = next;
    // Undefined after a long gap (throttled tab): keep the last report, start over from this reading.
    const connection = connectionReport(prev, next, this.healthContext());
    if (!connection) return;
    this.connection.set(connection);
    this.poorConnection.set(this.poorStreak.update(connection.verdict));
  }

  private healthContext(): HealthContext {
    const sources = new Map<string, TrackSource>();
    this.senders.forEach((transceiver, source) => {
      if (transceiver.mid) sources.set(transceiver.mid, source);
    });
    const others = this.signaling.participants();
    const secured = this.crypto.secured();
    const dropped = Object.fromEntries(
      Object.entries(this.crypto.droppedEnvelopes()).filter(([, count]) => !!count),
    );
    return {
      state: this.state(),
      forceRelay: this.forceRelay,
      sources,
      enabled: {
        microphone: this.micEnabled(),
        camera: this.cameraEnabled(),
        screen: this.screenShareEnabled(),
      },
      videoAllowed: this.videoAllowed(),
      targetHeight: qualityHeight(this.effectiveQuality()),
      encryption: {
        secured: others.filter((p) => secured.has(p.id)).length,
        participants: others.length,
        epoch: this.crypto.keyEpoch(),
        totals: this.crypto.telemetry(),
        dropped,
      },
    };
  }

  /**
   * Call quality for telemetry: what changed since the last report (numbers only — see call-stats.ts), plus
   * CryptoService's E2EE counters. Fire and forget: a failed report never affects the call.
   */
  private reportCallStats(report: StatsLike): void {
    const snapshot = statsSnapshot(report, performance.now());
    const e2ee = this.crypto.telemetry();
    const previous = this.lastReport;
    this.lastReport = { snapshot, e2ee };
    if (!previous) return;
    const platform = callPlatform(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
    const stats = callStats(previous.snapshot, snapshot, platform, {
      prev: previous.e2ee,
      next: e2ee,
    });
    if (stats) void this.signaling.reportCallStats(stats).catch(() => undefined);
  }
}

const STATS_INTERVAL_MS = 250;
/** 8 × 250 ms: the Connection drawer refreshes every 2 s. */
const CONNECTION_EVERY_TICKS = 8;
/** 60 × 250 ms = one call-quality report every 15 s. */
const REPORT_EVERY_TICKS = 60;
const LAYER_DEBOUNCE_MS = 500;
const ICE_GRACE_MS = 2000;
const ICE_RESTART_TIMEOUT_MS = 10_000;
const MAX_ICE_RESTARTS = 2;
const PULL_RETRY_BASE_MS = 1000;
const PULL_RETRY_MAX_MS = 15_000;

function mediaState(state: RTCPeerConnectionState): MediaState {
  switch (state) {
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'reconnecting';
    case 'failed':
    case 'closed':
      return 'disconnected';
    default:
      // 'new': nothing negotiated yet (e.g. no devices on and nobody publishing) — we're still in the call.
      return 'connected';
  }
}

/** The quality we send at most while the usage guard is saving bandwidth. */
const CAPPED_QUALITY: VideoQuality = '720p';

/** The room as far as receiving goes when only audio may flow (usage guard). */
function audioOnly(participants: readonly ParticipantDto[]): ParticipantDto[] {
  return participants.map((p) => ({
    ...p,
    tracks: p.tracks.filter((t) => t.source === 'microphone'),
  }));
}

/** Shown until someone's first key envelope (which carries their name) arrives. */
export const UNNAMED = 'Guest';

const nameOf = (names: ReadonlyMap<string, string>, id: string): string => names.get(id) ?? UNNAMED;

function remoteParticipant(
  p: ParticipantDto,
  name: string,
  role: CallParticipant['role'],
  speaking: ReadonlySet<string>,
): CallParticipant {
  const track = (source: TrackSource) => p.tracks.find((t) => t.source === source);
  const mic = track('microphone');
  const camera = track('camera');
  const screen = track('screen');
  return {
    identity: p.id,
    name,
    role,
    isLocal: false,
    isSpeaking: speaking.has(p.id),
    micMuted: !mic || mic.muted,
    cameraOn: !!camera && !camera.muted,
    sharingScreen: !!screen && !screen.muted,
  };
}

function remoteTiles(
  p: ParticipantDto,
  name: string,
  remote: ReadonlyMap<TrackKey, MediaStreamTrack>,
  speaking: ReadonlySet<string>,
  securing: boolean,
): Tile[] {
  const track = (source: TrackSource) => p.tracks.find((t) => t.source === source);
  const camera = track('camera');
  const mic = track('microphone');
  const screen = track('screen');
  const tiles: Tile[] = [
    {
      key: `${p.id}:camera`,
      participantId: p.id,
      name,
      displayName: name,
      isLocal: false,
      isScreen: false,
      isSpeaking: speaking.has(p.id),
      video: camera && !camera.muted ? remote.get(trackKey(p.id, 'camera')) : undefined,
      audio: remote.get(trackKey(p.id, 'microphone')),
      micMuted: !mic || mic.muted,
      mirror: false,
      securing,
    },
  ];
  const screenTrack = screen && !screen.muted ? remote.get(trackKey(p.id, 'screen')) : undefined;
  if (screenTrack) {
    tiles.push({ ...screenTile(p.id, name, name, false, screenTrack), securing });
  }
  return tiles;
}

function screenTile(
  id: string,
  name: string,
  displayName: string,
  isLocal: boolean,
  video: MediaStreamTrack,
): Tile {
  return {
    key: `${id}:screen`,
    participantId: id,
    name,
    displayName,
    isLocal,
    isScreen: true,
    isSpeaking: false,
    video,
    micMuted: true,
    mirror: false,
    securing: false,
  };
}

function captureHeight(track: MediaStreamTrack): number {
  return track.getSettings?.().height ?? 720;
}

/** Re-targets the camera's simulcast bitrates after a resolution change (no renegotiation needed). */
async function updateBitrates(
  sender: RTCRtpSender,
  height: number,
  codec: VideoCodec,
): Promise<void> {
  if (typeof sender.getParameters !== 'function') return;
  const parameters = sender.getParameters();
  const targets = new Map(cameraEncodings(height, codec).map((e) => [e.rid, e.maxBitrate]));
  parameters.encodings?.forEach((e) => (e.maxBitrate = targets.get(e.rid) ?? e.maxBitrate));
  await sender.setParameters(parameters);
}

/**
 * Camera: f/h/q simulcast with the codec's scalability mode. A browser that rejects the mode (it throws before
 * creating anything) gets the layers without it.
 */
function addSendTransceiver(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  source: TrackSource,
  codec: VideoCodec,
): RTCRtpTransceiver {
  if (source !== 'camera') return pc.addTransceiver(track, { direction: 'sendonly' });
  const height = captureHeight(track);
  const mode = simulcastScalabilityMode(codec);
  try {
    return pc.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: cameraEncodings(height, codec, mode),
    });
  } catch (e) {
    if (!mode) throw e;
    return pc.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: cameraEncodings(height, codec),
    });
  }
}

function sendCapabilities(): CodecCapability[] {
  return (
    (typeof RTCRtpSender !== 'undefined'
      ? RTCRtpSender.getCapabilities?.('video')?.codecs
      : undefined) ?? []
  );
}

/**
 * Every video transceiver (camera and screen) sends only the call's codec: frame encryption knows its layout, and
 * we never switch codecs on a published track (see codecs.ts).
 */
function preferCodec(
  transceiver: RTCRtpTransceiver,
  capabilities: readonly CodecCapability[],
  codec: VideoCodec,
): void {
  const preferences = codecPreferences(capabilities, codec);
  if (!preferences.length || !transceiver.setCodecPreferences) return;
  transceiver.setCodecPreferences(preferences as RTCRtpCodec[]);
}

/**
 * Tiny black video at 1 fps. Sent while the camera or screen is off so the SFU doesn't garbage-collect the track
 * (it drops tracks after 30 s without packets) and turning it back on needs no renegotiation.
 */
function blankVideoTrack(): MediaStreamTrack | null {
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') return null;
  canvas.width = 320;
  canvas.height = 180;
  canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.captureStream(1).getVideoTracks()[0] ?? null;
}
