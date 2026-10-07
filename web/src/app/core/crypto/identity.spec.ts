import { fromBase64Url, toBase64Url } from './encoding';
import { createIdentity, supportsIdentityKeys, verifyIdentity } from './identity';

describe('identity', () => {
  it('creates a self-signed bundle of 32-byte public keys', async () => {
    const { bundle } = await createIdentity('team-sync');
    expect(fromBase64Url(bundle.ed25519Pub).byteLength).toBe(32);
    expect(fromBase64Url(bundle.x25519Pub).byteLength).toBe(32);
    expect(fromBase64Url(bundle.sig).byteLength).toBe(64);
    expect(await verifyIdentity(bundle, 'team-sync')).toBeDefined();
  });

  it('is fresh every time (calls can’t be linked by key)', async () => {
    const a = await createIdentity('team-sync');
    const b = await createIdentity('team-sync');
    expect(a.bundle.ed25519Pub).not.toBe(b.bundle.ed25519Pub);
  });

  it('keeps private keys non-extractable', async () => {
    const { signing, agreement } = await createIdentity('team-sync');
    expect(signing.privateKey.extractable).toBe(false);
    expect(agreement.privateKey.extractable).toBe(false);
  });

  it('rejects a bundle replayed into another room', async () => {
    const { bundle } = await createIdentity('team-sync');
    expect(await verifyIdentity(bundle, 'other-room')).toBeUndefined();
  });

  it('rejects a bundle whose agreement key was swapped', async () => {
    const mine = await createIdentity('team-sync');
    const attacker = await createIdentity('team-sync');
    expect(
      await verifyIdentity({ ...mine.bundle, x25519Pub: attacker.bundle.x25519Pub }, 'team-sync'),
    ).toBeUndefined();
  });

  it('rejects malformed bundles', async () => {
    const { bundle } = await createIdentity('team-sync');
    const short = toBase64Url(new Uint8Array(31));
    for (const bad of [
      { ...bundle, ed25519Pub: short },
      { ...bundle, sig: 'not base64url!' },
      { ...bundle, sig: toBase64Url(new Uint8Array(64)) },
    ]) {
      expect(await verifyIdentity(bad, 'team-sync')).toBeUndefined();
    }
  });

  it('detects Ed25519 and X25519 support', async () => {
    expect(await supportsIdentityKeys()).toBe(true);
  });
});
