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
