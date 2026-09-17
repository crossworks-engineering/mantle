/**
 * Themed text (font) colour palette — twin of highlight-colors. Stores a TOKEN
 * KEY (e.g. `chart-2`), never a raw colour, so coloured text tracks the active
 * theme + light/dark. Unlike highlights (translucent tints) text uses the full
 * token colour for legibility. Pure (no React) → safe in the server renderer.
 */
export const TEXT_COLOR_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
export type TextColorToken = (typeof TEXT_COLOR_TOKENS)[number];

export function isTextColorToken(v: unknown): v is TextColorToken {
  return typeof v === 'string' && (TEXT_COLOR_TOKENS as readonly string[]).includes(v);
}

/** CSS `color` for a text-colour token, or null if unknown. */
export function textColor(token: unknown): string | null {
  if (!isTextColorToken(token)) return null;
  return `var(--${token})`;
}
