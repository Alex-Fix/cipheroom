import { isReactionEmoji } from '../chat/emoji';

/** Emoji this browser used last (picker's first row), remembered in this browser only. */
export const RECENT_EMOJI_KEY = 'cipheroom.recentEmoji';
export const MAX_RECENT_EMOJI = 16;

export function loadRecentEmoji(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((e): e is string => typeof e === 'string' && isReactionEmoji(e))
      .slice(0, MAX_RECENT_EMOJI);
  } catch {
    return [];
  }
}

/** Moves `emoji` to the front; returns the new list. */
export function rememberEmoji(emoji: string): string[] {
  const recent = [emoji, ...loadRecentEmoji().filter((e) => e !== emoji)].slice(
    0,
    MAX_RECENT_EMOJI,
  );
  try {
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(recent));
  } catch {
    // Storage unavailable (private mode) — recent emoji just won't be remembered.
  }
  return recent;
}
