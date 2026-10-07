/**
 * Encrypted media frame layout (design: docs/plans/2026-10-07-e2ee-media-design.md, "Frame format"):
 *
 *   [ clear header ][ AES-GCM ciphertext + 16 B tag ][ counter 8 B ][ keyIndex 1 B ]
 *   IV  = 0x00000000 ‖ counter (12 B)
 *   AAD = clear header ‖ counter ‖ keyIndex
 *
 * The clear header is what the SFU may need to forward the frame: the VP8 payload header (10 bytes on keyframes,
 * 3 on delta frames — the P bit, lowest bit of byte 0, is 0 on keyframes); nothing for audio. Pure functions over
 * WebCrypto, shared by the frame-crypto worker and its tests.
 */

export type MediaKind = 'audio' | 'video';

export const TAG_BYTES = 16;
export const TRAILER_BYTES = 9;
const VP8_KEYFRAME_HEADER = 10;
const VP8_DELTA_HEADER = 3;

/** How many leading bytes of a frame stay readable. */
export function clearHeaderBytes(kind: MediaKind, frame: Uint8Array): number {
  if (kind === 'audio' || frame.byteLength === 0) return 0;
  const header = (frame[0] & 0x01) === 0 ? VP8_KEYFRAME_HEADER : VP8_DELTA_HEADER;
  return Math.min(header, frame.byteLength);
}

/** Codecs the frame layout supports. Unknown (`undefined`, some browsers don't report it) is allowed. */
export function isSupportedCodec(kind: MediaKind, mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const codec = mimeType.toLowerCase();
  return kind === 'video' ? codec === 'video/vp8' : codec === 'audio/opus' || codec === 'audio/red';
}

export async function encryptFrame(
  kind: MediaKind,
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  keyIndex: number,
  counter: bigint,
): Promise<Uint8Array<ArrayBuffer>> {
  const clear = clearHeaderBytes(kind, frame);
  const trailer = new Uint8Array(TRAILER_BYTES);
  new DataView(trailer.buffer).setBigUint64(0, counter);
  trailer[8] = keyIndex;

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv(counter),
        additionalData: concat(frame.subarray(0, clear), trailer),
      },
      key,
      frame.subarray(clear),
    ),
  );
  return concat(frame.subarray(0, clear), ciphertext, trailer);
}

/** The frame's key index, or `undefined` when it's too short to be one of ours. */
export function frameKeyIndex(kind: MediaKind, frame: Uint8Array): number | undefined {
  const clear = clearHeaderBytes(kind, frame);
  return frame.byteLength < clear + TAG_BYTES + TRAILER_BYTES
    ? undefined
    : frame[frame.byteLength - 1];
}

/** Rejects (OperationError) when the frame was tampered with or encrypted under another key. */
export async function decryptFrame(
  kind: MediaKind,
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const clear = clearHeaderBytes(kind, frame);
  if (frame.byteLength < clear + TAG_BYTES + TRAILER_BYTES) throw new Error('Frame too short.');
  const trailerStart = frame.byteLength - TRAILER_BYTES;
  const trailer = frame.subarray(trailerStart);
  const counter = new DataView(trailer.buffer, trailer.byteOffset, 8).getBigUint64(0);

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv(counter),
        additionalData: concat(frame.subarray(0, clear), trailer),
      },
      key,
      frame.subarray(clear, trailerStart),
    ),
  );
  return concat(frame.subarray(0, clear), plaintext);
}

function iv(counter: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(4, counter);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
