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

export interface ParticipantDto {
  id: string;
  displayName: string;
  tracks: TrackDto[];
}

export interface JoinResult {
  selfId: string;
  participants: ParticipantDto[];
}

export interface RtcConfig {
  livekitUrl: string;
  token: string;
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

/** Client → server hub methods. */
export const HubMethods = {
  JoinRoom: 'JoinRoom',
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
} as const;

/** Server → client events. */
export const ClientEvents = {
  ParticipantJoined: 'ParticipantJoined',
  ParticipantLeft: 'ParticipantLeft',
  TracksPublished: 'TracksPublished',
  TracksUnpublished: 'TracksUnpublished',
  TrackMuted: 'TrackMuted',
} as const;
