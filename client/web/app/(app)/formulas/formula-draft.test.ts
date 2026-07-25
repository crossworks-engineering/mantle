import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { parseFormulaSpec } from '@mantle/content/formula-spec';
import { listOf, normalised, prune, scalar, toSpec, type Draft } from './formula-draft';
import { FORMULA_TEMPLATES } from './formula-templates';

describe('scalar', () => {
  it('reads a number as a number, so a lookup key still matches its rows', () => {
    // Lookup matching is strict equality — a key stored as '20' would never
    // match a row carrying 20.
    expect(scalar('0.61')).toBe(0.61);
    expect(scalar('20')).toBe(20);
    expect(scalar('-3')).toBe(-3);
    expect(scalar('1e5')).toBe(100000);
  });

  it('leaves values that merely contain digits alone', () => {
    expect(scalar('1/4 in')).toBe('1/4 in');
    expect(scalar('A')).toBe('A');
    expect(scalar('1.2.3')).toBe('1.2.3');
    expect(scalar('lbf/in2')).toBe('lbf/in2');
  });

  it('reads booleans, and treats blank as absent', () => {
    expect(scalar('true')).toBe(true);
    expect(scalar('false')).toBe(false);
    expect(scalar('   ')).toBeUndefined();
  });
});

describe('prune', () => {
  it('drops what the author never typed', () => {
    expect(prune({ id: 'x', latex: '', note: null, tags: [] })).toEqual({ id: 'x' });
  });

  it('keeps false and zero — they are values, not absences', () => {
    // A reduction factor of 0.0 is a real entry in a printed table; dropping it
    // would turn a specified zero into a missing row.
    expect(prune({ factor: 0, unverified: false })).toEqual({ factor: 0, unverified: false });
  });

  it('collapses an object left empty by pruning', () => {
    expect(prune({ source: { standard: '', part: '' } })).toBeUndefined();
  });
});

describe('normalised', () => {
  it('always carries the five spec arrays', () => {
    expect(Object.keys(normalised({ id: 'x' })).sort()).toEqual([
      'classifications',
      'expressions',
      'id',
      'lookups',
      'piecewise',
      'variables',
    ]);
  });

  it('does not clobber arrays that are already there', () => {
    const draft = { variables: [{ symbol: 'a' }] };
    expect(normalised(draft).variables).toEqual([{ symbol: 'a' }]);
  });
});

describe('listOf', () => {
  it('trims and drops blanks', () => {
    expect(listOf(' 5.3 , , 5.4 ')).toEqual(['5.3', '5.4']);
    expect(listOf('')).toEqual([]);
  });
});

/**
 * The property that matters most. The form and the YAML view are two windows
 * onto one draft, and an author will switch between them mid-edit — so a trip
 * through YAML and back must not change the spec. If it ever does, the failure
 * is silent and lands in a stored safety calculation.
 */
describe('form ↔ source round trip', () => {
  it.each(FORMULA_TEMPLATES.map((t) => [t.key, t.yaml] as const))(
    '%s survives draft → YAML → draft unchanged',
    (_key, yaml) => {
      const draft = normalised(YAML.parse(yaml) as Draft);
      const once = toSpec(draft);
      const again = toSpec(normalised(YAML.parse(YAML.stringify(once)) as Draft));
      expect(again).toEqual(once);
    },
  );

  it('preserves a spec that validates, through the round trip', () => {
    const yaml = FORMULA_TEMPLATES.find((t) => t.key === 'full')!.yaml;
    const spec = toSpec(normalised(YAML.parse(yaml) as Draft));
    const back = toSpec(normalised(YAML.parse(YAML.stringify(spec)) as Draft));
    const a = parseFormulaSpec(spec);
    const b = parseFormulaSpec(back);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.spec).toEqual(a.spec);
  });

  it('keeps numeric lookup values numeric across the trip', () => {
    // The failure this guards: a factor re-read as a string, so the strict
    // row match in the evaluator silently stops finding it.
    const draft = normalised({
      id: 'x',
      lookups: [
        {
          id: 't',
          keys: ['rating'],
          result: 'factor',
          rows: [{ rating: 'A', factor: 0.25 }],
        },
      ],
    } as Draft);
    const back = toSpec(normalised(YAML.parse(YAML.stringify(toSpec(draft))) as Draft));
    const rows = (back.lookups as Array<{ rows: Array<Record<string, unknown>> }>)[0]!.rows;
    expect(rows[0]!.factor).toBe(0.25);
    expect(typeof rows[0]!.factor).toBe('number');
  });
});
