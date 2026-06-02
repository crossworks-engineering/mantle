import { describe, expect, it } from 'vitest';
import { setView, type TableDoc } from './table-model';
import { listRows } from './table-list';

function bigGrid(n: number): TableDoc {
  return {
    columns: [
      { id: 'c_name', name: 'Name', type: 'text' },
      { id: 'c_n', name: 'N', type: 'number' },
    ],
    rows: Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      cells: { c_name: `Row ${i}`, c_n: i },
    })),
    aggregates: {},
    views: [],
  };
}

describe('listRows', () => {
  it('windows rows with offset/limit and reports the total', () => {
    const res = listRows(bigGrid(100), { offset: 10, limit: 5 });
    expect(res.total).toBe(100);
    expect(res.rows).toHaveLength(5);
    expect(res.rows[0]!.index).toBe(10);
    expect(res.rows[0]!.id).toBe('r10');
    expect(res.rows[0]!.cells.c_name).toBe('Row 10');
  });

  it('omits empty cells from the snapshot', () => {
    const doc = bigGrid(1);
    doc.rows[0]!.cells = { c_name: 'Only' };
    const res = listRows(doc);
    expect(res.rows[0]!.cells).toEqual({ c_name: 'Only' });
  });

  it('restricts the cell snapshot to requested columns but lists all columns', () => {
    const res = listRows(bigGrid(3), { columnIds: ['c_n'] });
    expect(res.columns.map((c) => c.id)).toEqual(['c_name', 'c_n']);
    expect(Object.keys(res.rows[0]!.cells)).toEqual(['c_n']);
  });

  it('applies a view before windowing', () => {
    let doc = bigGrid(5);
    doc = setView(doc, {
      id: 'v',
      name: 'top',
      filters: [{ colId: 'c_n', op: 'gte', value: 3 }],
      sort: [{ colId: 'c_n', dir: 'desc' }],
    });
    const res = listRows(doc, { viewId: 'v' });
    expect(res.total).toBe(2);
    expect(res.rows.map((r) => r.cells.c_name)).toEqual(['Row 4', 'Row 3']);
  });

  it('truncates long previews', () => {
    const doc = bigGrid(1);
    doc.rows[0]!.cells = { c_name: 'x'.repeat(200) };
    const res = listRows(doc, { previewChars: 20 });
    expect(res.rows[0]!.cells.c_name!.length).toBeLessThanOrEqual(20);
    expect(res.rows[0]!.cells.c_name!.endsWith('…')).toBe(true);
  });
});
