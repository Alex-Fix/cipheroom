import { callStatus } from './call-status';

describe('callStatus', () => {
  it('is connecting until joined', () => {
    expect(callStatus('disconnected', false)).toBe('connecting');
    expect(callStatus('connected', false)).toBe('connecting');
  });

  it('follows the media connection once joined', () => {
    expect(callStatus('connected', true)).toBe('connected');
    expect(callStatus('reconnecting', true)).toBe('reconnecting');
    expect(callStatus('disconnected', true)).toBe('disconnected');
  });

  it('reports a failed join regardless of the connection', () => {
    expect(callStatus('connected', true, true)).toBe('failed');
  });
});
