import { FULL_LAYER_MIN_PX, HALF_LAYER_MIN_PX, receiveLayer } from './layers';

describe('receiveLayer', () => {
  it('matches the layer to the tile’s size in device pixels', () => {
    expect(receiveLayer(1200)).toBe('f');
    expect(receiveLayer(FULL_LAYER_MIN_PX)).toBe('f');
    expect(receiveLayer(FULL_LAYER_MIN_PX - 1)).toBe('h');
    expect(receiveLayer(HALF_LAYER_MIN_PX)).toBe('h');
    expect(receiveLayer(HALF_LAYER_MIN_PX - 1)).toBe('q');
  });

  it('counts device pixels: a 2× phone stage gets the full layer, its thumbnails the quarter', () => {
    expect(receiveLayer(480, 2)).toBe('f');
    expect(receiveLayer(120, 2)).toBe('q');
    expect(receiveLayer(200, 2)).toBe('h');
  });

  it('receives the smallest layer off screen, hidden, or with the page in the background', () => {
    expect(receiveLayer(0)).toBe('q');
    expect(receiveLayer(1200, 1, false)).toBe('q');
  });

  it('keeps the full layer for tiles that never reported a size', () => {
    expect(receiveLayer(undefined)).toBe('f');
  });
});
