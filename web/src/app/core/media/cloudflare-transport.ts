import { MediaKind } from '../crypto/frame-codec';
import { FrameCrypto } from '../crypto/frame-transforms';
import { SignalingService } from '../signaling/signaling.service';
import {
  CloudflareRtcConfig,
  ParticipantDto,
  TrackRefDto,
  TrackSource,
  VideoLayer,
} from '../signaling/signaling.types';
import {
  CodecCapability,
  VideoCodec,
  codecPreferences,
  simulcastScalabilityMode,
} from './codecs';
import { NegotiationStep } from './connection-health';
import { StatsLike } from './ice-path';
import { MediaTransport, Publication, TransportEvents } from './media-transport';
import { MediaState } from './media.types';
import { cameraEncodings } from './quality';
import { sdpCodecs } from './sdp-codecs';
import { SerialQueue } from './serial-queue';
import { TrackKey, participantOf, subscriptionDiff, trackKey } from './subscriptions';

/**
 * The call's single RTCPeerConnection to Cloudflare Realtime SFU, negotiated through SignalingService (the api
 * proxies every SFU call).
 *
 * - Every SFU/peer-connection mutation runs through one queue: negotiations must never overlap.
 * - Negotiation order (MediaService): our own tracks are published before we receive anyone else's — iOS Safari
 *   can't add a camera once the connection began by answering the SFU's offer.
 * - Subscriptions follow the room (`follow`): newly published tracks are pulled, gone ones dropped; tracks the SFU
 *   couldn't add yet are retried with backoff.
 * - Recovery: ICE restart on connection loss; after two failed attempts the state becomes 'disconnected' and the
 *   room rejoins. A failed answer to an SFU offer does the same at once: Cloudflare keeps waiting for an answer and
 *   refuses every later negotiation on that session, so only a new session helps (`answerOffer`).
 * - E2EE: every sender gets the frame transform right after `addTransceiver`, every receiver in `ontrack` (and is
 *   retagged after each subscribe) — before any frame flows.
 */
export class CloudflareTransport implements MediaTransport {
  readonly forceRelay: boolean;

  private readonly pc: RTCPeerConnection;
  private readonly queue = new SerialQueue();
  private closed = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private restartAttempts = 0;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private pullFailures = 0;
  /** Our transceivers by source, kept for the whole call. */
  private readonly senders = new Map<TrackSource, RTCRtpTransceiver>();
  /** Remote tracks we receive or have requested → receiving mid (undefined while the request is in flight). */
  private readonly subscriptions = new Map<TrackKey, string | undefined>();
  private readonly midToKey = new Map<string, TrackKey>();
  /** The layer last requested for each remote camera (subscriptions start at the full layer). */
  private readonly layers = new Map<TrackKey, VideoLayer>();
  /** Data channel transport (files): set up on first use, once per connection. */
  private dataTransport?: Promise<void>;
  /** An answer to an SFU offer failed: the session refuses further negotiations until we rejoin. */
  private stuck = false;

  constructor(
    config: CloudflareRtcConfig,
    private readonly frames: FrameCrypto,
    private readonly signaling: SignalingService,
    private readonly events: TransportEvents,
    /** The room's tracks to receive right now (for retries). */
    private readonly wanted: () => readonly ParticipantDto[],
  ) {
    this.forceRelay = config.forceRelay;
    const pc = new RTCPeerConnection({
      // Empty list (local dev): the SFU's own candidates are enough without TURN.
      ...(config.iceServers.length ? { iceServers: config.iceServers } : {}),
      iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      ...frames.peerConnectionConfig,
    });
    this.pc = pc;
    pc.ontrack = (event) => this.onRemoteTrack(event);
    pc.onconnectionstatechange = () => this.onConnectionStateChange();
    events.state(mediaState(pc.connectionState));
  }

  /** Publishes tracks in one negotiation: one offer, one PublishTracks, one answer. All or nothing. */
  publish(items: readonly Publication[], codec: VideoCodec): Promise<void> {
    return this.queue.run(async () => {
      const pc = this.requireOpen();
      const capabilities = sendCapabilities();
      const transceivers = items.map(({ source, track }) => {
        const transceiver = addSendTransceiver(pc, track, source, codec);
        const kind = track.kind as MediaKind;
        // Before the first frame leaves: frames are only ever sent encrypted.
        this.frames.attachSender(transceiver.sender, kind, kind === 'video' ? codec : undefined);
        if (kind === 'video') preferCodec(transceiver, capabilities, codec);
        return transceiver;
      });
      try {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await this.signaling.publishTracks(
          pc.localDescription!.sdp,
          items.map(({ source }, i) => ({ mid: transceivers[i].mid!, source })),
        );
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (e) {
        this.recordFailure('publish', undefined, pc.localDescription?.sdp);
        // Leave the connection ready for the next negotiation.
        if (pc.signalingState === 'have-local-offer')
          await pc.setLocalDescription({ type: 'rollback' });
        transceivers.forEach((t) => t.stop());
        throw e;
      }
      items.forEach(({ source }, i) => this.senders.set(source, transceivers[i]));
    });
  }

  hasSender(source: TrackSource): boolean {
    return this.senders.has(source);
  }

  async replaceTrack(source: TrackSource, track: MediaStreamTrack | null): Promise<boolean> {
    const transceiver = this.senders.get(source);
    if (!transceiver) return false;
    await transceiver.sender.replaceTrack(track);
    return true;
  }

  async retargetCamera(height: number, codec: VideoCodec): Promise<void> {
    const transceiver = this.senders.get('camera');
    if (transceiver) await updateBitrates(transceiver.sender, height, codec);
  }

  follow(participants: readonly ParticipantDto[]): void {
    if (this.closed || this.stuck) return;
    const { subscribe, drop } = subscriptionDiff(participants, new Set(this.subscriptions.keys()));

    if (drop.length) {
      const mids = drop.flatMap((key) => this.forget(key));
      this.events.dropped(drop);
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

  subscribedKeys(): Iterable<TrackKey> {
    return this.subscriptions.keys();
  }

  async setLayer(key: TrackKey, layer: VideoLayer): Promise<void> {
    const mid = this.subscriptions.get(key);
    if (!mid) return;
    // Subscriptions start at the full layer (see the SFU adapter).
    if ((this.layers.get(key) ?? 'f') === layer) return;
    this.layers.set(key, layer);
    try {
      await this.queue.run(() => this.signaling.selectVideoLayer(mid, layer));
    } catch {
      this.layers.delete(key); // retried on the next change
    }
  }

  /**
   * Publishes a data channel (one file transfer) under our random `name` and resolves once it's open. Reliable and
   * ordered; binary messages as ArrayBuffers. Needs receiving to have started (MediaService checks): the transport
   * is added by answering an SFU offer, like a subscribe (negotiation order).
   */
  async publishChannel(name: string): Promise<RTCDataChannel> {
    await this.ensureDataTransport();
    const { channelId } = await this.queue.runFirst(() => this.signaling.publishDataChannel(name));
    return opened(this.negotiatedChannel(name, channelId));
  }

  /** Receives `participantId`'s data channel `name`; resolves once it's open. */
  async subscribeChannel(participantId: string, name: string): Promise<RTCDataChannel> {
    await this.ensureDataTransport();
    const { channelId } = await this.queue.runFirst(() =>
      this.signaling.subscribeDataChannel(participantId, name),
    );
    return opened(this.negotiatedChannel(name, channelId));
  }

  async closeChannel(name: string, participantId?: string): Promise<void> {
    if (!this.closed) await this.queue.runFirst(() => this.signaling.closeDataChannel(name, participantId));
  }

  stats(): Promise<StatsLike | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    return this.pc.getStats().catch(() => undefined);
  }

  senderSources(): ReadonlyMap<string, TrackSource> {
    const sources = new Map<string, TrackSource>();
    this.senders.forEach((transceiver, source) => {
      if (transceiver.mid) sources.set(transceiver.mid, source);
    });
    return sources;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    this.pc.close();
    this.senders.clear();
    this.subscriptions.clear();
    this.midToKey.clear();
    this.layers.clear();
    this.dataTransport = undefined;
  }

  private async pull(tracks: TrackRefDto[]): Promise<void> {
    const pc = this.requireOpen();
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
      await this.answerOffer(pc, result.offerSdp, 'subscribe-answer');
      this.tagReceivers(pc);
    }
    if (stale.length) await this.signaling.unsubscribeTracks(stale);

    // The SFU leaves out tracks it couldn't add yet (no media flowing yet, publisher just left): try again later.
    const missing = tracks.filter((t) => !received.has(trackKey(t.participantId, t.source)));
    if (missing.length) this.retryLater(missing);
    else this.pullFailures = 0;

    // Tiles may have reported their size before the track arrived.
    this.events.subscribed(result.tracks.map((t) => trackKey(t.participantId, t.source)));
  }

  /**
   * Forgets tracks we couldn't receive and re-syncs with the room after a growing delay (1 s, 2 s, 4 s … 15 s).
   * Tracks whose publisher is gone by then simply aren't requested again.
   */
  private retryLater(tracks: TrackRefDto[]): void {
    tracks.forEach((t) => this.subscriptions.delete(trackKey(t.participantId, t.source)));
    if (this.resyncTimer || this.stuck || this.closed) return;
    const delay = Math.min(PULL_RETRY_BASE_MS * 2 ** this.pullFailures++, PULL_RETRY_MAX_MS);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined;
      this.follow(this.wanted());
    }, delay);
  }

  private onConnectionStateChange(): void {
    clearTimeout(this.recoveryTimer);
    switch (this.pc.connectionState) {
      case 'connected':
        this.restartAttempts = 0;
        this.events.state('connected');
        break;
      case 'disconnected':
        // Often recovers by itself (brief network blip); restart ICE if it doesn't.
        this.events.state('reconnecting');
        this.recoveryTimer = setTimeout(() => void this.restartIce(), ICE_GRACE_MS);
        break;
      case 'failed':
        this.events.state('reconnecting');
        void this.restartIce();
        break;
      default:
        this.events.state(mediaState(this.pc.connectionState));
    }
  }

  /**
   * Client-initiated ICE restart (new network path, same SFU session — Cloudflare keeps it for 30 s). Gives up after
   * MAX_ICE_RESTARTS: the state becomes 'disconnected' and the room rejoins from scratch.
   */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (this.closed || pc.connectionState === 'connected') return;
    if (this.restartAttempts++ >= MAX_ICE_RESTARTS) {
      this.events.state('disconnected');
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
      this.recordFailure('ice-restart', undefined, pc.localDescription?.sdp);
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
      }
      if (!this.closed) this.events.state('disconnected');
    }
  }

  /** Drops a remote track locally; returns its mid if it had one. */
  private forget(key: TrackKey): string[] {
    const mid = this.subscriptions.get(key);
    this.subscriptions.delete(key);
    this.layers.delete(key);
    if (mid) this.midToKey.delete(mid);
    return mid ? [mid] : [];
  }

  private onRemoteTrack(event: RTCTrackEvent): void {
    const key = event.transceiver.mid ? this.midToKey.get(event.transceiver.mid) : undefined;
    // Before the first frame is decoded; untagged receivers drop frames until they're assigned.
    this.frames.attachReceiver(event.receiver, event.track.kind as MediaKind, key && participantOf(key));
    if (key) this.events.remoteTrack(key, event.track);
  }

  /**
   * Tags every receiving transceiver with the participant whose track it now carries: the SFU may reuse a receiver
   * for another participant's track without a new `ontrack`.
   */
  private tagReceivers(pc: RTCPeerConnection): void {
    for (const t of pc.getTransceivers()) {
      const key = t.mid ? this.midToKey.get(t.mid) : undefined;
      if (key)
        this.frames.attachReceiver(t.receiver, t.receiver.track.kind as MediaKind, participantOf(key));
    }
  }

  private ensureDataTransport(): Promise<void> {
    let established = false;
    // runFirst: someone is waiting on this file; video subscriptions queued behind it (or retrying) can wait.
    this.dataTransport ??= this.queue
      .runFirst(async () => {
        const pc = this.requireOpen();
        const transport = await this.signaling.openDataTransport();
        // From here on the SFU has set up the transport and won't again on this session: if anything below fails,
        // only a new session helps — answerOffer makes the room rejoin.
        established = true;
        await this.answerOffer(pc, transport.offerSdp, 'data-transport');
        // The SFU opens its own `server-events` channel in-band (stream transport.serverEventsChannelId): the browser
        // creates it by itself, and we ignore it. Creating it here too would collide (OperationError). Our file
        // channels are negotiated on the existing application section and need no further SDP.
      })
      .catch((error: unknown) => {
        if (!established) this.dataTransport = undefined; // e.g. the hub call failed: asking again is fine
        throw error;
      });
    return this.dataTransport;
  }

  private negotiatedChannel(name: string, id: number): RTCDataChannel {
    const channel = this.requireOpen().createDataChannel(name, { negotiated: true, id, ordered: true });
    channel.binaryType = 'arraybuffer';
    return channel;
  }

  private requireOpen(): RTCPeerConnection {
    if (this.closed) throw new Error('Not connected.');
    return this.pc;
  }

  /**
   * Answers an SFU offer. If any step fails, Cloudflare keeps waiting for an answer and refuses every later
   * negotiation on this session: the failure is recorded, subscriptions stop retrying, and the state becomes
   * 'disconnected' so the room rejoins with a new session.
   */
  private async answerOffer(pc: RTCPeerConnection, offerSdp: string, step: NegotiationStep): Promise<void> {
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signaling.renegotiate(answer.sdp!);
    } catch (e) {
      const answer = pc.localDescription?.type === 'answer' ? pc.localDescription.sdp : undefined;
      this.recordFailure(step, offerSdp, answer);
      if (!this.closed) {
        this.stuck = true;
        clearTimeout(this.resyncTimer);
        this.resyncTimer = undefined;
        this.events.state('disconnected');
      }
      throw e;
    }
  }

  /** Codec summaries only (sdp-codecs.ts): never the SDP itself. */
  private recordFailure(step: NegotiationStep, offered: string | undefined, sent: string | undefined): void {
    this.events.negotiationFailure({
      step,
      at: Date.now(),
      offered: sdpCodecs(offered),
      answered: sdpCodecs(sent),
    });
  }
}

const ICE_GRACE_MS = 2000;
const ICE_RESTART_TIMEOUT_MS = 10_000;
const MAX_ICE_RESTARTS = 2;
const PULL_RETRY_BASE_MS = 1000;
const PULL_RETRY_MAX_MS = 15_000;
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;

/** Resolves with the channel once it's open; rejects if it closes or doesn't open in time. */
function opened(channel: RTCDataChannel): Promise<RTCDataChannel> {
  if (channel.readyState === 'open') return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Data channel did not open.')), CHANNEL_OPEN_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
    };
    const fail = (error: Error) => {
      done();
      channel.close();
      reject(error);
    };
    const onOpen = () => {
      done();
      resolve(channel);
    };
    const onClose = () => fail(new Error('Data channel closed.'));
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
  });
}

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

/** Re-targets the camera's simulcast bitrates after a resolution change (no renegotiation needed). */
async function updateBitrates(sender: RTCRtpSender, height: number, codec: VideoCodec): Promise<void> {
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
  const height = track.getSettings?.().height ?? 720;
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
 * Every video transceiver (camera and screen) sends the call's codec, listed first: frame encryption knows its
 * layout, and we never switch codecs on a published track. Our other codecs follow so the SFU will offer them when
 * we subscribe to someone sending a different one (see codecs.ts).
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
