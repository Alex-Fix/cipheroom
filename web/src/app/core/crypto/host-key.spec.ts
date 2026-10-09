import { fromBase64Url } from './encoding';
import {
  createHostKey,
  deriveRoomId,
  hostKeyFrom,
  signHostAttestation,
  hostAttestationMessage,
  ROOM_ID_PATTERN,
} from './host-key';

describe('host key', () => {
  it('derives the room id from its public keys', async () => {
    const { hostKey } = await createHostKey();
    expect(hostKey.roomId).toMatch(ROOM_ID_PATTERN);
    expect(
      await deriveRoomId(fromBase64Url(hostKey.ed25519Pub), fromBase64Url(hostKey.x25519Pub)),
    ).toBe(hostKey.roomId);
  });

  it('keeps the signing key non-extractable and no X25519 private key at all', async () => {
    const { hostKey } = await createHostKey();
    expect(hostKey.signing.extractable).toBe(false);
    // WebKit can't read X25519 CryptoKeys back from IndexedDB: only Ed25519 keys may be stored (Safari, iOS).
    const stored = Object.values(hostKey).filter((v) => v instanceof CryptoKey) as CryptoKey[];
    expect(stored.map((k) => k.algorithm.name)).toEqual(['Ed25519']);
  });

  it('is the same meeting when imported from its private keys', async () => {
    const { hostKey, material } = await createHostKey();
    const again = await hostKeyFrom(material);
    expect([again.roomId, again.ed25519Pub, again.x25519Pub]).toEqual([
      hostKey.roomId,
      hostKey.ed25519Pub,
      hostKey.x25519Pub,
    ]);
  });

  it('attests a per-call identity with a signature anyone can check against the room', async () => {
    const { hostKey } = await createHostKey();
    const identity = 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q';
    const sig = await signHostAttestation(hostKey, identity);
    const pub = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(hostKey.ed25519Pub),
      'Ed25519',
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        pub,
        fromBase64Url(sig),
        hostAttestationMessage(hostKey.roomId, identity),
      ),
    ).toBe(true);
  });
});
