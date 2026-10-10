/** A piece of a chat message: plain text, or an http(s) link. Rendered by template interpolation and [href] only. */
export interface TextSegment {
  text: string;
  /** Set for links only: the parsed http(s) URL. */
  href?: string;
}

// Up to whitespace or an angle bracket / quote; trailing punctuation is left out below.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Splits text into plain parts and links. Only `http:` / `https:` URLs become links (never `javascript:` or
 * `data:`), and only if the URL parser accepts them. Nothing is fetched — no previews.
 */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    const trailing = url.match(TRAILING)?.[0] ?? '';
    // Keep a closing parenthesis that belongs to the URL, as in Wikipedia links.
    const keep = trailing.startsWith(')') && url.includes('(') ? ')' : '';
    url = url.slice(0, url.length - trailing.length) + keep;
    const href = safeHref(url);
    if (!href) continue;
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
