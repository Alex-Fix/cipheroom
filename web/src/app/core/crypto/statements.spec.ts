import { AuthorityDto } from '../signaling/signaling.types';
import { fields, toBase32, toBase64Url } from './encoding';
import { deriveRoomId, hostAttestationMessage } from './host-key';
import { createIdentity } from './identity';
import {
  coHostMessage,
  endMessage,
  isAdmitted,
  isAdmitter,
  muteMessage,
  revokeMessage,
  settingsMessage,
  sign,
  ticketMessage,
  verify,
  verifyAuthority,
} from './statements';

/**
 * tests/fixtures/admission-vectors.json — signed by Node's WebCrypto and checked by the api's tests too
 * (AdmissionVectorTests): both sides must encode and verify exactly the same bytes.
 */
const V = {
  fieldsSampleHex: '000000056c6162656c00000002c3a90000000400000007000000020102',
  hostEd25519Pub: 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w',
  hostX25519Pub: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
  roomId: 'efddmex6ms7upv5eyuy3bo5oqm',
  identity: 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q',
  guest: '7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E',
  attestation:
    'WtdWxIhxNtCUnolPinW-b5O-sZ84suSyDpziKLz20x4L4Lmnj2bPvBIafoqY313ldLAXVk3E3rf-WkOyKaJ9Aw',
  ticket: 'eM_aqBChdyzeCc-P4LyFe0mu1JlTxqMOiTpGzP4yrvrpcGG2TqiBWcgv5-208D68aGK-J7x251pPwb2_Nfw5BQ',
  coHost: 'anBBmOj8XgzSy8hzC6xgeZjSEIkxSbWm_hTBp-FVGXS5hFoj4dhPwJmuMiddify5Z1wfb6I2NyjsFWizKC6wAw',
  revoke: 'tuk4o8DxHra_1QqGObHnCEjWaak9JaW1KrAZ4kuqpcFGLlISxZmyO-_hYPd_v1FqWDoZ9nMDwf0MXQ4WBLLEDQ',
  settings:
    'lNBmTR3AHpcs0dokndpbrJdbE2lJkF5mXDSujM8E5-I1c5Xlep4RR6wNNwAXZV75QNfECo6wj8_L1FQw774FDA',
  end: 'MhxK8CC5RyV-8JmBAHWdkwpoxznmT2alU62XJdwDqUfoinwuFmclXu0AfYTmLc7Rag1H9tmWtrTlsMiD8wCRCg',
  mute: 'G7Sj1bahpIqFiogoImvybgXj25wHrbrGy1Ds-JLAcil9rwRupO4KJ5YvPBc3VONenWFBNxUbBELY83QX8c6hDg',
};

const pub = (b64: string) =>
  Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function authority(overrides: Partial<AuthorityDto> = {}): AuthorityDto {
  return {
    hostEd25519Pub: V.hostEd25519Pub,
    hostX25519Pub: V.hostX25519Pub,
    hosts: [{ identity: V.identity, sig: V.attestation }],
    coHosts: [],
    revoked: [],
    settings: null,
    admitters: [],
    ...overrides,
  };
}

describe('statements', () => {
  describe('shared vectors (same bytes as the api)', () => {
    it('encodes fields and derives the room id like the api', async () => {
      const sample = fields('label', 'é', 7, new Uint8Array([1, 2]));
      expect([...sample].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
        V.fieldsSampleHex,
      );
      expect(await deriveRoomId(pub(V.hostEd25519Pub), pub(V.hostX25519Pub))).toBe(V.roomId);
      expect(toBase32(new Uint8Array([0xff]))).toBe('74');
    });

    it('verifies every statement', async () => {
      expect(
        await verify(V.hostEd25519Pub, hostAttestationMessage(V.roomId, V.identity), V.attestation),
      ).toBe(true);
      expect(await verify(V.identity, ticketMessage(V.roomId, V.identity, V.guest), V.ticket)).toBe(
        true,
      );
      expect(await verify(V.identity, coHostMessage(V.roomId, V.identity, V.guest), V.coHost)).toBe(
        true,
      );
      expect(await verify(V.identity, revokeMessage(V.roomId, V.identity, V.guest), V.revoke)).toBe(
        true,
      );
      expect(
        await verify(V.identity, settingsMessage(V.roomId, V.identity, 3, true), V.settings),
      ).toBe(true);
      expect(await verify(V.identity, endMessage(V.roomId, V.identity), V.end)).toBe(true);
      expect(await verify(V.identity, muteMessage(V.roomId, V.identity, V.guest, 5), V.mute)).toBe(
        true,
      );
    });

    it('never verifies a statement for another purpose, room or signer', async () => {
      expect(await verify(V.identity, coHostMessage(V.roomId, V.identity, V.guest), V.ticket)).toBe(
        false,
      );
      expect(
        await verify(
          V.identity,
          ticketMessage('aaaaaaaaaaaaaaaaaaaaaaaaaa', V.identity, V.guest),
          V.ticket,
        ),
      ).toBe(false);
      expect(await verify(V.guest, ticketMessage(V.roomId, V.identity, V.guest), V.ticket)).toBe(
        false,
      );
      expect(
        await verify(V.identity, ticketMessage(V.roomId, V.identity, V.guest), 'garbage'),
      ).toBe(false);
    });
  });

  it('never accepts a signature from a small-order key', async () => {
    const zero = toBase64Url(new Uint8Array(32));
    for (let i = 0; i < 20; i++) {
      const message = crypto.getRandomValues(new Uint8Array(32));
      expect(await verify(zero, message, toBase64Url(new Uint8Array(64)))).toBe(false);
    }
  });

  describe('verifyAuthority', () => {
    it('trusts hosts the host key attested, and co-hosts and removals a host signed', async () => {
      const verified = await verifyAuthority(
        V.roomId,
        authority({
          coHosts: [{ subject: V.guest, issuer: V.identity, sig: V.coHost }],
          revoked: [{ subject: V.guest, issuer: V.identity, sig: V.revoke }],
          settings: { issuer: V.identity, seq: 3, autoAdmit: true, sig: V.settings },
        }),
      );
      expect(verified.hostKeysValid).toBe(true);
      expect([...verified.hosts]).toEqual([V.identity]);
      expect([...verified.coHosts]).toEqual([V.guest]);
      expect([...verified.revoked]).toEqual([V.guest]);
      expect(verified).toMatchObject({ autoAdmit: true, settingsSeq: 3 });
      expect(isAdmitter(verified, V.identity)).toBe(true);
      expect(isAdmitter(verified, V.guest)).toBe(false); // removed
    });

    it('trusts nobody when the host keys don’t match the room — a server can’t appoint a host', async () => {
      const verified = await verifyAuthority('aaaaaaaaaaaaaaaaaaaaaaaaaa', authority());
      expect(verified.hostKeysValid).toBe(false);
      expect(verified.hosts.size).toBe(0);
    });

    it('ignores statements that don’t verify', async () => {
      const verified = await verifyAuthority(
        V.roomId,
        authority({
          hosts: [{ identity: V.guest, sig: V.attestation }],
          coHosts: [{ subject: V.identity, issuer: V.guest, sig: V.coHost }],
          settings: { issuer: V.identity, seq: 3, autoAdmit: false, sig: V.settings },
        }),
      );
      expect(verified.hosts.size).toBe(0);
      expect(verified.coHosts.size).toBe(0);
      expect(verified.autoAdmit).toBe(false);
    });
  });

  describe('isAdmitted', () => {
    it('admits the attested host and ticket holders, and nobody else', async () => {
      const verified = await verifyAuthority(V.roomId, authority());
      const guest = { ed25519Pub: V.guest, x25519Pub: V.hostX25519Pub, sig: '' };
      const host = { ...guest, ed25519Pub: V.identity };
      const stranger = await createIdentity(V.roomId);

      expect(await isAdmitted(V.roomId, verified, host, null)).toBe(true);
      expect(
        await isAdmitted(V.roomId, verified, guest, { issuer: V.identity, sig: V.ticket }),
      ).toBe(true);
      expect(await isAdmitted(V.roomId, verified, guest, null)).toBe(false);
      expect(
        await isAdmitted(V.roomId, verified, stranger.bundle, {
          issuer: V.identity,
          sig: V.ticket,
        }),
      ).toBe(false);

      // A ticket signed by someone without authority counts for nothing, even if the signature is fine.
      const selfIssued = await sign(
        stranger,
        ticketMessage(V.roomId, stranger.bundle.ed25519Pub, V.guest),
      );
      expect(
        await isAdmitted(V.roomId, verified, guest, {
          issuer: stranger.bundle.ed25519Pub,
          sig: selfIssued,
        }),
      ).toBe(false);
      expect(toBase64Url(pub(V.guest))).toBe(V.guest);
    });
  });
});
