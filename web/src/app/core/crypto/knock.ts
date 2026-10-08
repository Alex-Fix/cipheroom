import { agreedKey } from './agreement';
import { fields, fromBase64Url, toBase64Url, utf8 } from './encoding';
import { Identity, PUBLIC_KEY_BYTES, SIGNATURE_BYTES, VerifiedIdentity } from './identity';
import { padName, unpadName } from './names';

/**
 * A knock: a lobby guest's display name, encrypted to one admitter (so the server never learns it) and signed by the
 * guest's per-call identity. Same construction as key envelopes, its own labels.
 *
 *   k    = HKDF-SHA-256(X25519(ephemeral, admitter), salt = roomId, info = "cipheroom/knock/v1")
 *   aad  = fields("cipheroom/knock-header/v1", roomId, guestEd25519Pub, admitterEd25519Pub)
 *   ct   = AES-GCM(k, iv, aad, padded name)
 *   sig  = Ed25519(guest, fields("cipheroom/knock-sig/v1", aad, eph, iv, ct))
 *   blob = base64url(JSON { v: 1, eph, iv, ct, sig })
 */
export const MAX_KNOCK_BLOB = 2048;
const INFO = 'cipheroom/knock/v1';
const HEADER_LABEL = 'cipheroom/knock-header/v1';
const SIGNATURE_LABEL = 'cipheroom/knock-sig/v1';

interface WireKnock {
  v: 1;
  eph: string;
  iv: string;
  ct: string;
  sig: string;
}

export async function sealKnock(
  roomId: string,
  name: string,
  guest: Identity,
  admitter: VerifiedIdentity,
): Promise<string> {
  const ephemeral = (await crypto.subtle.generateKey('X25519', false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const eph = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const key = await agreedKey(ephemeral.privateKey, admitter.agreement, roomId, INFO, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = header(roomId, guest.bundle.ed25519Pub, admitter.bundle.ed25519Pub);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, padName(name)),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      guest.signing.privateKey,
      fields(SIGNATURE_LABEL, aad, eph, iv, ct),
    ),
  );
  const wire: WireKnock = {
    v: 1,
    eph: toBase64Url(eph),
    iv: toBase64Url(iv),
    ct: toBase64Url(ct),
    sig: toBase64Url(sig),
  };
  return toBase64Url(utf8(JSON.stringify(wire)));
}

/** The guest's name, or undefined if the knock isn't from `guest` to us in this room (nothing of it is used then). */
export async function openKnock(
  roomId: string,
  blob: string,
  self: Identity,
  guest: VerifiedIdentity,
): Promise<string | undefined> {
  try {
    if (blob.length > MAX_KNOCK_BLOB) return undefined;
    const wire = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(blob)),
    ) as WireKnock;
    if (wire?.v !== 1) return undefined;
    const [eph, iv, ct, sig] = [wire.eph, wire.iv, wire.ct, wire.sig].map(fromBase64Url);
    if (
      eph.byteLength !== PUBLIC_KEY_BYTES ||
      iv.byteLength !== 12 ||
      sig.byteLength !== SIGNATURE_BYTES
    )
      return undefined;

    const aad = header(roomId, guest.bundle.ed25519Pub, self.bundle.ed25519Pub);
    const signed = await crypto.subtle.verify(
      'Ed25519',
      guest.signing,
      sig,
      fields(SIGNATURE_LABEL, aad, eph, iv, ct),
    );
    if (!signed) return undefined;

    const ephKey = await crypto.subtle.importKey('raw', eph, 'X25519', false, []);
    const key = await agreedKey(self.agreement.privateKey, ephKey, roomId, INFO, ['decrypt']);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct),
    );
    return unpadName(padded);
  } catch {
    return undefined;
  }
}

function header(roomId: string, guestPub: string, admitterPub: string): Uint8Array<ArrayBuffer> {
  return fields(HEADER_LABEL, roomId, fromBase64Url(guestPub), fromBase64Url(admitterPub));
}
