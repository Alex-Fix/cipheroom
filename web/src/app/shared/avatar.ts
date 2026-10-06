/** Avatar background colours: mid-saturation, readable with white text on the dark theme. */
export const AVATAR_PALETTE = [
  '#4f8cff',
  '#36b37e',
  '#f5a524',
  '#e5484d',
  '#9b6dff',
  '#14b8a6',
  '#ec4899',
  '#f97316',
] as const;

/** Stable colour for a name, so a participant has the same colour on every client. */
export function avatarColor(name: string): string {
  // FNV-1a: tiny, deterministic, good enough spread for a handful of colours.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_PALETTE[(hash >>> 0) % AVATAR_PALETTE.length];
}

/** Up to two initials: "Alex Papish" → "AP", "alex" → "A". */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase());
  return letters.join('') || '?';
}
