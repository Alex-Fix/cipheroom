import { ParticipantDto, TrackRefDto, TrackSource } from '../signaling/signaling.types';

/** Identifies a remote track: `${participantId}:${source}`. */
export type TrackKey = `${string}:${TrackSource}`;

export const trackKey = (participantId: string, source: TrackSource): TrackKey =>
  `${participantId}:${source}`;

export interface SubscriptionDiff {
  /** Published in the room, not yet received or requested. */
  subscribe: TrackRefDto[];
  /** Received, but no longer published (unpublished, or the participant left). */
  drop: TrackKey[];
}

/**
 * What to subscribe to and what to drop, given who publishes what (`participants`, from signaling) and what we
 * already receive or have requested (`known`). Mute doesn't matter: muted tracks stay subscribed.
 */
export function subscriptionDiff(
  participants: readonly ParticipantDto[],
  known: ReadonlySet<TrackKey>,
): SubscriptionDiff {
  const published = new Set<TrackKey>();
  const subscribe: TrackRefDto[] = [];
  for (const p of participants) {
    for (const t of p.tracks) {
      const key = trackKey(p.id, t.source);
      published.add(key);
      if (!known.has(key)) subscribe.push({ participantId: p.id, source: t.source });
    }
  }
  return { subscribe, drop: [...known].filter((key) => !published.has(key)) };
}
