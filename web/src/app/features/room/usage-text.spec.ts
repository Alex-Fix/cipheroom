import { isCallsPaused, resetDate, videoBlockedReason } from './usage-text';

const usage = (level: 'normal' | 'saving' | 'audio-only' | 'paused') => ({
  level,
  percent: 96,
  resetsAt: '2026-11-01T00:00:00+00:00',
});

describe('usage text', () => {
  it('names the reset day in UTC, whatever the local time zone', () =>
    expect(resetDate(usage('paused'))).toBe('1 November'));

  it('explains blocked video only when video is blocked', () => {
    expect(videoBlockedReason(undefined)).toBeUndefined();
    expect(videoBlockedReason(usage('saving'))).toBeUndefined();
    expect(videoBlockedReason(usage('audio-only'))).toContain('until 1 November');
  });

  it('recognises the server refusing a call', () => {
    expect(
      isCallsPaused(
        new Error(
          "An unexpected error occurred invoking 'JoinLobby' on the server. HubException: Calls are paused.",
        ),
      ),
    ).toBe(true);
    expect(isCallsPaused(new Error('Media server unavailable.'))).toBe(false);
    expect(isCallsPaused('Calls are paused.')).toBe(false);
  });
});
