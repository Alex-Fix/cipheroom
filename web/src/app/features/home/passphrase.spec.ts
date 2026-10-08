import { passphraseStrength } from './passphrase';

describe('passphraseStrength', () => {
  it.each([
    ['short', 'too-short'],
    ['abcdefghijkl', 'weak'],
    ['abcdefghijklmnop', 'good'],
    ['Abcdefgh1234', 'good'],
    ['correct horse battery staple', 'strong'],
    ['Tr0ub4dor&3-and-more!', 'strong'],
  ] as const)('%s → %s', (passphrase, strength) =>
    expect(passphraseStrength(passphrase)).toBe(strength),
  );
});
