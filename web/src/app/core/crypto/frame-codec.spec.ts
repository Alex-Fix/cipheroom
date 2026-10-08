import {
  FrameCodec,
  TAG_BYTES,
  TRAILER_BYTES,
  clearHeaderBytes,
  decryptFrame,
  encryptFrame,
  encryptedFrameCodec,
  frameCodecOf,
  frameKeyIndex,
} from './frame-codec';

function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

const any = () => true;

/** VP8 frame: P bit (lowest bit of byte 0) is 0 on keyframes. */
function vp8Frame(keyframe: boolean, length = 64): Uint8Array<ArrayBuffer> {
  const frame = crypto.getRandomValues(new Uint8Array(length));
  frame[0] = keyframe ? frame[0] & 0xfe : frame[0] | 0x01;
  return frame;
}

/** OBU header byte: type in bits 6–3, extension flag 0x04, has-size flag 0x02. */
const obuHeader = (type: number, { size = true, extension = false } = {}) =>
  (type << 3) | (extension ? 0x04 : 0) | (size ? 0x02 : 0);

/** Temporal delimiter, sequence header, and a frame OBU with an extension byte and a 200-byte payload. */
function av1Frame(): Uint8Array<ArrayBuffer> {
  const sequence = crypto.getRandomValues(new Uint8Array(12));
  const payload = crypto.getRandomValues(new Uint8Array(200));
  return new Uint8Array([
    obuHeader(2),
    0x00,
    obuHeader(1),
    sequence.byteLength,
    ...sequence,
    obuHeader(6, { extension: true }),
    0x08,
    0xc8,
    0x01,
    ...payload, // leb128(200) = c8 01
  ]);
}

/** OBU (header, payload) pairs, as a receiver-side parser would see them. */
function obus(frame: Uint8Array): { header: number; payload: Uint8Array }[] {
  const out = [];
  let offset = 0;
  while (offset < frame.byteLength) {
    const header = frame[offset];
    offset += header & 0x04 ? 2 : 1;
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = frame[offset++];
      size += (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    out.push({ header, payload: frame.subarray(offset, offset + size) });
    offset += size;
  }
  return out;
}

describe('frame codec', () => {
  it('keeps the VP8 payload header in the clear (10 bytes on keyframes, 3 on delta frames), nothing else', () => {
    expect(clearHeaderBytes('vp8', vp8Frame(true))).toBe(10);
    expect(clearHeaderBytes('vp8', vp8Frame(false))).toBe(3);
    expect(clearHeaderBytes('vp8', vp8Frame(true, 4))).toBe(4);
    expect(clearHeaderBytes('vp9', vp8Frame(true))).toBe(0);
    expect(clearHeaderBytes('audio', vp8Frame(true))).toBe(0);
  });

  it.each([
    ['vp8', vp8Frame(true)],
    ['vp8', vp8Frame(false)],
    ['vp9', crypto.getRandomValues(new Uint8Array(120))],
    ['audio', crypto.getRandomValues(new Uint8Array(80))],
  ] as const)('round-trips a %s frame', async (codec, frame) => {
    const key = await aesKey();
    const encrypted = await encryptFrame(codec, frame, key, 3, 41n);

    const clear = clearHeaderBytes(codec, frame);
    expect(encrypted.byteLength).toBe(frame.byteLength + TAG_BYTES + TRAILER_BYTES);
    expect(encrypted.subarray(0, clear)).toEqual(frame.subarray(0, clear));
    expect(encrypted.subarray(clear, frame.byteLength)).not.toEqual(frame.subarray(clear));
    expect(frameKeyIndex(encrypted)).toBe(3);
    expect(encryptedFrameCodec(encrypted)).toBe(codec);
    expect(await decryptFrame(encrypted, key, any)).toEqual(frame);
  });

  describe('AV1', () => {
    it('keeps the OBU structure: headers clear, payloads encrypted, trailer at the end of the last OBU', async () => {
      const frame = av1Frame();
      const encrypted = await encryptFrame('av1', frame, await aesKey(), 5, 9n);

      const before = obus(frame);
      const after = obus(encrypted);
      expect(after.map((o) => o.header)).toEqual(before.map((o) => o.header));
      expect(after[0].payload.byteLength).toBe(0); // temporal delimiter untouched
      expect(after[1].payload.byteLength).toBe(12 + TAG_BYTES);
      expect(after[2].payload.byteLength).toBe(200 + TAG_BYTES + TRAILER_BYTES);
      expect(after[2].payload.subarray(0, 200)).not.toEqual(before[2].payload);
      expect(frameKeyIndex(encrypted)).toBe(5);
      expect(encryptedFrameCodec(encrypted)).toBe('av1');
    });

    it('round-trips', async () => {
      const key = await aesKey();
      const frame = av1Frame();
      expect(await decryptFrame(await encryptFrame('av1', frame, key, 0, 1n), key, any)).toEqual(
        frame,
      );
    });

    it('still decrypts when the packetizer dropped the temporal delimiter (OBU index skips empty OBUs)', async () => {
      const key = await aesKey();
      const frame = av1Frame();
      const encrypted = await encryptFrame('av1', frame, key, 0, 1n);

      expect(await decryptFrame(encrypted.slice(2), key, any)).toEqual(frame.slice(2));
    });

    it('still decrypts when the last OBU arrives without a size field', async () => {
      const key = await aesKey();
      const frame = new Uint8Array([obuHeader(6), 0x05, 1, 2, 3, 4, 5]);
      const encrypted = await encryptFrame('av1', frame, key, 0, 1n);
      const withoutSize = new Uint8Array([obuHeader(6, { size: false }), ...encrypted.subarray(2)]);

      expect(await decryptFrame(withoutSize, key, any)).toEqual(frame);
    });

    it('rejects a tampered OBU header or payload', async () => {
      const key = await aesKey();
      const encrypted = await encryptFrame('av1', av1Frame(), key, 0, 7n);
      for (const index of [2, 4, 40]) {
        const tampered = encrypted.slice();
        tampered[index] ^= 0x08;
        await expect(decryptFrame(tampered, key, any)).rejects.toThrow();
      }
    });

    it('refuses frames it can’t parse or that have nothing to carry the trailer', async () => {
      const key = await aesKey();
      await expect(
        encryptFrame('av1', new Uint8Array([obuHeader(6), 0x40]), key, 0, 0n),
      ).rejects.toThrow();
      await expect(
        encryptFrame('av1', new Uint8Array([obuHeader(2), 0x00]), key, 0, 0n),
      ).rejects.toThrow();
    });
  });

  it('uses a different IV per counter', async () => {
    const key = await aesKey();
    const frame = vp8Frame(false);
    const a = await encryptFrame('vp8', frame, key, 0, 1n);
    const b = await encryptFrame('vp8', frame, key, 0, 2n);
    expect(a.subarray(3, frame.byteLength)).not.toEqual(b.subarray(3, frame.byteLength));
  });

  it('rejects a tampered clear header, ciphertext or trailer (counter, codec, key index)', async () => {
    const key = await aesKey();
    const encrypted = await encryptFrame('vp8', vp8Frame(true), key, 0, 7n);
    for (const index of [1, 20, encrypted.byteLength - 3, encrypted.byteLength - 1]) {
      const tampered = encrypted.slice();
      tampered[index] ^= 0x01;
      await expect(decryptFrame(tampered, key, any)).rejects.toThrow();
    }
  });

  it('rejects a frame relabelled as another codec, before parsing it as one', async () => {
    const key = await aesKey();
    const encrypted = await encryptFrame(
      'vp9',
      crypto.getRandomValues(new Uint8Array(64)),
      key,
      0,
      7n,
    );

    await expect(decryptFrame(encrypted, key, (c: FrameCodec) => c === 'vp8')).rejects.toThrow(
      'Unexpected frame codec.',
    );
    const relabelled = encrypted.slice();
    relabelled[relabelled.byteLength - 2] = 1; // vp8
    await expect(decryptFrame(relabelled, key, any)).rejects.toThrow();
  });

  it('rejects a frame encrypted under another key', async () => {
    const encrypted = await encryptFrame('audio', new Uint8Array(40), await aesKey(), 0, 0n);
    await expect(decryptFrame(encrypted, await aesKey(), any)).rejects.toThrow();
  });

  it('rejects frames too short to be encrypted, or with an unknown codec byte', async () => {
    const short = new Uint8Array(TAG_BYTES + TRAILER_BYTES - 1);
    expect(frameKeyIndex(short)).toBeUndefined();
    await expect(decryptFrame(short, await aesKey(), any)).rejects.toThrow();

    const unknown = new Uint8Array(TAG_BYTES + TRAILER_BYTES);
    unknown[unknown.byteLength - 2] = 9;
    expect(encryptedFrameCodec(unknown)).toBeUndefined();
  });

  it('maps reported codecs to layouts: VP8, VP9, AV1 and Opus only', () => {
    expect(frameCodecOf('video', 'video/VP8')).toBe('vp8');
    expect(frameCodecOf('video', 'video/VP9')).toBe('vp9');
    expect(frameCodecOf('video', 'video/AV1')).toBe('av1');
    expect(frameCodecOf('video', 'video/H264')).toBeUndefined();
    expect(frameCodecOf('audio', 'audio/opus')).toBe('audio');
    expect(frameCodecOf('audio', 'audio/PCMU')).toBeUndefined();
  });

  it('uses the negotiated codec when the browser doesn’t report one', () => {
    expect(frameCodecOf('video', undefined)).toBe('vp8');
    expect(frameCodecOf('video', undefined, 'av1')).toBe('av1');
    expect(frameCodecOf('audio', undefined)).toBe('audio');
  });
});
