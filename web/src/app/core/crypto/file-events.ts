import { fromBase64Url } from './encoding';
import { FILE_ID_BYTES, FILE_KEY_BYTES, MAX_FILE_BYTES, chunkCount, cleanFileName } from './file-crypto';

/**
 * File events inside encrypted chat (docs/plans/2026-10-10-encrypted-files-design.md). They are ordinary chat events —
 * signed by the author, encrypted with their chat key, invisible to the server:
 *
 * - `file`: the card — what the file is and its key. Only someone who got the card can decrypt the file.
 * - `file-request`: "send me this file" (or only the chunk `ranges` I'm missing), to the card's author.
 * - `file-channel`: the author streams `ranges` of the file on data channel `channel`, to the participants in `to`.
 * - `file-ready`: a recipient is subscribed to `channel` and can receive.
 * - `file-gone`: the author can't share the file any more.
 *
 * Ranges are half-open chunk index intervals [start, end).
 */
export type FileEvent =
  | {
      v: 1;
      seq: number;
      type: 'file';
      id: string;
      name: string;
      size: number;
      mime: string;
      hash: string;
      key: string;
      thumb?: string;
    }
  | { v: 1; seq: number; type: 'file-request'; file: string; ranges?: ChunkRange[] }
  | { v: 1; seq: number; type: 'file-channel'; file: string; channel: string; to: string[]; ranges: ChunkRange[] }
  | { v: 1; seq: number; type: 'file-ready'; file: string; channel: string }
  | { v: 1; seq: number; type: 'file-gone'; file: string };

export type ChunkRange = [start: number, end: number];

export type FileCard = Extract<FileEvent, { type: 'file' }>;

export const MAX_RANGES = 64;
export const MAX_RECIPIENTS = 64;
/** base64url of the largest thumbnail (6 KiB). */
export const MAX_THUMB_CHARS = 8192;
const MAX_MIME = 127;
const MAX_CHUNKS = chunkCount(MAX_FILE_BYTES);

/** Exactly the shapes we send; called by isChatEvent for unknown types (version and seq already checked). */
export function isFileEvent(e: Record<string, unknown>): boolean {
  const keys = Object.keys(e).sort().join();
  switch (e['type']) {
    case 'file':
      return (
        (keys === 'hash,id,key,mime,name,seq,size,type,v' || keys === 'hash,id,key,mime,name,seq,size,thumb,type,v') &&
        isBytes(e['id'], FILE_ID_BYTES) &&
        typeof e['name'] === 'string' &&
        cleanFileName(e['name']) === e['name'] &&
        Number.isInteger(e['size']) &&
        (e['size'] as number) > 0 &&
        (e['size'] as number) <= MAX_FILE_BYTES &&
        isMime(e['mime']) &&
        isBytes(e['hash'], 32) &&
        isBytes(e['key'], FILE_KEY_BYTES) &&
        (e['thumb'] === undefined || (typeof e['thumb'] === 'string' && e['thumb'].length <= MAX_THUMB_CHARS && isBase64Url(e['thumb'])))
      );
    case 'file-request':
      return (
        (keys === 'file,seq,type,v' || (keys === 'file,ranges,seq,type,v' && isRanges(e['ranges']))) &&
        isBytes(e['file'], FILE_ID_BYTES)
      );
    case 'file-channel':
      return (
        keys === 'channel,file,ranges,seq,to,type,v' &&
        isBytes(e['file'], FILE_ID_BYTES) &&
        isChannelName(e['channel']) &&
        Array.isArray(e['to']) &&
        e['to'].length > 0 &&
        e['to'].length <= MAX_RECIPIENTS &&
        e['to'].every(isParticipantId) &&
        isRanges(e['ranges'])
      );
    case 'file-ready':
      return keys === 'channel,file,seq,type,v' && isBytes(e['file'], FILE_ID_BYTES) && isChannelName(e['channel']);
    case 'file-gone':
      return keys === 'file,seq,type,v' && isBytes(e['file'], FILE_ID_BYTES);
    default:
      return false;
  }
}

/** Data channel names: 16 random bytes, base64url (what the api accepts). */
export const isChannelName = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Za-z0-9_-]{22}$/.test(name);

export const isParticipantId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);

function isRanges(value: unknown): value is ChunkRange[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_RANGES &&
    value.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 2 &&
        Number.isInteger(r[0]) &&
        Number.isInteger(r[1]) &&
        r[0] >= 0 &&
        r[0] < r[1] &&
        r[1] <= MAX_CHUNKS,
    )
  );
}

const isMime = (mime: unknown): mime is string =>
  typeof mime === 'string' && mime.length <= MAX_MIME && (mime === '' || /^[\w.+-]+\/[\w.+-]+$/.test(mime));

const isBase64Url = (text: string) => /^[A-Za-z0-9_-]*$/.test(text);

function isBytes(value: unknown, length: number): boolean {
  if (typeof value !== 'string') return false;
  try {
    return fromBase64Url(value).byteLength === length;
  } catch {
    return false;
  }
}
