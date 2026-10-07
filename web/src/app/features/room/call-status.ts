import { MediaState } from '../../core/media/media.types';

export type CallStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * What the header shows. Before joining (and while rejoining) it's "connecting"; `failed` = the join itself failed
 * (the room shows its own Retry, so no Rejoin in the header).
 */
export function callStatus(state: MediaState, joined: boolean, failed = false): CallStatus {
  if (failed) return 'failed';
  if (!joined) return 'connecting';
  return state;
}
