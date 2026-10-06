import { initials } from './initials';

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
