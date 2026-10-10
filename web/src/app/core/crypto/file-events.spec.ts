import { ChatEvent, MAX_CHAT_BLOB, chatKey, isChatEvent, openChat, sealChat } from './chat-crypto';
import { toBase64Url } from './encoding';
import { MAX_FILE_BYTES, newFileId } from './file-crypto';
import { FileCard, MAX_RANGES, MAX_THUMB_CHARS, isFileEvent } from './file-events';
import { createIdentity } from './identity';

const b64 = (n: number) => toBase64Url(new Uint8Array(n).fill(9));
const CHANNEL = 'AAAAAAAAAAAAAAAAAAAAAA';

const card = (overrides: Partial<FileCard> = {}): FileCard => ({
  v: 1,
  seq: 1,
  type: 'file',
  id: newFileId(),
  name: 'photo.jpg',
  size: 1234,
  mime: 'image/jpeg',
  hash: b64(32),
  key: b64(32),
  ...overrides,
});

const event = (body: Record<string, unknown>) => ({ v: 1, seq: 1, ...body });

describe('file events', () => {
  it('accepts the shapes we send', () => {
    const file = newFileId();
    for (const e of [
      card(),
      card({ thumb: b64(100), mime: '' }),
      event({ type: 'file-request', file }),
      event({ type: 'file-request', file, ranges: [[0, 3], [7, 8]] }),
      event({ type: 'file-channel', file, channel: CHANNEL, to: ['0123456789abcdef'], ranges: [[0, 1]] }),
      event({ type: 'file-ready', file, channel: CHANNEL }),
      event({ type: 'file-gone', file }),
    ]) {
      expect(isChatEvent(e), JSON.stringify(e)).toBe(true);
    }
  });

  it('rejects cards a server or a modified client could abuse', () => {
    for (const bad of [
      card({ size: 0 }),
      card({ size: MAX_FILE_BYTES + 1 }),
      card({ size: 1.5 }),
      card({ name: '../evil.sh' }),
      card({ name: 'a‮b' }),
      card({ mime: 'text/html; charset=x' }),
      card({ key: b64(16) }),
      card({ hash: 'not base64!' }),
      card({ thumb: 'x'.repeat(MAX_THUMB_CHARS + 1) }),
      { ...card(), extra: 1 },
    ]) {
      expect(isFileEvent(bad as unknown as Record<string, unknown>), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('rejects malformed requests and channel announcements', () => {
    const file = newFileId();
    for (const bad of [
      event({ type: 'file-request', file: 'short' }),
      event({ type: 'file-request', file, ranges: [] }),
      event({ type: 'file-request', file, ranges: [[3, 3]] }),
      event({ type: 'file-request', file, ranges: [[-1, 2]] }),
      event({ type: 'file-request', file, ranges: Array.from({ length: MAX_RANGES + 1 }, (_, i) => [i, i + 1]) }),
      event({ type: 'file-channel', file, channel: 'bad', to: ['0123456789abcdef'], ranges: [[0, 1]] }),
      event({ type: 'file-channel', file, channel: CHANNEL, to: [], ranges: [[0, 1]] }),
      event({ type: 'file-channel', file, channel: CHANNEL, to: ['Alice'], ranges: [[0, 1]] }),
      event({ type: 'file-unknown', file }),
    ]) {
      expect(isFileEvent(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('the largest card fits a chat event under the server’s limit', async () => {
    const alice = await createIdentity('room');
    const key = await chatKey(crypto.getRandomValues(new Uint8Array(32)));
    const largest = card({ name: '𝒳'.repeat(255), mime: `application/${'x'.repeat(100)}`, thumb: 'A'.repeat(MAX_THUMB_CHARS) });

    const blob = await sealChat({ roomId: 'room', fromId: 'alice', keyIndex: 0, key }, largest, alice);

    expect(blob.length).toBeLessThanOrEqual(MAX_CHAT_BLOB);
    expect(await openChat(blob, { roomId: 'room', fromId: 'alice', key }, alice.bundle.ed25519Pub)).toEqual(largest as ChatEvent);
  });
});
