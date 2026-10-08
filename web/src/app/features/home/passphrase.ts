import { MIN_PASSPHRASE_LENGTH } from '../../core/crypto/host-key-backup';

export type PassphraseStrength = 'too-short' | 'weak' | 'good' | 'strong';

/**
 * A rough guide, not a guarantee: length matters most (the backup is PBKDF2 with 600k iterations, so every extra
 * character multiplies an offline guesser's work), variety helps a little.
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const length = [...passphrase].length;
  if (length < MIN_PASSPHRASE_LENGTH) return 'too-short';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(passphrase),
  ).length;
  const words = passphrase.trim().split(/\s+/).length;
  if (length >= 20 && (kinds >= 3 || words >= 4)) return 'strong';
  if (length >= 16 || kinds >= 3) return 'good';
  return 'weak';
}

/** Saves text as a file (the encrypted backup) without sending it anywhere. */
export function downloadText(fileName: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
