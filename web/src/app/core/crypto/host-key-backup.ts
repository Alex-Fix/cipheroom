import { fields, parseFields } from './encoding';
import { HostKey, HostKeyMaterial, hostKeyFrom, wipe } from './host-key';
import { BACKUP_ITERATIONS, BackupError, open, seal, validIterations } from './passphrase-box';

export { BACKUP_ITERATIONS, BackupError, MIN_PASSPHRASE_LENGTH } from './passphrase-box';
export type { BackupProblem } from './passphrase-box';

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

const AAD_LABEL = 'cipheroom/host-backup/v1';
const KEYS_LABEL = 'cipheroom/host-backup-keys/v1';

export async function exportBackup(
  hostKey: HostKey,
  material: HostKeyMaterial,
  passphrase: string,
  iterations = BACKUP_ITERATIONS,
): Promise<string> {
  const plaintext = fields(KEYS_LABEL, material.ed25519Pkcs8, material.x25519Pkcs8);
  try {
    const box = await seal(
      plaintext,
      aad(hostKey.roomId, hostKey.ed25519Pub, hostKey.x25519Pub, iterations),
      passphrase,
      iterations,
    );
    const backup: HostKeyBackup = {
      v: 1,
      kind: 'cipheroom-host-key',
      roomId: hostKey.roomId,
      hostEd25519Pub: hostKey.ed25519Pub,
      hostX25519Pub: hostKey.x25519Pub,
      kdf: 'PBKDF2-SHA256',
      ...box,
    };
    return JSON.stringify(backup, null, 2);
  } finally {
    plaintext.fill(0);
  }
}

/** Unlocks a backup into a non-extractable host key. Throws BackupError. */
export async function importBackup(text: string, passphrase: string): Promise<HostKey> {
  const backup = parse(text);
  const plaintext = await open(
    backup,
    aad(backup.roomId, backup.hostEd25519Pub, backup.hostX25519Pub, backup.iterations),
    passphrase,
  );

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
      !validIterations(backup.iterations)
    ) {
      throw new Error('Bad shape.');
    }
    return backup;
  } catch {
    throw new BackupError('malformed');
  }
}
