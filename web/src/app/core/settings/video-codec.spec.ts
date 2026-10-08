import { VIDEO_CODEC_KEY, loadVideoCodec, saveVideoCodec } from './video-codec';

describe('video codec setting', () => {
  beforeEach(() => localStorage.removeItem(VIDEO_CODEC_KEY));

  it('defaults to VP9', () => {
    expect(loadVideoCodec()).toBe('vp9');
  });

  it('round-trips a choice', () => {
    saveVideoCodec('vp8');
    expect(loadVideoCodec()).toBe('vp8');
  });

  it('falls back to VP9 from a stored AV1 choice (AV1 was removed)', () => {
    localStorage.setItem(VIDEO_CODEC_KEY, 'av1');
    expect(loadVideoCodec()).toBe('vp9');
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem(VIDEO_CODEC_KEY, 'h264');
    expect(loadVideoCodec()).toBe('vp9');
  });
});
