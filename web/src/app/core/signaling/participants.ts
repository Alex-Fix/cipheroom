import { ParticipantDto, TrackDto, TrackSource } from './signaling.types';

// Pure updates of the room's participant list from server events (one track per source per participant).

export function withTracksPublished(
  list: ParticipantDto[],
  id: string,
  tracks: TrackDto[],
): ParticipantDto[] {
  const sources = new Set(tracks.map((t) => t.source));
  return update(list, id, (p) => ({
    ...p,
    tracks: [...p.tracks.filter((t) => !sources.has(t.source)), ...tracks],
  }));
}

export function withTracksUnpublished(
  list: ParticipantDto[],
  id: string,
  sources: TrackSource[],
): ParticipantDto[] {
  return update(list, id, (p) => ({
    ...p,
    tracks: p.tracks.filter((t) => !sources.includes(t.source)),
  }));
}

export function withTrackMuted(
  list: ParticipantDto[],
  id: string,
  source: TrackSource,
  muted: boolean,
): ParticipantDto[] {
  return update(list, id, (p) => ({
    ...p,
    tracks: p.tracks.map((t) => (t.source === source ? { ...t, muted } : t)),
  }));
}

function update(
  list: ParticipantDto[],
  id: string,
  change: (p: ParticipantDto) => ParticipantDto,
): ParticipantDto[] {
  return list.map((p) => (p.id === id ? change(p) : p));
}
