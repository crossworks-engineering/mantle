import { describe, expect, it } from 'vitest';
import { checkLookupCoverage, parseFormulaSpec } from './formula-spec';
import { evaluateSpec } from './formula-eval';

/**
 * The fixture is a real model, not a toy: the release-quantity calculation from
 * API RP 581 Part 3 (§5.3.2, §5.3.3.a, Tables 5.5–5.7). It is the reason the
 * spec format has four element kinds, so it is what the tests are held to.
 */
const raw = {
  id: 'api581-release-quantity',
  name: 'Release Quantity',
  source: { standard: 'API RP 581', part: '3', sections: ['5.3.2', '5.3.3.a'] },
  unitSystem: 'USC',
  variables: [
    { symbol: 'Cd', role: 'constant', value: 0.61, unit: null },
    { symbol: 'Kvn', role: 'constant', value: 1, unit: null },
    { symbol: 'C1', role: 'constant', value: 12, unit: 'in/ft' },
    { symbol: 'C2', role: 'constant', value: 1, unit: null },
    { symbol: 'gc', role: 'constant', value: 32.2, unit: 'ft/s2' },
    { symbol: 'R', role: 'constant', value: 1545, unit: 'ft-lb/(mol·R)' },
    { symbol: 'k', role: 'constant', value: 1.5, unit: null },
    { symbol: 'Patm', role: 'constant', value: 14.7, unit: 'lbf/in2 (abs)' },
    { symbol: 'd', role: 'input', value: 0.375, unit: 'in' },
    { symbol: 'An', role: 'derived', expression: 'PI / 4 * {d} ^ 2', unit: 'in2' },
    { symbol: 'rho_l', role: 'input', unit: 'lb/ft3' },
    { symbol: 'Pgauge', role: 'input', unit: 'lbf/in2 (g)' },
    { symbol: 'Ps', role: 'input', unit: 'lbf/in2 (abs)' },
    { symbol: 'MW', role: 'input', unit: 'lb/mol' },
    { symbol: 'Ts', role: 'input', unit: 'R' },
    { symbol: 'ReleaseTime', role: 'input', value: 3600, unit: 'sec' },
    { symbol: 'Wn', role: 'output', unit: 'lb/sec' },
  ],
  expressions: [
    {
      id: 'liquid-release-rate',
      equation: '3.3',
      resultSymbol: 'Wn',
      expression: '{Cd} * {Kvn} * {rho_l} * ({An} / {C1}) * SQRT(2 * {gc} * {Pgauge} / {rho_l})',
    },
    {
      id: 'transition-pressure',
      equation: '3.7',
      resultSymbol: 'Ptrans',
      expression: '{Patm} * (({k} + 1) / 2) ^ ({k} / ({k} - 1))',
    },
    {
      id: 'vapor-sonic',
      equation: '3.6',
      expression:
        '({Cd} / {C2}) * {An} * {Ps} * SQRT( ({k} * {MW} * {gc}) / ({R} * {Ts})' +
        ' * (2 / ({k} + 1)) ^ (({k} + 1) / ({k} - 1)) )',
    },
    {
      id: 'vapor-subsonic',
      equation: '3.5',
      expression:
        '({Cd} / {C2}) * {An} * {Ps} * SQRT( (({MW} * {gc}) / ({R} * {Ts}))' +
        ' * ((2 * {k}) / ({k} - 1)) * ({Patm} / {Ps}) ^ (2 / {k})' +
        ' * (1 - ({Patm} / {Ps}) ^ (({k} - 1) / {k})) )',
    },
    {
      id: 'volume-bbl',
      expression: '0.1781 * ({Wn} / {rho_l}) * {ReleaseTime}',
    },
  ],
  piecewise: [
    {
      id: 'vapor-release-rate',
      resultSymbol: 'Wn',
      cases: [
        { when: '{Ps} > {Ptrans}', use: 'vapor-sonic', label: 'Sonic' },
        { when: '{Ps} <= {Ptrans}', use: 'vapor-subsonic', label: 'Subsonic' },
      ],
    },
  ],
  lookups: [
    {
      id: 'fact_di',
      name: 'Release Magnitude Reduction Factor',
      keys: ['detection', 'isolation'],
      result: 'fact_di',
      domains: { detection: ['A', 'B', 'C'], isolation: ['A', 'B', 'C'] },
      rows: [
        { detection: 'A', isolation: 'A', fact_di: 0.25 },
        { detection: 'A', isolation: 'B', fact_di: 0.2 },
        { detection: 'A', isolation: 'C', fact_di: 0.1 },
        { detection: 'B', isolation: 'B', fact_di: 0.15 },
        { detection: 'B', isolation: 'C', fact_di: 0.1 },
        { detection: 'C', isolation: 'C', fact_di: 0.0 },
      ],
    },
    {
      id: 'ld_max',
      name: 'Maximum Leak Duration',
      keys: ['detection', 'isolation', 'holeSize'],
      result: 'ld_max',
      rows: [
        { detection: 'A', isolation: 'A', holeSize: '1/4 in', ld_max: 20 },
        { detection: 'A', isolation: 'A', holeSize: '1 in', ld_max: 10 },
        { detection: 'A', isolation: 'A', holeSize: '4 in', ld_max: 5 },
        { detection: 'B', isolation: 'C', holeSize: '1/4 in', ld_max: 60 },
      ],
    },
  ],
  classifications: [
    {
      id: 'detection-rating',
      domain: ['A', 'B', 'C'],
      criteria: {
        A: 'Instrumentation designed specifically to detect material losses by changes in operating conditions.',
        B: 'Suitably located detectors to determine when the material is present outside the pressure-containing envelope.',
        C: 'Visual detection, cameras, or detectors with marginal coverage.',
      },
    },
  ],
};

const parsed = parseFormulaSpec(raw);
if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.errors.join('; ')}`);
const spec = parsed.spec;

describe('parseFormulaSpec', () => {
  it('accepts the reference spec', () => {
    expect(parsed.ok).toBe(true);
    expect(spec.expressions).toHaveLength(5);
    expect(spec.lookups).toHaveLength(2);
  });

  it('reports every problem at once rather than the first', () => {
    const result = parseFormulaSpec({
      variables: [
        { symbol: 'a', role: 'constant' },
        { symbol: 'a', role: 'derived' },
        { symbol: 'b', role: 'wat' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'spec.id is required',
        expect.stringContaining("a constant needs a value"),
        expect.stringContaining("duplicate symbol 'a'"),
        expect.stringContaining('a derived variable needs an expression'),
        expect.stringContaining('role must be one of'),
      ]),
    );
  });

  it('rejects a branch pointing at an id that does not exist', () => {
    const result = parseFormulaSpec({
      id: 's',
      variables: [],
      piecewise: [{ id: 'p', cases: [{ when: '1', use: 'nope' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("unknown id 'nope'");
  });

  it('rejects a lookup row missing a key or its result', () => {
    const result = parseFormulaSpec({
      id: 's',
      variables: [],
      lookups: [{ id: 'l', keys: ['x'], result: 'y', rows: [{ x: 1 }, { y: 2 }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("rows[0] is missing result 'y'"),
          expect.stringContaining("rows[1] is missing key 'x'"),
        ]),
      );
    }
  });
});

describe('checkLookupCoverage', () => {
  it('names the combinations the source table leaves unspecified', () => {
    const gaps = checkLookupCoverage(spec).filter((g) => g.lookupId === 'fact_di');
    expect(gaps.map((g) => `${g.key.detection}${g.key.isolation}`).sort()).toEqual([
      'BA',
      'CA',
      'CB',
    ]);
  });

  it('says nothing about a lookup that declares no domains', () => {
    expect(checkLookupCoverage(spec).some((g) => g.lookupId === 'ld_max')).toBe(false);
  });
});

describe('evaluateSpec — the release-rate model', () => {
  it('liquid release rate, with the hole area derived from diameter', () => {
    const r = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50, Pgauge: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeCloseTo(3.186, 3);
    // The derived area appears in the trace, so the number can be explained.
    expect(r.trace).toContainEqual(
      expect.objectContaining({ kind: 'symbol', symbol: 'An', from: 'derived' }),
    );
  });

  it('transition pressure', () => {
    const r = evaluateSpec(spec, 'transition-pressure', {});
    expect(r.ok && r.value).toBeCloseTo(28.71, 2);
  });

  it('branches to sonic above the transition pressure', () => {
    const r = evaluateSpec(spec, 'vapor-release-rate', { Ps: 100, MW: 30, Ts: 560 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeCloseTo(0.1578, 4);
    expect(r.trace).toContainEqual(
      expect.objectContaining({ kind: 'branch', chose: 'vapor-sonic', label: 'Sonic' }),
    );
  });

  it('branches to subsonic at or below the transition pressure', () => {
    const r = evaluateSpec(spec, 'vapor-release-rate', { Ps: 20, MW: 30, Ts: 560 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeCloseTo(0.0281, 4);
    expect(r.trace).toContainEqual(
      expect.objectContaining({ kind: 'branch', chose: 'vapor-subsonic', label: 'Subsonic' }),
    );
  });

  it('converts to barrels once the rate is supplied', () => {
    const liquid = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50, Pgauge: 100 });
    expect(liquid.ok).toBe(true);
    if (!liquid.ok) return;
    const r = evaluateSpec(spec, 'volume-bbl', { Wn: liquid.value, rho_l: 50 });
    expect(r.ok && r.value).toBeCloseTo(40.85, 2); // ReleaseTime defaults to 3600 s
  });
});

describe('evaluateSpec — lookups', () => {
  it('returns the factor for a specified combination', () => {
    const r = evaluateSpec(spec, 'fact_di', { detection: 'A', isolation: 'B' });
    expect(r.ok && r.value).toBe(0.2);
  });

  it('reports which row matched, so the number can be cited', () => {
    const r = evaluateSpec(spec, 'ld_max', {
      detection: 'A',
      isolation: 'A',
      holeSize: '4 in',
    });
    expect(r.ok && r.value).toBe(5);
    if (!r.ok) return;
    expect(r.trace).toContainEqual(
      expect.objectContaining({ kind: 'lookup', id: 'ld_max', value: 5 }),
    );
  });

  it('an unspecified combination is an error, never a silent zero', () => {
    const r = evaluateSpec(spec, 'fact_di', { detection: 'C', isolation: 'A' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('does not specify this combination');
  });
});

describe('evaluateSpec — failing loud', () => {
  it('a missing input is an error, not a zero', () => {
    const r = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing required input 'Pgauge'");
  });

  it('symbols are case-sensitive — k and K are different quantities', () => {
    const r = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50, pgauge: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing required input 'Pgauge'");
  });

  it('a typo in a symbol is an error, not a silent zero', () => {
    const bad = parseFormulaSpec({
      ...raw,
      expressions: [{ id: 'e', expression: '{Densty} * 2' }],
      piecewise: [],
    });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    const r = evaluateSpec(bad.spec, 'e', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown symbol 'Densty'");
  });

  it('an ambiguous chained symbol names the candidates', () => {
    // Both liquid-release-rate and the vapor piecewise declare Wn, so
    // volume-bbl cannot know which release it is converting.
    const r = evaluateSpec(spec, 'volume-bbl', { rho_l: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('produced by more than one target');
      expect(r.error).toContain('supply it as an input');
    }
  });

  it('catches a circular derivation instead of hanging', () => {
    const cyclic = parseFormulaSpec({
      id: 'c',
      variables: [
        { symbol: 'a', role: 'derived', expression: '{b} + 1' },
        { symbol: 'b', role: 'derived', expression: '{a} + 1' },
      ],
      expressions: [{ id: 'e', expression: '{a}' }],
    });
    expect(cyclic.ok).toBe(true);
    if (!cyclic.ok) return;
    const r = evaluateSpec(cyclic.spec, 'e', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('circular reference');
  });

  it('an out-of-domain result is an error rather than a blank', () => {
    const r = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50, Pgauge: -100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('out-of-domain');
  });
});
