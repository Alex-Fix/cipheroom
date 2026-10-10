import { createDeviceKey } from './device-key';
import {
  backupKind,
  deviceBackupFileName,
  exportDeviceBackup,
  importDeviceBackup,
} from './device-key-backup';
import { BackupError, BackupProblem } from './passphrase-box';

const PASS = 'correct horse battery staple';
const FAST = 100_000; // the minimum, to keep tests quick

async function problem(promise: Promise<unknown>): Promise<BackupProblem | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof BackupError) return e.problem;
    throw e;
  }
}

describe('device key backup', () => {
  it('restores the same identity, non-extractable', async () => {
    const { deviceKey, material } = await createDeviceKey();
    const file = await exportDeviceBackup(deviceKey, material, PASS, FAST);
    expect(file).not.toContain(PASS);
    expect(backupKind(file)).toBe('device');

    const restored = await importDeviceBackup(file, PASS);
    expect(restored.pub).toBe(deviceKey.pub);
    expect(restored.signing.extractable).toBe(false);
  });

  it('refuses a wrong passphrase, a tampered file, a swapped public key and junk', async () => {
    const { deviceKey, material } = await createDeviceKey();
    const file = await exportDeviceBackup(deviceKey, material, PASS, FAST);
    expect(await problem(importDeviceBackup(file, 'wrong passphrase!'))).toBe('locked');

    const other = (await createDeviceKey()).deviceKey.pub;
    const swapped = JSON.stringify({ ...JSON.parse(file), devicePub: other });
    expect(await problem(importDeviceBackup(swapped, PASS))).toBe('locked'); // the public key is in the AAD

    expect(await problem(importDeviceBackup('{"kind":"cipheroom-device-key"}', PASS))).toBe(
      'malformed',
    );
    expect(await problem(importDeviceBackup('not json', PASS))).toBe('malformed');
    const weak = JSON.stringify({ ...JSON.parse(file), iterations: 10 });
    expect(await problem(importDeviceBackup(weak, PASS))).toBe('malformed');
  });

  it('tells the backup kinds apart, and names files without personal data', () => {
    expect(backupKind('{"kind":"cipheroom-host-key"}')).toBe('host');
    expect(backupKind('{"kind":"other"}')).toBeUndefined();
    expect(backupKind('nope')).toBeUndefined();
    expect(deviceBackupFileName('AbCd-_xyz123')).toBe('cipheroom-identity-AbCdxxxy.key');
  });
});
