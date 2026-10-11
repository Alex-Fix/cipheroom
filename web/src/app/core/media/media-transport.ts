import { NegotiationFailure } from './connection-health';
import { StatsLike } from './ice-path';
import { ParticipantDto, TrackSource, VideoLayer } from '../signaling/signaling.types';
import { VideoCodec } from './codecs';
import { MediaState } from './media.types';
import { TrackKey } from './subscriptions';

/** A track to publish; `placeholder`: placeholder frames, not a capture (kept in `placeholders`, not shown). */
export interface Publication {
  source: TrackSource;
  track: MediaStreamTrack;
  placeholder?: boolean;
}

/**
 * One file transfer's channel: the part of RTCDataChannel FileTransferService uses. Cloudflare: a real data channel
 * on the SFU; LiveKit: reliable data messages under the channel's name. Carries only file-crypto-sealed frames.
 */
export interface FileChannel {
  readonly readyState: RTCDataChannelState;
  /** Always 'arraybuffer': messages arrive as ArrayBuffers. */
  readonly binaryType: BinaryType;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  close(): void;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  onclose: ((event: Event) => void) | null;
  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void;
  removeEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void;
}

/** What a transport tells MediaService. Called synchronously, in the order things happen. */
export interface TransportEvents {
  /** The connection to the media server changed state. */
  state(state: MediaState): void;
  /** A remote track arrived (or its receiver now carries another track). */
  remoteTrack(key: TrackKey, track: MediaStreamTrack): void;
  /** We now receive these tracks: their layers can be chosen. */
  subscribed(keys: readonly TrackKey[]): void;
  /** We no longer receive these tracks. */
  dropped(keys: readonly TrackKey[]): void;
  /** A negotiation failed (codec summaries only, never SDP). */
  negotiationFailure(failure: NegotiationFailure): void;
}

/**
 * The media server behind a call — Cloudflare Realtime SFU today, LiveKit in LiveKit mode
 * (docs/plans/2026-10-11-livekit-media-mode-design.md). MediaService stays provider-neutral (devices, quality,
 * tiles, diagnostics, encryption wiring); a transport owns the connection, negotiation, subscriptions and recovery.
 * Every sender and receiver gets CryptoService's frame transform before its first frame.
 */
export interface MediaTransport {
  /** TURN only (testing), for the Connection drawer. */
  readonly forceRelay: boolean;

  /** Publishes tracks together (one negotiation where the provider has them); all or nothing. */
  publish(items: readonly Publication[], codec: VideoCodec): Promise<void>;
  /** Whether a source has been published on this connection. */
  hasSender(source: TrackSource): boolean;
  /** Swaps what a published source sends (null: nothing). False if the source isn't published. */
  replaceTrack(source: TrackSource, track: MediaStreamTrack | null): Promise<boolean>;
  /** Re-targets the camera's layer bitrates after a resolution change. */
  retargetCamera(height: number, codec: VideoCodec): Promise<void>;

  /** The room's tracks we should receive now (already filtered, e.g. audio only). */
  follow(participants: readonly ParticipantDto[]): void;
  /** Remote tracks we receive or have asked for. */
  subscribedKeys(): Iterable<TrackKey>;
  /** Receives `layer` of a remote camera (no-op until it's subscribed, or when unchanged). */
  setLayer(key: TrackKey, layer: VideoLayer): Promise<void>;

  /** File transfer channels (FileTransferService through MediaService); `recipients`: who asked for it. */
  publishChannel(name: string, recipients: readonly string[]): Promise<FileChannel>;
  subscribeChannel(participantId: string, name: string): Promise<FileChannel>;
  closeChannel(name: string, participantId?: string): Promise<void>;

  /** The connection's stats (getStats), or undefined once closed / unavailable. */
  stats(): Promise<StatsLike | undefined>;
  /** Our published sources by transceiver mid (for the Connection drawer). */
  senderSources(): ReadonlyMap<string, TrackSource>;

  /** Ends the connection; the transport can't be used afterwards. */
  close(): void;
}
