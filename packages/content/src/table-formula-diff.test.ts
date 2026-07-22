import { describe, expect, it } from 'vitest';
import { evalFormula } from './table-formula';
import { evalFormulaMath } from './table-formula-mathjs';
import type { Row, TableDoc } from './table-model';

/**
 * Differential harness: every expression runs through BOTH engines.
 *
 * Migrating an evaluator is only safe if you can enumerate what changes. This
 * suite is the change log — `AGREE` cases pin behaviour that must survive the
 * migration, `DIVERGES` cases are the deliberate breaks, each with the reason
 * it is acceptable. A divergence appearing in the AGREE list is a regression;
 * a DIVERGES case that starts agreeing means the shim grew something we
 * decided not to want.
 */
const doc: TableDoc = {
  columns: [
    { id: 'c_qty', name: 'Qty', type: 'number' },
    { id: 'c_price', name: 'Price', type: 'currency' },
    { id: 'c_paid', name: 'Paid', type: 'checkbox' },
    { id: 'c_name', name: 'Name', type: 'text' },
    { id: 'c_blank', name: 'Blank', type: 'number' },
    { id: 'c_calc', name: 'Calc', type: 'formula', formula: '{Qty}+1' },
  ],
  rows: [],
  aggregates: {},
  views: [],
};
const row: Row = {
  id: 'r1',
  cells: { c_qty: 4, c_price: 2.5, c_paid: true, c_name: 'Bolt', c_blank: null },
};

const old = (f: string) => evalFormula(f, doc, row);
const next = (f: string) => evalFormulaMath(f, doc, row);

/** Expressions both engines must answer identically. */
const AGREE: string[] = [
  // arithmetic + precedence
  '{Qty} * {Price}',
  '{Qty} + 6',
  '({Qty} + 1) * 2',
  '2 + 3 * 4',
  '-{Qty} + 10',
  '10 % 3',
  '2 * 3 ^ 2',
  '2 ^ 3 ^ 2',
  '2 ^ -1',
  '-2 ^ 2',
  // scientific / decimal literals
  '1e5',
  '1.5E-6',
  '.5 * 4',
  // the scientific function set
  'SQRT(16)',
  'LN(1)',
  'LOG10(1000)',
  'POW(2, 10)',
  'ROUND(EXP(1), 4)',
  'ROUND(PI, 5)',
  'ROUND(PI / 4 * 0.375 ^ 2, 4)',
  'ABS(0 - {Qty})',
  'MIN({Qty}, 2, 9)',
  'MAX({Qty}, 2, 9)',
  'SUM({Qty}, {Price})',
  'FLOOR(2.7)',
  'CEIL(2.1)',
  'ROUND({Price} * {Qty} * 0.333, 2)',
  // conditionals and comparisons
  'IF({Qty} > 3, 100, 0)',
  'IF({Paid}, 0, {Price})',
  "IF({Name} == 'Bolt', 'yes', 'no')",
  "IF({Name} != 'Nut', 'yes', 'no')",
  '{Qty} >= 4',
  '{Qty} < 4',
  // blank / unknown / formula refs all read as 0
  '{Blank} + 1',
  '{Unknown} + 1',
  '{Calc} + 1',
  // string joining
  "CONCAT({Name}, '-', {Qty})",
  // engineering acceptance: the release-rate equations
  '0.61 * 1 * 50 * (0.11 / 12) * SQRT(2 * 32.2 * 100 / 50)',
  '14.7 * ((1.5 + 1) / 2) ^ (1.5 / (1.5 - 1))',
  // failure modes
  '{Qty} / 0',
  '{Qty} *',
  'process.exit(1)',
  '',
  'SQRT(0 - 1)',
  'LN(0)',
];

/** Deliberate breaks, each with the reason it is acceptable. */
const DIVERGES: Array<{ expr: string; why: string }> = [
  {
    expr: "{Name} + '!'",
    why: '`+` no longer concatenates. Keeping it would mean loosening `add`, which is the override that silently broke unit arithmetic. Use CONCAT.',
  },
  {
    expr: "'a' + 4",
    why: 'Same: string + number is an error rather than a join.',
  },
];

describe('table formula engines — differential', () => {
  it.each(AGREE)('agrees on %s', (expr) => {
    expect(next(expr), `mathjs diverged on: ${expr}`).toStrictEqual(old(expr));
  });

  it.each(DIVERGES)('diverges deliberately on $expr — $why', ({ expr }) => {
    expect(next(expr)).not.toStrictEqual(old(expr));
  });

  it('has no undeclared divergences', () => {
    const surprises = AGREE.filter((e) => {
      const a = old(e);
      const b = next(e);
      return !Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b);
    });
    expect(surprises).toEqual([]);
  });
});

/**
 * The migration's whole purpose. These must keep passing after ANY future
 * signature override — the first attempt at the compat layer extended `add`
 * for strings and silently killed `1 ft + 2 ft`, disabling dimensional
 * checking while every other test stayed green.
 */
describe('unit integrity — the reason for the migration', () => {
  const unitDoc: TableDoc = { columns: [], rows: [], aggregates: {}, views: [] };
  const unitRow: Row = { id: 'u', cells: {} };
  const raw = (expr: string): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { create, all } = require('mathjs');
    return create(all).evaluate(expr);
  };

  it('still adds like quantities', () => {
    expect(String(raw('1 ft + 2 ft'))).toBe('3 ft');
  });

  it('recognises g_c as dimensionless', () => {
    // 32.2 lbm·ft/(lbf·s²) is a unit conversion constant ≈ 1, NOT 32.2 ft/s².
    expect(Number(raw('32.2 lbm ft/(lbf s^2)'))).toBeCloseTo(1.0008, 4);
  });

  it('computes the liquid release rate WITH units and gets our number', () => {
    const v = raw(
      '0.61 * 50 lbm/ft^3 * (0.11 in^2 / (12 in/ft)) * ' +
        'sqrt(2 * 32.2 lbm ft/(lbf s^2) * 100 lbf/in^2 / (50 lbm/ft^3))',
    ) as { toNumber: (u: string) => number };
    expect(v.toNumber('lbm/s')).toBeCloseTo(3.173, 3);
  });

  it('REJECTS the mislabelled g_c — the audit finding, caught mechanically', () => {
    expect(() =>
      (
        raw(
          '0.61 * 50 lbm/ft^3 * (0.11 in^2 / (12 in/ft)) * ' +
            'sqrt(2 * 32.2 ft/s^2 * 100 lbf/in^2 / (50 lbm/ft^3))',
        ) as { toNumber: (u: string) => number }
      ).toNumber('lbm/s'),
    ).toThrow(/Units do not match/);
  });

  it('rejects adding mismatched dimensions', () => {
    expect(() => raw('1 ft + 1 kg')).toThrow(/Units do not match/);
  });
});
