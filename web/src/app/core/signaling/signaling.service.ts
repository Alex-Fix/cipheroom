import { Injectable, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { withTrackMuted, withTracksPublished, withTracksUnpublished } from './participants';
import {
  AnswerDto,
  ClientEvents,
  HubMethods,
  IdentityDto,
  JoinResult,
  KeyEnvelopeDto,
  ParticipantDto,
  PublishTrackDto,
  RtcConfig,
  SubscribeResult,
  TrackDto,
  TrackRefDto,
  TrackSource,
  VideoLayer,
} from './signaling.types';

/** A key envelope for us; `fromId` is who the server says sent it (verified against the envelope's signature). */
export type KeyEnvelopeListener = (fromId: string, blob: string) => void;

/**
 * All signaling over SignalR: rooms, media negotiation with the SFU (the api relays SDP to Cloudflare) and E2EE key
 * envelopes (opaque to the api). The api never sees media or keys. `participants` mirrors the room, including who
 * publishes which tracks and everyone's public identity.
 */
@Injectable({ providedIn: 'root' })
export class SignalingService {
  private connection?: HubConnection;

  readonly connected = signal(false);
  readonly participants = signal<ParticipantDto[]>([]);
  private readonly keyEnvelopeListeners = new Set<KeyEnvelopeListener>();

  /** `identity`: our public keys for this call (from CryptoService); required — there are no unencrypted joins. */
  async joinRoom(roomId: string, displayName: string, identity: IdentityDto): Promise<JoinResult> {
    const connection = await this.ensureConnected();
    const result = await connection.invoke<JoinResult>(
      HubMethods.JoinRoom,
      roomId,
      displayName,
      identity,
    );
    this.participants.set(result.participants);
    return result;
  }

  async getRtcConfig(): Promise<RtcConfig> {
    return (await this.ensureConnected()).invoke<RtcConfig>(HubMethods.GetRtcConfig);
  }

  /** Publishes local tracks from our SDP offer; returns the SFU's answer. */
  async publishTracks(offerSdp: string, tracks: PublishTrackDto[]): Promise<string> {
    const result = await this.invoke<AnswerDto>(HubMethods.PublishTracks, offerSdp, tracks);
    return result.answerSdp;
  }

  async subscribeTracks(tracks: TrackRefDto[]): Promise<SubscribeResult> {
    return this.invoke<SubscribeResult>(HubMethods.SubscribeTracks, tracks);
  }

  /** Our answer to an SFU offer from subscribeTracks. */
  async renegotiate(answerSdp: string): Promise<void> {
    await this.invoke(HubMethods.Renegotiate, answerSdp);
  }

  /** ICE restart: our offer in, the SFU's answer out. */
  async restartIce(offerSdp: string): Promise<string> {
    const result = await this.invoke<AnswerDto>(HubMethods.RestartIce, offerSdp);
    return result.answerSdp;
  }

  async unpublishTracks(sources: TrackSource[]): Promise<void> {
    await this.invoke(HubMethods.UnpublishTracks, sources);
  }

  async unsubscribeTracks(mids: string[]): Promise<void> {
    await this.invoke(HubMethods.UnsubscribeTracks, mids);
  }

  async setTrackMuted(source: TrackSource, muted: boolean): Promise<void> {
    await this.invoke(HubMethods.SetTrackMuted, source, muted);
  }

  async selectVideoLayer(mid: string, layer: VideoLayer): Promise<void> {
    await this.invoke(HubMethods.SelectVideoLayer, mid, layer);
  }

  /** Sends sender-key envelopes, each relayed to its recipient only. One rotation = one call. */
  async sendKeyEnvelopes(envelopes: KeyEnvelopeDto[]): Promise<void> {
    await this.invoke(HubMethods.SendKeyEnvelopes, envelopes);
  }

  /** Envelopes addressed to us. Returns a function that removes the listener. */
  onKeyEnvelope(listener: KeyEnvelopeListener): () => void {
    this.keyEnvelopeListeners.add(listener);
    return () => this.keyEnvelopeListeners.delete(listener);
  }

  async leave(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.participants.set([]);
    // Stopping the connection also leaves the room server-side (OnDisconnectedAsync).
    await connection?.stop();
  }

  private async invoke<T = void>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.ensureConnected()).invoke<T>(method, ...args);
  }

  private async ensureConnected(): Promise<HubConnection> {
    if (this.connection?.state === HubConnectionState.Connected) return this.connection;

    const connection = new HubConnectionBuilder()
      .withUrl('/hubs/room')
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on(ClientEvents.ParticipantJoined, (p: ParticipantDto) =>
      this.participants.update((list) => [...list, p]),
    );
    connection.on(ClientEvents.ParticipantLeft, (id: string) =>
      this.participants.update((list) => list.filter((p) => p.id !== id)),
    );
    connection.on(ClientEvents.TracksPublished, (id: string, tracks: TrackDto[]) =>
      this.participants.update((list) => withTracksPublished(list, id, tracks)),
    );
    connection.on(ClientEvents.TracksUnpublished, (id: string, sources: TrackSource[]) =>
      this.participants.update((list) => withTracksUnpublished(list, id, sources)),
    );
    connection.on(ClientEvents.TrackMuted, (id: string, source: TrackSource, muted: boolean) =>
      this.participants.update((list) => withTrackMuted(list, id, source, muted)),
    );
    connection.on(ClientEvents.KeyEnvelopeReceived, (fromId: string, blob: string) =>
      this.keyEnvelopeListeners.forEach((listener) => listener(fromId, blob)),
    );
    connection.onclose(() => this.connected.set(false));

    await connection.start();
    this.connection = connection;
    this.connected.set(true);
    return connection;
  }
}
