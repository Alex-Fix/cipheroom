import { CallParticipant } from '../../core/livekit/livekit.service';
import { participantChanges } from './participant-changes';

const p = (identity: string, isLocal = false): CallParticipant => ({
  identity,
  name: identity,
  isLocal,
  isSpeaking: false,
  micMuted: false,
  cameraOn: false,
  sharingScreen: false,
});

describe('participantChanges', () => {
  it('reports remote joins and leaves', () => {
    const changes = participantChanges([p('me', true), p('bob')], [p('me', true), p('ann')]);
    expect(changes.joined.map((x) => x.identity)).toEqual(['ann']);
    expect(changes.left.map((x) => x.identity)).toEqual(['bob']);
  });

  it('ignores the local participant and unchanged people', () => {
    const changes = participantChanges([p('bob')], [p('me', true), p('bob')]);
    expect(changes).toEqual({ joined: [], left: [] });
  });
});
