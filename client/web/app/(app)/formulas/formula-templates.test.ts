import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import katex from 'katex';
import { parseFormulaSpec } from '@mantle/content-core/formula-spec';
import { FORMULA_SEED_SLUGS } from '@mantle/content-core/formula-seed';
import { FORMULA_TEMPLATES } from './formula-templates';

/**
 * A template that does not parse is worse than no template: it opens the editor
 * with a rail full of errors the author did not cause, and the first thing they
 * learn about the format is that it is broken.
 */
describe('FORMULA_TEMPLATES', () => {
  it.each(FORMULA_TEMPLATES.map((t) => [t.key, t] as const))('%s parses as YAML', (_key, t) => {
    const spec = YAML.parse(t.yaml);
    expect(spec).toBeTypeOf('object');
    expect(spec).not.toBeNull();
  });

  it.each(FORMULA_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s validates as a formula spec',
    (_key, t) => {
      const parsed = parseFormulaSpec(YAML.parse(t.yaml));
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    },
  );

  it('never shares a spec id with the instructional seed set', () => {
    // The seeder detects "already present" BY spec id. A template saved under
    // a seed slug would make "Add 5 example formulas" silently skip the real
    // one — the showcase originally shipped as 'reynolds-number' and did
    // exactly that.
    const seedSlugs = new Set(FORMULA_SEED_SLUGS);
    for (const t of FORMULA_TEMPLATES) {
      const spec = YAML.parse(t.yaml) as { id?: string };
      expect(seedSlugs.has(spec.id ?? ''), `template '${t.key}' collides on '${spec.id}'`).toBe(
        false,
      );
    }
  });

  /**
   * `latex` survives a JS template literal AND a YAML single-quoted scalar, and
   * getting the backslashes wrong at either step is invisible until something
   * renders it. The first cut carried `\\\\rho`, which reaches KaTeX as `\\rho`
   * — a LINE BREAK followed by the word "rho", not the symbol.
   */
  it('renders every LaTeX string in KaTeX', () => {
    const rendered: string[] = [];
    for (const t of FORMULA_TEMPLATES) {
      const spec = YAML.parse(t.yaml) as { expressions?: Array<{ latex?: string }> };
      for (const e of spec.expressions ?? []) {
        if (!e.latex) continue;
        expect(e.latex).not.toContain('\\\\');
        expect(() =>
          katex.renderToString(e.latex!, { throwOnError: true, trust: false }),
        ).not.toThrow();
        rendered.push(e.latex);
      }
    }
    // Guard the guard: a template set with no LaTeX would pass vacuously.
    expect(rendered.length).toBeGreaterThan(0);
  });
});
