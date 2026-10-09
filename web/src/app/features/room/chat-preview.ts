/** Longest message preview in a notice. */
export const PREVIEW_LENGTH = 60;

/** A message's first line, shortened for "Alice: …" notices (characters, not UTF-16 units). */
export function chatPreview(text: string): string {
  const line = text.split('\n')[0];
  const chars = [...line];
  const cut =
    chars.length > PREVIEW_LENGTH ? chars.slice(0, PREVIEW_LENGTH).join('').trimEnd() : line;
  return cut === text ? cut : `${cut}…`;
}
