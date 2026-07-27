import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The generator is plain .mjs (it runs under `node` at build time with no
// transpile step); vitest resolves it fine. Importing it is side-effect free —
// the CLI is guarded to direct execution.
import { generateCss, generateMode, generateRegistry, ROLE_HUES } from '../../themes/generate.mjs';
import { contrast, cssToHex, deltaE, solvePair, solveText } from '../../themes/model.mjs';
import { THEME_SEEDS } from '../../themes/seeds.mjs';

/**
 * The generator's own guarantees. `themes.test.ts` re-measures the WCAG
 * numbers on the shipped CSS with independent maths; this suite covers what
 * that one can't:
 *
 *   - DRIFT: the checked-in artifacts are exactly what the seeds generate.
 *     Editing themes.css by hand, or seeds without `pnpm themes:build`, fails
 *     here — the generated file cannot rot out from under its source.
 *   - the anchored-solver's behavioural contract (a passing value is emitted
 *     byte-for-byte; a failing one moves minimally; the ROUNDED hex is what
 *     gets validated — floats that clear 4.5 land at 4.48 as 8-bit hex, which
 *     cost nine test failures the first time),
 *   - distinguishability: the semantic roles stay tellable-apart from
 *     destructive and each other, and generated chart ramps never collapse
 *     two steps onto one colour (the achromatic dark ramps did exactly that
 *     before the ladder was made sequential).
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('drift', () => {
  it('styles/themes.css is exactly what the seeds generate', () => {
    expect(
      read('../../styles/themes.css') === generateCss(),
      'themes.css does not match themes/seeds.mjs — run `pnpm themes:build` (and never edit the generated file by hand)',
    ).toBe(true);
  });

  it('the picker registry is exactly what the seeds generate', () => {
    expect(
      read('./theme-registry.gen.ts') === generateRegistry(),
      'theme-registry.gen.ts does not match themes/seeds.mjs — run `pnpm themes:build`',
    ).toBe(true);
  });
});

describe('anchored solver', () => {
  it('emits a passing anchor byte-for-byte unchanged', () => {
    expect(solveText('#1e293b', ['#ffffff', '#f8fafc']).hex).toBe('#1e293b');
  });

  it('moves a failing anchor the minimum, keeping hue and chroma', () => {
    const r = solveText('#999999', ['#ffffff']);
    expect(contrast(r.hex, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    // an achromatic anchor stays achromatic (hue/chroma untouched) …
    const [rr, gg, bb] = [r.hex.slice(1, 3), r.hex.slice(3, 5), r.hex.slice(5, 7)];
    expect(rr).toBe(gg);
    expect(gg).toBe(bb);
    // … and lands just past the threshold, not at some distant safe colour.
    expect(contrast(r.hex, '#ffffff')).toBeLessThan(5.2);
  });

  it('validates the rounded hex it emits, not the float candidate', () => {
    // Property: for a spread of anchors and surfaces, the EMITTED hex —
    // re-parsed as 8-bit — must clear the ratio. A solver that measures floats
    // fails this on boundary values.
    const surfaces = ['#ffffff', '#f3f4f6', '#1b1b19', '#262626'];
    for (const anchor of ['#6366f1', '#ef4444', '#0c9746', '#ae6f00', '#c96442', '#72e3ad']) {
      for (const surface of surfaces) {
        const r = solveText(anchor, [surface]);
        expect(r.feasible).toBe(true);
        expect(contrast(r.hex, surface), `${anchor} solved on ${surface}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('pair solve keeps a consistent authored pair verbatim', () => {
    const pair = solvePair('#457928', '#ffffff'); // pinnacle primary: passes as authored
    expect(pair.fill).toBe(cssToHex('#457928'));
    expect(pair.fg).toBe('#ffffff');
  });

  it('pair solve deepens a broken fill rather than flipping its text dark', () => {
    // White on #e6067a is 3.9:1 — the classic authored defect. The one-sided
    // fix is near-black text (an identity flip); the pair solve must instead
    // deepen the fill and KEEP the light foreground.
    const pair = solvePair('#e6067a', '#ffffff');
    expect(contrast(pair.fg, pair.fill)).toBeGreaterThanOrEqual(4.5);
    expect(deltaE(pair.fg, '#ffffff'), 'foreground flipped instead of fill deepening').toBeLessThan(
      0.1,
    );
    expect(deltaE(pair.fill, '#e6067a')).toBeLessThan(0.2);
  });
});

describe('generated palette distinguishability', () => {
  const ROLES = Object.keys(ROLE_HUES);
  for (const seed of THEME_SEEDS) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${seed.id} ${mode}: roles and charts stay tellable-apart`, () => {
        const t = generateMode(seed[mode], { mode }) as Record<string, string>;
        // each semantic role vs destructive and vs its siblings
        const fills = ['destructive', ...ROLES];
        for (let i = 0; i < fills.length; i++) {
          for (let j = i + 1; j < fills.length; j++) {
            const d = deltaE(t[fills[i]!]!, t[fills[j]!]!);
            expect(
              d,
              `${seed.id}/${mode}: ${fills[i]} and ${fills[j]} are ΔE ${d.toFixed(3)} apart — ` +
                `a status colour that can be mistaken for another is worse than none`,
            ).toBeGreaterThanOrEqual(0.06);
          }
        }
        // charts: a categorical ramp with two equal steps mislabels data
        if (!seed[mode].charts) {
          for (let i = 1; i <= 5; i++) {
            for (let j = i + 1; j <= 5; j++) {
              const d = deltaE(t[`chart-${i}`]!, t[`chart-${j}`]!);
              expect(
                d,
                `${seed.id}/${mode}: chart-${i} vs chart-${j} ΔE ${d.toFixed(3)}`,
              ).toBeGreaterThanOrEqual(0.05);
            }
          }
        }
      });
    }
  }
});

describe('seeds hygiene', () => {
  it('ids are unique and clean-slate is the baseline', () => {
    const ids = THEME_SEEDS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('clean-slate');
  });

  it('every seeded colour is normalised 6-digit hex', () => {
    // The extractor normalised all notations; keeping seeds in one notation is
    // what makes "passing anchors ship byte-for-byte" reviewable in a diff.
    for (const t of THEME_SEEDS) {
      for (const mode of ['light', 'dark'] as const) {
        for (const [k, v] of Object.entries(t[mode])) {
          if (k === 'extras') continue;
          const values = k === 'charts' ? (v as string[]) : [v as string];
          for (const value of values) {
            expect(value, `${t.id}.${mode}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
      }
    }
  });
});
