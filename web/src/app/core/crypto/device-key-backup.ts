import { fields, parseFields } from './encoding';
import { DeviceKey, DeviceKeyMaterial, deviceKeyFrom, wipeDeviceMaterial } from './device-key';
import { BACKUP_ITERATIONS, BackupError, open, seal, validIterations } from './passphrase-box';

/**
 * The device key backup file: the private key encrypted with a passphrase (same scheme as host-key backups). It
 * restores this identity after clearing site data, or on another device — people who know us still recognise us.
 */
export interface DeviceKeyBackup {
  v: 1;
  kind: 'cipheroom-device-key';
  devicePub: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

const AAD_LABEL = 'cipheroom/device-backup/v1';
const KEY_LABEL = 'cipheroom/device-backup-key/v1';

export async function exportDeviceBackup(
  deviceKey: DeviceKey,
  material: DeviceKeyMaterial,
  passphrase: string,
  iterations = BACKUP_ITERATIONS,
): Promise<string> {
  const plaintext = fields(KEY_LABEL, material.pkcs8);
  try {
    const box = await seal(plaintext, aad(deviceKey.pub, iterations), passphrase, iterations);
    const backup: DeviceKeyBackup = {
      v: 1,
      kind: 'cipheroom-device-key',
      devicePub: deviceKey.pub,
      kdf: 'PBKDF2-SHA256',
      ...box,
    };
    return JSON.stringify(backup, null, 2);
  } finally {
    plaintext.fill(0);
  }
}

/** Unlocks a backup into a non-extractable device key. Throws BackupError. */
export async function importDeviceBackup(text: string, passphrase: string): Promise<DeviceKey> {
  const backup = parse(text);
  const plaintext = await open(backup, aad(backup.devicePub, backup.iterations), passphrase);
  let material: DeviceKeyMaterial | undefined;
  try {
    const [label, pkcs8, ...rest] = parseFields(plaintext);
    if (new TextDecoder().decode(label) !== KEY_LABEL || !pkcs8 || rest.length)
      throw new Error('Bad key.');
    material = { pkcs8 };
    const deviceKey = await deviceKeyFrom(material);
    if (deviceKey.pub !== backup.devicePub) throw new BackupError('mismatch');
    return deviceKey;
  } catch (e) {
    throw e instanceof BackupError ? e : new BackupError('malformed');
  } finally {
    plaintext.fill(0);
    if (material) wipeDeviceMaterial(material);
  }
}

/** Which kind of backup a file is, without unlocking it (the home page has one "Import" for both). */
export function backupKind(text: string): 'host' | 'device' | undefined {
  try {
    const kind = (JSON.parse(text) as { kind?: unknown })?.kind;
    return kind === 'cipheroom-host-key'
      ? 'host'
      : kind === 'cipheroom-device-key'
        ? 'device'
        : undefined;
  } catch {
    return undefined;
  }
}

/** File name for the download (no personal data). */
export const deviceBackupFileName = (devicePub: string): string =>
  `cipheroom-identity-${devicePub.slice(0, 8).replace(/[^A-Za-z0-9]/g, 'x')}.key`;

const aad = (devicePub: string, iterations: number) => fields(AAD_LABEL, devicePub, iterations);

function parse(text: string): DeviceKeyBackup {
  try {
    const backup = JSON.parse(text) as DeviceKeyBackup;
    if (
      backup?.v !== 1 ||
      backup.kind !== 'cipheroom-device-key' ||
      backup.kdf !== 'PBKDF2-SHA256' ||
      !(['devicePub', 'salt', 'iv', 'ct'] as const).every((k) => typeof backup[k] === 'string') ||
      !validIterations(backup.iterations)
    ) {
      throw new Error('Bad shape.');
    }
    return backup;
  } catch {
    throw new BackupError('malformed');
  }
}
