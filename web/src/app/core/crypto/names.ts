import { utf8 } from './encoding';

/**
 * Display names only travel end-to-end encrypted, and padded to one size so their length doesn't leak either:
 * 2-byte big-endian length, the UTF-8 bytes, zeros.
 */
export const MAX_NAME_LENGTH = 64;
const MAX_NAME_BYTES = 4 * MAX_NAME_LENGTH;
export const PADDED_NAME_BYTES = 2 + MAX_NAME_BYTES;

/** Trimmed, at most MAX_NAME_LENGTH characters (code points). */
export function cleanName(name: string): string {
  return [...name.trim()].slice(0, MAX_NAME_LENGTH).join('');
}

export function padName(name: string): Uint8Array<ArrayBuffer> {
  const bytes = utf8(cleanName(name));
  const out = new Uint8Array(PADDED_NAME_BYTES);
  new DataView(out.buffer).setUint16(0, bytes.byteLength);
  out.set(bytes, 2);
  return out;
}

/** Throws on anything padName couldn't have produced (wrong size, bad length, invalid UTF-8, non-zero padding). */
export function unpadName(padded: Uint8Array): string {
  if (padded.byteLength !== PADDED_NAME_BYTES) throw new Error('Bad name size.');
  const length = new DataView(padded.buffer, padded.byteOffset, 2).getUint16(0);
  if (length === 0 || length > MAX_NAME_BYTES) throw new Error('Bad name length.');
  if (padded.subarray(2 + length).some((b) => b !== 0)) throw new Error('Bad padding.');
  const name = new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(2, 2 + length));
  if (cleanName(name) !== name) throw new Error('Bad name.');
  return name;
}
