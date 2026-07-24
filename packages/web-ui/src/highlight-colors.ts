/**
 * Themed highlight palette. We store a TOKEN KEY (e.g. `chart-2`) on the
 * highlight mark, never a raw colour, so highlights track the active theme +
 * light/dark like the rest of the document. A null/unknown colour = the default
 * highlight (primary tint, styled in globals.css). Pure (no React) → safe to
 * import in the server-side public renderer.
 */
export const HIGHLIGHT_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
export type HighlightToken = (typeof HIGHLIGHT_TOKENS)[number];

export function isHighlightToken(v: unknown): v is HighlightToken {
  return typeof v === 'string' && (HIGHLIGHT_TOKENS as readonly string[]).includes(v);
}

/** CSS `background-color` for a highlight token, or null for the default tint. */
export function highlightColor(token: unknown): string | null {
  if (!isHighlightToken(token)) return null;
  return `color-mix(in oklab, var(--${token}) 30%, transparent)`;
}
