import { layerFor } from './layers';

describe('layerFor', () => {
  it('picks the smallest layer that stays sharp', () => {
    expect(layerFor(1200)).toBe('f');
    expect(layerFor(600)).toBe('h');
    expect(layerFor(160)).toBe('q');
  });

  it('accounts for high-density screens', () => {
    expect(layerFor(300, 1)).toBe('q');
    expect(layerFor(300, 2)).toBe('h');
    expect(layerFor(500, 2)).toBe('f');
  });

  it('uses the smallest layer for tiles that are not visible', () => {
    expect(layerFor(1200, 2, false)).toBe('q');
    expect(layerFor(0)).toBe('q');
  });
});
