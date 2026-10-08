import { bitrateFor, cameraEncodings, captureConstraints, supportedQualities } from './quality';

describe('video quality', () => {
  it('auto asks for the best the camera has, up to 4K; explicit choices cap it', () => {
    expect(captureConstraints('auto')).toEqual({
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    });
    expect(captureConstraints('1080p').height).toEqual({ ideal: 1080, max: 1080 });
  });

  it('offers 4K and 1080p only when the camera can capture them', () => {
    expect(supportedQualities(2160)).toEqual(['auto', '2160p', '1080p', '720p']);
    expect(supportedQualities(1080)).toEqual(['auto', '1080p', '720p']);
    expect(supportedQualities(720)).toEqual(['auto', '720p']);
    expect(supportedQualities(undefined)).toEqual(['auto', '720p']);
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
    expect(bitrateFor(1080, 'av1')).toBe(1_500_000);
    expect(cameraEncodings(720, 'av1').map((e) => e.maxBitrate)).toEqual([
      750_000, 250_000, 100_000,
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
