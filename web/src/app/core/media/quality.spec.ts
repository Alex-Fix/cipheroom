import {
  bitrateFor,
  cameraEncodings,
  captureConstraints,
  closestQuality,
  supportedQualities,
} from './quality';

describe('video quality', () => {
  it('asks for the chosen size and caps it there (a smaller camera gives its closest mode)', () => {
    expect(captureConstraints('1080p')).toEqual({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30 },
    });
    expect(captureConstraints('2160p').height).toEqual({ ideal: 2160, max: 2160 });
    expect(captureConstraints('720p').width).toEqual({ ideal: 1280, max: 1280 });
  });

  it('offers 4K and 1080p only when the camera can capture them', () => {
    expect(supportedQualities(2160)).toEqual(['2160p', '1080p', '720p']);
    expect(supportedQualities(1080)).toEqual(['1080p', '720p']);
    expect(supportedQualities(720)).toEqual(['720p']);
    expect(supportedQualities(480)).toEqual(['720p']);
    expect(supportedQualities(undefined)).toEqual(['1080p', '720p']);
  });

  it('turns a choice into the closest one the camera offers, never above it', () => {
    expect(closestQuality('1080p', ['2160p', '1080p', '720p'])).toBe('1080p');
    expect(closestQuality('1080p', ['720p'])).toBe('720p');
    expect(closestQuality('2160p', ['1080p', '720p'])).toBe('1080p');
    expect(closestQuality('720p', ['2160p', '1080p', '720p'])).toBe('720p');
  });

  it('scales simulcast bitrates with the captured resolution', () => {
    expect(cameraEncodings(2160).map((e) => e.maxBitrate)).toEqual([8_000_000, 3_000_000, 800_000]);
    expect(cameraEncodings(720).map((e) => e.maxBitrate)).toEqual([1_500_000, 500_000, 200_000]);
    expect(cameraEncodings(1080).map((e) => [e.rid, e.scaleResolutionDownBy])).toEqual([
      ['f', undefined],
      ['h', 2],
      ['q', 4],
    ]);
    expect(bitrateFor(1440)).toBe(5_000_000);
  });

  it('needs fewer bits with more efficient codecs', () => {
    expect(bitrateFor(1080, 'vp9')).toBe(1_950_000);
    expect(cameraEncodings(720, 'vp9').map((e) => e.maxBitrate)).toEqual([
      975_000, 325_000, 130_000,
    ]);
  });

  it('sets the scalability mode on every layer only when given', () => {
    expect(
      cameraEncodings(720, 'vp9', 'L1T3').map(
        (e) => (e as { scalabilityMode?: string }).scalabilityMode,
      ),
    ).toEqual(['L1T3', 'L1T3', 'L1T3']);
    expect(cameraEncodings(720).some((e) => 'scalabilityMode' in e)).toBe(false);
  });
});
