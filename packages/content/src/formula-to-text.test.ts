import { describe, expect, it } from 'vitest';
import { parseFormulaSpec } from './formula-spec';
import { formulaToText } from './formula-to-text';

const parsed = parseFormulaSpec({
  id: 'api581-release-quantity',
  name: 'Release Quantity',
  source: { standard: 'API RP 581', part: '3', sections: ['5.3.2'], tables: ['5.6'] },
  unitSystem: 'USC',
  variables: [
    { symbol: 'Cd', name: 'Discharge Coefficient', role: 'constant', value: 0.61 },
    { symbol: 'rho_l', name: 'Liquid Density', role: 'input', unit: 'lb/ft3' },
    { symbol: 'An', name: 'Release Hole Area', role: 'derived', expression: 'PI / 4 * {d} ^ 2' },
  ],
  expressions: [
    {
      id: 'liquid-release-rate',
      equation: '3.3',
      resultSymbol: 'Wn',
      unit: 'lb/sec',
      expression: '{Cd} * {rho_l}',
    },
  ],
  piecewise: [
    {
      id: 'vapor-release-rate',
      cases: [{ when: '{Ps} > {Ptrans}', use: 'liquid-release-rate', label: 'Sonic' }],
    },
  ],
  lookups: [
    {
      id: 'fact_di',
      name: 'Release Magnitude Reduction Factor',
      keys: ['detection', 'isolation'],
      result: 'fact_di',
      rows: [{ detection: 'A', isolation: 'A', fact_di: 0.25 }],
    },
  ],
  classifications: [
    {
      id: 'detection-rating',
      domain: ['A'],
      criteria: {
        A: 'Instrumentation designed specifically to detect material losses by changes in operating conditions.',
      },
    },
  ],
  notes: { pressureBasis: 'The vapour equations require absolute pressure.' },
});
if (!parsed.ok) throw new Error(parsed.errors.join('; '));
const text = formulaToText(parsed.spec);

describe('formulaToText', () => {
  it('leads with the name and a citable source', () => {
    expect(text).toContain('# Release Quantity');
    expect(text).toContain('Source: API RP 581 Part 3, §5.3.2, Tables 5.6');
  });

  it('includes the equations with their numbers and units', () => {
    expect(text).toContain('liquid-release-rate (Eq 3.3) → Wn [lb/sec]');
    expect(text).toContain('{Cd} * {rho_l}');
  });

  it('renders the variable table, showing a derived expression in place of a value', () => {
    expect(text).toContain('| Cd | Discharge Coefficient | 0.61 |');
    expect(text).toContain('| An | Release Hole Area | PI / 4 * {d} ^ 2 |');
  });

  it('renders lookups as tables so the rows are searchable individually', () => {
    expect(text).toContain('| detection | isolation | fact_di |');
    expect(text).toContain('| A | A | 0.25 |');
  });

  it('includes the branch conditions', () => {
    expect(text).toContain('Sonic — when {Ps} > {Ptrans} use liquid-release-rate');
  });

  it('includes the classification criteria prose — the most searchable content', () => {
    expect(text).toContain('A: Instrumentation designed specifically to detect material losses');
  });

  it('includes transcription notes', () => {
    expect(text).toContain('The vapour equations require absolute pressure.');
  });

  it('escapes pipes so a stray value cannot break the table markup', () => {
    const odd = parseFormulaSpec({
      id: 'x',
      variables: [{ symbol: 'a', name: 'has | pipe', role: 'constant', value: 1 }],
    });
    expect(odd.ok).toBe(true);
    if (odd.ok) expect(formulaToText(odd.spec)).toContain('has \\| pipe');
  });
});
