import { fields, fromBase64Url, toBase64Url } from './encoding';

describe('encoding', () => {
  it('round-trips base64url without padding', () => {
    for (const length of [0, 1, 2, 3, 32, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it('rejects anything that isn’t base64url', () => {
    expect(() => fromBase64Url('a+b/')).toThrow();
    expect(() => fromBase64Url('abc=')).toThrow();
    expect(() => fromBase64Url('abcde')).toThrow();
  });

  it('length-prefixes fields so different splits never encode the same', () => {
    expect(fields('ab', 'c')).not.toEqual(fields('a', 'bc'));
    expect(Array.from(fields('a', 258))).toEqual([0, 0, 0, 1, 97, 0, 0, 0, 4, 0, 0, 1, 2]);
  });
});
