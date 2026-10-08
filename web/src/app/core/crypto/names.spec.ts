import { PADDED_NAME_BYTES, cleanName, padName, unpadName } from './names';

describe('names', () => {
  it('round-trips through padding, trimmed', () => {
    expect(unpadName(padName('  Alex  '))).toBe('Alex');
    expect(unpadName(padName('Олександр 🙂'))).toBe('Олександр 🙂');
  });

  it('pads every name to the same size', () => {
    expect(padName('A').byteLength).toBe(PADDED_NAME_BYTES);
    expect(padName('🙂'.repeat(64)).byteLength).toBe(PADDED_NAME_BYTES);
  });

  it('caps names at 64 characters', () => expect([...cleanName('x'.repeat(100))]).toHaveLength(64));

  it('rejects anything padName could not have produced', () => {
    const padded = padName('Alex');
    const trailing = padded.slice();
    trailing[PADDED_NAME_BYTES - 1] = 1;
    const empty = new Uint8Array(PADDED_NAME_BYTES);
    const invalidUtf8 = padded.slice();
    invalidUtf8[2] = 0xff;
    for (const bad of [padded.slice(1), trailing, empty, invalidUtf8])
      expect(() => unpadName(bad)).toThrow();
  });
});
