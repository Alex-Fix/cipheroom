import { TestBed } from '@angular/core/testing';
import { CryptoService } from './crypto.service';
import { verifyIdentity } from './identity';

describe('CryptoService', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [CryptoService] });
    crypto = TestBed.inject(CryptoService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a verifiable identity for the room', async () => {
    const bundle = await crypto.identityBundle('team-sync');
    expect(await verifyIdentity(bundle, 'team-sync')).toBeDefined();
  });

  it('keeps the identity for the call, so rejoining keeps the safety code', async () => {
    const first = await crypto.identityBundle('team-sync');
    expect(await crypto.identityBundle('team-sync')).toBe(first);
  });

  it('never reuses an identity in another room', async () => {
    const first = await crypto.identityBundle('team-sync');
    expect((await crypto.identityBundle('other-room')).ed25519Pub).not.toBe(first.ed25519Pub);
  });

  it('refuses to join without Ed25519/X25519 support', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockRejectedValue(
      new DOMException('', 'NotSupportedError'),
    );
    await expect(crypto.identityBundle('team-sync')).rejects.toThrow(
      "This browser can't encrypt calls.",
    );
  });
});
