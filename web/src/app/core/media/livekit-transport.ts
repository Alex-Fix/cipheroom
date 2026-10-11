// Types only: the library itself is loaded when a LiveKit call starts, so Cloudflare deployments never download it.
import type {
  ConnectionState,
  LocalTrack,
  LocalTrackPublication,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  Track,
  VideoQuality,
} from 'livekit-client';
import { MediaKind } from '../crypto/frame-codec';
import { FrameCrypto } from '../crypto/frame-transforms';
import { SignalingService } from '../signaling/signaling.service';
import { LiveKitRtcConfig, ParticipantDto, TrackSource, VideoLayer } from '../signaling/signaling.types';
import { VideoCodec } from './codecs';
import { StatsLike } from './ice-path';
import { FileChannel, MediaTransport, Publication, TransportEvents } from './media-transport';
import { MediaState } from './media.types';
import { RELAY_TOKEN, RELAY_URL, WebSocketHost, installRelayWebSocket } from './relay-websocket';
import { TrackKey, trackKey } from './subscriptions';

/**
 * The call on a self-hosted LiveKit server (docs/plans/2026-10-11-livekit-media-mode-design.md), through
 * livekit-client. Its signaling runs over our SignalR connection (relay-websocket.ts); media goes straight to LiveKit.
 *
 * - E2EE: our transform goes on every sender in livekit-client's `LocalSenderCreated` (after the sender exists,
 *   before negotiation) and on every receiver in `TrackSubscribed`. Chromium uses encoded streams with the flag set on
 *   every peer connection livekit-client makes; WebKit uses script transforms (spike: zero unencrypted frames).
 *   LiveKit's own E2EE is not used.
 * - Subscriptions follow the room as MediaService sees it (`follow`), so audio-only and gone tracks behave as on
 *   Cloudflare; tile sizes pick LiveKit's video quality (VP8 simulcast, VP9 SVC — same API).
 * - What we publish is announced to the room (AnnounceTracks) so tiles and mute state read it like any track.
 * - Files: reliable data messages under the channel's name, to the recipients only.
 * - Recovery is livekit-client's (resume, then full reconnect); if it gives up, the state becomes 'disconnected' and
 *   the room rejoins.
 */
export class LiveKitTransport implements MediaTransport {
  readonly forceRelay = false;

  private room?: Room;
  private lib?: typeof import('livekit-client');
  private readonly ready: Promise<void>;
  private readonly restore: (() => void)[] = [];
  private closed = false;
  /** Remote tracks the room says we should receive. */
  private wanted = new Set<TrackKey>();
  private readonly published = new Map<TrackSource, LocalTrackPublication>();
  /** The video layer asked for per remote camera (subscriptions start at the full layer). */
  private readonly layers = new Map<TrackKey, VideoLayer>();
  private readonly incoming = new Map<string, LiveKitFileChannel>();
  private sendingCodec?: VideoCodec;

  constructor(
    _config: LiveKitRtcConfig,
    private readonly frames: FrameCrypto,
    private readonly signaling: SignalingService,
    private readonly events: TransportEvents,
    host: PeerConnectionHost & WebSocketHost = globalThis as unknown as PeerConnectionHost & WebSocketHost,
  ) {
    frames.preferEncodedStreams();
    if (frames.transformApi === 'encoded-streams') this.restore.push(requireEncodedStreams(host));
    this.restore.push(installRelayWebSocket(signaling, host));
    events.state('connecting');
    this.ready = this.start().then(
      () => {
        if (!this.closed) events.state('connected');
      },
      (error: unknown) => {
        if (!this.closed) events.state('disconnected');
        throw error;
      },
    );
    this.ready.catch(() => undefined);
  }

  private async start(): Promise<void> {
    this.lib = await loadLiveKit();
    if (this.closed) return;
    const room = new this.lib.Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false });
    this.room = room;
    this.listen(room);
    await room.connect(RELAY_URL, RELAY_TOKEN, { autoSubscribe: false });
  }

  async publish(items: readonly Publication[], codec: VideoCodec): Promise<void> {
    await this.ready;
    const room = this.requireOpen();
    const lib = this.lib!;
    this.sendingCodec = codec;
    const added: LocalTrackPublication[] = [];
    try {
      for (const { source, track } of items) {
        const local: LocalTrack =
          track.kind === 'audio' ? new lib.LocalAudioTrack(track, undefined, true) : new lib.LocalVideoTrack(track, undefined, true);
        const publication = await room.localParticipant.publishTrack(local, {
          source: LIVEKIT_SOURCE[source],
          videoCodec: codec,
          backupCodec: false,
          simulcast: source === 'camera',
        });
        added.push(publication);
        this.published.set(source, publication);
      }
      await this.signaling.announceTracks(items.map((i) => i.source));
    } catch (e) {
      for (const publication of added) {
        if (publication.track) await room.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined);
      }
      items.forEach(({ source }) => this.published.delete(source));
      throw e;
    }
  }

  hasSender(source: TrackSource): boolean {
    return this.published.has(source);
  }

  async replaceTrack(source: TrackSource, track: MediaStreamTrack | null): Promise<boolean> {
    const local = this.published.get(source)?.track;
    if (!local) return false;
    if (track) {
      await local.replaceTrack(track, true);
      if (local.isMuted) await local.unmute();
    } else {
      await local.mute();
    }
    return true;
  }

  /** LiveKit picks the layers' bitrates from the track it's given. */
  async retargetCamera(): Promise<void> {}

  follow(participants: readonly ParticipantDto[]): void {
    this.wanted = new Set(participants.flatMap((p) => p.tracks.map((t) => trackKey(p.id, t.source))));
    this.applySubscriptions();
  }

  *subscribedKeys(): Iterable<TrackKey> {
    for (const [key, publication] of this.remotePublications()) if (publication.isDesired) yield key;
  }

  async setLayer(key: TrackKey, layer: VideoLayer): Promise<void> {
    const publication = this.remotePublications().get(key);
    if (!publication?.isSubscribed) return;
    if ((this.layers.get(key) ?? 'f') === layer) return;
    this.layers.set(key, layer);
    publication.setVideoQuality(LIVEKIT_QUALITY[layer]);
  }

  async publishChannel(name: string, recipients: readonly string[]): Promise<FileChannel> {
    await this.ready;
    const room = this.requireOpen();
    return LiveKitFileChannel.sending((data) =>
      room.localParticipant.publishData(data, { reliable: true, topic: name, destinationIdentities: [...recipients] }),
    );
  }

  async subscribeChannel(participantId: string, name: string): Promise<FileChannel> {
    await this.ready;
    this.requireOpen();
    const key = channelKey(participantId, name);
    const channel = LiveKitFileChannel.receiving(() => this.incoming.delete(key));
    this.incoming.set(key, channel);
    return channel;
  }

  /** Nothing to tell the server: LiveKit data messages need no channel. */
  async closeChannel(name: string, participantId?: string): Promise<void> {
    if (participantId) this.incoming.get(channelKey(participantId, name))?.close();
  }

  async stats(): Promise<StatsLike | undefined> {
    const transports = this.room?.engine?.pcManager;
    if (this.closed || !transports) return undefined;
    const reports = await Promise.all([transports.publisher.getStats(), transports.subscriber?.getStats()].map((p) => p?.catch(() => undefined)));
    const merged = new Map<string, unknown>();
    reports.forEach((report) => report?.forEach((value, id) => merged.set(id, value)));
    return merged;
  }

  senderSources(): ReadonlyMap<string, TrackSource> {
    const sources = new Map<string, TrackSource>();
    const transceivers = this.room?.engine?.pcManager?.publisher.getTransceivers() ?? [];
    this.published.forEach((publication, source) => {
      const mid = transceivers.find((t) => t.sender === publication.track?.sender)?.mid;
      if (mid) sources.set(mid, source);
    });
    return sources;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.incoming.forEach((channel) => channel.close());
    this.incoming.clear();
    this.published.clear();
    const undo = () => this.restore.splice(0).reverse().forEach((u) => u());
    if (this.room) void this.room.disconnect().finally(undo);
    else void this.ready.catch(() => undefined).finally(() => (this.room ? this.room.disconnect().finally(undo) : undo()));
  }

  private listen(room: Room): void {
    // Before negotiation: no frame of ours leaves unencrypted.
    room.localParticipant.on('localSenderCreated', (sender: RTCRtpSender, track: Track) => {
      const kind = track.kind as MediaKind;
      this.frames.attachSender(sender, kind, kind === 'video' ? this.sendingCodec : undefined);
    });
    room
      .on('trackPublished', () => this.applySubscriptions())
      .on('trackSubscribed', (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        const key = keyOf(participant.identity, publication.source);
        if (!key) return;
        if (track.receiver) this.frames.attachReceiver(track.receiver, track.kind as MediaKind, participant.identity);
        this.layers.delete(key);
        this.events.remoteTrack(key, track.mediaStreamTrack);
        this.events.subscribed([key]);
      })
      .on('trackUnsubscribed', (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        const key = keyOf(participant.identity, publication.source);
        if (!key) return;
        this.layers.delete(key);
        this.events.dropped([key]);
      })
      .on('dataReceived', (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (!participant || !topic) return;
        this.incoming.get(channelKey(participant.identity, topic))?.deliver(payload);
      })
      .on('connectionStateChanged', (state: ConnectionState) => {
        if (!this.closed) this.events.state(mediaState(state));
      });
  }

  /** Subscribes to exactly what the room wants us to receive (audio only, gone publishers, …). */
  private applySubscriptions(): void {
    if (this.closed) return;
    for (const [key, publication] of this.remotePublications()) {
      const want = this.wanted.has(key);
      if (publication.isDesired !== want) publication.setSubscribed(want);
    }
  }

  private remotePublications(): Map<TrackKey, RemoteTrackPublication> {
    const publications = new Map<TrackKey, RemoteTrackPublication>();
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.trackPublications.values()) {
        const key = keyOf(participant.identity, publication.source);
        if (key) publications.set(key, publication);
      }
    }
    return publications;
  }

  private requireOpen(): Room {
    if (this.closed || !this.room) throw new Error('Not connected.');
    return this.room;
  }
}

/** livekit-client's Track.Source values. */
const LIVEKIT_SOURCE = {
  microphone: 'microphone',
  camera: 'camera',
  screen: 'screen_share',
} as Record<TrackSource, Track.Source>;

/** livekit-client's VideoQuality values (LOW 0, MEDIUM 1, HIGH 2). */
const LIVEKIT_QUALITY = { f: 2, h: 1, q: 0 } as Record<VideoLayer, VideoQuality>;

/** Loads livekit-client (replaced in tests). */
export let loadLiveKit = (): Promise<typeof import('livekit-client')> => import('livekit-client');

/** Tests only. */
export function setLiveKitLoader(loader: typeof loadLiveKit): void {
  loadLiveKit = loader;
}

function keyOf(identity: string, source: Track.Source): TrackKey | undefined {
  const ours = (Object.keys(LIVEKIT_SOURCE) as TrackSource[]).find((s) => LIVEKIT_SOURCE[s] === source);
  return ours ? trackKey(identity, ours) : undefined;
}

function channelKey(participantId: string, name: string): string {
  return `${participantId}\n${name}`;
}

function mediaState(state: ConnectionState): MediaState {
  switch (state as string) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
    case 'signalReconnecting':
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}

/** Where `RTCPeerConnection` lives (the page; tests pass their own). */
export interface PeerConnectionHost {
  RTCPeerConnection: typeof RTCPeerConnection;
}

/**
 * Encoded streams need `encodedInsertableStreams` on the peer connection from the start, and livekit-client creates
 * (and reconfigures) its own: every one made during the call gets it. Returns the undo.
 */
function requireEncodedStreams(host: PeerConnectionHost): () => void {
  const Native = host.RTCPeerConnection;
  const withFlag = (config?: RTCConfiguration): RTCConfiguration => ({ ...config, encodedInsertableStreams: true }) as RTCConfiguration;
  host.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(withFlag(config));
    }

    override setConfiguration(config?: RTCConfiguration): void {
      super.setConfiguration(withFlag(config));
    }
  } as typeof RTCPeerConnection;
  return () => (host.RTCPeerConnection = Native);
}

/**
 * A file transfer's channel over LiveKit's reliable data messages (FileChannel). Sending: messages go out in order;
 * `bufferedAmount` counts what LiveKit hasn't taken yet, for FileTransferService's backpressure. Receiving: messages
 * from one participant under one name.
 */
export class LiveKitFileChannel extends EventTarget implements FileChannel {
  readyState: RTCDataChannelState = 'open';
  readonly binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  private constructor(
    private readonly publish?: (data: Uint8Array<ArrayBuffer>) => Promise<void>,
    private readonly onClosed?: () => void,
  ) {
    super();
  }

  static sending(publish: (data: Uint8Array<ArrayBuffer>) => Promise<void>): LiveKitFileChannel {
    return new LiveKitFileChannel(publish);
  }

  static receiving(onClosed: () => void): LiveKitFileChannel {
    return new LiveKitFileChannel(undefined, onClosed);
  }

  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (!this.publish || this.readyState !== 'open') throw new DOMException('The channel is not open.', 'InvalidStateError');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.bufferedAmount += bytes.byteLength;
    void this.publish(bytes)
      .catch(() => this.close())
      .finally(() => {
        const before = this.bufferedAmount;
        this.bufferedAmount -= bytes.byteLength;
        if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.dispatchEvent(new Event('bufferedamountlow'));
        }
      });
  }

  deliver(payload: Uint8Array): void {
    if (this.readyState !== 'open') return;
    const data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onClosed?.();
    const event = new Event('close');
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}
