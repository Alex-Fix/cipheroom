import { StageSpeaker, TAKE_STAGE_MS } from './stage-speaker';

const set = (...ids: string[]) => new Set(ids);

describe('StageSpeaker', () => {
  it('gives the stage to someone who keeps speaking, not to a short interjection', () => {
    const s = new StageSpeaker();
    expect(s.update(set('bob'), 0)).toBeUndefined();
    expect(s.update(set('bob'), TAKE_STAGE_MS - 1)).toBeUndefined();
    expect(s.update(set('bob'), TAKE_STAGE_MS)).toBe('bob');

    // Carol says "mm-hm": Bob keeps the stage.
    expect(s.update(set('bob', 'carol'), TAKE_STAGE_MS + 200)).toBe('bob');
    expect(s.update(set('bob'), TAKE_STAGE_MS + 600)).toBe('bob');
  });

  it('keeps the last speaker through silence, then hands over to the next one', () => {
    const s = new StageSpeaker();
    s.update(set('bob'), 0);
    s.update(set('bob'), 2000);
    expect(s.update(set(), 5000)).toBe('bob');

    s.update(set('carol'), 6000);
    expect(s.update(set('carol'), 6000 + TAKE_STAGE_MS)).toBe('carol');
  });

  it('doesn’t switch while the current speaker is still talking', () => {
    const s = new StageSpeaker();
    s.update(set('bob'), 0);
    s.update(set('bob'), 2000);
    s.update(set('bob', 'carol'), 2100);
    expect(s.update(set('bob', 'carol'), 2100 + TAKE_STAGE_MS)).toBe('bob');
    // Bob stops; Carol has been speaking long enough.
    expect(s.update(set('carol'), 4000)).toBe('carol');
  });

  it('orders people by when they last spoke', () => {
    const s = new StageSpeaker();
    s.update(set('bob'), 0);
    s.update(set('carol'), 100);
    s.update(set('dan'), 200);
    s.update(set('bob'), 300);
    expect(s.recent()).toEqual(['bob', 'dan', 'carol']);
  });

  it('forgets people who left', () => {
    const s = new StageSpeaker();
    s.update(set('bob'), 0);
    s.update(set('bob'), 2000);
    s.forget(set('carol'));
    expect(s.recent()).toEqual([]);
    expect(s.update(set(), 3000)).toBeUndefined();
  });
});
