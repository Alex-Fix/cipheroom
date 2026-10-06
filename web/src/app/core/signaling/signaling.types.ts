// Mirrors src/server/Cipheroom.Api/Hubs (IRoomClient, RoomHub, Contracts). Keep in sync — see docs/signaling-protocol.md.

export interface ParticipantDto {
  id: string;
  displayName: string;
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

/** Client → server hub methods. */
export const HubMethods = {
  JoinRoom: 'JoinRoom',
  LeaveRoom: 'LeaveRoom',
  GetRtcConfig: 'GetRtcConfig',
} as const;

/** Server → client events. */
export const ClientEvents = {
  ParticipantJoined: 'ParticipantJoined',
  ParticipantLeft: 'ParticipantLeft',
} as const;
