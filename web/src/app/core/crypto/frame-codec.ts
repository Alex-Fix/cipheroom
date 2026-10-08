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
 * authenticated, so the SFU can't relabel a frame.
 *
 * AV1 is different: Chrome's packetizer splits frames by their OBUs (it drops temporal delimiters), so each OBU keeps
 * its header and a size field in the clear and only its payload is encrypted, with IV = index ‖ counter (index =
 * 1, 2, … over non-empty OBUs) and AAD = OBU header ‖ trailer. The trailer goes at the end of the last OBU's payload,
 * so it is still the last 10 bytes of the frame.
 *
 * Pure functions over WebCrypto, shared by the frame-crypto worker and its tests.
 */

export type MediaKind = 'audio' | 'video';

/** Layout of an encrypted frame; stored in the trailer. */
export type FrameCodec = 'audio' | 'vp8' | 'vp9' | 'av1';

export type VideoFrameCodec = Exclude<FrameCodec, 'audio'>;

export const TAG_BYTES = 16;
export const TRAILER_BYTES = 10;
const COUNTER_BYTES = 8;
const VP8_KEYFRAME_HEADER = 10;
const VP8_DELTA_HEADER = 3;

/** Wire ids of the codec byte. */
const CODEC_IDS: Record<FrameCodec, number> = { audio: 0, vp8: 1, vp9: 2, av1: 3 };
const CODECS_BY_ID: readonly FrameCodec[] = ['audio', 'vp8', 'vp9', 'av1'];

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
    case 'video/av1':
      return 'av1';
    default:
      return undefined;
  }
}

/** How many leading bytes of a (non-AV1) frame stay readable. */
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
  if (codec === 'av1') return encryptAv1(frame, key, counter, trailer);

  const clear = clearHeaderBytes(codec, frame);
  const header = frame.subarray(0, clear);
  const ciphertext = await seal(
    key,
    iv(0, counter),
    concat(header, trailer),
    frame.subarray(clear),
  );
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
  if (codec === 'av1') return decryptAv1(frame, key, counter);

  const clear = clearHeaderBytes(codec, frame);
  if (trailerStart - clear < TAG_BYTES) throw new Error('Frame too short.');
  const header = frame.subarray(0, clear);
  const plaintext = await open(
    key,
    iv(0, counter),
    concat(header, trailer),
    frame.subarray(clear, trailerStart),
  );
  return concat(header, plaintext);
}

// AV1 (see the header comment). OBU header byte: forbidden bit, type (4 bits), extension flag (0x04), has-size flag
// (0x02), reserved bit; one extension byte when flagged; then the payload size as leb128 when has-size is set.

interface Obu {
  /** Header (+ extension byte), always with the has-size flag set: that's how it's written back. */
  header: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
}

async function encryptAv1(
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  counter: bigint,
  trailer: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const obus = parseObus(frame);
  const last = obus.at(-1);
  // The trailer must ride inside an OBU the packetizer keeps (it drops empty ones).
  if (!last || last.payload.byteLength === 0) throw new Error('No OBU to carry the trailer.');
  let index = 0;
  for (const obu of obus) {
    if (obu.payload.byteLength === 0) continue;
    obu.payload = await seal(key, iv(++index, counter), concat(obu.header, trailer), obu.payload);
  }
  last.payload = concat(last.payload, trailer);
  return writeObus(obus);
}

async function decryptAv1(
  frame: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  counter: bigint,
): Promise<Uint8Array<ArrayBuffer>> {
  const obus = parseObus(frame);
  const last = obus.at(-1);
  if (!last || last.payload.byteLength < TAG_BYTES + TRAILER_BYTES)
    throw new Error('Frame too short.');
  const trailer = last.payload.slice(last.payload.byteLength - TRAILER_BYTES);
  last.payload = last.payload.subarray(0, last.payload.byteLength - TRAILER_BYTES);
  let index = 0;
  for (const obu of obus) {
    if (obu.payload.byteLength === 0) continue;
    obu.payload = await open(key, iv(++index, counter), concat(obu.header, trailer), obu.payload);
  }
  return writeObus(obus);
}

function parseObus(frame: Uint8Array<ArrayBuffer>): Obu[] {
  const obus: Obu[] = [];
  let offset = 0;
  while (offset < frame.byteLength) {
    const first = frame[offset];
    const headerLength = first & 0x04 ? 2 : 1;
    if (offset + headerLength > frame.byteLength) throw new Error('Truncated OBU header.');
    const header = frame.slice(offset, offset + headerLength);
    header[0] |= 0x02;
    offset += headerLength;
    let size = frame.byteLength - offset;
    if (first & 0x02) {
      const leb = readLeb128(frame, offset);
      offset += leb.length;
      size = leb.value;
    }
    if (offset + size > frame.byteLength) throw new Error('OBU overruns the frame.');
    obus.push({ header, payload: frame.subarray(offset, offset + size) });
    offset += size;
  }
  return obus;
}

function writeObus(obus: Obu[]): Uint8Array<ArrayBuffer> {
  return concat(...obus.flatMap((o) => [o.header, writeLeb128(o.payload.byteLength), o.payload]));
}

function readLeb128(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = data[offset + i];
    if (byte === undefined) throw new Error('Truncated leb128.');
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  throw new Error('leb128 too long.');
}

function writeLeb128(value: number): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return new Uint8Array(out);
}

/** IV = index (4 B) ‖ counter (8 B): index 0 for whole frames, 1… for AV1 OBUs. */
function iv(index: number, counter: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, index);
  view.setBigUint64(4, counter);
  return bytes;
}

async function seal(
  key: CryptoKey,
  ivBytes: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData },
      key,
      plaintext as Uint8Array<ArrayBuffer>,
    ),
  );
}

async function open(
  key: CryptoKey,
  ivBytes: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData },
      key,
      ciphertext as Uint8Array<ArrayBuffer>,
    ),
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
