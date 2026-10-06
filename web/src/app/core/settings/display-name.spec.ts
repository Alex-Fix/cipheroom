import { DISPLAY_NAME_KEY, loadDisplayName, saveDisplayName } from './display-name';

describe('display name', () => {
  beforeEach(() => localStorage.removeItem(DISPLAY_NAME_KEY));

  it('is empty until saved', () => {
    expect(loadDisplayName()).toBe('');
  });

  it('round-trips through localStorage', () => {
    saveDisplayName('Alex');
    expect(loadDisplayName()).toBe('Alex');
  });

  it('falls back to empty when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadDisplayName()).toBe('');
    vi.restoreAllMocks();
  });
});
