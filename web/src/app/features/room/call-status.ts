import { ConnectionState } from 'livekit-client';

export type CallStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * LiveKit starts out "disconnected" before the first connect — that's still "connecting" to the user.
 * `failed` = the join itself failed (the room shows its own Retry, so no Rejoin in the header).
 */
export function callStatus(state: ConnectionState, joined: boolean, failed = false): CallStatus {
  if (failed) return 'failed';
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting';
    case ConnectionState.Connecting:
      return 'connecting';
    default:
      return joined ? 'disconnected' : 'connecting';
  }
}
