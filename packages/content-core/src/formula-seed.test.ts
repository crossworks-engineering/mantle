import { describe, expect, it } from 'vitest';
import { checkLookupCoverage, parseFormulaSpec, type FormulaSpec } from './formula-spec';
import { checkDimensions } from './formula-dimensions';
import { evaluateSpec } from './formula-eval';
import { signatureOf } from './formula-signature';
import { FORMULA_SEED, FORMULA_SEED_SLUGS, SEED_TAG } from './formula-seed';

/**
 * The seed set is shipped content AND the regression suite. It is held to a
 * higher bar than an owner's own formulas precisely because it is the example
 * everyone learns the format from: it must parse clean, be dimensionally
 * consistent, have no coverage gaps of its own, and produce the right NUMBERS.
 *
 * The arithmetic assertions are the valuable half. A change to the evaluator
 * that quietly breaks exponentiation or lookup matching would otherwise surface
 * on a live assessment rather than in CI.
 */

const specOf = (raw: Record<string, unknown>): FormulaSpec => {
  const parsed = parseFormulaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.spec;
};

describe('FORMULA_SEED', () => {
  it('ships exactly five — the bank is owner-derived, this is only the primer', () => {
    expect(FORMULA_SEED).toHaveLength(5);
  });

  it('has unique slugs matching each spec id, so re-seeding can detect duplicates', () => {
    expect(new Set(FORMULA_SEED_SLUGS).size).toBe(FORMULA_SEED.length);
    for (const f of FORMULA_SEED) expect(f.spec.id).toBe(f.slug);
  });

  it('tags every entry so the owner can find and clear the set as a group', () => {
    for (const f of FORMULA_SEED) expect(f.tags).toContain(SEED_TAG);
  });

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))('%s parses clean', (_slug, f) => {
    const parsed = parseFormulaSpec(f.spec);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))(
    '%s is dimensionally consistent',
    (_slug, f) => {
      expect(checkDimensions(specOf(f.spec))).toEqual([]);
    },
  );

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))(
    '%s has no coverage gaps of its own',
    (_slug, f) => {
      // An owner's transcription may legitimately have gaps (the SOURCE is
      // incomplete). The teaching set must not — a gap here would read as the
      // format being broken.
      expect(checkLookupCoverage(specOf(f.spec))).toEqual([]);
    },
  );

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))(
    '%s cites a source with an edition',
    (_slug, f) => {
      const source = specOf(f.spec).source;
      expect(source?.standard).toBeTruthy();
      // An equation number is part of a claim, and numbers move between
      // editions — so the set practises what formula_authoring preaches.
      expect(source?.edition).toBeTruthy();
    },
  );

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))(
    '%s produces the right numbers',
    (_slug, f) => {
      expect(f.examples.length).toBeGreaterThan(0);
      for (const ex of f.examples) {
        const result = evaluateSpec(specOf(f.spec), ex.target, ex.inputs);
        if (!result.ok) throw new Error(`${f.slug} / ${ex.target}: ${result.error}`);
        expect(typeof result.value).toBe('number');
        expect(result.value as number).toBeCloseTo(
          ex.expected,
          // toBeCloseTo takes digits; derive them from the stated tolerance.
          Math.max(0, Math.round(-Math.log10(ex.tolerance ?? 1e-6))),
        );
      }
    },
  );

  it.each(FORMULA_SEED.map((f) => [f.slug, f] as const))(
    '%s asks only for inputs its signature declares',
    (_slug, f) => {
      // Guards the contract the whole feature rests on: if an example supplies
      // a symbol the signature never mentions, the two have diverged.
      const spec = specOf(f.spec);
      const sig = signatureOf(spec);
      for (const ex of f.examples) {
        const target = sig.find((s) => s.id === ex.target);
        expect(target, `${f.slug}: no signature for target ${ex.target}`).toBeDefined();
        const declared = new Set(target!.inputs.map((i) => i.symbol));
        for (const supplied of Object.keys(ex.inputs)) {
          expect(declared.has(supplied), `${f.slug}/${ex.target}: ${supplied} undeclared`).toBe(
            true,
          );
        }
        // Every REQUIRED input must be covered by the example.
        for (const required of target!.inputs.filter((i) => i.required)) {
          expect(
            Object.hasOwn(ex.inputs, required.symbol),
            `${f.slug}/${ex.target}: missing required ${required.symbol}`,
          ).toBe(true);
        }
      }
    },
  );
});

/**
 * The set's other job: between the five, exercise every part of the model. A
 * teaching set with no piecewise teaches nothing about piecewise.
 */
describe('FORMULA_SEED — construct coverage', () => {
  const specs = FORMULA_SEED.map((f) => specOf(f.spec));
  const some = (p: (s: FormulaSpec) => boolean) => specs.some(p);

  it('covers plain expressions and derived variables', () => {
    expect(some((s) => s.expressions.length > 0)).toBe(true);
    expect(some((s) => s.variables.some((v) => v.role === 'derived'))).toBe(true);
  });

  it('covers constants and defaulted inputs', () => {
    expect(some((s) => s.variables.some((v) => v.role === 'constant'))).toBe(true);
    expect(some((s) => s.variables.some((v) => v.role === 'input' && v.value !== undefined))).toBe(
      true,
    );
  });

  it('covers a piecewise branch', () => {
    expect(some((s) => s.piecewise.length > 0)).toBe(true);
  });

  it('covers a lookup with DECLARED domains — the reason coverage checking works', () => {
    expect(some((s) => s.lookups.some((l) => l.domains && Object.keys(l.domains).length > 0))).toBe(
      true,
    );
  });

  it('covers a classification with criteria prose', () => {
    expect(some((s) => s.classifications.length > 0)).toBe(true);
  });

  it('covers latex, notes, and units on results', () => {
    expect(some((s) => s.expressions.some((e) => e.latex))).toBe(true);
    expect(some((s) => Boolean(s.notes && Object.keys(s.notes).length > 0))).toBe(true);
    expect(some((s) => s.expressions.some((e) => e.unit))).toBe(true);
  });

  it('carries exactly one unverified equation — the warning has to be seeable', () => {
    const unverified = specs.flatMap((s) => s.expressions.filter((e) => e.unverified));
    expect(unverified).toHaveLength(1);
    // And it must say WHY, since that text is what a reader acts on.
    expect(unverified[0]!.unverified!.length).toBeGreaterThan(40);
  });

  it('covers symbol chaining through a produced result', () => {
    // pump-hydraulic-power's shaft power resolves Ph via the target producing it.
    const chained = specs.some((s) =>
      s.expressions.some((e) =>
        s.expressions.some(
          (o) => o.id !== e.id && o.resultSymbol && e.expression.includes(`{${o.resultSymbol}}`),
        ),
      ),
    );
    expect(chained).toBe(true);
  });
});
