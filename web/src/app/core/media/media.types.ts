import { IcePath } from '../livekit/ice-path';

/** Call connection state as the UI shows it. */
export type MediaState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface Tile {
  key: string;
  /** Label for the tile, e.g. "Alex (you)". */
  name: string;
  /** The participant's own name, same on every client (avatar initials and colour). */
  displayName: string;
  isLocal: boolean;
  isScreen: boolean;
  isSpeaking: boolean;
  video?: MediaStreamTrack;
  audio?: MediaStreamTrack;
  micMuted: boolean;
  /** Mirror the preview: only your own front-facing camera (a mirrored rear camera would show text backwards). */
  mirror: boolean;
}

/** One person in the call — i.e. someone who can receive your audio and video. */
export interface CallParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  micMuted: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
}

export interface Diagnostics {
  forceRelay: boolean;
  publisher?: IcePath;
  subscriber?: IcePath;
}
