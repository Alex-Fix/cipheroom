import { fields, fromBase64Url, toBase64Url } from './encoding';

/**
 * End-to-end encrypted files (design: docs/plans/2026-10-10-encrypted-files-design.md). Each file gets its own random
 * key, which travels only inside the file card — a chat event, so signed by the sender and encrypted with their chat
 * key. The bytes go over an SFU data channel in 16 KiB chunks:
 *
 *   fileKey = 32 random bytes → AES-GCM-256 (raw bytes only to build the card; imported non-extractable)
 *   total   = ceil(size / 16 KiB)
 *   aad     = fields("cipheroom/file-chunk/v1", roomId, fileId, index, total)
 *   frame   = version ‖ uint32 index ‖ iv (12 B, random) ‖ AES-GCM(fileKey, iv, aad, chunk)
 *   hash    = SHA-256(fields("cipheroom/file-hash/v1", size, SHA-256(chunk 0), …, SHA-256(chunk total−1)))
 *
 * IVs are random, not counters: a resent chunk is read from disk again, and if the file changed meanwhile a counter
 * would reuse a nonce on different data. `total` in the AAD makes truncation and extension fail; the hash in the
 * signed card catches a file that changed on the sender's disk between chunks or transfers.
 */

/** Plaintext per chunk. Cloudflare's SFU stalls on 64 KiB messages (spike, 2026-10-10). */
export const CHUNK_BYTES = 16 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_NAME = 255;
export const FILE_KEY_BYTES = 32;
export const FILE_ID_BYTES = 16;
export const FRAME_OVERHEAD = 1 + 4 + 12 + 16;

const VERSION = 1;
const IV_BYTES = 12;
const HEADER_BYTES = 1 + 4 + IV_BYTES;
const CHUNK_LABEL = 'cipheroom/file-chunk/v1';
const HASH_LABEL = 'cipheroom/file-hash/v1';

export type FileRejection = 'malformed' | 'undecryptable' | 'wrong-chunk' | 'hash-mismatch';

export class FileError extends Error {
  constructor(readonly reason: FileRejection) {
    super(`File chunk rejected: ${reason}.`);
  }
}

/** Which file a chunk belongs to, and how many chunks it has. */
export interface FileContext {
  roomId: string;
  /** base64url, 16 bytes. */
  fileId: string;
  total: number;
  key: CryptoKey;
}

export const chunkCount = (size: number): number => Math.ceil(size / CHUNK_BYTES);

export const newFileId = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(FILE_ID_BYTES)));

/** A fresh file key: the raw bytes (for the card only) and the non-extractable key for sealing. */
export async function newFileKey(): Promise<{ raw: string; key: CryptoKey }> {
  const bytes = crypto.getRandomValues(new Uint8Array(FILE_KEY_BYTES));
  const raw = toBase64Url(bytes);
  bytes.fill(0);
  return { raw, key: await importFileKey(raw) };
}

/** The key from a card (base64url, 32 bytes) as a non-extractable AES-GCM key. */
export async function importFileKey(raw: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(raw);
  if (bytes.byteLength !== FILE_KEY_BYTES) throw new FileError('malformed');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealChunk(context: FileContext, index: number, chunk: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(index) || index < 0 || index >= context.total) throw new Error('Chunk index out of range.');
  if (chunk.byteLength === 0 || chunk.byteLength > CHUNK_BYTES) throw new Error('Bad chunk size.');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context, index) }, context.key, chunk),
  );
  const out = new Uint8Array(HEADER_BYTES + ct.byteLength);
  out[0] = VERSION;
  new DataView(out.buffer).setUint32(1, index);
  out.set(iv, 5);
  out.set(ct, HEADER_BYTES);
  return out;
}

/** The chunk index a frame claims (to skip duplicates before decrypting). Throws FileError('malformed'). */
export function frameIndex(frame: ArrayBuffer | Uint8Array): number {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < HEADER_BYTES + 16 + 1 || bytes.byteLength > HEADER_BYTES + 16 + CHUNK_BYTES || bytes[0] !== VERSION) {
    throw new FileError('malformed');
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
}

/** Decrypts one frame of this file. Throws FileError: malformed, wrong-chunk (index out of range) or undecryptable. */
export async function openChunk(context: FileContext, frame: ArrayBuffer | Uint8Array): Promise<{ index: number; chunk: Uint8Array<ArrayBuffer> }> {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const index = frameIndex(bytes);
  if (index >= context.total) throw new FileError('wrong-chunk');
  try {
    const chunk = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(5, HEADER_BYTES), additionalData: aad(context, index) },
        context.key,
        bytes.slice(HEADER_BYTES),
      ),
    );
    return { index, chunk };
  } catch {
    throw new FileError('undecryptable');
  }
}

/**
 * The file's content hash, from each chunk's SHA-256 in order (computed as chunks are read or received, so neither
 * side needs the whole file in one buffer). base64url.
 */
export async function contentHash(size: number, chunkHashes: readonly Uint8Array[]): Promise<string> {
  if (chunkHashes.length !== chunkCount(size)) throw new Error('Wrong number of chunk hashes.');
  const digest = await crypto.subtle.digest('SHA-256', fields(HASH_LABEL, size, ...chunkHashes));
  return toBase64Url(new Uint8Array(digest));
}

export async function chunkHash(chunk: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', chunk));
}

/**
 * A file name as it may be shown and saved: no control or bidirectional-override characters, no path separators,
 * no leading dots (hidden files), trimmed, at most MAX_FILE_NAME code points; "file" if nothing is left.
 */
export function cleanFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩/\\]/g, '')
    .trim()
    .replace(/^\.+/, '');
  const limited = [...cleaned].slice(0, MAX_FILE_NAME).join('').trim();
  return limited || 'file';
}

const aad = (context: FileContext, index: number) =>
  fields(CHUNK_LABEL, context.roomId, fromBase64Url(context.fileId), index, context.total);
