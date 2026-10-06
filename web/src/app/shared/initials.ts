/** Up to two initials for a monogram: "Alex Papish" → "AP", "alex" → "A". */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase());
  return letters.join('') || '?';
}
