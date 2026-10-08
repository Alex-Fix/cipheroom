import { utf8 } from './encoding';

/**
 * The key-agreement step shared by sender-key envelopes and knocks: X25519 between an ephemeral key and the
 * recipient's identity key, then HKDF-SHA-256 (salt = room id, info = what it's for) to a non-extractable AES-GCM key.
 */
export async function agreedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  roomId: string,
  info: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(roomId), info: utf8(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}
