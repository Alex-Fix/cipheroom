import { createHostKey } from './host-key';
import { BackupError, exportBackup, importBackup } from './host-key-backup';

/** The lowest count importBackup accepts: keeps the tests fast (real backups use 600k). */
const FAST = 100_000;
const PASSPHRASE = 'correct horse battery staple';

async function problem(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof BackupError) return e.problem;
    throw e;
  }
}

describe('host key backup', () => {
  it('restores the same meeting, non-extractable', async () => {
    const { hostKey, material } = await createHostKey();
    const file = await exportBackup(hostKey, material, PASSPHRASE, FAST);

    const restored = await importBackup(file, PASSPHRASE);
    expect(restored.roomId).toBe(hostKey.roomId);
    expect(restored.signing.extractable).toBe(false);
  });

  it('contains no private key material in the clear', async () => {
    const { hostKey, material } = await createHostKey();
    const file = await exportBackup(hostKey, material, PASSPHRASE, FAST);
    const pkcs8 = btoa(String.fromCharCode(...material.ed25519Pkcs8));
    expect(file).not.toContain(pkcs8.slice(20, 40));
    expect(JSON.parse(file)).toMatchObject({
      kind: 'cipheroom-host-key',
      roomId: hostKey.roomId,
      iterations: FAST,
    });
  });

  it('refuses short passphrases', async () => {
    const { hostKey, material } = await createHostKey();
    await expect(exportBackup(hostKey, material, 'short', FAST)).rejects.toThrow(
      'Passphrase too short.',
    );
  });

  it('tells a wrong passphrase and a tampered file apart from files that aren’t backups', async () => {
    const { hostKey, material } = await createHostKey();
    const file = await exportBackup(hostKey, material, PASSPHRASE, FAST);
    const other = await createHostKey();
    const relabelled = JSON.stringify({ ...JSON.parse(file), roomId: other.hostKey.roomId });
    const weakened = JSON.stringify({ ...JSON.parse(file), iterations: 1000 });

    expect(await problem(importBackup(file, 'wrong passphrase!'))).toBe('locked');
    expect(await problem(importBackup(relabelled, PASSPHRASE))).toBe('locked'); // the room id is authenticated
    expect(await problem(importBackup(weakened, PASSPHRASE))).toBe('malformed');
    expect(await problem(importBackup('{"hello":"world"}', PASSPHRASE))).toBe('malformed');
    expect(await problem(importBackup('not json', PASSPHRASE))).toBe('malformed');
  });
});
