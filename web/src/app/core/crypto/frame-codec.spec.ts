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

  it('rejects codec byte 3 (reserved: it was AV1)', async () => {
    const key = await aesKey();
    const encrypted = await encryptFrame(
      'vp9',
      crypto.getRandomValues(new Uint8Array(64)),
      key,
      0,
      7n,
    );
    encrypted[encrypted.byteLength - 2] = 3;

    expect(encryptedFrameCodec(encrypted)).toBeUndefined();
    await expect(decryptFrame(encrypted, key, any)).rejects.toThrow('Unexpected frame codec.');
  });

  it('rejects frames too short to be encrypted, or with an unknown codec byte', async () => {
    const short = new Uint8Array(TAG_BYTES + TRAILER_BYTES - 1);
    expect(frameKeyIndex(short)).toBeUndefined();
    await expect(decryptFrame(short, await aesKey(), any)).rejects.toThrow();

    const unknown = new Uint8Array(TAG_BYTES + TRAILER_BYTES);
    unknown[unknown.byteLength - 2] = 9;
    expect(encryptedFrameCodec(unknown)).toBeUndefined();
  });

  it('maps reported codecs to layouts: VP8, VP9 and Opus only', () => {
    expect(frameCodecOf('video', 'video/VP8')).toBe('vp8');
    expect(frameCodecOf('video', 'video/VP9')).toBe('vp9');
    expect(frameCodecOf('video', 'video/AV1')).toBeUndefined();
    expect(frameCodecOf('video', 'video/H264')).toBeUndefined();
    expect(frameCodecOf('audio', 'audio/opus')).toBe('audio');
    expect(frameCodecOf('audio', 'audio/PCMU')).toBeUndefined();
  });

  it('uses the negotiated codec when the browser doesn’t report one', () => {
    expect(frameCodecOf('video', undefined)).toBe('vp8');
    expect(frameCodecOf('video', undefined, 'vp9')).toBe('vp9');
    expect(frameCodecOf('audio', undefined)).toBe('audio');
  });
});
