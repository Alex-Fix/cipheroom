import { canStrip, crc32, minimalTiff, stripImageMetadata, tiffOrientation } from './image-metadata';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const has = (bytes: Uint8Array, needle: string) => new TextDecoder('latin1').decode(bytes).includes(needle);

/** Little-endian TIFF: orientation plus a fake GPS tag and a string we must not leak. */
function exifTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(8 + 2 + 2 * 12 + 4 + 16);
  const v = new DataView(out.buffer);
  out.set(enc('II'), 0);
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  v.setUint16(8, 2, true);
  v.setUint16(10, 0x0112, true);
  v.setUint16(12, 3, true);
  v.setUint32(14, 1, true);
  v.setUint16(18, orientation, true);
  v.setUint16(22, 0x8825, true); // GPS IFD pointer
  v.setUint16(24, 4, true);
  v.setUint32(26, 1, true);
  v.setUint32(30, 38, true);
  out.set(enc('GPS-51.5N-0.12W!'), 38);
  return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return cat([0xff, marker, length >> 8, length & 0xff], payload);
}

const SCAN = cat([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6], [0x11, 0x22, 0xff, 0x00, 0x33], [0xff, 0xd9]);
const DQT = segment(0xdb, Uint8Array.from({ length: 65 }, (_, i) => i));
const SOF = segment(0xc0, Uint8Array.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));

function jpeg(...segments: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return cat([0xff, 0xd8], ...segments, SCAN);
}

function png(...chunks: [string, Uint8Array][]): Uint8Array<ArrayBuffer> {
  const parts = chunks.map(([type, data]) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(enc(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  });
  return cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...parts);
}

function webp(...chunks: [string, Uint8Array][]): Uint8Array<ArrayBuffer> {
  const body = cat(
    ...chunks.map(([type, data]) => {
      const out = new Uint8Array(8 + data.length + (data.length & 1));
      out.set(enc(type), 0);
      new DataView(out.buffer).setUint32(4, data.length, true);
      out.set(data, 8);
      return out;
    }),
  );
  const head = new Uint8Array(12);
  head.set(enc('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, 4 + body.length, true);
  head.set(enc('WEBP'), 8);
  return cat(head, body);
}

describe('stripImageMetadata', () => {
  describe('JPEG', () => {
    it('drops EXIF (GPS), XMP, IPTC and comments but keeps JFIF, ICC, tables and the image data byte for byte', () => {
      const source = jpeg(
        segment(0xe0, cat(enc('JFIF\0'), [1, 2, 0, 0, 1, 0, 1, 0, 0])),
        segment(0xe1, cat(enc('Exif\0\0'), exifTiff(1))),
        segment(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Secret Street 1</x:xmpmeta>')),
        segment(0xe2, cat(enc('ICC_PROFILE\0'), [1, 1, 9, 9])),
        segment(0xed, enc('Photoshop 3.0\0IPTC by Jane')),
        segment(0xfe, enc('shot at home')),
        DQT,
        SOF,
      );

      const { bytes, stripped } = stripImageMetadata(source);

      expect(stripped).toBe(true);
      for (const secret of ['GPS-51.5N', 'Secret Street', 'IPTC by Jane', 'shot at home', 'Exif']) {
        expect(has(bytes, secret)).toBe(false);
      }
      expect(has(bytes, 'JFIF')).toBe(true);
      expect(has(bytes, 'ICC_PROFILE')).toBe(true);
      // Tables, frame header and scan unchanged, in order, at the end.
      expect([...bytes.subarray(bytes.length - (DQT.length + SOF.length + SCAN.length))]).toEqual([...cat(DQT, SOF, SCAN)]);
    });

    it('keeps the orientation as a minimal EXIF block before the tables', () => {
      const source = jpeg(segment(0xe1, cat(enc('Exif\0\0'), exifTiff(6))), DQT, SOF);

      const { bytes } = stripImageMetadata(source);

      expect(has(bytes, 'GPS-51.5N')).toBe(false);
      const app1 = bytes.subarray(2, 2 + 4 + 6 + 26);
      expect([...app1.subarray(0, 2)]).toEqual([0xff, 0xe1]);
      expect(tiffOrientation(app1.subarray(10))).toBe(6);
      expect([...bytes.subarray(2 + app1.length, 2 + app1.length + 2)]).toEqual([0xff, 0xdb]);
    });

    it('keeps the Adobe segment that CMYK images need', () => {
      const { bytes } = stripImageMetadata(jpeg(segment(0xee, enc('Adobe\0d\0\0\0\0\x01')), DQT, SOF));
      expect(has(bytes, 'Adobe')).toBe(true);
    });

    it('returns a truncated file unchanged, marked as not stripped', () => {
      const source = jpeg(segment(0xe1, cat(enc('Exif\0\0'), exifTiff(1))), DQT).subarray(0, 30);
      const result = stripImageMetadata(source.slice());
      expect(result.stripped).toBe(false);
      expect(result.bytes).toEqual(source);
    });
  });

  describe('PNG', () => {
    it('drops text, time and EXIF chunks and keeps image chunks unchanged', () => {
      const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
      const idat = Uint8Array.from([1, 2, 3, 4, 5]);
      const source = png(
        ['IHDR', ihdr],
        ['tEXt', enc('Author\0Jane Doe')],
        ['iTXt', enc('XML:com.adobe.xmp\0\0\0\0\0Secret Street')],
        ['tIME', Uint8Array.from([7, 234, 10, 10, 12, 0, 0])],
        ['eXIf', exifTiff(1)],
        ['IDAT', idat],
        ['IEND', new Uint8Array(0)],
      );

      const { bytes, stripped } = stripImageMetadata(source);

      expect(stripped).toBe(true);
      expect(bytes).toEqual(png(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]));
    });

    it('keeps a non-default orientation as a minimal eXIf chunk with a valid CRC', () => {
      const source = png(['IHDR', new Uint8Array(13)], ['eXIf', exifTiff(3)], ['IEND', new Uint8Array(0)]);

      const { bytes } = stripImageMetadata(source);

      expect(bytes).toEqual(png(['IHDR', new Uint8Array(13)], ['eXIf', minimalTiff(3)], ['IEND', new Uint8Array(0)]));
    });
  });

  describe('WebP', () => {
    it('drops EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size', () => {
      const vp8x = Uint8Array.from([0x0c | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // EXIF + XMP + alpha flags
      const image = Uint8Array.from([9, 8, 7]);
      const source = webp(['VP8X', vp8x], ['VP8L', image], ['EXIF', exifTiff(1)], ['XMP ', enc('Secret Street')]);

      const { bytes } = stripImageMetadata(source);

      expect(bytes).toEqual(webp(['VP8X', Uint8Array.from([0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])], ['VP8L', image]));
    });

    it('keeps a non-default orientation, with the EXIF flag set', () => {
      const vp8x = Uint8Array.from([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const source = webp(['VP8X', vp8x], ['VP8 ', Uint8Array.from([1, 2])], ['EXIF', cat(enc('Exif\0\0'), exifTiff(8))]);

      const { bytes } = stripImageMetadata(source);

      expect(bytes).toEqual(webp(['VP8X', vp8x], ['VP8 ', Uint8Array.from([1, 2])], ['EXIF', minimalTiff(8)]));
      expect(has(bytes, 'GPS')).toBe(false);
    });
  });

  it('leaves other files alone', () => {
    const gif = enc('GIF89a....');
    expect(stripImageMetadata(gif)).toEqual({ bytes: gif, stripped: false });
    expect(canStrip(gif)).toBe(false);
    expect(canStrip(jpeg(DQT))).toBe(true);
  });

  it('reads orientation from both byte orders', () => {
    expect(tiffOrientation(exifTiff(5))).toBe(5);
    expect(tiffOrientation(minimalTiff(7))).toBe(7);
    expect(tiffOrientation(enc('nope'))).toBeUndefined();
  });

  it('computes the PNG CRC-32', () => {
    expect(crc32(enc('IEND'))).toBe(0xae426082);
  });
});
