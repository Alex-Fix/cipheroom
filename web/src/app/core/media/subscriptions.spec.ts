import { IdentityDto, ParticipantDto } from '../signaling/signaling.types';
import { subscriptionDiff, TrackKey } from './subscriptions';

/** Public keys only; the shape is all these tests need. */
const identity: IdentityDto = { ed25519Pub: 'ed', x25519Pub: 'x', sig: 'sig' };

const alice: ParticipantDto = {
  id: 'a',
  displayName: 'Alice',
  identity,
  videoCodecs: ['vp8'],
  tracks: [
    { source: 'microphone', kind: 'audio', muted: false },
    { source: 'camera', kind: 'video', muted: true },
  ],
};
const bob: ParticipantDto = {
  id: 'b',
  displayName: 'Bob',
  identity,
  videoCodecs: ['vp8'],
  tracks: [],
};

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
