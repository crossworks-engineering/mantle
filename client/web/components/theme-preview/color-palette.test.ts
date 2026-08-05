import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Color Palette tab is the only surface where a human can see what a theme
 * actually resolves every token to. A token missing from it is a token nobody
 * can audition — and adding a semantic role is documented as "one line in
 * ROLE_HUES plus a @theme inline mapping" (docs/themes.md), neither of which
 * passes anywhere near this component.
 *
 * So the coverage is DISCOVERED rather than declared, the same way
 * ink-audit.test.ts discovers what is used as text: read the tokens the
 * generated stylesheet actually ships and demand the tab list every colour
 * one. Non-colour tokens (radius, fonts, shadows, spacing, tracking) are not
 * swatches and are excluded by name.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../../../../packages/web-ui/styles/themes.css', import.meta.url)),
  'utf8',
);
const SOURCE = readFileSync(fileURLToPath(new URL('./color-palette.tsx', import.meta.url)), 'utf8');

/** Tokens the baseline `:root` block declares — every theme block is a
 *  same-shaped override of it, so this is the full shipped vocabulary. */
function shippedTokens(): string[] {
  const at = CSS.indexOf(':root {');
  const body = CSS.slice(at, CSS.indexOf('\n}', at));
  return [...body.matchAll(/--([\w-]+):/g)].map((m) => m[1]!);
}

/** Not a colour, so not a swatch. */
const NOT_A_SWATCH = /^(radius|font-|shadow|letter-spacing|spacing|tracking)/;

/** The token names the component's GROUPS table lists. */
function listedTokens(): string[] {
  const from = SOURCE.indexOf('const GROUPS');
  const to = SOURCE.indexOf('const ALL_TOKENS');
  expect(from, 'GROUPS table not found — did the component get restructured?').toBeGreaterThan(-1);
  expect(to, 'ALL_TOKENS not found — did the component get restructured?').toBeGreaterThan(from);
  return [
    ...new Set([...SOURCE.slice(from, to).matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!)),
  ];
}

describe('color palette tab', () => {
  it('shows every colour token themes.css ships', () => {
    const missing = shippedTokens()
      .filter((t) => !NOT_A_SWATCH.test(t))
      .filter((t) => !listedTokens().includes(t));
    expect(missing, 'add these to GROUPS in color-palette.tsx').toEqual([]);
  });

  it('invents nothing themes.css does not ship', () => {
    const shipped = new Set(shippedTokens());
    const phantom = listedTokens().filter((t) => !shipped.has(t));
    expect(phantom, 'these would render as blank swatches').toEqual([]);
  });
});
