import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLOR_THEMES } from './themes';

/**
 * Contrast contract for EVERY theme — light and dark.
 *
 * themes.css is generated (themes/generate.mjs solves each text token against
 * the surfaces it must be legible on), so this suite can demand the full
 * matrix from all themes instead of hand-asserting Pinnacle and hoping about
 * the rest. It deliberately re-implements the colour maths and re-parses the
 * CSS instead of importing the generator: the generator asserting its own
 * output would prove nothing, this recomputes the WCAG numbers from scratch on
 * the exact bytes that ship. If the generator's solver, gamut clamp or hex
 * rounding drifts, these fail.
 *
 *   4.5:1  text — every `-foreground` on its own fill; `foreground` and
 *          `muted-foreground` on every neutral surface; every ink
 *          (primary/destructive/success/warning/info and the code-* syntax
 *          palette) on every neutral surface, because inks land wherever their
 *          ~330 call sites happen to sit.
 *   3.0:1  non-text — focus rings against what they ring, and generated chart
 *          colours against the chart surfaces. Seeded brand ramps (pinnacle)
 *          are authored artwork and exempt from the chart bar.
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

/** A CSS colour value -> linear-light sRGB. The generator emits hex, but the
 *  parser keeps oklch()/hsl() support so a hand-written value in a consumer
 *  stylesheet can be measured too. */
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

/** Every fill and the -foreground the theme declares goes on it. */
const ON_FILL_PAIRS: Array<[string, string]> = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['info-foreground', 'info'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
];

/** Tokens used as TEXT on an undeclared surface, and the surfaces they can
 *  land on. THE POINT OF THE INK TOKENS: `text-primary-ink`, a code-* token in
 *  a highlighted block, a success-ink status line — none of these declare a
 *  background, so each must clear AA against ALL neutral surfaces, in every
 *  theme. That is a promise the fills could not keep (a fill must also stay
 *  behind its own light -foreground; in dark mode the two jobs pull opposite
 *  ways) — the split is what makes this assertion satisfiable at all. */
const INK_TOKENS = [
  'primary-ink',
  'destructive-ink',
  'success-ink',
  'warning-ink',
  'info-ink',
  'code-keyword',
  'code-string',
  'code-number',
  'code-title',
  'code-variable',
] as const;
const INK_SURFACES = ['background', 'card', 'muted', 'popover', 'sidebar'] as const;

/** The app's body and secondary text land on every neutral surface too. */
const WIDE_TEXT = ['foreground', 'muted-foreground'] as const;

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

describe('every registered theme', () => {
  for (const theme of COLOR_THEMES) {
    const sels = selectorsFor(theme.id);
    for (const [mode, selector] of [
      ['light', sels.light],
      ['dark', sels.dark],
    ] as const) {
      const t = resolved(selector);

      it(`${theme.id} ${mode}: every -foreground reaches AA on its own fill`, () => {
        for (const [fg, fill] of ON_FILL_PAIRS) {
          const ratio = contrast(t[fg]!, t[fill]!);
          expect(
            ratio,
            `${theme.id} (${mode}) renders ${fg} ${t[fg]} on ${fill} ${t[fill]} at ` +
              `${ratio.toFixed(2)}:1. The generator must solve this pair — fix the seed or ` +
              `the solver, never the emitted CSS.`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });

      it(`${theme.id} ${mode}: every ink is legible on every neutral surface`, () => {
        for (const ink of [...INK_TOKENS, ...WIDE_TEXT]) {
          for (const surface of INK_SURFACES) {
            const ratio = contrast(t[ink]!, t[surface]!);
            expect(
              ratio,
              `${theme.id} (${mode}): ${ink} ${t[ink]} on ${surface} ${t[surface]} is ` +
                `${ratio.toFixed(2)}:1 — inks land on any neutral surface, so all must clear AA.`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it(`${theme.id} ${mode}: focus rings reach non-text contrast`, () => {
        for (const [ring, surface] of UI_PAIRS) {
          expect(
            contrast(t[ring]!, t[surface]!),
            `${theme.id} (${mode}): ${ring} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      });
    }

    it(`${theme.id}: picker swatches match its real light-mode colours`, () => {
      // swatches are [primary, accent, background] and drive the picker
      // preview. They are generated from the same seeds as the CSS, so a
      // mismatch means one artifact was rebuilt without the other.
      //
      // Compare RENDERED COLOUR, not notation, so a hand-added registry entry
      // written in oklch would still be judged fairly.
      const t = resolved(sels.light);
      expect(theme.swatches.map(toHex), `${theme.id} swatches are stale`).toEqual(
        [t.primary!, t.accent!, t.background!].map(toHex),
      );
    });
  }
});

describe('dropped themes stay dropped', () => {
  // retro-arcade declared its own body text on its own muted fill at 2.01:1 —
  // structurally self-contradicting palettes were removed, not repainted. A
  // stored data-color-theme for one of these falls back to the :root baseline
  // because no block matches, which is the intended degradation.
  for (const id of ['retro-arcade', 'northern-lights']) {
    it(`${id} has no CSS block and no registry entry`, () => {
      expect(CSS).not.toContain(`[data-color-theme="${id}"]`);
      expect(COLOR_THEMES.map((t) => t.id)).not.toContain(id);
    });
  }
});

describe('pinnacle theme', () => {
  it('is registered in the picker', () => {
    expect(COLOR_THEMES.map((t) => t.id)).toContain('pinnacle');
    expect(CSS).toContain('[data-color-theme="pinnacle"]');
    expect(CSS).toContain('.dark[data-color-theme="pinnacle"]');
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
    it(`${mode}: keeps the brand hues in the chart ramp`, () => {
      // The one seeded `charts` override: Pinnacle's ramp is brand identity,
      // pinned verbatim by the seed rather than generated.
      const t = tokens(selector);
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
  }
});
