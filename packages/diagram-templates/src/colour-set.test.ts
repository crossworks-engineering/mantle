/**
 * The colour set (style 2): one fixed colour per meaning, each clearing the
 * WCAG contrast a line (3:1) and its text (4.5:1) need on the paper and on
 * white, each told apart in grey by its weight, dash or words; and the
 * classic style untouched for every drawing saved before it (style absent
 * or 1 draws byte for byte as before). All tags are made up.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PALETTE, ROLE_COLOURS, ROLE_STROKES, contrastRatio, luminance } from './runtime/style.ts';
import { THEME_ROLE_COLOURS } from './runtime/theme.ts';
import { lineNoteSuffix, markSuffix } from './templates/pid/check.ts';
import { wordColour } from './templates/pid/render.ts';
import { buildCanvas, checkStaticSvg, estimateMeasurer, render, validate } from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f: string) =>
  JSON.parse(readFileSync(path.join(ROOT, f), 'utf8')) as Record<string, unknown>;
const svgOf = (data: unknown, opts?: { theme: 'tokens' }) => {
  const r = render('pid', data, estimateMeasurer, opts);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
};

describe('the colour set', () => {
  it.each(Object.entries(ROLE_COLOURS))('%s clears 4.5:1 on paper and white', (_role, hex) => {
    // Text needs 4.5:1, a line 3:1: every role is both.
    expect(contrastRatio(hex, PALETTE.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex, PALETTE.white)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex, PALETTE.paper)).toBeGreaterThanOrEqual(3);
  });

  it('computes WCAG contrast as the spec does', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(luminance('#ffffff')).toBeCloseTo(1, 6);
    // The house accent, as style.ts says: about 4.7 on paper.
    expect(contrastRatio(PALETTE.accent, PALETTE.paper)).toBeGreaterThan(4.5);
  });

  it('is one colour per meaning', () => {
    const values = Object.values(ROLE_COLOURS);
    expect(new Set(values).size).toBe(values.length);
    // None of them is a house colour that already means something else.
    for (const v of values) expect(Object.values(PALETTE)).not.toContain(v);
  });

  it('reads in grey: the line roles differ in weight or dash', () => {
    const { main, branch, deadleg } = ROLE_STROKES;
    expect(main.width).toBeGreaterThan(branch.width);
    expect(main.dash).toBeUndefined();
    expect(branch.dash).toBeUndefined();
    expect(deadleg.dash).toBeTruthy();
  });

  it('every role has its own theme token for a mini app, no two the same', () => {
    const tokens = Object.values(ROLE_COLOURS).map((v) => THEME_ROLE_COLOURS[v]);
    for (const t of tokens) expect(t).toBeTruthy();
    expect(new Set(tokens).size).toBe(tokens.length);
    // Each falls back to a different expression too, not only a different name.
    const fallbacks = tokens.map((t) => /^var\(--diagram-[a-z]+, (.*)\)$/.exec(t!)?.[1]);
    expect(new Set(fallbacks).size).toBe(tokens.length);
  });
});

/** A theme token's colour: `var()` with its fallback, `color-mix(in
 *  oklab, a p%, b)` and `#rrggbb`, as a browser computes them (CSS Color 4,
 *  Oklab with the gamut clipped). Enough for the role tokens, no more. */
type Rgb = [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const rgbOf = (hex: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const hexOf = (c: Rgb) =>
  `#${c
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const toOklab = (c: Rgb): Rgb => {
  const [r, g, b] = c.map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const fromOklab = ([L, a, b]: Rgb): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => gam(Math.min(1, Math.max(0, v)))) as Rgb;
};
function resolveToken(expr: string, vars: Record<string, string>): string {
  const e = expr.trim();
  const v = /^var\(--([\w-]+)(?:,\s*([\s\S]*))?\)$/.exec(e);
  if (v) {
    const own = vars[v[1]!];
    if (own !== undefined) return resolveToken(own, vars);
    if (v[2] === undefined) throw new Error(`--${v[1]} is not set`);
    return resolveToken(v[2], vars);
  }
  const mix = /^color-mix\(in oklab,\s*([\s\S]*)\)$/.exec(e);
  if (mix) {
    const body = mix[1]!;
    let depth = 0;
    let i = 0;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
      else if (body[i] === ',' && depth === 0) break;
    }
    const first = /^([\s\S]*)\s+([\d.]+)%$/.exec(body.slice(0, i).trim())!;
    const p = Number(first[2]) / 100;
    const a = toOklab(rgbOf(resolveToken(first[1]!, vars)));
    const b = toOklab(rgbOf(resolveToken(body.slice(i + 1), vars)));
    return hexOf(fromOklab([0, 1, 2].map((k) => a[k]! * p + b[k]! * (1 - p)) as Rgb));
  }
  if (/^#[0-9a-f]{6}$/i.test(e)) return e;
  throw new Error(`not a colour this test reads: ${e}`);
}

/** Every theme the apps ship (share-ui themes.css), light and dark, as
 *  the tokens a drawing inside it sees (a dark block over its light one). */
function shippedThemes(): { name: string; vars: Record<string, string> }[] {
  const css = readFileSync(path.join(ROOT, '../share-ui/styles/themes.css'), 'utf8');
  const blocks = [...css.matchAll(/^([^\n{@]+)\{([^}]*)\}/gm)].map((m) => ({
    sel: m[1]!.trim(),
    vars: Object.fromEntries(
      [...m[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]),
    ),
  }));
  const light = blocks.find((b) => b.sel.startsWith(':root'))!.vars;
  const dark = blocks.find((b) => b.sel === '.dark')!.vars;
  const out: { name: string; vars: Record<string, string> }[] = [];
  const lightOf = new Map<string, Record<string, string>>();
  for (const b of blocks) {
    if (!b.vars.card) continue;
    const theme = /data-color-theme="([^"]+)"/.exec(b.sel)?.[1] ?? 'default';
    const isDark = b.sel.startsWith('.dark');
    if (!isDark) lightOf.set(theme, b.vars);
    const vars = isDark
      ? { ...light, ...(lightOf.get(theme) ?? {}), ...dark, ...b.vars }
      : { ...light, ...b.vars };
    out.push({ name: `${theme} ${isDark ? 'dark' : 'light'}`, vars });
  }
  return out;
}

describe('the themed roles keep their contrast in every shipped theme', () => {
  const themes = shippedThemes();
  it('reads the themes, light and dark', () => {
    expect(themes.length).toBeGreaterThan(20);
    expect(themes.some((t) => t.name === 'default light')).toBe(true);
    expect(themes.some((t) => t.name === 'default dark')).toBe(true);
  });
  it.each(themes.map((t) => [t.name, t.vars] as const))(
    '%s: each role clears 3:1 as a line and 4.5:1 as text on the card',
    (_name, vars) => {
      const card = resolveToken('var(--card)', vars);
      const low: string[] = [];
      for (const [role, hex] of Object.entries(ROLE_COLOURS)) {
        const token = THEME_ROLE_COLOURS[hex]!;
        // themeCss: a line takes the token, text a quarter of the foreground.
        const line = resolveToken(token, vars);
        const text = resolveToken(`color-mix(in oklab, ${token} 75%, var(--foreground))`, vars);
        if (contrastRatio(line, card) < 3)
          low.push(`${role} line ${contrastRatio(line, card).toFixed(2)}`);
        if (contrastRatio(text, card) < 4.5)
          low.push(`${role} text ${contrastRatio(text, card).toFixed(2)}`);
      }
      expect(low).toEqual([]);
    },
  );
});

describe('style 2 draws in the colour set', () => {
  // A made-up loop: a main line with a control valve, a branch, a bubble.
  const data = {
    title: 'Colour check',
    description: 'A made-up drum, its pump and a level loop.',
    style: 2,
    equipment: [
      { id: 'V-101', type: 'vertical-vessel' },
      { id: 'P-101', type: 'centrifugal-pump' },
    ],
    lines: [
      {
        id: 'L1',
        number: '4"-P-1001-A1',
        from: 'V-101',
        to: 'P-101',
        inline: [{ type: 'control', tag: 'LV-101' }],
      },
      { id: 'L2', from: 'T-1', end: 'cap', weight: 'secondary' },
    ],
    tees: [{ id: 'T-1', on: 'L1' }],
    instruments: [{ tag: 'LT-101', on: 'V-101' }],
    signals: [{ from: 'LT-101', to: 'LV-101' }],
  };

  it('checks clean, draws static, and uses the roles', () => {
    expect(validate('pid', data).ok).toBe(true);
    const r = svgOf(data);
    expect(checkStaticSvg(r.svg)).toEqual([]);
    expect(r.svg).toContain(`stroke="${ROLE_COLOURS.main}"`);
    expect(r.svg).toContain(`stroke-width="${ROLE_STROKES.main.width}"`);
    expect(r.svg).toContain(`stroke="${ROLE_COLOURS.instrument}"`);
  });

  it('a deadleg is dashed and named in the legend', () => {
    const r = svgOf({ ...load('test/pid-set.json'), style: 2 });
    const page = r.pages!.find((p) => p.id === 'sheet-1')!;
    expect(page.svg).toContain(`stroke="${ROLE_COLOURS.deadleg}"`);
    expect(page.svg).toContain(`stroke-dasharray="${ROLE_STROKES.deadleg.dash}"`);
    expect(page.svg).toContain('>DEADLEG<');
    // A guess note in the guess colour, a page reference in the link one.
    expect(r.svg).toMatch(
      new RegExp(`fill="${ROLE_COLOURS.guess}"[^>]*>INFERRED JOIN \\(GUESS\\)`),
    );
    expect(r.svg).toMatch(new RegExp(`fill="${ROLE_COLOURS.link}"[^>]*>SEE PAGE`));
  });

  it('a set gives its style to every page', () => {
    const r = svgOf({ ...load('test/pid-set.json'), style: 2 });
    for (const p of r.pages!) expect(p.svg, p.id).toContain(ROLE_COLOURS.main);
  });

  it('themes the roles for a mini app, and only when used', () => {
    const themed = svgOf(data, { theme: 'tokens' }).svg;
    expect(themed).toContain(
      `[stroke="${ROLE_COLOURS.main}"]{stroke:var(--diagram-main, var(--destructive-ink, var(--destructive)))}`,
    );
    const classic = svgOf(load('test/pid-all-parts.json'), { theme: 'tokens' }).svg;
    expect(classic).not.toContain(ROLE_COLOURS.main);
  });

  it('a classic drawing whose profile names a role colour keeps it as the author set it', () => {
    // A circuit coloured with the main line's hex, in a style 1 drawing.
    const own = {
      ...data,
      style: 1,
      circuits: [{ id: 'C1', colour: ROLE_COLOURS.main, lines: ['L1'] }],
    };
    const themed = svgOf(own, { theme: 'tokens' }).svg;
    expect(themed).toContain(ROLE_COLOURS.main);
    expect(themed).not.toContain(`[stroke="${ROLE_COLOURS.main}"]{`);
  });

  it('a themed set of style 2 themes its roles', () => {
    const r = svgOf({ ...load('test/pid-set.json'), style: 2 }, { theme: 'tokens' });
    expect(r.pages![0]!.svg + r.svg).toContain('--diagram-');
  });
});

describe('older drawings keep their output', () => {
  const files = [
    'samples/pid-feed-drum.json',
    'samples/pid-column-site-profile.json',
    'test/pid-all-parts.json',
    'test/pid-set.json',
    'test/pid-tee-bypass.json',
  ];

  it.each(files)('%s: style 1 and a view draw byte for byte as no style', (f) => {
    const d = load(f);
    const before = svgOf(d);
    expect(svgOf({ ...d, style: 1 }).svg).toBe(before.svg);
    expect(svgOf({ ...d, view: { zoom: false } }).svg).toBe(before.svg);
    expect(svgOf({ ...d, view: {} }).warnings).toEqual(before.warnings);
    // And style 2 is a different drawing (the pin is not vacuous).
    expect(svgOf({ ...d, style: 2 }).svg).not.toBe(before.svg);
  });

  it('a canvas without crops is the same file as before', () => {
    const d = load('samples/pid-feed-drum.json');
    const a = buildCanvas({ template: 'pid', data: d, mode: 'import' });
    expect(a).not.toContain('diagram-assets');
    expect(buildCanvas({ template: 'pid', data: d, mode: 'import', assets: { crops: {} } })).toBe(
      a,
    );
  });

  it('refuses a style edition that does not exist', () => {
    const r = validate('pid', { ...load('samples/pid-feed-drum.json'), style: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/style: 3 is not a style edition/);
  });
});

describe('the trust words take their colour from the words the view draws', () => {
  it('every word markSuffix and lineNoteSuffix can draw has its role colour', () => {
    const C = ROLE_COLOURS;
    const marks: [Parameters<typeof markSuffix>[0], string][] = [
      ['unchecked', C.guess],
      ['unsure', C.guess],
      ['checked', C.checked],
      ['contradicted', C.contradicted],
      [{ state: 'corrected', alt: 'orifice' }, C.corrected],
      [{ state: 'corrected' }, C.contradicted],
    ];
    for (const [m, colour] of marks)
      expect(wordColour(markSuffix(m)), JSON.stringify(m)).toBe(colour);
    const join = (state: string) => ({ key: 'g', kind: 'join', state });
    const valve = (state: string) => ({ check: { key: 'v', kind: 'valve', state } });
    const lines: [unknown, string][] = [
      [{ checks: [join('checked')] }, C.checked],
      [{ checks: [join('unchecked')] }, C.guess],
      [{ checks: [join('contradicted')] }, C.contradicted],
      [{ checks: [join('contradicted'), join('contradicted')] }, C.contradicted],
      [{ inline: [valve('contradicted')] }, C.contradicted],
      [{ inline: [valve('corrected')] }, C.corrected],
      [{ inline: [valve('checked')] }, C.checked],
    ];
    for (const [l, colour] of lines) {
      const word = lineNoteSuffix(l);
      expect(word, JSON.stringify(l)).not.toBe('');
      expect(wordColour(word), word).toBe(colour);
    }
    expect(lineNoteSuffix({ checks: [join('contradicted'), join('contradicted')] })).toBe(
      ' (GUESS; IMAGE: 2 NO)',
    );
  });
});

describe("a drawing's own colours are never a check's", () => {
  const trust = [
    ROLE_COLOURS.guess,
    ROLE_COLOURS.checked,
    ROLE_COLOURS.contradicted,
    ROLE_COLOURS.corrected,
  ];
  const drawing = (extra: Record<string, unknown>) => ({
    title: 'Colours',
    equipment: [
      { id: 'V-1', type: 'vertical-vessel' },
      { id: 'V-2', type: 'vertical-vessel' },
    ],
    lines: [{ id: 'L1', from: 'V-1', to: 'V-2', service: 'P' }],
    ...extra,
  });

  it('a circuit or a service in a trust colour is refused, in any case, with what to pick', () => {
    for (const hex of [...trust, ...trust.map((c) => c.toUpperCase())]) {
      const circuit = validate(
        'pid',
        drawing({ circuits: [{ id: 'C1', colour: hex, lines: ['L1'] }] }),
      );
      expect(circuit.ok, hex).toBe(false);
      expect(circuit.ok ? '' : circuit.errors.join(' ')).toMatch(
        /circuits\[0\]\.colour: .* keeps for the image check .* Pick another/,
      );
      const service = validate('pid', drawing({ profile: { serviceColours: { P: hex } } }));
      expect(service.ok, hex).toBe(false);
      expect(service.ok ? '' : service.errors.join(' ')).toMatch(
        /profile\.serviceColours\.P: .* image check/,
      );
    }
  });

  it('any other colour, a role colour of a line included, is kept', () => {
    for (const hex of [ROLE_COLOURS.main, ROLE_COLOURS.branch, '#123456', 'series-2']) {
      expect(
        validate('pid', drawing({ circuits: [{ id: 'C1', colour: hex, lines: ['L1'] }] })).ok,
        hex,
      ).toBe(true);
      expect(validate('pid', drawing({ profile: { serviceColours: { P: hex } } })).ok, hex).toBe(
        true,
      );
    }
  });
});
