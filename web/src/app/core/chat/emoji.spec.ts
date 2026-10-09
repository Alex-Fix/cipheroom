import { EMOJI_CATEGORIES, QUICK_REACTIONS, isReactionEmoji } from './emoji';

describe('emoji', () => {
  const all = EMOJI_CATEGORIES.flatMap((c) => c.emoji);

  it('offers a few hundred emoji, each once', () => {
    expect(all.length).toBeGreaterThan(200);
    expect(new Set(all).size).toBe(all.length);
  });

  it('every entry is one grapheme of at most 32 UTF-16 units (what a reaction may carry)', () => {
    const segmenter = new Intl.Segmenter();
    for (const emoji of all) {
      expect([...segmenter.segment(emoji)]).toHaveLength(1);
      expect(emoji.length).toBeLessThanOrEqual(32);
    }
  });

  it('allows reactions from the set only', () => {
    for (const emoji of QUICK_REACTIONS) expect(isReactionEmoji(emoji)).toBe(true);
    expect(isReactionEmoji('🎉')).toBe(true);
    expect(isReactionEmoji('a')).toBe(false);
    expect(isReactionEmoji('👍👍')).toBe(false);
    expect(isReactionEmoji('<b>')).toBe(false);
  });
});
