import { describe, expect, it } from 'vitest';
import { diffTableDocs, type TableDoc } from './table-model';

function doc(): TableDoc {
  return {
    columns: [
      { id: 'c1', name: 'Item', type: 'text' },
      { id: 'c2', name: 'Qty', type: 'number' },
    ],
    rows: [
      { id: 'r1', cells: { c1: 'Widget', c2: 2 } },
      { id: 'r2', cells: { c1: 'Gadget', c2: 3 } },
    ],
    aggregates: {},
    views: [],
  };
}

describe('diffTableDocs', () => {
  it('returns no ops for identical docs', () => {
    expect(diffTableDocs(doc(), doc())).toEqual([]);
  });

  it('emits row_update with only the changed cells', () => {
    const next = doc();
    next.rows[0] = { id: 'r1', cells: { c1: 'Widget XL', c2: 2 } };
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_update', rowId: 'r1', cells: { c1: 'Widget XL' } },
    ]);
  });

  it('emits row_add anchored to the nearest pre-existing predecessor', () => {
    const next = doc();
    next.rows = [next.rows[0]!, { id: 'r-new', cells: { c1: 'Gizmo' } }, next.rows[1]!];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_add', rowId: 'r-new', cells: { c1: 'Gizmo' }, afterRowId: 'r1' },
    ]);
  });

  it('a new leading row anchors to null (front insert)', () => {
    const next = doc();
    next.rows = [{ id: 'r0', cells: {} }, ...next.rows];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_add', rowId: 'r0', cells: {}, afterRowId: null },
    ]);
  });

  it('emits row_delete + column ops together', () => {
    const next = doc();
    next.rows = [next.rows[1]!];
    next.columns = [
      next.columns[0]!,
      next.columns[1]!,
      { id: 'c3', name: 'Done', type: 'checkbox' },
    ];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'column_add', column: { id: 'c3', name: 'Done', type: 'checkbox' }, afterColumnId: 'c2' },
      { op: 'row_delete', rowId: 'r1' },
    ]);
  });

  it('emits column_update patches (rename + retype + ref)', () => {
    const next = doc();
    next.columns[1] = { id: 'c2', name: 'Amount', type: 'reference', ref: { tabId: 't1', columnId: 'c1' } };
    expect(diffTableDocs(doc(), next)).toEqual([
      {
        op: 'column_update',
        columnId: 'c2',
        patch: { name: 'Amount', type: 'reference', ref: { tabId: 't1', columnId: 'c1' } },
      },
    ]);
  });

  it('emits aggregate_set and view_set upserts', () => {
    const next = doc();
    next.aggregates = { c2: 'sum' };
    next.views = [{ id: 'v1', name: 'All' }];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'aggregate_set', columnId: 'c2', kind: 'sum' },
      { op: 'view_set', view: { id: 'v1', name: 'All' } },
    ]);
  });

  it('returns null for reordering and view deletion (not expressible as ops)', () => {
    const rowSwap = doc();
    rowSwap.rows = [rowSwap.rows[1]!, rowSwap.rows[0]!];
    expect(diffTableDocs(doc(), rowSwap)).toBeNull();

    const colSwap = doc();
    colSwap.columns = [colSwap.columns[1]!, colSwap.columns[0]!];
    expect(diffTableDocs(doc(), colSwap)).toBeNull();

    const withView = doc();
    withView.views = [{ id: 'v1', name: 'All' }];
    expect(diffTableDocs(withView, doc())).toBeNull();
  });
});
