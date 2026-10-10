import { fromBase64Url } from '../crypto/encoding';
import { THUMBNAIL_MAX_BYTES, makeThumbnail, smallestFitting } from './thumbnail';

describe('thumbnail', () => {
  it('lowers the quality until the preview fits', async () => {
    const tried: number[] = [];
    const result = await smallestFitting(async (quality) => {
      tried.push(quality);
      return new Blob([new Uint8Array(quality > 0.5 ? THUMBNAIL_MAX_BYTES + 1 : 10)]);
    });

    expect(tried).toEqual([0.7, 0.5]);
    expect(fromBase64Url(result!).byteLength).toBe(10);
  });

  it('gives up when nothing fits', async () => {
    expect(await smallestFitting(async () => new Blob([new Uint8Array(THUMBNAIL_MAX_BYTES + 1)]))).toBeUndefined();
  });

  it('gives up on images this browser cannot decode', async () => {
    expect(await makeThumbnail(new Blob(['not an image'], { type: 'image/png' }))).toBeUndefined();
  });
});
