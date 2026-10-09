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
  AuthorityDto,
  CallStatsDto,
  ClientEvents,
  HostProofDto,
  HubMethods,
  IdentityDto,
  KeyEnvelopeDto,
  KnockDto,
  LobbyGuestDto,
  LobbyResult,
  ParticipantDto,
  PublishTrackDto,
  RtcConfig,
  SubscribeResult,
  TicketDto,
  TrackDto,
  TrackRefDto,
  TrackSource,
  UsageDto,
  VideoLayer,
} from './signaling.types';

/** A key envelope for us; `fromId` is who the server says sent it (verified against the envelope's signature). */
export type KeyEnvelopeListener = (fromId: string, blob: string) => void;

/**
 * Lobby and host-control events (server → us). Signed ones (`muteRequested`, `callEnded`) must be verified by
 * CryptoService before anyone acts on them.
 */
export type LobbyEvent =
  | { type: 'knock'; guest: LobbyGuestDto; blob: string }
  | { type: 'lobbyLeft'; guestId: string }
  | { type: 'admitted'; result: LobbyResult }
  | { type: 'denied' }
  | { type: 'removed' }
  | { type: 'muteRequested'; fromId: string; seq: number; sig: string }
  | { type: 'callEnded'; issuer: string; sig: string };

export type LobbyEventListener = (event: LobbyEvent) => void;

/**
 * All signaling over SignalR: the lobby and host controls, rooms, media negotiation with the SFU (the api relays SDP
 * to Cloudflare) and E2EE key envelopes and knocks (opaque to the api). The api never sees media, keys or names.
 * `participants` mirrors the room (who publishes which tracks, everyone's public identity and ticket); `authority`
 * is the room's signed chain of authority as the server relays it (CryptoService verifies it).
 */
@Injectable({ providedIn: 'root' })
export class SignalingService {
  private connection?: HubConnection;

  readonly connected = signal(false);
  readonly participants = signal<ParticipantDto[]>([]);
  readonly authority = signal<AuthorityDto | undefined>(undefined);
  /** The usage guard's latest verdict (kept across calls: it's server-wide). */
  readonly usage = signal<UsageDto | undefined>(undefined);
  private readonly keyEnvelopeListeners = new Set<KeyEnvelopeListener>();
  private readonly lobbyListeners = new Set<LobbyEventListener>();

  /**
   * Enters a room: straight in with a host proof or a ticket from earlier in this call, otherwise into the lobby
   * (`admitted: false`) until an admitter lets us in (`admitted` event). `identity`: our public keys for this call —
   * required, there are no unencrypted joins. `videoCodecs`: what this browser can decode.
   */
  async joinLobby(
    roomId: string,
    identity: IdentityDto,
    videoCodecs: readonly string[],
    hostProof: HostProofDto | null,
    ticket: TicketDto | null,
  ): Promise<LobbyResult> {
    const connection = await this.ensureConnected();
    const result = await connection.invoke<LobbyResult>(
      HubMethods.JoinLobby,
      roomId,
      identity,
      videoCodecs,
      hostProof,
      ticket,
    );
    this.authority.set(result.authority);
    this.participants.set(result.participants);
    return result;
  }

  /** From the lobby: our name, encrypted to each admitter. */
  async knock(knocks: KnockDto[]): Promise<void> {
    await this.invoke(HubMethods.Knock, knocks);
  }

  async admit(guestId: string, ticket: string): Promise<void> {
    await this.invoke(HubMethods.Admit, guestId, ticket);
  }

  async deny(guestId: string): Promise<void> {
    await this.invoke(HubMethods.Deny, guestId);
  }

  async grantCoHost(participantId: string, grant: string): Promise<void> {
    await this.invoke(HubMethods.GrantCoHost, participantId, grant);
  }

  async removeParticipant(participantId: string, revocation: string): Promise<void> {
    await this.invoke(HubMethods.RemoveParticipant, participantId, revocation);
  }

  async updateSettings(seq: number, autoAdmit: boolean, sig: string): Promise<void> {
    await this.invoke(HubMethods.UpdateSettings, seq, autoAdmit, sig);
  }

  async askToMute(participantId: string, seq: number, sig: string): Promise<void> {
    await this.invoke(HubMethods.AskToMute, participantId, seq, sig);
  }

  async endCall(sig: string): Promise<void> {
    await this.invoke(HubMethods.EndCall, sig);
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

  /** Call-quality summary for telemetry (numbers only); recorded server-side as metrics. */
  async reportCallStats(stats: CallStatsDto): Promise<void> {
    await this.invoke(HubMethods.ReportCallStats, stats);
  }

  /** Envelopes addressed to us. Returns a function that removes the listener. */
  onKeyEnvelope(listener: KeyEnvelopeListener): () => void {
    this.keyEnvelopeListeners.add(listener);
    return () => this.keyEnvelopeListeners.delete(listener);
  }

  /** Lobby and host-control events. Returns a function that removes the listener. */
  onLobbyEvent(listener: LobbyEventListener): () => void {
    this.lobbyListeners.add(listener);
    return () => this.lobbyListeners.delete(listener);
  }

  async leave(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.participants.set([]);
    this.authority.set(undefined);
    // Stopping the connection also leaves the room server-side (OnDisconnectedAsync).
    await connection?.stop();
  }

  private async invoke<T = void>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.ensureConnected()).invoke<T>(method, ...args);
  }

  private emit(event: LobbyEvent): void {
    this.lobbyListeners.forEach((listener) => listener(event));
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
    connection.on(ClientEvents.AuthorityUpdated, (authority: AuthorityDto) =>
      this.authority.set(authority),
    );
    connection.on(ClientEvents.KnockReceived, (guest: LobbyGuestDto, blob: string) =>
      this.emit({ type: 'knock', guest, blob }),
    );
    connection.on(ClientEvents.LobbyLeft, (guestId: string) =>
      this.emit({ type: 'lobbyLeft', guestId }),
    );
    connection.on(ClientEvents.Admitted, (result: LobbyResult) => {
      this.authority.set(result.authority);
      this.participants.set(result.participants);
      this.emit({ type: 'admitted', result });
    });
    connection.on(ClientEvents.Denied, () => this.emit({ type: 'denied' }));
    connection.on(ClientEvents.Removed, () => this.emit({ type: 'removed' }));
    connection.on(ClientEvents.MuteRequested, (fromId: string, seq: number, sig: string) =>
      this.emit({ type: 'muteRequested', fromId, seq, sig }),
    );
    connection.on(ClientEvents.CallEnded, (issuer: string, sig: string) =>
      this.emit({ type: 'callEnded', issuer, sig }),
    );
    connection.on(ClientEvents.UsageChanged, (usage: UsageDto) => this.usage.set(usage));
    connection.onclose(() => this.connected.set(false));

    await connection.start();
    this.connection = connection;
    this.connected.set(true);
    return connection;
  }
}
