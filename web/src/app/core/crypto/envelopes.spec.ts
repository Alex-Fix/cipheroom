import { fromBase64Url, toBase64Url, utf8 } from './encoding';
import {
  EnvelopeError,
  EnvelopeHeader,
  EnvelopeRejection,
  MAX_ENVELOPE_BLOB,
  keyIndexOf,
  openEnvelope,
  sealEnvelope,
} from './envelopes';
import { Identity, VerifiedIdentity, createIdentity, verifyIdentity } from './identity';

const ROOM = 'team-sync';

async function participant(): Promise<{ identity: Identity; verified: VerifiedIdentity }> {
  const identity = await createIdentity(ROOM);
  return { identity, verified: (await verifyIdentity(identity.bundle, ROOM))! };
}

function header(epoch = 5): EnvelopeHeader {
  return { roomId: ROOM, epoch, keyIndex: keyIndexOf(epoch), fromId: 'alice', toId: 'bob' };
}

const expected: { roomId: string; selfId: string; fromId: string; lastEpoch?: number } = {
  roomId: ROOM,
  selfId: 'bob',
  fromId: 'alice',
};

async function rejection(promise: Promise<unknown>): Promise<EnvelopeRejection | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof EnvelopeError) return e.reason;
    throw e;
  }
}

/** Decodes a blob, applies `change` to its JSON and re-encodes it (a tampering server). */
function tamper(blob: string, change: (wire: Record<string, unknown>) => void): string {
  const wire = JSON.parse(new TextDecoder().decode(fromBase64Url(blob)));
  change(wire);
  return toBase64Url(utf8(JSON.stringify(wire)));
}

describe('envelopes', () => {
  let alice: Awaited<ReturnType<typeof participant>>;
  let bob: Awaited<ReturnType<typeof participant>>;
  let senderKey: Uint8Array<ArrayBuffer>;
  let blob: string;

  beforeAll(async () => {
    alice = await participant();
    bob = await participant();
    senderKey = crypto.getRandomValues(new Uint8Array(32));
    blob = await sealEnvelope(header(), senderKey, alice.identity, bob.verified);
  });

  const open = (b: string, exp = expected, recipient = bob.identity, sender = alice.verified) =>
    openEnvelope(b, exp, recipient, sender);

  it('delivers the sender key to its recipient', async () => {
    const opened = await open(blob);
    expect(new Uint8Array(opened.senderKey)).toEqual(senderKey);
    expect(opened).toMatchObject({ epoch: 5, keyIndex: 5 });
  });

  it('is opaque and small enough for the server to relay', () => {
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blob.length).toBeLessThanOrEqual(MAX_ENVELOPE_BLOB);
    // The sender key never appears in the clear.
    expect(new TextDecoder().decode(fromBase64Url(blob))).not.toContain(toBase64Url(senderKey));
  });

  it('can’t be opened by anyone but the recipient', async () => {
    const carol = await participant();
    expect(await rejection(open(blob, { ...expected, selfId: 'carol' }, carol.identity))).toBe(
      'wrong-recipient',
    );
    // Even if a malicious server relabels it for Carol, she can't decrypt it.
    const relabelled = await sealEnvelope(
      { ...header(), toId: 'carol' },
      senderKey,
      alice.identity,
      bob.verified,
    );
    expect(
      await rejection(open(relabelled, { ...expected, selfId: 'carol' }, carol.identity)),
    ).toBe('undecryptable');
  });

  it.each([
    ['roomId', 'other-room'],
    ['epoch', 21],
    ['fromId', 'mallory'],
    ['toId', 'carol'],
  ])('rejects a tampered header (%s)', async (field, value) => {
    const tampered = tamper(blob, (w) => {
      w[field] = value;
      if (field === 'epoch') w['keyIndex'] = keyIndexOf(value as number);
    });
    expect(await rejection(open(tampered))).toBe('bad-signature');
  });

  it.each(['eph', 'iv', 'ct', 'sig'])('rejects a tampered %s', async (field) => {
    const tampered = tamper(blob, (w) => {
      const bytes = fromBase64Url(w[field] as string);
      bytes[0] ^= 0x01;
      w[field] = toBase64Url(bytes);
    });
    expect(await rejection(open(tampered))).toBe('bad-signature');
  });

  it('rejects an envelope signed by someone other than the participant it claims to be from', async () => {
    const mallory = await participant();
    const forged = await sealEnvelope(header(), senderKey, mallory.identity, bob.verified);
    expect(await rejection(open(forged))).toBe('bad-signature');
  });

  it('rejects an envelope the server attributes to another sender', async () => {
    expect(await rejection(open(blob, { ...expected, fromId: 'carol' }))).toBe('wrong-sender');
  });

  it('rejects an envelope for another room', async () => {
    expect(await rejection(open(blob, { ...expected, roomId: 'other-room' }))).toBe('wrong-room');
  });

  it('rejects replayed and older epochs', async () => {
    expect(await rejection(open(blob, { ...expected, lastEpoch: 4 }))).toBeUndefined();
    expect(await rejection(open(blob, { ...expected, lastEpoch: 5 }))).toBe('stale-epoch');
    expect(await rejection(open(blob, { ...expected, lastEpoch: 9 }))).toBe('stale-epoch');
  });

  it('rejects malformed blobs', async () => {
    const malformed = [
      'not base64url!',
      toBase64Url(utf8('not json')),
      tamper(blob, (w) => (w['v'] = 2)),
      tamper(blob, (w) => (w['keyIndex'] = 6)), // must be epoch mod 16
      tamper(blob, (w) => delete w['sig']),
      'A'.repeat(MAX_ENVELOPE_BLOB + 1),
    ];
    for (const bad of malformed) expect(await rejection(open(bad))).toBe('malformed');
  });

  it('refuses to seal bad keys or indexes', async () => {
    await expect(
      sealEnvelope(header(), new Uint8Array(16), alice.identity, bob.verified),
    ).rejects.toThrow('Invalid sender key.');
    await expect(
      sealEnvelope({ ...header(), keyIndex: 0 }, senderKey, alice.identity, bob.verified),
    ).rejects.toThrow('Invalid key index.');
  });

  it('uses a fresh ephemeral key and IV for every envelope', async () => {
    const again = await sealEnvelope(header(), senderKey, alice.identity, bob.verified);
    const a = JSON.parse(new TextDecoder().decode(fromBase64Url(blob)));
    const b = JSON.parse(new TextDecoder().decode(fromBase64Url(again)));
    expect(b.eph).not.toBe(a.eph);
    expect(b.iv).not.toBe(a.iv);
  });
});
