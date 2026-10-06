import { Injectable, OnDestroy, signal } from '@angular/core';
import { ConnectionState, Participant, Room, RoomEvent, Track } from 'livekit-client';
import { RtcConfig } from '../signaling/signaling.types';
import { IcePath, selectedIcePath } from './ice-path';

export interface Tile {
  key: string;
  /** Label for the tile, e.g. "Alex (you)". */
  name: string;
  /** The participant's own name, same on every client (avatar initials and colour). */
  displayName: string;
  isLocal: boolean;
  isScreen: boolean;
  isSpeaking: boolean;
  video?: Track;
  audio?: Track;
  micMuted: boolean;
}

export interface Diagnostics {
  forceRelay: boolean;
  publisher?: IcePath;
  subscriber?: IcePath;
}

/**
 * Owns the LiveKit Room for one call. Provided per room route, so it lives exactly as long as the call.
 * LiveKit callbacks only ever write signals.
 */
@Injectable()
export class LiveKitService implements OnDestroy {
  private room?: Room;
  private statsTimer?: ReturnType<typeof setInterval>;

  readonly state = signal<ConnectionState>(ConnectionState.Disconnected);
  readonly tiles = signal<Tile[]>([]);
  readonly micEnabled = signal(false);
  readonly cameraEnabled = signal(false);
  readonly screenShareEnabled = signal(false);
  readonly canPlaybackAudio = signal(true);
  readonly diagnostics = signal<Diagnostics>({ forceRelay: false });

  async connect(config: RtcConfig): Promise<void> {
    // TODO(e2ee): enable LiveKit E2EE with our per-participant key provider before publishing (see e2ee-media skill).
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room
      .on(RoomEvent.ConnectionStateChanged, (s) => this.state.set(s))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.canPlaybackAudio.set(room.canPlaybackAudio))
      .on(RoomEvent.ParticipantConnected, () => this.refresh())
      .on(RoomEvent.ParticipantDisconnected, () => this.refresh())
      .on(RoomEvent.TrackSubscribed, () => this.refresh())
      .on(RoomEvent.TrackUnsubscribed, () => this.refresh())
      .on(RoomEvent.TrackMuted, () => this.refresh())
      .on(RoomEvent.TrackUnmuted, () => this.refresh())
      .on(RoomEvent.LocalTrackPublished, () => this.refresh())
      .on(RoomEvent.LocalTrackUnpublished, () => this.refresh())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.refresh());

    this.diagnostics.set({ forceRelay: config.forceRelay });
    await room.connect(config.livekitUrl, config.token, {
      rtcConfig: {
        // Empty list → LiveKit's own ICE servers (local dev). Cloudflare TURN in production.
        ...(config.iceServers.length ? { iceServers: config.iceServers } : {}),
        iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
      },
    });

    this.canPlaybackAudio.set(room.canPlaybackAudio);
    this.refresh();
    this.statsTimer = setInterval(() => void this.collectStats(), 2000);
  }

  /** Rejects with the browser's DOMException (e.g. NotAllowedError) when the device can't be used. */
  async setMicrophone(enabled: boolean): Promise<void> {
    try {
      await this.room?.localParticipant.setMicrophoneEnabled(enabled);
    } finally {
      this.refresh();
    }
  }

  async setCamera(enabled: boolean): Promise<void> {
    try {
      await this.room?.localParticipant.setCameraEnabled(enabled);
    } finally {
      this.refresh();
    }
  }

  async setScreenShare(enabled: boolean): Promise<void> {
    try {
      await this.room?.localParticipant.setScreenShareEnabled(enabled);
    } finally {
      this.refresh();
    }
  }

  /** Must be called from a user gesture when the browser blocked autoplay. */
  async startAudio(): Promise<void> {
    await this.room?.startAudio();
  }

  async disconnect(): Promise<void> {
    clearInterval(this.statsTimer);
    const room = this.room;
    this.room = undefined;
    await room?.disconnect();
    this.tiles.set([]);
  }

  ngOnDestroy(): void {
    void this.disconnect();
  }

  private refresh(): void {
    const room = this.room;
    if (!room) return;

    const local = room.localParticipant;
    this.micEnabled.set(local.isMicrophoneEnabled);
    this.cameraEnabled.set(local.isCameraEnabled);
    this.screenShareEnabled.set(local.isScreenShareEnabled);

    const participants: Participant[] = [local, ...room.remoteParticipants.values()];
    this.tiles.set(participants.flatMap((p) => this.tilesFor(p, p === local)));
  }

  private tilesFor(p: Participant, isLocal: boolean): Tile[] {
    const camera = p.getTrackPublication(Track.Source.Camera);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    const screen = p.getTrackPublication(Track.Source.ScreenShare);
    const displayName = p.name || p.identity;
    const name = displayName + (isLocal ? ' (you)' : '');

    const tiles: Tile[] = [
      {
        key: `${p.identity}:camera`,
        name,
        displayName,
        isLocal,
        isScreen: false,
        isSpeaking: p.isSpeaking,
        video: camera && !camera.isMuted ? camera.track : undefined,
        // Never play our own microphone back.
        audio: isLocal ? undefined : mic?.track,
        micMuted: !mic || mic.isMuted,
      },
    ];
    if (screen?.track && !screen.isMuted) {
      tiles.push({
        key: `${p.identity}:screen`,
        name,
        displayName,
        isLocal,
        isScreen: true,
        isSpeaking: false,
        video: screen.track,
        micMuted: true,
      });
    }
    return tiles;
  }

  private async collectStats(): Promise<void> {
    const room = this.room;
    if (!room) return;

    const published = [...room.localParticipant.trackPublications.values()].find((t) => t.track);
    const subscribed = [...room.remoteParticipants.values()]
      .flatMap((p) => [...p.trackPublications.values()])
      .find((t) => t.track);

    const [pub, sub] = await Promise.all([
      published?.track?.getRTCStatsReport(),
      subscribed?.track?.getRTCStatsReport(),
    ]);
    this.diagnostics.update((d) => ({
      ...d,
      publisher: pub ? selectedIcePath(pub) : undefined,
      subscriber: sub ? selectedIcePath(sub) : undefined,
    }));
  }
}
