import { ROOM_ID_PATTERN } from '../../core/crypto/host-key';

/**
 * The meeting a pasted invite link (or bare meeting code) points to; undefined if it isn't one. Only the id is taken
 * from a link — never its host, so a link to another site can't send anyone there.
 */
export function parseRoomLink(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /\/r\/([a-z2-7]+)(?:[/?#]|$)/.exec(trimmed);
  const id = (match ? match[1] : trimmed).toLowerCase();
  return ROOM_ID_PATTERN.test(id) ? id : undefined;
}

/** How a meeting is shown in lists: short and recognisable, not the whole id. */
export const shortRoomId = (roomId: string): string =>
  `${roomId.slice(0, 4)}-${roomId.slice(4, 8)}`;
