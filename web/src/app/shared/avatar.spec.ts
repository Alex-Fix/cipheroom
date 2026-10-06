import { AVATAR_PALETTE, avatarColor, initials } from './avatar';

describe('avatarColor', () => {
  it('is deterministic and always from the palette', () => {
    for (const name of ['Alex', 'Олександр', '', 'a very long name with spaces', '🦊']) {
      expect(avatarColor(name)).toBe(avatarColor(name));
      expect(AVATAR_PALETTE).toContain(avatarColor(name));
    }
  });

  it('spreads different names over several colours', () => {
    const colours = new Set(
      ['Alex', 'Bob', 'Carol', 'Dave', 'Eve', 'Mallory', 'Trent', 'Peggy'].map(avatarColor),
    );
    expect(colours.size).toBeGreaterThan(3);
  });
});

describe('initials', () => {
  it('takes the first letter of up to two words', () => {
    expect(initials('Alex Papish')).toBe('AP');
    expect(initials('  alex  ')).toBe('A');
    expect(initials('anna maria von trapp')).toBe('AM');
  });

  it('handles non-latin and emoji names', () => {
    expect(initials('олександр')).toBe('О');
    expect(initials('🦊 Fox')).toBe('🦊F');
  });

  it('falls back for empty names', () => {
    expect(initials('   ')).toBe('?');
  });
});
