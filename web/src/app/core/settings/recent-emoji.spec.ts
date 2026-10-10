import { MAX_RECENT_EMOJI, RECENT_EMOJI_KEY, loadRecentEmoji, rememberEmoji } from './recent-emoji';

describe('recent emoji', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts empty and keeps the latest first, without duplicates', () => {
    expect(loadRecentEmoji()).toEqual([]);
    rememberEmoji('👍');
    rememberEmoji('🎉');
    expect(rememberEmoji('👍')).toEqual(['👍', '🎉']);
    expect(loadRecentEmoji()).toEqual(['👍', '🎉']);
  });

  it('keeps at most MAX_RECENT_EMOJI', () => {
    const many = [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😂',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '🤩',
      '😘',
    ];
    many.forEach(rememberEmoji);
    expect(loadRecentEmoji()).toHaveLength(MAX_RECENT_EMOJI);
    expect(loadRecentEmoji()[0]).toBe('😘');
  });

  it('ignores anything stored that isn’t one of our emoji', () => {
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(['👍', '<img>', 3]));
    expect(loadRecentEmoji()).toEqual(['👍']);
    localStorage.setItem(RECENT_EMOJI_KEY, '{not json');
    expect(loadRecentEmoji()).toEqual([]);
  });

  it('works without storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('', 'SecurityError');
    });
    expect(rememberEmoji('👍')).toEqual(['👍']);
  });
});
