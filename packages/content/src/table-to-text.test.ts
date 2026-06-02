import { describe, expect, it } from 'vitest';
import { setAggregate, type TableDoc } from './table-model';
import { formatCellText, tableToText } from './table-to-text';

function grid(): TableDoc {
  return {
    columns: [
      { id: 'c_item', name: 'Item', type: 'text' },
      { id: 'c_qty', name: 'Qty', type: 'number' },
      { id: 'c_price', name: 'Price', type: 'currency', format: { currency: 'USD', decimals: 2 } },
      { id: 'c_total', name: 'Total', type: 'formula', formula: '{Qty} * {Price}' },
    ],
    rows: [
      { id: 'r1', cells: { c_item: 'Widget', c_qty: 2, c_price: 9.5 } },
      { id: 'r2', cells: { c_item: 'Gadget | special', c_qty: 3, c_price: 4 } },
    ],
    aggregates: {},
    views: [],
  };
}

describe('formatCellText', () => {
  it('formats currency and percent and checkbox', () => {
    expect(formatCellText(9.5, { id: 'c', name: 'P', type: 'currency', format: { currency: 'ZAR', decimals: 2 } })).toBe('ZAR 9.50');
    expect(formatCellText(15, { id: 'c', name: 'P', type: 'percent', format: { decimals: 1 } })).toBe('15.0%');
    expect(formatCellText(true, { id: 'c', name: 'P', type: 'checkbox' })).toBe('✓');
    expect(formatCellText(false, { id: 'c', name: 'P', type: 'checkbox' })).toBe('');
  });
});

describe('tableToText', () => {
  it('renders a GFM pipe table with a title and resolved formulas', () => {
    const text = tableToText(grid(), { title: 'Order' });
    expect(text).toContain('# Order');
    expect(text).toContain('| Item | Qty | Price | Total |');
    expect(text).toContain('| --- | --- | --- | --- |');
    // formula column resolved
    expect(text).toContain('USD 9.50');
    expect(text).toMatch(/\| Widget \| 2 \| USD 9.50 \| 19 \|/);
  });

  it('escapes pipes inside cells', () => {
    const text = tableToText(grid());
    expect(text).toContain('Gadget \\| special');
  });

  it('appends a Totals row only when an aggregate is set', () => {
    expect(tableToText(grid())).not.toContain('Totals');
    const withTotal = setAggregate(grid(), 'c_qty', 'sum');
    const text = tableToText(withTotal);
    expect(text).toContain('Totals');
    expect(text).toContain('sum: 5');
  });
});
