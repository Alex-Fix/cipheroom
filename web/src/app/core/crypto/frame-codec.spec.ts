import {
  TAG_BYTES,
  TRAILER_BYTES,
  clearHeaderBytes,
  decryptFrame,
  encryptFrame,
  frameKeyIndex,
  isSupportedCodec,
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

/** VP8 frame: P bit (lowest bit of byte 0) is 0 on keyframes. */
function vp8Frame(keyframe: boolean, length = 64): Uint8Array<ArrayBuffer> {
  const frame = crypto.getRandomValues(new Uint8Array(length));
  frame[0] = keyframe ? frame[0] & 0xfe : frame[0] | 0x01;
  return frame;
}

describe('frame codec', () => {
  it('keeps the VP8 payload header in the clear: 10 bytes on keyframes, 3 on delta frames', () => {
    expect(clearHeaderBytes('video', vp8Frame(true))).toBe(10);
    expect(clearHeaderBytes('video', vp8Frame(false))).toBe(3);
    expect(clearHeaderBytes('video', vp8Frame(true, 4))).toBe(4);
    expect(clearHeaderBytes('audio', vp8Frame(true))).toBe(0);
  });

  it.each([
    ['video', vp8Frame(true)],
    ['video', vp8Frame(false)],
    ['audio', crypto.getRandomValues(new Uint8Array(80))],
  ] as const)('round-trips a %s frame', async (kind, frame) => {
    const key = await aesKey();
    const encrypted = await encryptFrame(kind, frame, key, 3, 41n);

    const clear = clearHeaderBytes(kind, frame);
    expect(encrypted.byteLength).toBe(frame.byteLength + TAG_BYTES + TRAILER_BYTES);
    expect(encrypted.subarray(0, clear)).toEqual(frame.subarray(0, clear));
    expect(encrypted.subarray(clear, frame.byteLength)).not.toEqual(frame.subarray(clear));
    expect(frameKeyIndex(kind, encrypted)).toBe(3);
    expect(await decryptFrame(kind, encrypted, key)).toEqual(frame);
  });

  it('uses a different IV per counter', async () => {
    const key = await aesKey();
    const frame = vp8Frame(false);
    const a = await encryptFrame('video', frame, key, 0, 1n);
    const b = await encryptFrame('video', frame, key, 0, 2n);
    expect(a.subarray(3, frame.byteLength)).not.toEqual(b.subarray(3, frame.byteLength));
  });

  it('rejects a tampered clear header, ciphertext or trailer', async () => {
    const key = await aesKey();
    const encrypted = await encryptFrame('video', vp8Frame(true), key, 0, 7n);
    for (const index of [1, 20, encrypted.byteLength - 3]) {
      const tampered = encrypted.slice();
      tampered[index] ^= 0x01;
      await expect(decryptFrame('video', tampered, key)).rejects.toThrow();
    }
  });

  it('rejects a frame encrypted under another key', async () => {
    const encrypted = await encryptFrame('audio', new Uint8Array(40), await aesKey(), 0, 0n);
    await expect(decryptFrame('audio', encrypted, await aesKey())).rejects.toThrow();
  });

  it('rejects frames too short to be encrypted', async () => {
    const short = new Uint8Array(TAG_BYTES + TRAILER_BYTES - 1);
    expect(frameKeyIndex('audio', short)).toBeUndefined();
    await expect(decryptFrame('audio', short, await aesKey())).rejects.toThrow();
  });

  it('allows VP8 and Opus only (unknown codec allowed: not every browser reports it)', () => {
    expect(isSupportedCodec('video', 'video/VP8')).toBe(true);
    expect(isSupportedCodec('video', 'video/H264')).toBe(false);
    expect(isSupportedCodec('audio', 'audio/opus')).toBe(true);
    expect(isSupportedCodec('audio', 'audio/PCMU')).toBe(false);
    expect(isSupportedCodec('video', undefined)).toBe(true);
  });
});
