/**
 * Pure text helpers behind forum topic auto-titling — no DB or provider
 * imports so they unit-test without a stack (the forum-search.ts pattern).
 */

/** Longest title the composer path will produce (forum's own cap is 200). */
export const TITLE_CLAMP = 80;

/** Clamp to `max` characters at a word boundary with a trailing ellipsis.
 *  Counts Unicode code points (Array.from), so an emoji at the cut line is
 *  dropped whole instead of being split into a lone surrogate. */
export function clampTitle(text: string, max = TITLE_CLAMP): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** First line of the message, whitespace-collapsed, clamped. The no-model
 *  fallback — always returns something usable. */
export function heuristicTitle(body: string): string {
  const line =
    body
      .trim()
      .split('\n')[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  if (!line) return 'New topic';
  return clampTitle(line);
}

/** Strip model artifacts (wrapping quotes, newlines, trailing period) and
 *  clamp. Returns '' when nothing survives — callers fall back. */
export function sanitizeTitle(raw: string): string {
  const t = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\.+$/, '')
    .trim();
  return t ? clampTitle(t) : '';
}
