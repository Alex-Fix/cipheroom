import { ConnectionState } from 'livekit-client';
import { callStatus } from './call-status';

describe('callStatus', () => {
  it('treats the initial disconnected state as connecting', () => {
    expect(callStatus(ConnectionState.Disconnected, false)).toBe('connecting');
    expect(callStatus(ConnectionState.Disconnected, true)).toBe('disconnected');
  });

  it('maps both reconnect states to reconnecting', () => {
    expect(callStatus(ConnectionState.Reconnecting, true)).toBe('reconnecting');
    expect(callStatus(ConnectionState.SignalReconnecting, true)).toBe('reconnecting');
    expect(callStatus(ConnectionState.Connected, true)).toBe('connected');
  });

  it('reports a failed join regardless of LiveKit state', () => {
    expect(callStatus(ConnectionState.Disconnected, false, true)).toBe('failed');
  });
});
