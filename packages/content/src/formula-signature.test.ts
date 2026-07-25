import { describe, expect, it } from 'vitest';
import { parseFormulaSpec, type FormulaSpec } from './formula-spec';
import { evaluateSpec } from './formula-eval';
import { signatureForTarget, signatureLine, signatureOf } from './formula-signature';

/**
 * Same model the spec tests are held to — the release-quantity calculation from
 * API RP 581 Part 3 — because the signature's whole job is to predict what
 * `evaluateSpec` will demand of it, and that is the spec with every construct
 * in play at once.
 */
const raw = {
  id: 'api581-release-quantity',
  name: 'Release Quantity',
  source: { standard: 'API RP 581', part: '3', sections: ['5.3.2'] },
  unitSystem: 'USC',
  variables: [
    { symbol: 'Cd', role: 'constant', value: 0.61, unit: null },
    { symbol: 'C1', role: 'constant', value: 12, unit: 'in/ft' },
    { symbol: 'C2', role: 'constant', value: 1, unit: null },
    { symbol: 'gc', role: 'constant', value: 32.2, unit: 'lbm-ft/(lbf-s2)' },
    { symbol: 'R', role: 'constant', value: 1545, unit: 'ft-lbf/(lb-mol·°R)' },
    { symbol: 'k', role: 'constant', value: 1.5, unit: null },
    { symbol: 'Patm', role: 'constant', value: 14.7, unit: 'lbf/in2 (abs)' },
    { symbol: 'd', role: 'input', value: 0.375, unit: 'in' },
    { symbol: 'An', role: 'derived', expression: 'PI / 4 * {d} ^ 2', unit: 'in2' },
    { symbol: 'rho_l', role: 'input', unit: 'lb/ft3' },
    { symbol: 'Pgauge', role: 'input', unit: 'lbf/in2 (g)' },
    { symbol: 'Ps', role: 'input', unit: 'lbf/in2 (abs)' },
    { symbol: 'MW', role: 'input', unit: 'lb/lb-mol' },
    { symbol: 'Ts', role: 'input', unit: 'R' },
    { symbol: 'Wn', role: 'output', unit: 'lb/sec' },
  ],
  expressions: [
    {
      id: 'liquid-release-rate',
      equation: '3.3',
      resultSymbol: 'Wn',
      unit: 'lb/sec',
      expression: '{Cd} * {rho_l} * ({An} / {C1}) * SQRT(2 * {gc} * {Pgauge} / {rho_l})',
    },
    {
      id: 'transition-pressure',
      equation: '3.7',
      unverified: 'Supplied from memory; the source never defines it.',
      resultSymbol: 'Ptrans',
      expression: '{Patm} * (({k} + 1) / 2) ^ ({k} / ({k} - 1))',
    },
    {
      id: 'vapor-sonic',
      equation: '3.6',
      expression: '({Cd} / {C2}) * {An} * {Ps} * SQRT( ({k} * {MW} * {gc}) / ({R} * {Ts}) )',
    },
    {
      id: 'vapor-subsonic',
      equation: '3.5',
      expression: '({Cd} / {C2}) * {An} * {Ps} * SQRT( ({MW} * {gc}) / ({R} * {Ts}) )',
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
        { detection: 'B', isolation: 'C', fact_di: 0.1 },
        { detection: 'C', isolation: 'C', fact_di: 0.0 },
      ],
    },
    {
      id: 'ld_max',
      name: 'Maximum Leak Duration',
      keys: ['detection', 'holeSize'],
      result: 'ld_max',
      rows: [
        { detection: 'A', holeSize: '1/4 in', ld_max: 20 },
        { detection: 'A', holeSize: '1 in', ld_max: 10 },
        { detection: 'B', holeSize: '1/4 in', ld_max: 60 },
      ],
    },
  ],
  classifications: [
    {
      id: 'detection-rating',
      domain: ['A', 'B', 'C'],
      criteria: {
        A: 'Instrumentation designed specifically to detect material losses.',
        B: 'Suitably located detectors outside the pressure-containing envelope.',
        C: 'Visual detection, cameras, or detectors with marginal coverage.',
      },
    },
  ],
};

function parse(input: unknown): FormulaSpec {
  const result = parseFormulaSpec(input);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.errors.join('; ')}`);
  return result.spec;
}

const spec = parse(raw);
const sigOf = (id: string) => {
  const found = signatureForTarget(spec, id);
  if (!found) throw new Error(`no signature for '${id}'`);
  return found;
};
const symbols = (id: string) => sigOf(id).inputs.map((i) => i.symbol);
const required = (id: string) =>
  sigOf(id)
    .inputs.filter((i) => i.required)
    .map((i) => i.symbol);

describe('signatureOf', () => {
  it('covers every evaluable target, expressions then piecewise then lookups', () => {
    expect(signatureOf(spec).map((s) => s.id)).toEqual([
      'liquid-release-rate',
      'transition-pressure',
      'vapor-sonic',
      'vapor-subsonic',
      'vapor-release-rate',
      'fact_di',
      'ld_max',
    ]);
  });

  it('reports what a target produces, with the unit of the answer', () => {
    expect(sigOf('liquid-release-rate')).toMatchObject({
      kind: 'expression',
      produces: 'Wn',
      unit: 'lb/sec',
      equation: '3.3',
    });
  });

  it('takes a piecewise unit from the symbol it produces, having none itself', () => {
    expect(sigOf('vapor-release-rate')).toMatchObject({ kind: 'piecewise', unit: 'lb/sec' });
  });

  it('omits constants and derived variables — the caller supplies neither', () => {
    const got = symbols('liquid-release-rate');
    for (const fixed of ['Cd', 'C1', 'gc', 'An']) expect(got).not.toContain(fixed);
  });

  it('walks THROUGH a derived variable to the inputs it needs', () => {
    // An is derived from d, and d carries a default — so it is offered, not demanded.
    const d = sigOf('liquid-release-rate').inputs.find((i) => i.symbol === 'd');
    expect(d).toMatchObject({ required: false, default: 0.375, unit: 'in' });
  });

  it('demands an input with no declared default', () => {
    expect(required('liquid-release-rate')).toEqual(['rho_l', 'Pgauge']);
  });

  it('lists inputs in reading order', () => {
    expect(symbols('liquid-release-rate')).toEqual(['rho_l', 'd', 'Pgauge']);
  });
});

describe('signatureOf — the ladder matches the evaluator', () => {
  it('agrees with evaluateSpec about what is missing', () => {
    // Supply every required input and nothing else: evaluation must succeed.
    const inputs: Record<string, number> = { rho_l: 50, Pgauge: 100 };
    expect(required('liquid-release-rate')).toEqual(Object.keys(inputs));
    const ok = evaluateSpec(spec, 'liquid-release-rate', inputs);
    expect(ok.ok).toBe(true);

    // Drop one and the evaluator names exactly the symbol the signature did.
    const short = evaluateSpec(spec, 'liquid-release-rate', { rho_l: 50 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toContain("missing required input 'Pgauge'");
  });

  it('resolves a symbol through the unique target that produces it', () => {
    // Ptrans is produced by transition-pressure, so it is not asked for; the
    // constants that expression needs are not asked for either.
    const got = symbols('vapor-release-rate');
    expect(got).not.toContain('Ptrans');
    expect(got).not.toContain('Patm');
  });

  it('demands a symbol two targets both produce, as the evaluator does', () => {
    // Wn is produced by BOTH liquid-release-rate and vapor-release-rate.
    const volume = parse({
      ...raw,
      expressions: [...raw.expressions, { id: 'volume', expression: '{Wn} * 2' }],
    });
    const sig = signatureForTarget(volume, 'volume')!;
    const wn = sig.inputs.find((i) => i.symbol === 'Wn');
    expect(wn).toMatchObject({ required: true });
    expect(wn?.note).toContain('produced by more than one target');
    expect(evaluateSpec(volume, 'volume', {}).ok).toBe(false);
  });

  it('flags a symbol the spec never declares', () => {
    // `detection` and `isolation` are lookup keys with no variable behind them.
    const detection = sigOf('fact_di').inputs.find((i) => i.symbol === 'detection');
    expect(detection).toMatchObject({ required: true, undeclared: true });
  });

  it('treats an output symbol nothing produces as a required input', () => {
    const orphan = parse({
      ...raw,
      piecewise: [],
      expressions: [{ id: 'only', expression: '{Wn} + 1' }],
    });
    expect(signatureForTarget(orphan, 'only')!.inputs).toEqual([
      { symbol: 'Wn', unit: 'lb/sec', kind: 'number', required: true },
    ]);
  });
});

describe('signatureOf — branches', () => {
  it('unions both branches rather than reporting the one a value would take', () => {
    // Ps gates the branch; MW and Ts are needed whichever way it goes.
    expect(required('vapor-release-rate').sort()).toEqual(['MW', 'Ps', 'Ts']);
  });

  it('breaks the need down per case', () => {
    const branches = sigOf('vapor-release-rate').branches!;
    expect(branches.map((b) => b.label)).toEqual(['Sonic', 'Subsonic']);
    expect(branches[0]).toMatchObject({ when: '{Ps} > {Ptrans}', use: 'vapor-sonic' });
    expect(branches[0]!.inputs).toContain('MW');
  });

  it('rolls unverified up to every target that depends on it', () => {
    // The piecewise carries no `unverified` of its own; its branch condition
    // depends on one, and that is what decides whether a number may be relied on.
    expect(sigOf('vapor-release-rate').unverified).toEqual([
      { id: 'transition-pressure', reason: 'Supplied from memory; the source never defines it.' },
    ]);
    expect(sigOf('liquid-release-rate').unverified).toEqual([]);
  });
});

describe('signatureOf — enums', () => {
  it('makes a lookup key an enum over its declared domain', () => {
    expect(sigOf('fact_di').inputs.find((i) => i.symbol === 'isolation')).toMatchObject({
      kind: 'enum',
      domain: ['A', 'B', 'C'],
    });
  });

  it('falls back to the values the rows actually carry', () => {
    // ld_max declares no domains, so the legal keys are what can match a row.
    expect(sigOf('ld_max').inputs.find((i) => i.symbol === 'holeSize')).toMatchObject({
      kind: 'enum',
      domain: ['1/4 in', '1 in'],
    });
  });

  it('attaches the criteria prose of the classification named after the symbol', () => {
    const detection = sigOf('fact_di').inputs.find((i) => i.symbol === 'detection');
    expect(detection?.criteria?.A).toContain('Instrumentation designed');
  });

  it('does NOT attach a rubric to a symbol that merely shares its domain', () => {
    // `isolation` is A|B|C too, but `detection-rating` describes detection.
    expect(sigOf('fact_di').inputs.find((i) => i.symbol === 'isolation')?.criteria).toBeUndefined();
  });

  it('offers a classification domain even where no lookup declares one', () => {
    const rated = parse({
      ...raw,
      piecewise: [],
      lookups: [],
      expressions: [{ id: 'only', expression: '{detection} == "A"' }],
    });
    expect(signatureForTarget(rated, 'only')!.inputs[0]).toMatchObject({
      symbol: 'detection',
      kind: 'enum',
      domain: ['A', 'B', 'C'],
    });
  });
});

describe('signatureOf — robustness', () => {
  it('terminates on a circular derived chain instead of recursing forever', () => {
    // parseFormulaSpec permits this; the evaluator catches it at run time.
    const cyclic = parse({
      id: 'cyclic',
      variables: [
        { symbol: 'a', role: 'derived', expression: '{b} + 1' },
        { symbol: 'b', role: 'derived', expression: '{a} + 1' },
      ],
      expressions: [{ id: 'go', expression: '{a}' }],
    });
    expect(signatureForTarget(cyclic, 'go')!.inputs).toEqual([]);
    expect(evaluateSpec(cyclic, 'go', {}).ok).toBe(false);
  });

  it('terminates on a piecewise that names itself', () => {
    const looped = parse({
      id: 'looped',
      variables: [],
      expressions: [{ id: 'e', expression: '1' }],
      piecewise: [{ id: 'p', cases: [{ when: '{x} > 1', use: 'p' }], otherwise: 'e' }],
    });
    expect(signatureForTarget(looped, 'p')!.inputs.map((i) => i.symbol)).toEqual(['x']);
  });

  it('returns nothing for a target that does not exist', () => {
    expect(signatureForTarget(spec, 'no-such-target')).toBeUndefined();
  });

  it('survives a spec whose arrays are missing entirely', () => {
    expect(signatureOf({ id: 'bare' } as unknown as FormulaSpec)).toEqual([]);
  });
});

describe('signatureLine', () => {
  it('renders a call line with units, marking optionals', () => {
    expect(signatureLine(sigOf('liquid-release-rate'))).toBe(
      'liquid-release-rate(rho_l [lb/ft3], d? [in], Pgauge [lbf/in2 (g)]) → Wn [lb/sec]',
    );
  });

  it('omits the arrow when a target declares no result symbol', () => {
    expect(signatureLine(sigOf('vapor-sonic'))).toBe(
      'vapor-sonic(d? [in], Ps [lbf/in2 (abs)], MW [lb/lb-mol], Ts [R])',
    );
  });
});
