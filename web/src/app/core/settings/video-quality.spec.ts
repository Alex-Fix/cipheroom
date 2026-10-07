import { VIDEO_QUALITY_KEY, loadVideoQuality, saveVideoQuality } from './video-quality';

describe('video quality setting', () => {
  beforeEach(() => localStorage.removeItem(VIDEO_QUALITY_KEY));

  it('defaults to auto', () => {
    expect(loadVideoQuality()).toBe('auto');
  });

  it('round-trips a choice', () => {
    saveVideoQuality('1080p');
    expect(loadVideoQuality()).toBe('1080p');
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem(VIDEO_QUALITY_KEY, '8k');
    expect(loadVideoQuality()).toBe('auto');
  });
});
