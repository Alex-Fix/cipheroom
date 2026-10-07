import { receiveLayer } from './layers';

describe('receiveLayer', () => {
  it('receives the highest quality while on screen and the smallest otherwise', () => {
    expect(receiveLayer(true)).toBe('f');
    expect(receiveLayer(false)).toBe('q');
  });
});
