import { fields, fromBase64Url, toBase64Url } from './encoding';

/**
 * Per-call device identity: an Ed25519 signing key and an X25519 agreement key, created at join and kept in memory
 * only (fresh every call — calls can't be linked by key). Private keys are non-extractable. The public bundle is
 * self-signed over the room id, binding the X25519 key to the Ed25519 key that the safety code covers.
 */
export interface Identity {
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
  bundle: IdentityBundle;
}

/** Public keys only, as sent to the server (`IdentityDto`): base64url. */
export interface IdentityBundle {
  ed25519Pub: string;
  x25519Pub: string;
  sig: string;
}

/** Another participant's bundle after its signature checked out. */
export interface VerifiedIdentity {
  bundle: IdentityBundle;
  signing: CryptoKey;
  agreement: CryptoKey;
}

export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
const BUNDLE_LABEL = 'cipheroom/id/v1';

export async function createIdentity(roomId: string): Promise<Identity> {
  const signing = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const agreement = (await crypto.subtle.generateKey('X25519', false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ed25519Pub = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
  const x25519Pub = new Uint8Array(await crypto.subtle.exportKey('raw', agreement.publicKey));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      signing.privateKey,
      bundleMessage(roomId, ed25519Pub, x25519Pub),
    ),
  );
  return {
    signing,
    agreement,
    bundle: {
      ed25519Pub: toBase64Url(ed25519Pub),
      x25519Pub: toBase64Url(x25519Pub),
      sig: toBase64Url(sig),
    },
  };
}

/** `undefined` when the bundle is malformed or its signature doesn't verify for this room. */
export async function verifyIdentity(
  bundle: IdentityBundle,
  roomId: string,
): Promise<VerifiedIdentity | undefined> {
  try {
    const ed25519Pub = fromBase64Url(bundle.ed25519Pub);
    const x25519Pub = fromBase64Url(bundle.x25519Pub);
    const sig = fromBase64Url(bundle.sig);
    if (
      ed25519Pub.byteLength !== PUBLIC_KEY_BYTES ||
      x25519Pub.byteLength !== PUBLIC_KEY_BYTES ||
      sig.byteLength !== SIGNATURE_BYTES
    ) {
      return undefined;
    }
    const signing = await crypto.subtle.importKey('raw', ed25519Pub, 'Ed25519', true, ['verify']);
    const valid = await crypto.subtle.verify(
      'Ed25519',
      signing,
      sig,
      bundleMessage(roomId, ed25519Pub, x25519Pub),
    );
    if (!valid) return undefined;
    const agreement = await crypto.subtle.importKey('raw', x25519Pub, 'X25519', true, []);
    return { bundle, signing, agreement };
  } catch {
    return undefined;
  }
}

/** Whether this browser's WebCrypto has Ed25519 and X25519 (no P-256 fallback by design). */
export async function supportsIdentityKeys(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

function bundleMessage(
  roomId: string,
  ed25519Pub: Uint8Array,
  x25519Pub: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return fields(BUNDLE_LABEL, roomId, ed25519Pub, x25519Pub);
}
