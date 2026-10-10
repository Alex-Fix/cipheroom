import { CALL_VIEW_KEY, defaultCallView, loadCallView, saveCallView } from './call-view';

describe('call view settings', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults to speaker + floating self-view on phones, grid on larger screens', () => {
    expect(loadCallView(true)).toEqual({
      view: 'speaker',
      selfView: 'float',
      corner: 'top-right',
      collapsed: false,
    });
    expect(loadCallView(false)).toEqual(defaultCallView(false));
    expect(defaultCallView(false).view).toBe('grid');
  });

  it('remembers the last choice', () => {
    saveCallView({ view: 'speaker', selfView: 'hidden', corner: 'bottom-left', collapsed: true });
    expect(loadCallView(false)).toEqual({
      view: 'speaker',
      selfView: 'hidden',
      corner: 'bottom-left',
      collapsed: true,
    });
  });

  it('falls back to defaults for anything it doesn’t recognise', () => {
    localStorage.setItem(
      CALL_VIEW_KEY,
      JSON.stringify({ view: 'mosaic', corner: 'middle', selfView: 'float' }),
    );
    expect(loadCallView(false)).toEqual({ ...defaultCallView(false), selfView: 'float' });
    localStorage.setItem(CALL_VIEW_KEY, '{oops');
    expect(loadCallView(true)).toEqual(defaultCallView(true));
  });

  it('works without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('', 'SecurityError');
    });
    expect(() => saveCallView(defaultCallView(true))).not.toThrow();
    expect(loadCallView(false)).toEqual(defaultCallView(false));
  });
});
