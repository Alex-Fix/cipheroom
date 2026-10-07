import { CallParticipant } from '../../core/media/media.types';

export interface ParticipantChanges {
  joined: CallParticipant[];
  left: CallParticipant[];
}

/** Remote people who appeared or disappeared between two snapshots of the room. */
export function participantChanges(
  previous: readonly CallParticipant[],
  next: readonly CallParticipant[],
): ParticipantChanges {
  const before = new Set(previous.map((p) => p.identity));
  const after = new Set(next.map((p) => p.identity));
  return {
    joined: next.filter((p) => !p.isLocal && !before.has(p.identity)),
    left: previous.filter((p) => !p.isLocal && !after.has(p.identity)),
  };
}
