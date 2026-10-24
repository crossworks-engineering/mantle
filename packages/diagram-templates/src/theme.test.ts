/**
 * Theme mode (runtime/theme.ts): a mini app draws a template in its own
 * theme tokens. Pinned here: without the option the drawing is what it was
 * (a canvas, diagram_render and present_export are untouched); with it, the
 * drawing is the same markup plus one scoped stylesheet; and every colour
 * the templates draw with has a token, checked on every sample and on a
 * P&ID that uses every part (test/pid-all-parts.json). The browser test in
 * packages/tools (canvas-render/app-library-examples.test.ts) checks the
 * painted colours in light, dark and a live switch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_ATTR, THEME_COLOURS, estimateMeasurer, render } from './index.ts';
import { PALETTE, SERIES } from './runtime/style.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAWINGS = [
  ...readdirSync(path.join(ROOT, 'samples'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(ROOT, 'samples', f)),
  path.join(ROOT, 'test/pid-all-parts.json'),
];
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { template: string };

describe('theme mode', () => {
  for (const f of DRAWINGS) {
    const name = path.basename(f);
    it(`${name}: no option draws the house style; the option only adds the stylesheet`, () => {
      const data = load(f);
      const plain = render(data.template, data, estimateMeasurer);
      const empty = render(data.template, data, estimateMeasurer, {});
      const themed = render(data.template, data, estimateMeasurer, { theme: 'tokens' });
      expect(plain.ok && empty.ok && themed.ok, name).toBe(true);
      if (!plain.ok || !empty.ok || !themed.ok) return;
      expect(empty.svg).toBe(plain.svg);
      expect(plain.svg).not.toContain(THEME_ATTR);
      expect(plain.svg).not.toContain('<style');
      expect(plain.svg).not.toContain('var(');
      expect(themed.svg.startsWith(`<svg ${THEME_ATTR}="tokens"`)).toBe(true);
      const stripped = themed.svg
        .replace(` ${THEME_ATTR}="tokens"`, '')
        .replace(/<style>[^<]*<\/style>/, '');
      expect(stripped).toBe(plain.svg);
    });

    it(`${name}: every colour drawn has a token`, () => {
      const data = load(f);
      const out = render(data.template, data, estimateMeasurer, { theme: 'tokens' });
      if (!out.ok) throw new Error(out.errors.join('; '));
      const drawn = new Set(
        [...out.svg.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]!),
      );
      drawn.delete('none');
      const missing = [...drawn].filter((c) => !(c in THEME_COLOURS));
      expect(missing, `${name}: house colours with no token`).toEqual([]);
      // ...and the stylesheet carries a rule for each.
      for (const c of drawn) {
        expect(out.svg).toContain(`[fill="${c}"]{fill:${THEME_COLOURS[c]}}`);
        expect(out.svg).toContain(`[stroke="${c}"]{stroke:${THEME_COLOURS[c]}}`);
      }
    });
  }

  it('the whole house palette and the series have tokens', () => {
    for (const c of [...Object.values(PALETTE), ...Object.values(SERIES)]) {
      expect(THEME_COLOURS[c], c).toBeDefined();
    }
  });

  it('the stylesheet is scoped to the themed drawing, so it cannot restyle the page', () => {
    const data = load(DRAWINGS[0]!);
    const out = render(data.template, data, estimateMeasurer, { theme: 'tokens' });
    if (!out.ok) throw new Error('render');
    const css = /<style>([^<]*)<\/style>/.exec(out.svg)![1]!;
    for (const rule of css.split('}').filter(Boolean)) {
      expect(rule.startsWith(`svg[${THEME_ATTR}] `), rule).toBe(true);
    }
  });

  it('a colour the data names itself is the author choice and stays', () => {
    const data = JSON.parse(readFileSync(path.join(ROOT, 'test/pid-all-parts.json'), 'utf8')) as {
      circuits: { colour: string }[];
    };
    data.circuits[0]!.colour = '#123456';
    const out = render('pid', data, estimateMeasurer, { theme: 'tokens' });
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.svg).toContain('"#123456"');
    expect(out.svg).not.toContain('[stroke="#123456"]');
  });
});
