import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { Camera, CameraFacing, cameraFacing, hasRearCamera } from './cameras';
import { selectedIcePath } from './ice-path';
import { loadVideoQuality, saveVideoQuality } from '../settings/video-quality';
import { SignalingService } from '../signaling/signaling.service';
import {
  ParticipantDto,
  RtcConfig,
  TrackRefDto,
  TrackSource,
  VideoLayer,
} from '../signaling/signaling.types';
import { AudioPlayback } from './audio-playback';
import { receiveLayer } from './layers';
import { CallParticipant, Diagnostics, MediaState, Tile } from './media.types';
import { VideoQuality, cameraEncodings, captureConstraints, supportedQualities } from './quality';
import { SerialQueue } from './serial-queue';
import { SpeakingDetector, sameMembers } from './speaking';
import { TrackKey, subscriptionDiff, trackKey } from './subscriptions';

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
 * - Quality: we send the camera at the chosen quality (`videoQuality`, default auto = best the camera has, up to
 *   4K) as f/h/q simulcast, and receive the highest layer of every camera on screen (`q` when hidden).
 * - Recovery: ICE restart on connection loss; after two failed attempts `state` becomes 'disconnected' and the
 *   room rejoins.
 * - E2EE (next milestone) hooks in where senders and receivers are created.
 */
@Injectable()
export class MediaService implements OnDestroy {
  private readonly signaling = inject(SignalingService);
  private readonly audioPlayback = inject(AudioPlayback);
  private readonly queue = new SerialQueue();
  private readonly speakingDetector = new SpeakingDetector();

  private pc?: RTCPeerConnection;
  private statsTimer?: ReturnType<typeof setInterval>;
  private statsTicks = 0;
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
  readonly diagnostics = signal<Diagnostics>({ forceRelay: false });

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

  readonly participants = computed<CallParticipant[]>(() => {
    const self = this.self();
    if (!self) return [];
    const me: CallParticipant = {
      identity: self.id,
      name: self.displayName,
      isLocal: true,
      isSpeaking: this.speaking().has(self.id),
      micMuted: !this.micEnabled(),
      cameraOn: this.cameraEnabled(),
      sharingScreen: this.screenShareEnabled(),
    };
    const speaking = this.speaking();
    return [me, ...this.signaling.participants().map((p) => remoteParticipant(p, speaking))];
  });

  readonly tiles = computed<Tile[]>(() => {
    const self = this.self();
    if (!self) return [];
    const local = this.localTracks();
    const name = `${self.displayName} (you)`;
    const tiles: Tile[] = [
      {
        key: `${self.id}:camera`,
        name,
        displayName: self.displayName,
        isLocal: true,
        isScreen: false,
        isSpeaking: this.speaking().has(self.id),
        video: this.cameraEnabled() ? local.camera : undefined,
        // Never play our own microphone back.
        micMuted: !this.micEnabled(),
        mirror: this.cameraFacing() !== 'environment',
      },
    ];
    if (this.screenShareEnabled() && local.screen) {
      tiles.push(screenTile(self.id, name, self.displayName, true, local.screen));
    }
    const remote = this.remoteTracks();
    const speaking = this.speaking();
    for (const p of this.signaling.participants()) tiles.push(...remoteTiles(p, remote, speaking));
    return tiles;
  });

  constructor() {
    // Follow the room: pull newly published tracks, drop ones that went away.
    effect(() => {
      const participants = this.signaling.participants();
      if (this.self()) untracked(() => this.syncSubscriptions(participants));
    });
  }

  /** Opens the peer connection for a joined participant. Media is published later, per device. */
  connect(config: RtcConfig, self: Self): void {
    const pc = new RTCPeerConnection({
      // Empty list (local dev): the SFU's own candidates are enough without TURN.
      ...(config.iceServers.length ? { iceServers: config.iceServers } : {}),
      iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;
    pc.ontrack = (event) => this.onRemoteTrack(event);
    pc.onconnectionstatechange = () => this.onConnectionStateChange(pc);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.diagnostics.set({ forceRelay: config.forceRelay });
    this.state.set(mediaState(pc.connectionState));
    this.self.set(self);
    this.statsTimer = setInterval(() => void this.collectStats(), STATS_INTERVAL_MS);
  }

  /**
   * Rendered width (CSS px) of a tile, 0 when it's not on screen. Remote camera tiles then receive the matching
   * simulcast layer (debounced, so resizing doesn't flood the SFU).
   */
  setTileSize(tileKey: string, width: number): void {
    // Only on/off screen matters: on screen we always want the highest layer.
    const key = tileKey as TrackKey;
    if (!key.endsWith(':camera')) return;
    this.tileWidths.set(key, width);
    this.scheduleLayer(key);
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
    Object.values(this.localTracks()).forEach((t) => t?.stop());
    this.placeholders.forEach((t) => t.stop());
    this.placeholders.clear();
    this.senders.clear();
    this.subscriptions.clear();
    this.midToKey.clear();
    this.self.set(undefined);
    this.localTracks.set({});
    this.remoteTracks.set(new Map());
    this.speaking.set(new Set());
    this.state.set('disconnected');
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
    if (source === 'camera') await updateBitrates(transceiver.sender, captureHeight(track));
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

  private publish(source: TrackSource, track: MediaStreamTrack): Promise<void> {
    return this.queue.run(async () => {
      const pc = this.requirePc();
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        ...(source === 'camera' ? { sendEncodings: cameraEncodings(captureHeight(track)) } : {}),
      });
      if (source === 'camera') preferVp8(transceiver);
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
      this.setLocalTrack(source, track);
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
      this.syncSubscriptions(this.signaling.participants());
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
    // Tiles that never reported a size count as on screen.
    const onScreen = document.visibilityState !== 'hidden' && (this.tileWidths.get(key) ?? 1) > 0;
    const layer = receiveLayer(onScreen);
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
    if (!key) return;
    this.remoteTracks.update((tracks) => new Map(tracks).set(key, event.track));
  }

  private setLocalTrack(source: TrackSource, track: MediaStreamTrack | undefined): void {
    this.localTracks.update((tracks) => ({ ...tracks, [source]: track }));
  }

  private requirePc(): RTCPeerConnection {
    if (!this.pc) throw new Error('Not connected.');
    return this.pc;
  }

  private cameraConstraints(extra: MediaTrackConstraints = {}): MediaTrackConstraints {
    return { ...captureConstraints(this.videoQuality()), ...extra };
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

    if (this.statsTicks++ % DIAGNOSTICS_EVERY_TICKS === 0) {
      // One peer connection carries both directions.
      const path = selectedIcePath(report);
      this.diagnostics.update((d) => ({ ...d, publisher: path, subscriber: path }));
    }
  }
}

const STATS_INTERVAL_MS = 250;
const DIAGNOSTICS_EVERY_TICKS = 8;
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

function remoteParticipant(p: ParticipantDto, speaking: ReadonlySet<string>): CallParticipant {
  const track = (source: TrackSource) => p.tracks.find((t) => t.source === source);
  const mic = track('microphone');
  const camera = track('camera');
  const screen = track('screen');
  return {
    identity: p.id,
    name: p.displayName,
    isLocal: false,
    isSpeaking: speaking.has(p.id),
    micMuted: !mic || mic.muted,
    cameraOn: !!camera && !camera.muted,
    sharingScreen: !!screen && !screen.muted,
  };
}

function remoteTiles(
  p: ParticipantDto,
  remote: ReadonlyMap<TrackKey, MediaStreamTrack>,
  speaking: ReadonlySet<string>,
): Tile[] {
  const track = (source: TrackSource) => p.tracks.find((t) => t.source === source);
  const camera = track('camera');
  const mic = track('microphone');
  const screen = track('screen');
  const tiles: Tile[] = [
    {
      key: `${p.id}:camera`,
      name: p.displayName,
      displayName: p.displayName,
      isLocal: false,
      isScreen: false,
      isSpeaking: speaking.has(p.id),
      video: camera && !camera.muted ? remote.get(trackKey(p.id, 'camera')) : undefined,
      audio: remote.get(trackKey(p.id, 'microphone')),
      micMuted: !mic || mic.muted,
      mirror: false,
    },
  ];
  const screenTrack = screen && !screen.muted ? remote.get(trackKey(p.id, 'screen')) : undefined;
  if (screenTrack) tiles.push(screenTile(p.id, p.displayName, p.displayName, false, screenTrack));
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
    name,
    displayName,
    isLocal,
    isScreen: true,
    isSpeaking: false,
    video,
    micMuted: true,
    mirror: false,
  };
}

function captureHeight(track: MediaStreamTrack): number {
  return track.getSettings?.().height ?? 720;
}

/** Re-targets the camera's simulcast bitrates after a resolution change (no renegotiation needed). */
async function updateBitrates(sender: RTCRtpSender, height: number): Promise<void> {
  if (typeof sender.getParameters !== 'function') return;
  const parameters = sender.getParameters();
  const targets = new Map(cameraEncodings(height).map((e) => [e.rid, e.maxBitrate]));
  parameters.encodings?.forEach((e) => (e.maxBitrate = targets.get(e.rid) ?? e.maxBitrate));
  await sender.setParameters(parameters);
}

/** VP8 first: simulcast support everywhere, and simple to frame-encrypt later (E2EE). */
function preferVp8(transceiver: RTCRtpTransceiver): void {
  const codecs =
    typeof RTCRtpReceiver !== 'undefined'
      ? RTCRtpReceiver.getCapabilities?.('video')?.codecs
      : undefined;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const isVp8 = (c: { mimeType: string }) => /vp8/i.test(c.mimeType);
  transceiver.setCodecPreferences([...codecs.filter(isVp8), ...codecs.filter((c) => !isVp8(c))]);
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
