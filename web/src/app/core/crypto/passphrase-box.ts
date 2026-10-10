import { fromBase64Url, toBase64Url, utf8 } from './encoding';

/**
 * Passphrase encryption for backup files (host keys, the device key): PBKDF2-SHA-256 → AES-GCM-256, WebCrypto only.
 * The caller's AAD binds the file's public header (kind, public keys, iterations) to the ciphertext.
 */
export interface PassphraseBox {
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

export type BackupProblem = 'malformed' | 'locked' | 'mismatch';

/** `locked`: wrong passphrase (or a tampered file); `mismatch`: the keys don't match what the file says they are. */
export class BackupError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(`Key backup: ${problem}.`);
  }
}

export const BACKUP_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Refuse files that would make us spin forever or that are too weak to have come from us. */
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 10_000_000;

export async function seal(
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
  passphrase: string,
  iterations = BACKUP_ITERATIONS,
): Promise<PassphraseBox> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error('Passphrase too short.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passphraseKey(passphrase, salt, iterations, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext),
  );
  return { iterations, salt: toBase64Url(salt), iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/** The plaintext (the caller wipes it). Throws BackupError: `malformed` for a bad box, `locked` if it won't open. */
export async function open(
  box: PassphraseBox,
  aad: Uint8Array<ArrayBuffer>,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  let salt: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>;
  try {
    [salt, iv, ct] = [box.salt, box.iv, box.ct].map(fromBase64Url);
  } catch {
    throw new BackupError('malformed');
  }
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || !validIterations(box.iterations))
    throw new BackupError('malformed');
  try {
    const key = await passphraseKey(passphrase, salt, box.iterations, ['decrypt']);
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct),
    );
  } catch {
    throw new BackupError('locked');
  }
}

export const validIterations = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= MIN_ITERATIONS && (n as number) <= MAX_ITERATIONS;

async function passphraseKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    utf8(passphrase.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}
