import { mixLab, oklabToRgb, parseColor, rgbToHex, rgbToOklab, type Lab, type Rgb } from './color';
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
  /** The quietest text that sits on the background; the legibility floor
   *  is measured against it. Absent: no floor (a test, a bare palette). */
  mutedForeground?: string;
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
    mutedForeground: read('--muted-foreground') || undefined,
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
  /** Minimum contrast (WCAG ratio) of `tokens.mutedForeground` against every
   *  colour painted; a colour below it is pulled toward the page surface
   *  until it passes. Omitted or no muted token: no floor. */
  textFloor?: number;
};

/** The floor every real surface paints with: AA for body text (4.5:1) on the
 *  palette, plus a margin for the shading and grain the shader adds on top. */
export const DRIFT_TEXT_FLOOR = 4.8;

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two sRGB colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `lab` pulled toward `ground` just far enough that `text` reads on it at
 *  `floor`. When even the ground fails the floor (a theme's own problem),
 *  the ground is the best there is. */
function liftToFloor(lab: Lab, ground: Lab, text: Rgb, floor: number): Lab {
  if (contrastRatio(text, oklabToRgb(lab)) >= floor) return lab;
  if (contrastRatio(text, oklabToRgb(ground)) < floor) return ground;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(text, oklabToRgb(mixLab(lab, ground, mid))) >= floor) hi = mid;
    else lo = mid;
  }
  return mixLab(lab, ground, hi);
}

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

  // The legibility floor: every colour painted keeps the quietest text
  // readable, whatever the strength, tone or theme asked for.
  const text =
    input.textFloor && tokens.mutedForeground ? parseColor(tokens.mutedForeground) : null;
  const floor = (lab: Lab): Lab =>
    text && input.textFloor ? liftToFloor(lab, bg, text, input.textFloor) : lab;

  const colors: string[] = [];
  for (const { c } of order) {
    const rgb = parseColor(c);
    if (!rgb) continue;
    // Per-colour jitter keeps the washes from all landing at one distance.
    const toward = (1 - strength) * (0.75 + rnd() * 0.25);
    const washed = shift(mixLab(rgbToOklab(rgb), bg, toward), 0.03);
    colors.push(rgbToHex(oklabToRgb(floor(washed))));
  }
  // The ground itself, once, so every style can open space between colours.
  colors.splice(
    Math.floor(rnd() * (colors.length + 1)),
    0,
    rgbToHex(oklabToRgb(floor(shift(bg, 0.015)))),
  );

  return { background: rgbToHex(oklabToRgb(floor(shift(bg, 0.02)))), colors };
}
