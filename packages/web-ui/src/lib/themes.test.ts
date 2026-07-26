import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLOR_THEMES } from './themes';

/**
 * Contrast contract for the Pinnacle theme.
 *
 * The eight Pinnacle brand colours are all light-key — white text fails AA on
 * every one of them — so the palette is easy to get wrong in exactly the way
 * that bleaches a UI out (pale ink on a pale fill). This test pins the pairs
 * the app actually renders, at WCAG 2.1 thresholds:
 *
 *   4.5:1  text pairs — a `-foreground` on its own fill, and the tokens that
 *          are used as INK on a surface (`text-muted-foreground` on `bg-card`,
 *          `text-primary`/`text-destructive` on `bg-background`, …). Note that
 *          `--primary` therefore has to clear 4.5 in BOTH directions: white on
 *          it, and it on the background.
 *   3.0:1  non-text UI — the focus ring against the surface it rings.
 *
 * Only Pinnacle is asserted: the ~40 tweakcn presets are imported artwork and
 * several of them would fail, so failing the suite on them would just mean a
 * skipped test. Any hand-authored theme added later belongs here.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../../styles/themes.css', import.meta.url)),
  'utf8',
);

function tokens(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const body = CSS.slice(at, CSS.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`expected a 6-digit hex, got ${hex}`);
  const channels = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** [ink, surface] pairs the UI actually pairs up, per the style-guide rules. */
const TEXT_PAIRS: Array<[string, string]> = [
  // A fill and its own -foreground (the "suggested combination" in the picker).
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  // Tokens used as ink on the plain surfaces.
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'popover'],
  ['muted-foreground', 'sidebar'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['primary', 'muted'],
  ['primary', 'sidebar'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['destructive', 'muted'],
  ['destructive', 'sidebar'],
  ['foreground', 'card'],
  ['foreground', 'popover'],
  ['foreground', 'muted'],
  ['foreground', 'secondary'],
  ['foreground', 'sidebar'],
];

const UI_PAIRS: Array<[string, string]> = [
  ['ring', 'background'],
  ['ring', 'card'],
  ['sidebar-ring', 'sidebar'],
];

describe('pinnacle theme', () => {
  it('is registered in the picker', () => {
    expect(COLOR_THEMES.map((t) => t.id)).toContain('pinnacle');
    expect(CSS).toContain('[data-color-theme="pinnacle"]');
    expect(CSS).toContain('.dark[data-color-theme="pinnacle"]');
  });

  it('shows its real light-mode colours in the picker swatches', () => {
    const t = tokens('[data-color-theme="pinnacle"]');
    const entry = COLOR_THEMES.find((x) => x.id === 'pinnacle')!;
    expect(entry.swatches).toEqual([t.primary, t.accent, t.background]);
  });

  it('defines the same token set as the baseline in both modes', () => {
    // Colour tokens only — type, shadow and metric tokens inherit from :root.
    const inherited = ['radius', 'spacing', 'letter-spacing'];
    const baseline = Object.keys(tokens(':root')).filter(
      (k) => !k.startsWith('font-') && !k.startsWith('shadow') && !k.startsWith('tracking'),
    );
    for (const selector of [
      '[data-color-theme="pinnacle"]',
      '.dark[data-color-theme="pinnacle"]',
    ]) {
      const t = tokens(selector);
      const missing = baseline.filter((k) => !(k in t) && !inherited.includes(k));
      expect(missing, `${selector} is missing tokens`).toEqual([]);
    }
  });

  for (const [mode, selector] of [
    ['light', '[data-color-theme="pinnacle"]'],
    ['dark', '.dark[data-color-theme="pinnacle"]'],
  ] as const) {
    describe(mode, () => {
      const t = tokens(selector);

      it.each(TEXT_PAIRS)('%s on %s reaches AA text contrast', (ink, surface) => {
        expect(contrast(t[ink]!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
      });

      it.each(UI_PAIRS)('%s on %s reaches AA non-text contrast', (a, b) => {
        expect(contrast(t[a]!, t[b]!)).toBeGreaterThanOrEqual(3);
      });

      it('keeps the brand hues in the chart ramp', () => {
        const brand = [
          '#ea3635',
          '#ec1c35',
          '#d48b38',
          '#b2d234',
          '#6fbe44',
          '#6fc173',
          '#6ec7aa',
          '#6ec8b7',
        ];
        const ramp = [1, 2, 3, 4, 5].map((n) => t[`chart-${n}`]!);
        expect(ramp.every((c) => brand.includes(c))).toBe(true);
        expect(new Set(ramp).size).toBe(5);
      });
    });
  }
});
