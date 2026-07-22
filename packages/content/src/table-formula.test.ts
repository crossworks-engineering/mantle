import { describe, expect, it } from 'vitest';
import { evalFormula } from './table-formula';
import type { Row, TableDoc } from './table-model';

const doc: TableDoc = {
  columns: [
    { id: 'c_qty', name: 'Qty', type: 'number' },
    { id: 'c_price', name: 'Price', type: 'currency' },
    { id: 'c_paid', name: 'Paid', type: 'checkbox' },
    { id: 'c_name', name: 'Name', type: 'text' },
    { id: 'c_calc', name: 'Calc', type: 'formula', formula: '{Qty}+1' },
  ],
  rows: [],
  aggregates: {},
  views: [],
};

const row: Row = {
  id: 'r1',
  cells: { c_qty: 4, c_price: 2.5, c_paid: true, c_name: 'Bolt' },
};

const ev = (f: string) => evalFormula(f, doc, row);

describe('evalFormula — arithmetic', () => {
  it('multiplies and adds column refs', () => {
    expect(ev('{Qty} * {Price}')).toBe(10);
    expect(ev('{Qty} + 6')).toBe(10);
    expect(ev('({Qty} + 1) * 2')).toBe(10);
  });
  it('respects precedence and unary minus', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('-{Qty} + 10')).toBe(6);
  });
  it('division by zero collapses to null', () => {
    expect(ev('{Qty} / 0')).toBeNull();
  });
});

describe('evalFormula — functions', () => {
  it('ROUND, ABS, MIN, MAX, SUM', () => {
    expect(ev('ROUND({Price} * {Qty} * 0.333, 2)')).toBe(3.33);
    expect(ev('ABS(0 - {Qty})')).toBe(4);
    expect(ev('MIN({Qty}, 2, 9)')).toBe(2);
    expect(ev('MAX({Qty}, 2, 9)')).toBe(9);
    expect(ev('SUM({Qty}, {Price})')).toBe(6.5);
  });
  it('IF with comparisons', () => {
    expect(ev('IF({Qty} > 3, 100, 0)')).toBe(100);
    expect(ev('IF({Paid}, 0, {Price})')).toBe(0);
    expect(ev("IF({Name} == 'Bolt', 'yes', 'no')")).toBe('yes');
  });
  it('CONCAT and string +', () => {
    expect(ev("CONCAT({Name}, '-', {Qty})")).toBe('Bolt-4');
    expect(ev("{Name} + '!'")).toBe('Bolt!');
  });
});

describe('evalFormula — scientific', () => {
  it('SQRT, LN, LOG10, EXP, POW', () => {
    expect(ev('SQRT(16)')).toBe(4);
    expect(ev('LN(1)')).toBe(0);
    expect(ev('LOG10(1000)')).toBe(3);
    expect(ev('ROUND(EXP(1), 4)')).toBe(2.7183);
    expect(ev('POW(2, 10)')).toBe(1024);
  });
  it('out-of-domain inputs render blank rather than a bogus number', () => {
    expect(ev('SQRT(0 - 1)')).toBeNull(); // NaN
    expect(ev('LN(0)')).toBeNull(); // -Infinity
  });
  it('PI and E are constants, not column refs', () => {
    expect(ev('ROUND(PI, 5)')).toBe(3.14159);
    expect(ev('ROUND(PI / 4 * 0.375 ^ 2, 4)')).toBe(0.1104); // area of a 3/8" hole
  });
  it('^ binds tighter than * but looser than unary minus', () => {
    expect(ev('2 * 3 ^ 2')).toBe(18); // not 36
    expect(ev('0 - 2 ^ 2')).toBe(-4);
    expect(ev('-2 ^ 2')).toBe(-4); // -(2^2), per maths convention. Excel says +4.
  });
  it('accepts scientific notation and leading-dot decimals', () => {
    expect(ev('1e5')).toBe(100000);
    expect(ev('1.5E-6')).toBe(0.0000015);
    expect(ev('6.02e+23')).toBe(6.02e23);
    expect(ev('.5 * 4')).toBe(2);
    // A bare E after a number is still the constant, and so fails loudly
    // rather than being silently swallowed as a malformed exponent.
    expect(ev('2E')).toBeNull();
  });
  it('compares numbers the same way it adds them', () => {
    // Regression: `compare` once used bare Number() while toNum stripped
    // separators, so '1,000' was 1000 to arithmetic and NaN to a comparison —
    // and a NaN comparison fell through to STRING ordering.
    expect(ev("'1,000' > 28.7")).toBe(true);
    expect(ev("'1,000' * 1")).toBe(1000); // `+` would concatenate, by design
  });
  it('^ is right-associative and accepts a negative exponent', () => {
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // 2^(3^2), not (2^3)^2 = 64
    expect(ev('2 ^ -1')).toBe(0.5);
  });
});

// Acceptance: the release-rate equations from a published engineering standard
// (API RP 581 Part 3 §5.3.2/§5.3.3), which is why the scientific set exists.
// None of these were expressible before. Expected values verified independently.
describe('evalFormula — engineering formulas', () => {
  const vessel: TableDoc = {
    columns: [
      { id: 'c_rho', name: 'Density', type: 'number' },
      { id: 'c_pg', name: 'Pgauge', type: 'number' },
      { id: 'c_ps', name: 'Ps', type: 'number' },
      { id: 'c_mw', name: 'MW', type: 'number' },
      { id: 'c_ts', name: 'Ts', type: 'number' },
      { id: 'c_k', name: 'k', type: 'number' },
    ],
    rows: [],
    aggregates: {},
    views: [],
  };
  const r: Row = {
    id: 'v1',
    cells: { c_rho: 50, c_pg: 100, c_ps: 100, c_mw: 30, c_ts: 560, c_k: 1.5 },
  };
  const evv = (f: string) => evalFormula(f, vessel, r);

  it('liquid release rate (Eq 3.3) → lb/sec', () => {
    const liquid =
      '0.61 * 1 * {Density} * (0.11 / 12) * SQRT(2 * 32.2 * {Pgauge} / {Density})';
    expect(evv(`ROUND(${liquid}, 3)`)).toBe(3.173);
  });

  it('vapor release rate, sonic (Eq 3.6) → lb/sec', () => {
    const sonic =
      '(0.61 / 1) * 0.11 * {Ps} * SQRT( ({k} * {MW} * 32.2) / (1545 * {Ts})' +
      ' * (2 / ({k} + 1)) ^ (({k} + 1) / ({k} - 1)) )';
    expect(evv(`ROUND(${sonic}, 4)`)).toBe(0.1572);
  });

  it('transition pressure (Eq 3.7) selects sonic vs subsonic', () => {
    const ptrans = '14.7 * (({k} + 1) / 2) ^ ({k} / ({k} - 1))';
    expect(evv(`ROUND(${ptrans}, 2)`)).toBe(28.71);
    // Ps = 100 psia is above the transition pressure, so the release is sonic.
    expect(evv(`IF({Ps} > ${ptrans}, 'sonic', 'subsonic')`)).toBe('sonic');
  });
});

describe('evalFormula — safety', () => {
  it('returns null for broken / hostile input rather than throwing', () => {
    expect(ev('{Qty} *')).toBeNull();
    expect(ev('process.exit(1)')).toBeNull();
    expect(ev('{Unknown} + 1')).toBe(1); // unknown ref → 0
  });
  it('refuses to recurse into another formula column', () => {
    expect(ev('{Calc} + 1')).toBe(1); // {Calc} resolves to null/0 (no formula chaining)
  });
  it('blank formula → null', () => {
    expect(ev('')).toBeNull();
  });
});
