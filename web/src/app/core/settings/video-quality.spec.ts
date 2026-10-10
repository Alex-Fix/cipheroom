import { VIDEO_QUALITY_KEY, loadVideoQuality, saveVideoQuality } from './video-quality';

describe('video quality setting', () => {
  beforeEach(() => localStorage.removeItem(VIDEO_QUALITY_KEY));

  it('defaults to Full HD, also for the old Auto choice', () => {
    expect(loadVideoQuality()).toBe('1080p');
    localStorage.setItem(VIDEO_QUALITY_KEY, 'auto');
    expect(loadVideoQuality()).toBe('1080p');
  });

  it('round-trips a choice', () => {
    saveVideoQuality('1080p');
    expect(loadVideoQuality()).toBe('1080p');
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem(VIDEO_QUALITY_KEY, '8k');
    expect(loadVideoQuality()).toBe('1080p');
  });
});
