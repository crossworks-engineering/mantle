import { mixLab, oklabToRgb, parseColor, rgbToHex, rgbToOklab, type Lab } from './color';
import { mulberry32 } from './options';
import type { DriftPaletteSource, DriftTone } from '@mantle/content-core/drift-spec';

export type { DriftPaletteSource, DriftTone };

/**
 * Theme → Drift palette. A saved background stores NO colours: every colour
 * is derived from the live theme tokens at paint time, so one background
 * follows all the colour themes and light/dark by construction (the contract
 * the Neat spec established, kept).
 *
 * The derived colours are washes — each brand colour pulled part of the way
 * into `--background` — and `strength` says how far. That is the legibility
 * guarantee: at the default the gradient reads as a tint of the page
 * surface, never a poster fighting the text on it. All of it happens in
 * OKLab, so a wash keeps its hue instead of greying on the way to the ground.
 */

export type DriftThemeTokens = {
  background: string;
  primary: string;
  accent: string;
  secondary: string;
  chart: string[];
};

/** The tokens, resolved to literal colours off the live document. Null when
 *  the theme is unresolvable (a test DOM, a broken stylesheet) — paint
 *  nothing rather than a wrong guess. */
export function readDriftThemeTokens(
  root: Element = document.documentElement,
): DriftThemeTokens | null {
  const cs = getComputedStyle(root);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  const tokens: DriftThemeTokens = {
    background: read('--background'),
    primary: read('--primary'),
    accent: read('--accent'),
    secondary: read('--secondary'),
    chart: [1, 2, 3, 4, 5].map((i) => read(`--chart-${i}`)).filter(Boolean),
  };
  return tokens.background && tokens.primary ? tokens : null;
}

export type DriftPaletteInput = {
  seed: number;
  tone: DriftTone;
  mode: 'light' | 'dark';
  source: DriftPaletteSource;
  /** 0 = a whisper of colour on the page surface, 1 = the raw theme colours. */
  strength: number;
};

/** Spec + live tokens → the background and colours Drift paints. Pure and
 *  deterministic: a preview and the real surface can never disagree. */
export function driftPaletteFromTheme(
  tokens: DriftThemeTokens,
  input: DriftPaletteInput,
): { background: string; colors: string[] } {
  const rnd = mulberry32(input.seed ^ 0x5bd1e995);
  const bgRgb = parseColor(tokens.background);
  if (!bgRgb) return { background: tokens.background, colors: [] };
  const bg = rgbToOklab(bgRgb);
  const darker = input.tone === 'darker' || (input.tone === 'auto' && input.mode === 'dark');
  const strength = Math.min(1, Math.max(0, input.strength));

  const sources =
    input.source === 'chart' && tokens.chart.length >= 2
      ? tokens.chart
      : [tokens.primary, tokens.accent, tokens.secondary];

  // Seeded order, so re-rolling the seed reshuffles which hue leads.
  const order = sources.map((c, i) => ({ c, k: rnd() + i * 0.01 })).sort((a, b) => a.k - b.k);

  // The ground shifts a touch off the page surface in the chosen direction,
  // so the darkest (or lightest) parts sit just beyond the content's own.
  const shift = (lab: Lab, amount: number): Lab => [
    Math.min(1, Math.max(0, lab[0] + (darker ? -amount : amount))),
    lab[1],
    lab[2],
  ];

  const colors: string[] = [];
  for (const { c } of order) {
    const rgb = parseColor(c);
    if (!rgb) continue;
    // Per-colour jitter keeps the washes from all landing at one distance.
    const toward = (1 - strength) * (0.75 + rnd() * 0.25);
    const washed = shift(mixLab(rgbToOklab(rgb), bg, toward), 0.03);
    colors.push(rgbToHex(oklabToRgb(washed)));
  }
  // The ground itself, once, so every style can open space between colours.
  colors.splice(Math.floor(rnd() * (colors.length + 1)), 0, rgbToHex(oklabToRgb(shift(bg, 0.015))));

  return { background: rgbToHex(oklabToRgb(shift(bg, 0.02))), colors };
}
