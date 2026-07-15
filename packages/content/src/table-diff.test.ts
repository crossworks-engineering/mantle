import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyOpsToFile, readDocFile, writeDocFile, type CellValue, type TableOp } from '@mantle/tabledb';
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

  it('emits row_add anchored to the immediate predecessor', () => {
    const next = doc();
    next.rows = [next.rows[0]!, { id: 'r-new', cells: { c1: 'Gizmo' } }, next.rows[1]!];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_add', rowId: 'r-new', cells: { c1: 'Gizmo' }, afterRowId: 'r1' },
    ]);
  });

  it('a run of new rows chains each to the previous NEW row (batch order preserves the run)', () => {
    // Anchoring the whole run to one shared pre-existing row reversed it —
    // the engine midpoint-inserts directly after the anchor (audit).
    const next = doc();
    next.rows = [
      next.rows[0]!,
      { id: 'n1', cells: {} },
      { id: 'n2', cells: {} },
      { id: 'n3', cells: {} },
      next.rows[1]!,
    ];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_add', rowId: 'n1', cells: {}, afterRowId: 'r1' },
      { op: 'row_add', rowId: 'n2', cells: {}, afterRowId: 'n1' },
      { op: 'row_add', rowId: 'n3', cells: {}, afterRowId: 'n2' },
    ]);
  });

  it('a new leading row is an explicit front insert (afterRowId null means APPEND to the engine)', () => {
    const next = doc();
    next.rows = [{ id: 'r0', cells: {} }, ...next.rows];
    expect(diffTableDocs(doc(), next)).toEqual([
      { op: 'row_add', rowId: 'r0', cells: {}, atStart: true },
    ]);
  });

  it('clearing a column property travels as explicit null (undefined dies in JSON)', () => {
    const prev = doc();
    prev.columns[1] = { id: 'c2', name: 'Qty', type: 'number', width: 200, format: { decimals: 2 } };
    const next = doc(); // width + format gone
    expect(diffTableDocs(prev, next)).toEqual([
      { op: 'column_update', columnId: 'c2', patch: { format: null, width: null } },
    ]);
  });

  it('returns null for view reordering (no op expresses it)', () => {
    const prev = doc();
    prev.views = [{ id: 'v1', name: 'A' }, { id: 'v2', name: 'B' }];
    const next = doc();
    next.views = [{ id: 'v2', name: 'B' }, { id: 'v1', name: 'A' }];
    expect(diffTableDocs(prev, next)).toBeNull();
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

  it('returns null for row/column reordering and view deletion (not expressible as ops)', () => {
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

// ── Round-trip against the REAL engine: applyOps(X, diff(X, Y)) must equal Y.
// The audit found three row-order shapes where it didn't (top insert appended,
// runs reversed) and property clears that never landed.
describe('diffTableDocs round-trip through the engine', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'table-diff-roundtrip-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const coerce = (v: unknown): CellValue => v as CellValue;
  let n = 0;

  function roundTrip(prev: TableDoc, next: TableDoc): TableDoc {
    const abs = path.join(dir, `rt-${n++}.sqlite`);
    writeDocFile(abs, prev, { nodeId: `rt-${n}`, ownerId: 'owner-rt' });
    const ops = diffTableDocs(prev, next);
    expect(ops).not.toBeNull();
    applyOpsToFile(abs, ops! as TableOp[], coerce);
    return readDocFile(abs) as TableDoc;
  }

  function base(rowIds: string[]): TableDoc {
    return {
      columns: [{ id: 'c1', name: 'Item', type: 'text' }],
      rows: rowIds.map((id) => ({ id, cells: { c1: id } })),
      aggregates: {},
      views: [],
    };
  }

  it('a run appended at the bottom lands in order', () => {
    const applied = roundTrip(base(['a', 'b']), base(['a', 'b', 'n1', 'n2', 'n3']));
    expect(applied.rows.map((r) => r.id)).toEqual(['a', 'b', 'n1', 'n2', 'n3']);
  });

  it('a run inserted in the middle lands in order', () => {
    const applied = roundTrip(base(['a', 'b']), base(['a', 'n1', 'n2', 'b']));
    expect(applied.rows.map((r) => r.id)).toEqual(['a', 'n1', 'n2', 'b']);
  });

  it('rows inserted at the top land at the top, in order', () => {
    const applied = roundTrip(base(['a', 'b']), base(['n1', 'n2', 'a', 'b']));
    expect(applied.rows.map((r) => r.id)).toEqual(['n1', 'n2', 'a', 'b']);
  });

  it('inserting into an empty table lands in order', () => {
    const applied = roundTrip(base([]), base(['n1', 'n2']));
    expect(applied.rows.map((r) => r.id)).toEqual(['n1', 'n2']);
  });

  it('clearing width/format actually clears them in the file', () => {
    const prev = base(['a']);
    prev.columns[0] = { id: 'c1', name: 'Item', type: 'text', width: 200, format: { decimals: 1 } };
    const applied = roundTrip(prev, base(['a']));
    expect(applied.columns[0]!.width).toBeUndefined();
    expect(applied.columns[0]!.format).toBeUndefined();
  });

  it('mixed edit: delete + run insert + cell update still reproduces next', () => {
    const prev = base(['a', 'b', 'c']);
    const next = base(['a', 'n1', 'n2', 'c']);
    next.rows[3] = { id: 'c', cells: { c1: 'C-EDITED' } };
    const applied = roundTrip(prev, next);
    expect(applied.rows.map((r) => r.id)).toEqual(['a', 'n1', 'n2', 'c']);
    expect(applied.rows[3]!.cells.c1).toBe('C-EDITED');
  });
});
