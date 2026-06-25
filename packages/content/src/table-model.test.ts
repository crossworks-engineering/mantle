import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addRow,
  addSelectOption,
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
  groupRows,
  queryRows,
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

describe('addSelectOption', () => {
  function selDoc() {
    return {
      columns: [{ id: 'c_s', name: 'Status', type: 'select' as const, options: [{ id: 'open', label: 'Open' }] }],
      rows: [{ id: 'r1', cells: {} }],
      aggregates: {},
      views: [],
    };
  }
  it('appends a new option with a slug id', () => {
    const doc = addSelectOption(selDoc(), 'c_s', 'In Progress');
    expect(doc.columns[0]!.options).toEqual([
      { id: 'open', label: 'Open' },
      { id: 'in_progress', label: 'In Progress' },
    ]);
  });
  it('is a case-insensitive no-op when the label already exists', () => {
    const base = selDoc();
    expect(addSelectOption(base, 'c_s', 'open')).toBe(base);
  });
  it('ignores blanks and unknown columns', () => {
    const base = selDoc();
    expect(addSelectOption(base, 'c_s', '   ')).toBe(base);
    expect(addSelectOption(base, 'nope', 'X')).toBe(base);
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

describe('queryRows (ad-hoc filter + sort)', () => {
  function bigGrid(): TableDoc {
    let doc = grid();
    doc = addRow(doc, { c_item: 'Anvil', c_qty: 1, c_price: 50 }).doc;
    return doc;
  }

  it('ANDs filters by default', () => {
    const doc = bigGrid();
    const rows = queryRows(doc, {
      filters: [
        { colId: 'c_price', op: 'lt', value: 40 },
        { colId: 'c_qty', op: 'gte', value: 3 },
      ],
    });
    expect(rows.map((r) => r.cells.c_item)).toEqual(['Gadget']);
  });

  it('ORs filters when match=any', () => {
    const doc = bigGrid();
    const rows = queryRows(doc, {
      match: 'any',
      filters: [
        { colId: 'c_item', op: 'eq', value: 'Widget' },
        { colId: 'c_price', op: 'gte', value: 50 },
      ],
    });
    expect(rows.map((r) => r.cells.c_item).sort()).toEqual(['Anvil', 'Widget']);
  });

  it('applies sort and leaves the doc unchanged', () => {
    const doc = bigGrid();
    const before = doc.rows.map((r) => r.id);
    const rows = queryRows(doc, { sort: [{ colId: 'c_price', dir: 'desc' }] });
    expect(rows.map((r) => r.cells.c_item)).toEqual(['Anvil', 'Widget', 'Gadget']);
    expect(doc.rows.map((r) => r.id)).toEqual(before); // pure: no mutation
  });

  it('no filters returns every row in document order', () => {
    const doc = bigGrid();
    expect(queryRows(doc, {}).map((r) => r.id)).toEqual(['r1', 'r2', doc.rows[2]!.id]);
  });
});

describe('groupRows (group by)', () => {
  function catGrid(): TableDoc {
    return {
      columns: [
        { id: 'c_svc', name: 'Service', type: 'text' },
        { id: 'c_metal', name: 'Metallurgy', type: 'text' },
        { id: 'c_press', name: 'Pressure', type: 'number' },
      ],
      rows: [
        { id: 'r1', cells: { c_svc: 'Steam', c_metal: 'CS', c_press: 1000 } },
        { id: 'r2', cells: { c_svc: 'Steam', c_metal: 'CS', c_press: 2000 } },
        { id: 'r3', cells: { c_svc: 'Amine', c_metal: 'SS', c_press: 500 } },
        { id: 'r4', cells: { c_svc: 'Amine', c_metal: 'CS', c_press: 3000 } },
      ],
      aggregates: {},
      views: [],
    };
  }

  it('buckets by a column in first-seen order with correct counts', () => {
    const buckets = groupRows(catGrid(), { groupColIds: ['c_svc'] });
    expect(buckets.map((b) => b.key)).toEqual([['Steam'], ['Amine']]);
    expect(buckets.map((b) => b.rows.length)).toEqual([2, 2]);
    expect(buckets[0]!.rows.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('per-group aggregates compose with computeAggregate over bucket.rows', () => {
    const doc = catGrid();
    const buckets = groupRows(doc, { groupColIds: ['c_svc'] });
    const maxByService = buckets.map((b) => [b.key[0], computeAggregate(doc, 'c_press', 'max', b.rows)]);
    expect(maxByService).toEqual([['Steam', 2000], ['Amine', 3000]]);
  });

  it('filters rows before grouping', () => {
    const buckets = groupRows(catGrid(), {
      groupColIds: ['c_metal'],
      filters: [{ colId: 'c_press', op: 'gte', value: 1000 }],
    });
    // r3 (SS, 500) is filtered out → only a CS bucket of r1, r2, r4
    expect(buckets.map((b) => b.key)).toEqual([['CS']]);
    expect(buckets[0]!.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r4']);
  });

  it('supports a multi-column composite key', () => {
    const buckets = groupRows(catGrid(), { groupColIds: ['c_svc', 'c_metal'] });
    expect(buckets.map((b) => b.key)).toEqual([['Steam', 'CS'], ['Amine', 'SS'], ['Amine', 'CS']]);
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
