/**
 * Removes metadata from photos before they are shared (docs/plans/2026-10-10-encrypted-files-design.md): GPS location,
 * camera, times, comments — EXIF, XMP, IPTC and text chunks. The image data is copied byte for byte (no re-encoding,
 * no quality loss). The only thing kept from EXIF is the orientation, rewritten as a minimal EXIF block, so phone
 * photos don't turn sideways. Colour information (ICC profiles, Adobe colour transform) is kept.
 *
 * JPEG, PNG and WebP are recognised by their bytes, not the file's claimed type. Anything else — or a file that
 * doesn't parse — is returned unchanged with `stripped: false`, so the UI can say metadata wasn't removed.
 */
export interface StripResult {
  bytes: Uint8Array<ArrayBuffer>;
  stripped: boolean;
}

export function stripImageMetadata(bytes: Uint8Array<ArrayBuffer>): StripResult {
  try {
    if (isJpeg(bytes)) return { bytes: stripJpeg(bytes), stripped: true };
    if (isPng(bytes)) return { bytes: stripPng(bytes), stripped: true };
    if (isWebp(bytes)) return { bytes: stripWebp(bytes), stripped: true };
  } catch {
    // Malformed: send as is, but say so.
  }
  return { bytes, stripped: false };
}

/** Whether we know how to strip this file's metadata (by its first bytes). */
export function canStrip(head: Uint8Array): boolean {
  return isJpeg(head) || isPng(head) || isWebp(head);
}

const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);
const isWebp = (b: Uint8Array) => b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';

// --- JPEG -------------------------------------------------------------------------------------------------------

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function stripJpeg(src: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new ByteWriter(src.length);
  out.bytes(src.subarray(0, 2)); // SOI
  let orientation = 1;
  let offset = 2;
  let wroteOrientation = false;
  while (offset < src.length) {
    if (src[offset] !== 0xff) throw new Error('Bad JPEG marker.');
    // Fill bytes before a marker.
    while (src[offset + 1] === 0xff) offset++;
    const marker = src[offset + 1];
    if (marker === undefined) throw new Error('Truncated JPEG.');
    if (marker === 0xd9) {
      out.bytes(src.subarray(offset, offset + 2));
      return out.result();
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.bytes(src.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const length = (src[offset + 2] << 8) | src[offset + 3];
    if (length < 2 || offset + 2 + length > src.length) throw new Error('Truncated JPEG segment.');
    const segment = src.subarray(offset, offset + 2 + length);
    const payload = segment.subarray(4);

    if (marker === 0xda) {
      // Start of scan: everything from here on is image data — copied as is.
      if (orientation !== 1 && !wroteOrientation) out.bytes(jpegOrientationSegment(orientation));
      out.bytes(src.subarray(offset));
      return out.result();
    }
    if (marker === 0xe1 && startsWith(payload, EXIF_HEADER)) {
      orientation = tiffOrientation(payload.subarray(EXIF_HEADER.length)) ?? orientation;
    } else if (keepJpegSegment(marker, payload)) {
      // Our minimal EXIF goes after the kept APPn segments, before the tables and frame header.
      if (orientation !== 1 && !wroteOrientation && (marker < 0xe0 || marker > 0xef)) {
        out.bytes(jpegOrientationSegment(orientation));
        wroteOrientation = true;
      }
      out.bytes(segment);
    }
    offset += 2 + length;
  }
  throw new Error('JPEG without image data.');
}

/** APP0 (JFIF), ICC profiles (APP2 "ICC_PROFILE"), Adobe (APP14, needed to decode CMYK) and all non-APP segments
 * except comments. Every other APPn (EXIF, XMP, IPTC/Photoshop, maker data) is dropped. */
function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker < 0xe0 || marker > 0xef) return true;
  if (marker === 0xe0) return true;
  if (marker === 0xe2) return ascii(payload, 0, 12) === 'ICC_PROFILE\0';
  if (marker === 0xee) return ascii(payload, 0, 5) === 'Adobe';
  return false;
}

function jpegOrientationSegment(orientation: number): Uint8Array {
  const tiff = minimalTiff(orientation);
  const length = 2 + EXIF_HEADER.length + tiff.length;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...EXIF_HEADER, ...tiff]);
}

// --- PNG --------------------------------------------------------------------------------------------------------

const PNG_DROPPED = new Set(['tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf']);

function stripPng(src: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const out = new ByteWriter(src.length);
  out.bytes(src.subarray(0, 8));
  let offset = 8;
  while (offset < src.length) {
    if (offset + 12 > src.length) throw new Error('Truncated PNG chunk.');
    const length = view.getUint32(offset);
    const type = ascii(src, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > src.length) throw new Error('Truncated PNG chunk.');
    if (type === 'eXIf') {
      const orientation = tiffOrientation(src.subarray(offset + 8, offset + 8 + length));
      if (orientation && orientation !== 1) out.bytes(pngChunk('eXIf', minimalTiff(orientation)));
    } else if (!PNG_DROPPED.has(type)) {
      out.bytes(src.subarray(offset, end));
    }
    offset = end;
    if (type === 'IEND') return out.result();
  }
  throw new Error('PNG without IEND.');
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(asciiBytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// --- WebP -------------------------------------------------------------------------------------------------------

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(src: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > src.length) throw new Error('Truncated WebP.');
  const chunks: Uint8Array[] = [];
  let orientation = 1;
  let vp8x: Uint8Array | undefined;
  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) throw new Error('Truncated WebP chunk.');
    const type = ascii(src, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size & 1);
    if (end > riffEnd) throw new Error('Truncated WebP chunk.');
    if (type === 'EXIF') {
      const data = src.subarray(offset + 8, offset + 8 + size);
      // Some writers keep the JPEG-style "Exif\0\0" prefix.
      orientation = tiffOrientation(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data) ?? orientation;
    } else if (type !== 'XMP ') {
      const chunk = src.slice(offset, end);
      if (type === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    offset = end;
  }

  const keepExif = orientation !== 1 && vp8x !== undefined;
  if (vp8x) vp8x[8] = (vp8x[8] & ~(VP8X_EXIF | VP8X_XMP)) | (keepExif ? VP8X_EXIF : 0);
  if (keepExif) chunks.push(webpChunk('EXIF', minimalTiff(orientation)));

  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new ByteWriter(12 + body);
  out.bytes(asciiBytes('RIFF'));
  out.uint32le(4 + body);
  out.bytes(asciiBytes('WEBP'));
  chunks.forEach((c) => out.bytes(c));
  return out.result();
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(asciiBytes(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

// --- TIFF (inside EXIF) -----------------------------------------------------------------------------------------

const ORIENTATION_TAG = 0x0112;

/** The orientation (1–8) in a TIFF structure's first IFD, if any. */
export function tiffOrientation(tiff: Uint8Array): number | undefined {
  if (tiff.length < 8) return undefined;
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const le = order === 'II';
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return undefined;
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > tiff.length) return undefined;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (view.getUint16(entry, le) === ORIENTATION_TAG && view.getUint16(entry + 2, le) === 3) {
      const value = view.getUint16(entry + 8, le);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** Big-endian TIFF with one IFD holding only the orientation. */
export function minimalTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(out.buffer);
  out.set(asciiBytes('MM'), 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, ORIENTATION_TAG);
  view.setUint16(12, 3); // SHORT
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  view.setUint32(22, 0); // no next IFD
  return out;
}

// --- helpers ----------------------------------------------------------------------------------------------------

class ByteWriter {
  private buffer: Uint8Array<ArrayBuffer>;
  private length = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(capacity, 64));
  }

  bytes(b: Uint8Array): void {
    this.reserve(b.length);
    this.buffer.set(b, this.length);
    this.length += b.length;
  }

  uint32le(n: number): void {
    this.reserve(4);
    new DataView(this.buffer.buffer).setUint32(this.length, n, true);
    this.length += 4;
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

const asciiBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const startsWith = (b: Uint8Array, prefix: readonly number[]) => prefix.every((x, i) => b[i] === x);

let crcTable: Uint32Array | undefined;

export function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
