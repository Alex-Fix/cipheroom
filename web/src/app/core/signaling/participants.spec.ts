import { withTrackMuted, withTracksPublished, withTracksUnpublished } from './participants';
import { ParticipantDto, TrackDto } from './signaling.types';

const mic: TrackDto = { source: 'microphone', kind: 'audio', muted: false };
const cam: TrackDto = { source: 'camera', kind: 'video', muted: false };
const screen: TrackDto = { source: 'screen', kind: 'video', muted: false };

const room = (): ParticipantDto[] => [
  { id: 'a', displayName: 'Alice', tracks: [mic] },
  { id: 'b', displayName: 'Bob', tracks: [] },
];

describe('participant track updates', () => {
  it('adds published tracks to that participant only', () => {
    const list = withTracksPublished(room(), 'a', [cam, screen]);

    expect(list[0].tracks).toEqual([mic, cam, screen]);
    expect(list[1].tracks).toEqual([]);
  });

  it('replaces a track republished for the same source', () => {
    const list = withTracksPublished(room(), 'a', [{ ...mic, muted: true }]);
    expect(list[0].tracks).toEqual([{ ...mic, muted: true }]);
  });

  it('removes unpublished sources', () => {
    const list = withTracksUnpublished(withTracksPublished(room(), 'a', [cam]), 'a', [
      'microphone',
    ]);
    expect(list[0].tracks).toEqual([cam]);
  });

  it('updates mute state of one source', () => {
    const list = withTrackMuted(withTracksPublished(room(), 'a', [cam]), 'a', 'microphone', true);
    expect(list[0].tracks).toEqual([{ ...mic, muted: true }, cam]);
  });

  it('ignores unknown participants and leaves the input untouched', () => {
    const before = room();
    const list = withTracksPublished(before, 'zzz', [cam]);

    expect(list).toEqual(room());
    expect(before).toEqual(room());
  });
});
