import { VIDEO_CODEC_KEY, loadVideoCodec, saveVideoCodec } from './video-codec';

describe('video codec setting', () => {
  beforeEach(() => localStorage.removeItem(VIDEO_CODEC_KEY));

  it('defaults to VP9', () => {
    expect(loadVideoCodec()).toBe('vp9');
  });

  it('round-trips a choice', () => {
    saveVideoCodec('av1');
    expect(loadVideoCodec()).toBe('av1');
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem(VIDEO_CODEC_KEY, 'h264');
    expect(loadVideoCodec()).toBe('vp9');
  });
});
