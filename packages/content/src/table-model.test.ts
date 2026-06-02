import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addRow,
  applyView,
  tableDocFromGrid,
  cellIsEmpty,
  coerceCell,
  computeAggregate,
  deleteColumn,
  deleteRow,
  emptyTableDoc,
  ensureTableDoc,
  findColumnByName,
  resolveCell,
  setAggregate,
  setCell,
  setView,
  updateColumn,
  updateRow,
  type TableDoc,
} from './table-model';

function grid(): TableDoc {
  return {
    columns: [
      { id: 'c_item', name: 'Item', type: 'text' },
      { id: 'c_qty', name: 'Qty', type: 'number' },
      { id: 'c_price', name: 'Price', type: 'currency', format: { currency: 'USD', decimals: 2 } },
    ],
    rows: [
      { id: 'r1', cells: { c_item: 'Widget', c_qty: 2, c_price: 9.5 } },
      { id: 'r2', cells: { c_item: 'Gadget', c_qty: 3, c_price: 4 } },
    ],
    aggregates: {},
    views: [],
  };
}

describe('ensureTableDoc', () => {
  it('fills missing arrays and assigns ids', () => {
    const doc = ensureTableDoc({ columns: [{ name: 'A', type: 'text' }] });
    expect(doc.columns[0]!.id).toBeTruthy();
    expect(doc.rows).toEqual([]);
    expect(doc.aggregates).toEqual({});
  });

  it('returns the SAME reference when nothing changes', () => {
    const doc = grid();
    expect(ensureTableDoc(doc)).toBe(doc);
  });

  it('drops cells for unknown columns', () => {
    const doc = ensureTableDoc({
      columns: [{ id: 'c1', name: 'A', type: 'text' }],
      rows: [{ id: 'r1', cells: { c1: 'x', ghost: 'y' } }],
    });
    expect(doc.rows[0]!.cells).toEqual({ c1: 'x' });
  });

  it('coerces an unknown column type to text', () => {
    const doc = ensureTableDoc({ columns: [{ id: 'c1', name: 'A', type: 'wat' }], rows: [] });
    expect(doc.columns[0]!.type).toBe('text');
  });
});

describe('coerceCell', () => {
  it('parses numbers, stripping thousands separators', () => {
    expect(coerceCell('1,234.5', 'number')).toBe(1234.5);
    expect(coerceCell('', 'number')).toBeNull();
    expect(coerceCell('nope', 'number')).toBeNull();
  });
  it('coerces checkboxes from truthy strings', () => {
    expect(coerceCell('yes', 'checkbox')).toBe(true);
    expect(coerceCell('0', 'checkbox')).toBe(false);
    expect(coerceCell(true, 'checkbox')).toBe(true);
  });
  it('splits multiselect strings', () => {
    expect(coerceCell('a, b ,c', 'multiselect')).toEqual(['a', 'b', 'c']);
  });
});

describe('row ops', () => {
  it('adds a row, coercing cells to column types', () => {
    const { doc, row } = addRow(grid(), { c_qty: '5', c_item: 'Bolt' });
    expect(doc.rows).toHaveLength(3);
    expect(row.cells.c_qty).toBe(5);
    expect(row.cells.c_item).toBe('Bolt');
  });
  it('inserts after a given row', () => {
    const { doc, row } = addRow(grid(), { c_item: 'Mid' }, 'r1');
    expect(doc.rows[1]!.id).toBe(row.id);
  });
  it('updates a row by merge and clears emptied cells', () => {
    const doc = updateRow(grid(), 'r1', { c_qty: 10, c_item: '' });
    const r1 = doc.rows.find((r) => r.id === 'r1')!;
    expect(r1.cells.c_qty).toBe(10);
    expect('c_item' in r1.cells).toBe(false);
  });
  it('setCell is a single-cell update', () => {
    const doc = setCell(grid(), 'r2', 'c_price', 7);
    expect(doc.rows.find((r) => r.id === 'r2')!.cells.c_price).toBe(7);
  });
  it('deletes a row', () => {
    expect(deleteRow(grid(), 'r1').rows.map((r) => r.id)).toEqual(['r2']);
  });
});

describe('column ops', () => {
  it('re-coerces cells when a column type changes', () => {
    const doc = updateColumn(grid(), 'c_qty', { type: 'text' });
    expect(doc.rows[0]!.cells.c_qty).toBe('2');
  });
  it('deleteColumn prunes cells and aggregates', () => {
    let doc = setAggregate(grid(), 'c_qty', 'sum');
    doc = deleteColumn(doc, 'c_qty');
    expect(doc.columns.find((c) => c.id === 'c_qty')).toBeUndefined();
    expect(doc.rows[0]!.cells.c_qty).toBeUndefined();
    expect(doc.aggregates?.c_qty).toBeUndefined();
  });
  it('addColumn appends with an id', () => {
    const { doc, column } = addColumn(grid(), { name: 'Tag', type: 'text' });
    expect(column.id).toBeTruthy();
    expect(doc.columns.at(-1)!.name).toBe('Tag');
  });
});

describe('aggregates', () => {
  it('sums and averages numeric columns', () => {
    const doc = grid();
    expect(computeAggregate(doc, 'c_qty', 'sum')).toBe(5);
    expect(computeAggregate(doc, 'c_price', 'sum')).toBe(13.5);
    expect(computeAggregate(doc, 'c_qty', 'avg')).toBe(2.5);
    expect(computeAggregate(doc, 'c_qty', 'max')).toBe(3);
  });
  it('count counts rows; filled/empty count cells', () => {
    const doc = updateRow(grid(), 'r2', { c_item: '' });
    expect(computeAggregate(doc, 'c_item', 'count')).toBe(2);
    expect(computeAggregate(doc, 'c_item', 'filled')).toBe(1);
    expect(computeAggregate(doc, 'c_item', 'empty')).toBe(1);
  });
  it('returns null for a numeric aggregate on an all-text column', () => {
    expect(computeAggregate(grid(), 'c_item', 'sum')).toBeNull();
  });
});

describe('formula columns via resolveCell', () => {
  it('computes a same-row expression', () => {
    let doc = grid();
    doc = addColumn(doc, { name: 'Total', type: 'formula', formula: '{Qty} * {Price}' }).doc;
    const col = findColumnByName(doc, 'Total')!;
    expect(resolveCell(doc, doc.rows[0]!, col)).toBe(19);
    expect(resolveCell(doc, doc.rows[1]!, col)).toBe(12);
  });

  it('aggregates resolve formula columns (sum/avg over computed cells)', () => {
    let doc = grid();
    doc = addColumn(doc, { name: 'Total', type: 'formula', formula: '{Qty} * {Price}' }).doc;
    const colId = findColumnByName(doc, 'Total')!.id;
    expect(computeAggregate(doc, colId, 'sum')).toBe(31); // 19 + 12
    expect(computeAggregate(doc, colId, 'avg')).toBe(15.5);
  });
});

describe('views (filter + sort)', () => {
  it('filters then sorts', () => {
    let doc = grid();
    doc = addRow(doc, { c_item: 'Anvil', c_qty: 1, c_price: 50 }).doc;
    doc = setView(doc, {
      id: 'v1',
      name: 'cheap-desc',
      filters: [{ colId: 'c_price', op: 'lt', value: 40 }],
      sort: [{ colId: 'c_qty', dir: 'desc' }],
    });
    const rows = applyView(doc, 'v1');
    expect(rows.map((r) => r.cells.c_item)).toEqual(['Gadget', 'Widget']);
  });
  it('unknown view id returns all rows in document order', () => {
    const doc = grid();
    expect(applyView(doc, 'nope').map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('tableDocFromGrid (import)', () => {
  it('builds a typed doc with ids and coerced cells', () => {
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Qty', type: 'number' },
        { name: 'Bogus', type: 'wat' },
      ],
      rows: [
        ['Widget', 2, 'x'],
        ['Gadget', '3', null],
      ],
    });
    expect(doc.columns.map((c) => c.type)).toEqual(['text', 'number', 'text']);
    expect(doc.columns.every((c) => c.id)).toBe(true);
    const [r0, r1] = doc.rows;
    expect(r0!.cells[doc.columns[1]!.id]).toBe(2);
    expect(r1!.cells[doc.columns[1]!.id]).toBe(3); // '3' coerced to number
    expect(doc.rows.every((r) => r.id)).toBe(true);
  });
});

describe('emptyTableDoc', () => {
  it('produces a usable starter grid', () => {
    const doc = emptyTableDoc();
    expect(doc.columns).toHaveLength(2);
    expect(doc.rows).toHaveLength(3);
    expect(cellIsEmpty(doc.rows[0]!.cells.whatever ?? null)).toBe(true);
  });
});
