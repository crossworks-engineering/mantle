import { describe, expect, it } from 'vitest';
import { parseFormulaSpec } from './formula-spec';
import { checkDimensions, normaliseUnit } from './formula-dimensions';

const LIQUID = '{Cd} * {Kvn} * {rho_l} * ({An} / {C1}) * SQRT(2 * {gc} * {Pgauge} / {rho_l})';

function spec(gcUnit: string, resultUnit = 'lb/sec') {
  const r = parseFormulaSpec({
    id: 'api581',
    unitSystem: 'USC',
    variables: [
      { symbol: 'Cd', role: 'constant', value: 0.61 },
      { symbol: 'Kvn', role: 'constant', value: 1 },
      { symbol: 'C1', role: 'constant', value: 12, unit: 'in/ft' },
      { symbol: 'gc', role: 'constant', value: 32.2, unit: gcUnit },
      { symbol: 'An', role: 'input', value: 0.11, unit: 'in2' },
      { symbol: 'rho_l', role: 'input', unit: 'lb/ft3' },
      { symbol: 'Pgauge', role: 'input', unit: 'lbf/in2 (g)' },
    ],
    expressions: [{ id: 'liquid', expression: LIQUID, unit: resultUnit }],
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec;
}

describe('normaliseUnit — the conventions printed tables actually use', () => {
  it('reads hyphen as multiply and implicit exponents', () => {
    expect(normaliseUnit('lbm-ft/(lbf-s2)')).toBe('lbm ft/(lbf s^2)');
    expect(normaliseUnit('lb/ft3')).toBe('lb/ft^3');
    expect(normaliseUnit('in2')).toBe('in^2');
  });
  it('drops a pressure-basis qualifier, which is not a dimension', () => {
    expect(normaliseUnit('lbf/in2 (abs)')).toBe('lbf/in^2');
    expect(normaliseUnit('lbf/in2 (g)')).toBe('lbf/in^2');
  });
  it('maps Rankine, which would otherwise parse as roentgen', () => {
    expect(normaliseUnit('R')).toBe('degR');
  });
  it('treats unitless markers as no unit', () => {
    expect(normaliseUnit('')).toBeNull();
    expect(normaliseUnit('unitless')).toBeNull();
  });
});

describe('checkDimensions', () => {
  it('accepts the release-rate equation with g_c labelled correctly', () => {
    expect(checkDimensions(spec('lbm-ft/(lbf-s2)'))).toEqual([]);
  });

  it('REJECTS g_c mislabelled as an acceleration — the audit finding', () => {
    // Numerically identical in USC, so every value stayed right and every test
    // passed. Only the dimensions expose it.
    const issues = checkDimensions(spec('ft/s2'));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('mismatch');
    expect(issues[0]?.id).toBe('liquid');
    expect(issues[0]?.detail).toMatch(/a term is missing, or a variable's unit is wrong/);
  });

  it('catches a wrongly declared result unit', () => {
    const issues = checkDimensions(spec('lbm-ft/(lbf-s2)', 'ft'));
    expect(issues[0]?.kind).toBe('mismatch');
    expect(issues[0]?.declared).toBe('ft');
  });

  it('catches a dropped term — the error no proofreading reliably finds', () => {
    const r = parseFormulaSpec({
      id: 'd',
      variables: [
        { symbol: 'rho', role: 'input', unit: 'lb/ft3' },
        { symbol: 'A', role: 'input', unit: 'in2' },
        { symbol: 'v', role: 'input', unit: 'ft/s' },
      ],
      // Mass flow is rho * A * v. Dropping `{v}` still computes a number.
      expressions: [{ id: 'w', expression: '{rho} * {A}', unit: 'lb/sec' }],
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(checkDimensions(r.spec)[0]?.kind).toBe('mismatch');
  });

  it('reports an unreadable unit once, rather than as a cascade', () => {
    const r = parseFormulaSpec({
      id: 'u',
      variables: [{ symbol: 'x', role: 'input', unit: 'widgets per fortnight' }],
      expressions: [{ id: 'e', expression: '{x} * 2', unit: 'lb/sec' }],
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const issues = checkDimensions(r.spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('unparseable-unit');
    expect(issues[0]?.id).toBe('x');
  });

  it('says nothing about a spec that declares no units', () => {
    const r = parseFormulaSpec({
      id: 'n',
      variables: [{ symbol: 'a', role: 'input' }],
      expressions: [{ id: 'e', expression: '{a} * 2' }],
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(checkDimensions(r.spec)).toEqual([]);
  });
});
