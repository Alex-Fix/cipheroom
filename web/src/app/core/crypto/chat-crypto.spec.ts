import {
  ChatError,
  ChatEvent,
  ChatRejection,
  MAX_CHAT_BLOB,
  MAX_CHAT_TEXT,
  PAD_BUCKETS,
  chatKey,
  chatKeyIndex,
  cleanChatText,
  isChatEvent,
  newChatId,
  openChat,
  pad,
  sealChat,
  unpad,
} from './chat-crypto';
import { fields, fromBase64Url, toBase64Url } from './encoding';
import { Identity, createIdentity } from './identity';
import { sign } from './statements';

const ROOM = 'team-sync';

async function rejection(promise: Promise<unknown>): Promise<ChatRejection | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof ChatError) return e.reason;
    throw e;
  }
}

type ChatMessage = Extract<ChatEvent, { type: 'message' }>;

const message = (text = 'hello', seq = 1): ChatMessage => ({
  v: 1,
  seq,
  type: 'message',
  id: newChatId(),
  text,
});

describe('chat crypto', () => {
  let alice: Identity;
  let mallory: Identity;
  let key: CryptoKey;
  const context = () => ({ roomId: ROOM, fromId: 'alice', keyIndex: 3, key });
  const open = (blob: string, overrides: Partial<{ roomId: string; fromId: string }> = {}) =>
    openChat(blob, { roomId: ROOM, fromId: 'alice', key, ...overrides }, alice.bundle.ed25519Pub);

  beforeAll(async () => {
    alice = await createIdentity(ROOM);
    mallory = await createIdentity(ROOM);
    key = await chatKey(crypto.getRandomValues(new Uint8Array(32)));
  });

  it('round-trips a message and a reaction', async () => {
    const m = message('see https://example.org 👋\nok');
    const blob = await sealChat(context(), m, alice);
    expect(chatKeyIndex(blob)).toBe(3);
    expect(await open(blob)).toEqual(m);

    const r: ChatEvent = { v: 1, seq: 2, type: 'reaction', target: m.id, emoji: '👍', on: true };
    expect(await open(await sealChat(context(), r, alice))).toEqual(r);
  });

  it('pads so that a message and a reaction look the same to the server', async () => {
    const short = await sealChat(context(), message('hi'), alice);
    const reaction = await sealChat(
      context(),
      { v: 1, seq: 2, type: 'reaction', target: newChatId(), emoji: '🎉', on: false },
      alice,
    );
    const longer = await sealChat(context(), message('x'.repeat(300)), alice);
    expect(short.length).toBe(reaction.length);
    expect(short.length).toBe(longer.length);
  });

  it('the largest message fits the largest bucket, under the server’s limit', async () => {
    // 2,000 emoji fit 8 KB; characters JSON escapes (6 bytes each) are the worst case.
    expect((await sealChat(context(), message('😀'.repeat(MAX_CHAT_TEXT)), alice)).length).toBe(
      10963,
    );
    const blob = await sealChat(context(), message('\uD800'.repeat(MAX_CHAT_TEXT)), alice);
    expect(blob.length).toBe(MAX_CHAT_BLOB);
    expect(MAX_CHAT_BLOB).toBeLessThanOrEqual(22528);
  });

  it('derives a different key from the media key for the same sender key', async () => {
    const senderKey = crypto.getRandomValues(new Uint8Array(32));
    const a = await chatKey(senderKey);
    const b = await chatKey(senderKey);
    const blob = await sealChat({ ...context(), key: a }, message(), alice);
    await expect(
      openChat(blob, { roomId: ROOM, fromId: 'alice', key: b }, alice.bundle.ed25519Pub),
    ).resolves.toBeDefined();
    expect(a.extractable).toBe(false);
    await expect(chatKey(new Uint8Array(16))).rejects.toThrow('Invalid sender key.');
  });

  it('rejects another room, a re-attributed sender or another key', async () => {
    const blob = await sealChat(context(), message(), alice);
    expect(await rejection(open(blob, { roomId: 'other-room' }))).toBe('undecryptable');
    expect(await rejection(open(blob, { fromId: 'mallory' }))).toBe('undecryptable');
    const other = await chatKey(crypto.getRandomValues(new Uint8Array(32)));
    expect(
      await rejection(
        openChat(blob, { roomId: ROOM, fromId: 'alice', key: other }, alice.bundle.ed25519Pub),
      ),
    ).toBe('undecryptable');
  });

  it('rejects a changed key index or flipped ciphertext', async () => {
    const bytes = fromBase64Url(await sealChat(context(), message(), alice));
    const relabelled = bytes.slice();
    relabelled[1] = 4;
    expect(await rejection(open(toBase64Url(relabelled)))).toBe('undecryptable');
    const flipped = bytes.slice();
    flipped[40] ^= 1;
    expect(await rejection(open(toBase64Url(flipped)))).toBe('undecryptable');
  });

  it('rejects an event signed by someone else, even under the right key', async () => {
    // Mallory holds Alice's chat key (every member does) and tries to speak as her.
    const forged = await sealChat(context(), message('send me the code'), mallory);
    expect(await rejection(open(forged))).toBe('bad-signature');
  });

  it('rejects malformed blobs', async () => {
    expect(await rejection(open('not base64url!'))).toBe('malformed');
    expect(await rejection(open(toBase64Url(new Uint8Array(40))))).toBe('malformed');
    expect(await rejection(open('A'.repeat(MAX_CHAT_BLOB + 1)))).toBe('malformed');
    const bytes = fromBase64Url(await sealChat(context(), message(), alice));
    const version = bytes.slice();
    version[0] = 2;
    expect(await rejection(open(toBase64Url(version)))).toBe('malformed');
    const index = bytes.slice();
    index[1] = 16;
    expect(() => chatKeyIndex(toBase64Url(index))).toThrow(ChatError);
  });

  it('rejects signed events of the wrong shape', async () => {
    // A well-signed, well-encrypted payload whose JSON isn't one of our events.
    const json = new TextEncoder().encode(
      JSON.stringify({ v: 1, seq: 1, type: 'message', id: 'x', text: 'hi' }),
    );
    const sig = fromBase64Url(await sign(alice, fields('cipheroom/chat-sig/v1', ROOM, json)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: fields('cipheroom/chat-aad/v1', ROOM, 'alice', 3) },
        key,
        pad(fields(json, sig)),
      ),
    );
    const blob = toBase64Url(new Uint8Array([1, 3, ...iv, ...ct]));
    expect(await rejection(open(blob))).toBe('malformed');
  });

  describe('events', () => {
    const id = newChatId();

    it('accepts exactly our shapes', () => {
      expect(isChatEvent({ v: 1, seq: 1, type: 'message', id, text: 'hi' })).toBe(true);
      expect(
        isChatEvent({ v: 1, seq: 9, type: 'reaction', target: id, emoji: '❤️', on: false }),
      ).toBe(true);
    });

    it.each([
      null,
      [],
      { v: 2, seq: 1, type: 'message', id, text: 'hi' },
      { v: 1, seq: 0, type: 'message', id, text: 'hi' },
      { v: 1, seq: 1.5, type: 'message', id, text: 'hi' },
      { v: 1, seq: 1, type: 'message', id: 'short', text: 'hi' },
      { v: 1, seq: 1, type: 'message', id, text: '' },
      { v: 1, seq: 1, type: 'message', id, text: ' padded ' },
      { v: 1, seq: 1, type: 'message', id, text: 'evil‮txt' },
      { v: 1, seq: 1, type: 'message', id, text: 'hi', extra: true },
      { v: 1, seq: 1, type: 'reaction', target: id, emoji: '', on: true },
      { v: 1, seq: 1, type: 'reaction', target: id, emoji: 'x'.repeat(33), on: true },
      { v: 1, seq: 1, type: 'reaction', target: id, emoji: '👍', on: 'yes' },
      { v: 1, seq: 1, type: 'typing' },
    ])('rejects %j', (event) => {
      expect(isChatEvent(event)).toBe(false);
    });
  });

  describe('text', () => {
    it('trims, normalises newlines and keeps tabs and emoji', () => {
      expect(cleanChatText('  hi\r\nthere\t🙂  ')).toBe('hi\nthere\t🙂');
    });

    it('drops control characters and bidi overrides', () => {
      expect(cleanChatText('a\u0000b\u0007c‮d⁦e\u009bf')).toBe('abcdef');
    });

    it('caps the length in characters, not UTF-16 units', () => {
      expect([...cleanChatText('😀'.repeat(MAX_CHAT_TEXT + 5))]).toHaveLength(MAX_CHAT_TEXT);
    });
  });

  describe('padding', () => {
    it('round-trips into the smallest bucket that fits', () => {
      for (const n of [0, 100, 508, 509, 2044, 8000, 16380]) {
        const content = crypto.getRandomValues(new Uint8Array(n));
        const padded = pad(content);
        expect(padded.byteLength).toBe(PAD_BUCKETS.find((b) => b >= n + 4));
        expect(unpad(padded)).toEqual(content);
      }
      expect(() => pad(new Uint8Array(16381))).toThrow('Chat event too large.');
    });

    it('rejects anything pad couldn’t have produced', () => {
      const padded = pad(new Uint8Array([1, 2, 3]));
      expect(() => unpad(padded.slice(0, 500))).toThrow();
      const long = padded.slice();
      long[3] = 255;
      long[2] = 255;
      expect(() => unpad(long)).toThrow();
      const dirty = padded.slice();
      dirty[400] = 1;
      expect(() => unpad(dirty)).toThrow();
    });
  });
});
