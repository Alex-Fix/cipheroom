import { fields, fromBase64Url, parseFields, toBase64Url, utf8 } from './encoding';
import { HostKey, HostKeyMaterial, hostKeyFrom, wipe } from './host-key';

/**
 * The host key backup file: the private keys encrypted with a passphrase (PBKDF2-SHA-256 → AES-GCM-256, WebCrypto
 * only). It is the only way to move a meeting to another browser; it can only be made right after the meeting is
 * created, because stored host keys are non-extractable.
 */
export interface HostKeyBackup {
  v: 1;
  kind: 'cipheroom-host-key';
  roomId: string;
  hostEd25519Pub: string;
  hostX25519Pub: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

export type BackupProblem = 'malformed' | 'locked' | 'mismatch';

/** `locked`: wrong passphrase (or a tampered file); `mismatch`: keys don't match the meeting the file names. */
export class BackupError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(`Host key backup: ${problem}.`);
  }
}

export const BACKUP_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Refuse files that would make us spin forever or that are too weak to have come from us. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const AAD_LABEL = 'cipheroom/host-backup/v1';
const KEYS_LABEL = 'cipheroom/host-backup-keys/v1';

export async function exportBackup(
  hostKey: HostKey,
  material: HostKeyMaterial,
  passphrase: string,
  iterations = BACKUP_ITERATIONS,
): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error('Passphrase too short.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passphraseKey(passphrase, salt, iterations, ['encrypt']);
  const plaintext = fields(KEYS_LABEL, material.ed25519Pkcs8, material.x25519Pkcs8);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad(hostKey.roomId, hostKey.ed25519Pub, hostKey.x25519Pub, iterations),
      },
      key,
      plaintext,
    ),
  );
  plaintext.fill(0);
  const backup: HostKeyBackup = {
    v: 1,
    kind: 'cipheroom-host-key',
    roomId: hostKey.roomId,
    hostEd25519Pub: hostKey.ed25519Pub,
    hostX25519Pub: hostKey.x25519Pub,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ct: toBase64Url(ct),
  };
  return JSON.stringify(backup, null, 2);
}

/** Unlocks a backup into a non-extractable host key. Throws BackupError. */
export async function importBackup(text: string, passphrase: string): Promise<HostKey> {
  const backup = parse(text);
  let salt: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>;
  try {
    [salt, iv, ct] = [backup.salt, backup.iv, backup.ct].map(fromBase64Url);
  } catch {
    throw new BackupError('malformed');
  }
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new BackupError('malformed');

  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    const key = await passphraseKey(passphrase, salt, backup.iterations, ['decrypt']);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: aad(
            backup.roomId,
            backup.hostEd25519Pub,
            backup.hostX25519Pub,
            backup.iterations,
          ),
        },
        key,
        ct,
      ),
    );
  } catch {
    throw new BackupError('locked');
  }

  let material: HostKeyMaterial | undefined;
  try {
    const [label, ed25519Pkcs8, x25519Pkcs8, ...rest] = parseFields(plaintext);
    if (
      new TextDecoder().decode(label) !== KEYS_LABEL ||
      !ed25519Pkcs8 ||
      !x25519Pkcs8 ||
      rest.length
    ) {
      throw new Error('Bad keys.');
    }
    material = { ed25519Pkcs8, x25519Pkcs8 };
    const hostKey = await hostKeyFrom(material);
    if (
      hostKey.roomId !== backup.roomId ||
      hostKey.ed25519Pub !== backup.hostEd25519Pub ||
      hostKey.x25519Pub !== backup.hostX25519Pub
    ) {
      throw new BackupError('mismatch');
    }
    return hostKey;
  } catch (e) {
    throw e instanceof BackupError ? e : new BackupError('malformed');
  } finally {
    plaintext.fill(0);
    if (material) wipe(material);
  }
}

/** File name for the download (no personal data). */
export const backupFileName = (roomId: string): string =>
  `cipheroom-host-${roomId.slice(0, 8)}.key`;

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

function aad(
  roomId: string,
  ed25519Pub: string,
  x25519Pub: string,
  iterations: number,
): Uint8Array<ArrayBuffer> {
  return fields(AAD_LABEL, roomId, ed25519Pub, x25519Pub, iterations);
}

function parse(text: string): HostKeyBackup {
  try {
    const backup = JSON.parse(text) as HostKeyBackup;
    const strings = ['roomId', 'hostEd25519Pub', 'hostX25519Pub', 'salt', 'iv', 'ct'] as const;
    if (
      backup?.v !== 1 ||
      backup.kind !== 'cipheroom-host-key' ||
      backup.kdf !== 'PBKDF2-SHA256' ||
      !strings.every((k) => typeof backup[k] === 'string') ||
      !Number.isInteger(backup.iterations) ||
      backup.iterations < MIN_ITERATIONS ||
      backup.iterations > MAX_ITERATIONS
    ) {
      throw new Error('Bad shape.');
    }
    return backup;
  } catch {
    throw new BackupError('malformed');
  }
}
