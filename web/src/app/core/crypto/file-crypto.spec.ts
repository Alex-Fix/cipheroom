import { toBase64Url } from './encoding';
import {
  CHUNK_BYTES,
  FileContext,
  FileError,
  FileRejection,
  chunkCount,
  chunkHash,
  cleanFileName,
  contentHash,
  frameIndex,
  importFileKey,
  newFileId,
  newFileKey,
  openChunk,
  sealChunk,
} from './file-crypto';

const ROOM = 'team-sync';

async function rejection(promise: Promise<unknown>): Promise<FileRejection | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof FileError) return e.reason;
    throw e;
  }
}

async function context(total = 3): Promise<FileContext & { raw: string }> {
  const { raw, key } = await newFileKey();
  return { roomId: ROOM, fileId: newFileId(), total, key, raw };
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('file-crypto', () => {
  it('round-trips a chunk, with the recipient importing the key from the card', async () => {
    const sender = await context();
    const frame = await sealChunk(sender, 1, bytes(CHUNK_BYTES));

    const recipient = { ...sender, key: await importFileKey(sender.raw) };
    const { index, chunk } = await openChunk(recipient, frame);

    expect(index).toBe(1);
    expect(chunk).toEqual(bytes(CHUNK_BYTES));
    expect(frame.byteLength).toBe(1 + 4 + 12 + CHUNK_BYTES + 16);
  });

  it('keeps keys non-extractable', async () => {
    const { key } = await newFileKey();
    expect(key.extractable).toBe(false);
  });

  it('uses a fresh IV for every seal of the same chunk', async () => {
    const c = await context();
    const a = await sealChunk(c, 0, bytes(10));
    const b = await sealChunk(c, 0, bytes(10));
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });

  it('rejects a tampered frame', async () => {
    const c = await context();
    const frame = await sealChunk(c, 0, bytes(100));
    frame[frame.byteLength - 1] ^= 1;
    expect(await rejection(openChunk(c, frame))).toBe('undecryptable');
  });

  it('rejects a chunk moved to another index', async () => {
    const c = await context();
    const frame = await sealChunk(c, 0, bytes(100));
    new DataView(frame.buffer).setUint32(1, 2);
    expect(await rejection(openChunk(c, frame))).toBe('undecryptable');
  });

  it('binds the total: a truncated or extended file fails', async () => {
    const c = await context(3);
    const frame = await sealChunk(c, 1, bytes(100));
    expect(await rejection(openChunk({ ...c, total: 2 }, frame))).toBe('undecryptable');
    expect(await rejection(openChunk({ ...c, total: 4 }, frame))).toBe('undecryptable');
    const last = await sealChunk(c, 2, bytes(100));
    expect(await rejection(openChunk({ ...c, total: 2 }, last))).toBe('wrong-chunk');
  });

  it('binds room and file', async () => {
    const c = await context();
    const frame = await sealChunk(c, 0, bytes(100));
    expect(await rejection(openChunk({ ...c, roomId: 'other' }, frame))).toBe('undecryptable');
    expect(await rejection(openChunk({ ...c, fileId: newFileId() }, frame))).toBe('undecryptable');
    expect(await rejection(openChunk({ ...c, key: (await newFileKey()).key }, frame))).toBe('undecryptable');
  });

  it('rejects malformed frames before decrypting', async () => {
    const c = await context();
    expect(() => frameIndex(new Uint8Array(10))).toThrow(FileError);
    const frame = await sealChunk(c, 0, bytes(100));
    frame[0] = 2;
    expect(await rejection(openChunk(c, frame))).toBe('malformed');
    expect(await rejection(importFileKey(toBase64Url(bytes(16))))).toBe('malformed');
  });

  it('refuses to seal out-of-range or oversized chunks', async () => {
    const c = await context(2);
    await expect(sealChunk(c, 2, bytes(1))).rejects.toThrow();
    await expect(sealChunk(c, 0, bytes(CHUNK_BYTES + 1))).rejects.toThrow();
    await expect(sealChunk(c, 0, bytes(0))).rejects.toThrow();
  });

  it('hashes content from chunk hashes, bound to the size', async () => {
    const size = CHUNK_BYTES + 5;
    const chunks = [bytes(CHUNK_BYTES, 1), bytes(5, 2)];
    const hashes = await Promise.all(chunks.map(chunkHash));

    const hash = await contentHash(size, hashes);

    expect(hash).toBe(await contentHash(size, hashes));
    expect(hash).not.toBe(await contentHash(size, [hashes[1], hashes[0]]));
    expect(hash).not.toBe(await contentHash(size, [hashes[0], await chunkHash(bytes(5, 3))]));
    await expect(contentHash(size, [hashes[0]])).rejects.toThrow();
    expect(chunkCount(size)).toBe(2);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
  });

  it('cleans file names', () => {
    expect(cleanFileName('  report.pdf ')).toBe('report.pdf');
    expect(cleanFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(cleanFileName('C:\\Users\\x.txt')).toBe('C:Usersx.txt');
    expect(cleanFileName('.bashrc')).toBe('bashrc');
    expect(cleanFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(cleanFileName('a\u0000b\nc')).toBe('abc');
    expect(cleanFileName('...')).toBe('file');
    expect([...cleanFileName('é'.repeat(300))].length).toBe(255);
  });
});
