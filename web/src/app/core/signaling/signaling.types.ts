// Mirrors src/Cipheroom.Api/Hubs (IRoomClient, RoomHub, Contracts). Keep in sync — see docs/signaling-protocol.md.

export type TrackSource = 'microphone' | 'camera' | 'screen';

/** Simulcast layer of a received camera track: full, half or quarter resolution. */
export type VideoLayer = 'f' | 'h' | 'q';

/** A published track as other participants see it. */
export interface TrackDto {
  source: TrackSource;
  kind: 'audio' | 'video';
  muted: boolean;
}

/** A participant's public E2EE keys for this call (base64url), self-signed by their browser. Public keys only. */
export interface IdentityDto {
  ed25519Pub: string;
  x25519Pub: string;
  sig: string;
}

/**
 * Someone in the call. No display name: names only travel end-to-end encrypted (in key envelopes). `ticket` is the
 * signed admission that let them in (null for a host, whom the host key attests) — every client verifies it.
 */
export interface ParticipantDto {
  id: string;
  tracks: TrackDto[];
  identity: IdentityDto;
  /** Video codecs this participant can decode, among `vp8` (always), `vp9`. */
  videoCodecs: string[];
  ticket: TicketDto | null;
}

/** An admission ticket: the admitting identity (Ed25519, base64url) and its signature over the admitted identity. */
export interface TicketDto {
  issuer: string;
  sig: string;
}

/** Host's browser only: the host public keys (the room id derives from them) and the host key's attestation. */
export interface HostProofDto {
  hostEd25519Pub: string;
  hostX25519Pub: string;
  attestation: string;
}

/** A knock for one admitter: our name, encrypted to them. Opaque to the server. */
export interface KnockDto {
  toId: string;
  blob: string;
}

/** Someone waiting in the lobby, as an admitter sees them. */
export interface LobbyGuestDto {
  id: string;
  identity: IdentityDto;
}

export interface HostAttestationDto {
  identity: string;
  sig: string;
}

/** A signed statement by `issuer` about `subject` (Ed25519 identities, base64url): co-host grant or removal. */
export interface StatementDto {
  subject: string;
  issuer: string;
  sig: string;
}

export interface SettingsDto {
  issuer: string;
  seq: number;
  autoAdmit: boolean;
  sig: string;
}

/** A host or co-host in the call right now: where knocks go. */
export interface AdmitterDto {
  id: string;
  identity: IdentityDto;
}

/**
 * The room's chain of authority, from the host keys (which the room id commits to) down. Public keys and signatures
 * only; CryptoService verifies all of it — the server's word counts for nothing.
 */
export interface AuthorityDto {
  hostEd25519Pub: string | null;
  hostX25519Pub: string | null;
  hosts: HostAttestationDto[];
  coHosts: StatementDto[];
  revoked: StatementDto[];
  settings: SettingsDto | null;
  admitters: AdmitterDto[];
}

/** `admitted` false = waiting in the lobby (no participants). `ticket`: ours, to rejoin this call without knocking. */
export interface LobbyResult {
  selfId: string;
  admitted: boolean;
  participants: ParticipantDto[];
  authority: AuthorityDto;
  ticket: TicketDto | null;
}

/** A sender-key envelope for one recipient; `blob` is opaque to the server (signed, encrypted end to end). */
export interface KeyEnvelopeDto {
  toId: string;
  blob: string;
}

/** ICE servers for the peer connection to the SFU (Cloudflare STUN/TURN); `forceRelay` = TURN only (testing). */
export interface RtcConfig {
  iceServers: RTCIceServer[];
  forceRelay: boolean;
}

/** A local track to publish: the transceiver mid on our peer connection and what it carries. */
export interface PublishTrackDto {
  mid: string;
  source: TrackSource;
}

/** A remote track, by publisher and source. */
export interface TrackRefDto {
  participantId: string;
  source: TrackSource;
}

export interface AnswerDto {
  answerSdp: string;
}

/** `mid` is the receiving transceiver on our peer connection. */
export interface SubscribedTrackDto {
  participantId: string;
  source: TrackSource;
  mid: string;
}

/** `offerSdp` must be answered with Renegotiate; null when nothing new was added. */
export interface SubscribeResult {
  offerSdp: string | null;
  tracks: SubscribedTrackDto[];
}

/** Coarse browser bucket for call-quality reports (anything else is recorded as `other`). */
export type CallPlatform =
  | 'ios-safari'
  | 'android-chrome'
  | 'desktop-chrome'
  | 'desktop-safari'
  | 'desktop-firefox'
  | 'other';

/** One direction of one media kind over the report interval, summed over its streams. */
export interface StreamStatsDto {
  bytes: number;
  packets: number;
  packetsLost: number;
  jitterMs: number | null;
  /** Received video: time frozen during the interval. */
  freezeSeconds: number | null;
  /** Received video: tallest stream; sent video: what we encode. */
  height: number | null;
  fps: number | null;
}

/** End-to-end encryption health over the interval: counts and seconds only. */
export interface E2eeStatsDto {
  framesEncrypted: number;
  framesDecrypted: number;
  framesFailed: number;
  framesMissingKey: number;
  envelopesDropped: number;
  securingSeconds: number;
}

/**
 * A call-quality summary for the last ~15 s (ReportCallStats): numbers only — no ids, names, addresses or media.
 * The server records it as metrics; nobody else sees it.
 */
export interface CallStatsDto {
  platform: CallPlatform;
  path: 'direct' | 'relay' | 'unknown';
  intervalSeconds: number;
  /** Round trip on the connection to Cloudflare. */
  rttMs: number | null;
  audioSent: StreamStatsDto | null;
  audioReceived: StreamStatsDto | null;
  videoSent: StreamStatsDto | null;
  videoReceived: StreamStatsDto | null;
  e2ee: E2eeStatsDto | null;
}

/** The usage guard's level (server-wide): how close this month's Cloudflare traffic is to the free tier. */
export type UsageLevel = 'normal' | 'saving' | 'audio-only' | 'paused';

/**
 * Sent when we connect and whenever the level changes. `percent` of the free tier (null at `normal`); `resetsAt`:
 * when the month resets (ISO-8601, UTC). Design: docs/plans/2026-10-09-usage-guard-design.md.
 */
export interface UsageDto {
  level: UsageLevel;
  percent: number | null;
  resetsAt: string;
}

/** Client → server hub methods. */
export const HubMethods = {
  JoinLobby: 'JoinLobby',
  Knock: 'Knock',
  Admit: 'Admit',
  Deny: 'Deny',
  GrantCoHost: 'GrantCoHost',
  RemoveParticipant: 'RemoveParticipant',
  UpdateSettings: 'UpdateSettings',
  AskToMute: 'AskToMute',
  EndCall: 'EndCall',
  LeaveRoom: 'LeaveRoom',
  GetRtcConfig: 'GetRtcConfig',
  PublishTracks: 'PublishTracks',
  SubscribeTracks: 'SubscribeTracks',
  Renegotiate: 'Renegotiate',
  RestartIce: 'RestartIce',
  UnpublishTracks: 'UnpublishTracks',
  UnsubscribeTracks: 'UnsubscribeTracks',
  SetTrackMuted: 'SetTrackMuted',
  SelectVideoLayer: 'SelectVideoLayer',
  SendKeyEnvelopes: 'SendKeyEnvelopes',
  ReportCallStats: 'ReportCallStats',
} as const;

/** Server → client events. */
export const ClientEvents = {
  ParticipantJoined: 'ParticipantJoined',
  ParticipantLeft: 'ParticipantLeft',
  TracksPublished: 'TracksPublished',
  TracksUnpublished: 'TracksUnpublished',
  TrackMuted: 'TrackMuted',
  KeyEnvelopeReceived: 'KeyEnvelopeReceived',
  KnockReceived: 'KnockReceived',
  LobbyLeft: 'LobbyLeft',
  Admitted: 'Admitted',
  Denied: 'Denied',
  AuthorityUpdated: 'AuthorityUpdated',
  Removed: 'Removed',
  MuteRequested: 'MuteRequested',
  CallEnded: 'CallEnded',
  UsageChanged: 'UsageChanged',
} as const;
