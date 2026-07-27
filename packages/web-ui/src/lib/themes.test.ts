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

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const toLinearChannel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A CSS colour value -> linear-light sRGB. themes.css uses three notations:
 *  hex for most presets, oklch() for the baseline and `vercel`, and one hsl(). */
function toLinear(value: string): [number, number, number] {
  const v = value.trim();

  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`bad hex: ${value}`);
    return [0, 2, 4].map((i) => toLinearChannel(parseInt(h.slice(i, i + 2), 16) / 255)) as [
      number,
      number,
      number,
    ];
  }

  const args = v
    .slice(v.indexOf('(') + 1, v.lastIndexOf(')'))
    .split('/')[0]!
    .trim()
    .split(/[\s,]+/);

  if (v.startsWith('oklch')) {
    const L = args[0]!.endsWith('%') ? parseFloat(args[0]!) / 100 : parseFloat(args[0]!);
    const C = args[1]!.endsWith('%') ? (parseFloat(args[1]!) / 100) * 0.4 : parseFloat(args[1]!);
    const H = (parseFloat(args[2] ?? '0') || 0) * (Math.PI / 180);
    const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    // Out-of-gamut components are clamped, which is what a browser renders.
    return [
      clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  if (v.startsWith('hsl')) {
    const [h, sPct, lPct] = args.map((x) => parseFloat(x));
    const [S, L] = [sPct! / 100, lPct! / 100];
    const k = (n: number) => (n + h! / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map(toLinearChannel) as [number, number, number];
  }

  throw new Error(`unsupported colour notation: ${value}`);
}

function luminance(value: string): number {
  const [r, g, b] = toLinear(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Normalise any supported notation to a 6-digit hex, so colours written in
 *  different notations can be compared as colours. */
function toHex(value: string): string {
  const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  return (
    '#' +
    toLinear(value)
      .map((c) =>
        Math.round(clamp(toSrgb(clamp(c))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
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

/** Selectors for a registered theme. `clean-slate` is the BASELINE — it has no
 *  `[data-color-theme]` block at all, it *is* `:root` / `.dark`. */
function selectorsFor(id: string): { light: string; dark: string } {
  return id === 'clean-slate'
    ? { light: ':root', dark: '.dark' }
    : { light: `[data-color-theme="${id}"]`, dark: `.dark[data-color-theme="${id}"]` };
}

/** A theme block only overrides what it changes; the rest inherits from :root. */
function resolved(selector: string): Record<string, string> {
  return { ...tokens(':root'), ...tokens(selector) };
}

/**
 * The one contrast rule that holds for EVERY theme, not just Pinnacle.
 *
 * `accent` is the hover/selected fill behind list rows, command-palette items,
 * menu items and combobox options — the highest-traffic fill in the app. Its
 * own `accent-foreground` must be legible on it, or selected text disappears
 * at exactly the moment the user is looking at it.
 *
 * This is not hypothetical. The same defect shipped TWICE and was found by a
 * user rather than by CI: slash-menu + mention-list (fixed v0.205.7), then the
 * shared CommandItem, the ⌘K palette and four more call sites (v0.206.1). Both
 * were markup pairing the wrong ink with `bg-accent` — but eleven presets ALSO
 * declared a pair that fails on its own, so the palettes were fixed to clear
 * 4.5:1 (v0.206.7, hue and chroma preserved, only lightness moved).
 *
 * The wider ink-on-surface matrix below is still asserted for Pinnacle only —
 * the imported presets fail it in ~659 places and bringing them all to AA is a
 * separate, deliberate piece of work.
 */
describe('every registered theme', () => {
  for (const theme of COLOR_THEMES) {
    const sels = selectorsFor(theme.id);
    for (const [mode, selector] of [
      ['light', sels.light],
      ['dark', sels.dark],
    ] as const) {
      it(`${theme.id} ${mode}: accent-foreground on accent reaches AA text contrast`, () => {
        const t = resolved(selector);
        const ratio = contrast(t['accent-foreground']!, t.accent!);
        expect(
          ratio,
          `${theme.id} (${mode}) renders accent-foreground ${t['accent-foreground']} on ` +
            `accent ${t.accent} at ${ratio.toFixed(2)}:1 — selected rows and palette items ` +
            `would be unreadable. Move the LIGHTNESS of whichever of the two shifts least, ` +
            `keeping hue and chroma so the theme keeps its character.`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${theme.id}: picker swatches match its real light-mode colours`, () => {
      // swatches are [primary, accent, background] and drive the picker preview.
      // A palette edit that skips them leaves the picker advertising a colour
      // the theme no longer uses — which is how the accent fix could have
      // silently desynced four themes.
      //
      // Compare RENDERED COLOUR, not notation: the registry stores hex while
      // the baseline declares oklch, and `#6366f1` === `oklch(0.5854 0.2041
      // 277.1173)` exactly. A string compare would only ever pass for the
      // themes that happen to be written in hex.
      const t = resolved(sels.light);
      expect(theme.swatches.map(toHex), `${theme.id} swatches are stale`).toEqual(
        [t.primary!, t.accent!, t.background!].map(toHex),
      );
    });
  }
});

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
