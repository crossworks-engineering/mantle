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
      `[stroke="${ROLE_COLOURS.main}"]{stroke:var(--diagram-main, var(--destructive))}`,
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
