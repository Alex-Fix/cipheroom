import { SpeakingDetector, sameMembers } from './speaking';

describe('SpeakingDetector', () => {
  it('marks loud participants as speaking and holds briefly after they stop', () => {
    const detector = new SpeakingDetector(0.04, 800);

    expect(
      detector.update(
        new Map([
          ['a', 0.2],
          ['b', 0.01],
        ]),
        0,
      ),
    ).toEqual(new Set(['a']));
    expect(
      detector.update(
        new Map([
          ['a', 0],
          ['b', 0],
        ]),
        500,
      ),
    ).toEqual(new Set(['a']));
    expect(
      detector.update(
        new Map([
          ['a', 0],
          ['b', 0],
        ]),
        900,
      ),
    ).toEqual(new Set());
  });

  it('treats missing samples like silence', () => {
    const detector = new SpeakingDetector(0.04, 800);
    detector.update(new Map([['a', 0.5]]), 0);

    expect(detector.update(new Map(), 1000)).toEqual(new Set());
  });
});

describe('sameMembers', () => {
  it('compares sets by content', () => {
    expect(sameMembers(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameMembers(new Set(['a']), new Set(['b']))).toBe(false);
  });
});
