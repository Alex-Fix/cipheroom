import { toBase64Url } from './encoding';
import { SAFETY_EMOJI, safetyCode } from './safety-code';

const key = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

describe('safetyCode', () => {
  const [a, b, c] = [key(), key(), key()];

  it('is 4 emoji and 8 digits', async () => {
    const code = await safetyCode('team-sync', [a, b]);
    expect(code.emoji).toHaveLength(4);
    expect(code.digits).toMatch(/^\d{4} \d{4}$/);
    for (const e of code.emoji) expect(SAFETY_EMOJI).toContainEqual([e.symbol, e.name]);
  });

  it('is the same for everyone, whatever order they see participants in', async () => {
    expect(await safetyCode('team-sync', [a, b, c])).toEqual(
      await safetyCode('team-sync', [c, a, b]),
    );
  });

  it('changes when someone joins, leaves or swaps a key', async () => {
    const base = await safetyCode('team-sync', [a, b]);
    expect(await safetyCode('team-sync', [a, b, c])).not.toEqual(base);
    expect(await safetyCode('team-sync', [a])).not.toEqual(base);
    expect(await safetyCode('team-sync', [a, c])).not.toEqual(base);
  });

  it('counts a duplicated key', async () => {
    expect(await safetyCode('team-sync', [a, b, b])).not.toEqual(
      await safetyCode('team-sync', [a, b]),
    );
  });

  it('depends on the room', async () => {
    expect(await safetyCode('team-sync', [a, b])).not.toEqual(
      await safetyCode('other-room', [a, b]),
    );
  });

  it('uses 64 distinct emoji (the bit layout depends on it)', () => {
    expect(SAFETY_EMOJI).toHaveLength(64);
    expect(new Set(SAFETY_EMOJI.map(([symbol]) => symbol)).size).toBe(64);
    expect(new Set(SAFETY_EMOJI.map(([, name]) => name)).size).toBe(64);
  });
});
