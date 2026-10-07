import { ParticipantDto } from '../signaling/signaling.types';
import { subscriptionDiff, TrackKey } from './subscriptions';

const alice: ParticipantDto = {
  id: 'a',
  displayName: 'Alice',
  tracks: [
    { source: 'microphone', kind: 'audio', muted: false },
    { source: 'camera', kind: 'video', muted: true },
  ],
};
const bob: ParticipantDto = { id: 'b', displayName: 'Bob', tracks: [] };

describe('subscriptionDiff', () => {
  it('subscribes to every published track not yet known, muted or not', () => {
    expect(subscriptionDiff([alice, bob], new Set())).toEqual({
      subscribe: [
        { participantId: 'a', source: 'microphone' },
        { participantId: 'a', source: 'camera' },
      ],
      drop: [],
    });
  });

  it('skips known tracks and drops ones that are no longer published', () => {
    const known = new Set<TrackKey>(['a:microphone', 'a:screen', 'gone:camera']);

    expect(subscriptionDiff([alice], known)).toEqual({
      subscribe: [{ participantId: 'a', source: 'camera' }],
      drop: ['a:screen', 'gone:camera'],
    });
  });
});
