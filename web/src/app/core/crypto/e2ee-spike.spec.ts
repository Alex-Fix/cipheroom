import { e2eeSpikeMode } from './e2ee-spike';

describe('e2eeSpikeMode', () => {
  beforeEach(() => sessionStorage.clear());

  it('is off unless requested', () => {
    expect(e2eeSpikeMode('')).toBeUndefined();
    expect(e2eeSpikeMode('?e2ee=bogus')).toBeUndefined();
  });

  it('is remembered for the tab until turned off', () => {
    expect(e2eeSpikeMode('?e2ee=passthrough')).toBe('passthrough');
    expect(e2eeSpikeMode('')).toBe('passthrough');
    expect(e2eeSpikeMode('?e2ee=spike')).toBe('spike');
    expect(e2eeSpikeMode('?e2ee=off')).toBeUndefined();
    expect(e2eeSpikeMode('')).toBeUndefined();
  });
});
