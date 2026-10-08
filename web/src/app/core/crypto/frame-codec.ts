/**
 * Encrypted media frame layout, v2 (designs: docs/plans/2026-10-07-e2ee-media-design.md "Frame format",
 * docs/plans/2026-10-08-video-compression-design.md):
 *
 *   [ clear header ][ AES-GCM ciphertext + 16 B tag ][ counter 8 B ][ codec 1 B ][ keyIndex 1 B ]
 *   IV  = 0x00000000 ‖ counter (12 B)
 *   AAD = clear header ‖ counter ‖ codec ‖ keyIndex
 *
 * The clear header is what the SFU and the RTP packetizer need: the VP8 payload header (10 bytes on keyframes, 3 on
 * delta frames — the P bit, lowest bit of byte 0, is 0 on keyframes); nothing for VP9 (its RTP descriptor comes from
 * encoder metadata) or audio. The codec byte tells the receiver which layout it got before parsing anything, and is
 * authenticated, so the SFU can't relabel a frame. Codec ids: 0 audio, 1 VP8, 2 VP9; 3 is reserved (it was AV1,
 * removed: docs/plans/2026-10-08-remove-av1-design.md) and, like any unknown id, makes a frame undecodable.
 *
 * Pure functions over WebCrypto, shared by the frame-crypto worker and its tests.
 */

export type MediaKind = 'audio' | 'video';

/** Layout of an encrypted frame; stored in the trailer. */
export type FrameCodec = 'audio' | 'vp8' | 'vp9';

export type VideoFrameCodec = Exclude<FrameCodec, 'audio'>;

export const TAG_BYTES = 16;
export const TRAILER_BYTES = 10;
const COUNTER_BYTES = 8;
const VP8_KEYFRAME_HEADER = 10;
const VP8_DELTA_HEADER = 3;

/** Wire ids of the codec byte. */
const CODEC_IDS: Record<FrameCodec, number> = { audio: 0, vp8: 1, vp9: 2 };
const CODECS_BY_ID: readonly FrameCodec[] = ['audio', 'vp8', 'vp9'];

/**
 * The frame layout for a codec the browser reports (`mimeType` from the encoded frame's metadata), or `undefined`
 * when we can't encrypt it. Not every browser reports it: unknown video falls back to `fallback` (what the sender
 * was negotiated with), unknown audio is Opus.
 */
export function frameCodecOf(
  kind: MediaKind,
  mimeType: string | undefined,
  fallback: VideoFrameCodec = 'vp8',
): FrameCodec | undefined {
  const mime = mimeType?.toLowerCase();
  if (kind === 'audio')
    return !mime || mime === 'audio/opus' || mime === 'audio/red' ? 'audio' : undefined;
  if (!mime) return fallback;
  switch (mime) {
    case 'video/vp8':
      return 'vp8';
    case 'video/vp9':
      return 'vp9';
    default:
      return undefined;
  }
}

/** How many leading bytes of a frame stay readable. */
export function clearHeaderBytes(codec: FrameCodec, frame: Uint8Array): number {
  if (codec !== 'vp8' || frame.byteLength === 0) return 0;
  const header = (frame[0] & 0x01) === 0 ? VP8_KEYFRAME_HEADER : VP8_DELTA_HEADER;
  return Math.min(header, frame.byteLength);
}

export async function encryptFrame(
  codec: FrameCodec,
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  keyIndex: number,
  counter: bigint,
): Promise<Uint8Array<ArrayBuffer>> {
  const trailer = new Uint8Array(TRAILER_BYTES);
  new DataView(trailer.buffer).setBigUint64(0, counter);
  trailer[COUNTER_BYTES] = CODEC_IDS[codec];
  trailer[COUNTER_BYTES + 1] = keyIndex;

  const clear = clearHeaderBytes(codec, frame);
  const header = frame.subarray(0, clear);
  const ciphertext = await seal(key, iv(counter), concat(header, trailer), frame.subarray(clear));
  return concat(header, ciphertext, trailer);
}

/** The frame's key index, or `undefined` when it's too short to be one of ours. */
export function frameKeyIndex(frame: Uint8Array): number | undefined {
  return frame.byteLength < TAG_BYTES + TRAILER_BYTES ? undefined : frame[frame.byteLength - 1];
}

/** The layout an encrypted frame says it has, or `undefined` when it's too short or the byte is unknown. */
export function encryptedFrameCodec(frame: Uint8Array): FrameCodec | undefined {
  if (frame.byteLength < TAG_BYTES + TRAILER_BYTES) return undefined;
  return CODECS_BY_ID[frame[frame.byteLength - 2]];
}

/**
 * Rejects (OperationError) when the frame was tampered with or encrypted under another key, and (Error) when its
 * codec byte isn't one `expected` accepts — what the receiver's kind and the browser's metadata say it must be.
 */
export async function decryptFrame(
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  expected: (codec: FrameCodec) => boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const codec = encryptedFrameCodec(frame);
  if (!codec || !expected(codec)) throw new Error('Unexpected frame codec.');
  const trailerStart = frame.byteLength - TRAILER_BYTES;
  const trailer = frame.slice(trailerStart);
  const counter = new DataView(trailer.buffer).getBigUint64(0);

  const clear = clearHeaderBytes(codec, frame);
  if (trailerStart - clear < TAG_BYTES) throw new Error('Frame too short.');
  const header = frame.subarray(0, clear);
  const plaintext = await open(
    key,
    iv(counter),
    concat(header, trailer),
    frame.subarray(clear, trailerStart),
  );
  return concat(header, plaintext);
}

function iv(counter: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(4, counter);
  return bytes;
}

async function seal(
  key: CryptoKey,
  ivBytes: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes, additionalData }, key, plaintext),
  );
}

async function open(
  key: CryptoKey,
  ivBytes: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData }, key, ciphertext),
  );
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
