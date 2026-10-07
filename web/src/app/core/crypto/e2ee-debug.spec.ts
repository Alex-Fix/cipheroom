import { passThroughRequested } from './e2ee-debug';

describe('passThroughRequested', () => {
  beforeEach(() => sessionStorage.clear());

  it('is off unless requested', () => {
    expect(passThroughRequested('')).toBe(false);
    expect(passThroughRequested('?e2ee=spike')).toBe(false);
  });

  it('is remembered for the tab until turned off', () => {
    expect(passThroughRequested('?e2ee=passthrough')).toBe(true);
    expect(passThroughRequested('')).toBe(true);
    expect(passThroughRequested('?e2ee=off')).toBe(false);
    expect(passThroughRequested('')).toBe(false);
  });
});
