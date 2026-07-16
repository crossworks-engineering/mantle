import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  readDocFile,
  shapeHashOf,
  shapeHashOfFile,
  writeDocFile,
  describeWorkbook,
} from './engine';
import type { CellValue, ColumnType, TableDocLike } from './doc-types';
import { applyOpsToFile, finalizePublishedFile, type TableOp } from './ops';
import { aggregateWindow, listRowsWindow, queryRowsWindow } from './window';
import { openTableFile } from './sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-p3-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-1', ownerId: 'owner-1' };

// A stand-in for table-model's coerceCell (the content layer injects the real
// one) — enough fidelity for the behaviors under test.
const coerce = (value: unknown, type: ColumnType): CellValue => {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'number' || type === 'currency' || type === 'percent') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'checkbox') return value === true || ['true', '1', 'yes'].includes(String(value));
  if (type === 'multiselect') return Array.isArray(value) ? value.map(String) : [String(value)];
  return String(value);
};

function baseDoc(): TableDocLike {
  return {
    columns: [
      { id: 'c-name', name: 'Name', type: 'text' },
      { id: 'c-qty', name: 'Qty', type: 'number' },
      { id: 'c-status', name: 'Status', type: 'select' },
    ],
    rows: [
      { id: 'r1', cells: { 'c-name': 'alpha', 'c-qty': 1, 'c-status': 'Open' } },
      { id: 'r2', cells: { 'c-name': 'beta', 'c-qty': 2, 'c-status': 'Closed' } },
      { id: 'r3', cells: { 'c-name': 'gamma', 'c-qty': 3, 'c-status': 'Open' } },
    ],
  };
}

function draftFile(name: string, doc = baseDoc()): string {
  const file = path.join(dir, `${name}.draft.sqlite`);
  writeDocFile(file, doc, META); // draft shape: no FTS
  return file;
}

describe('applyOpsToFile', () => {
  it('applies a mixed batch atomically and round-trips', () => {
    const file = draftFile('ops-mixed');
    const ops: TableOp[] = [
      { op: 'row_add', rowId: 'r4', cells: { 'c-name': 'delta', 'c-qty': '4' }, afterRowId: 'r1' },
      { op: 'cell_set', rowId: 'r2', columnId: 'c-qty', value: 20 },
      { op: 'row_delete', rowId: 'r3' },
      { op: 'aggregate_set', columnId: 'c-qty', kind: 'sum' },
      { op: 'select_option_add', columnId: 'c-status', label: 'On hold' },
    ];
    const res = applyOpsToFile(file, ops, coerce);
    expect(res.applied).toBe(5);
    expect(res.createdIds[0]).toBe('r4');

    const doc = readDocFile(file);
    expect(doc.rows.map((r) => r.id)).toEqual(['r1', 'r4', 'r2']); // add-after order held
    expect(doc.rows[1]!.cells['c-qty']).toBe(4); // coerced through the injected fn
    expect(doc.rows[2]!.cells['c-qty']).toBe(20);
    expect(doc.aggregates).toEqual({ 'c-qty': 'sum' });
    const status = doc.columns.find((c) => c.id === 'c-status')!;
    expect(status.options).toEqual([{ id: 'on_hold', label: 'On hold' }]);
  });

  it('a failing op rolls back the whole batch', () => {
    const file = draftFile('ops-atomic');
    const ops: TableOp[] = [
      { op: 'row_add', rowId: 'r4', cells: {} },
      { op: 'column_add', column: { id: 'c-name', name: 'Dup', type: 'text' } }, // duplicate id → throws
    ];
    expect(() => applyOpsToFile(file, ops, coerce)).toThrow(/already exists/);
    expect(readDocFile(file).rows).toHaveLength(3); // r4 rolled back
  });

  it('column add / rename / retype / delete keep data + view coherent', () => {
    const file = draftFile('ops-cols');
    applyOpsToFile(
      file,
      [
        {
          op: 'column_add',
          column: { id: 'c-due', name: 'Due', type: 'text' },
          afterColumnId: 'c-name',
        },
        { op: 'cell_set', rowId: 'r1', columnId: 'c-due', value: '2026-07-15' },
      ],
      coerce,
    );
    let doc = readDocFile(file);
    expect(doc.columns.map((c) => c.id)).toEqual(['c-name', 'c-due', 'c-qty', 'c-status']);

    // retype text → number re-coerces stored values
    applyOpsToFile(
      file,
      [
        { op: 'cell_set', rowId: 'r2', columnId: 'c-due', value: '42' },
        { op: 'column_update', columnId: 'c-due', patch: { type: 'number' } },
      ],
      coerce,
    );
    doc = readDocFile(file);
    expect(doc.rows[1]!.cells['c-due']).toBe(42);
    expect(doc.rows[0]!.cells['c-due']).toBeNull; // '2026-07-15' isn't numeric → null (dropped)

    applyOpsToFile(
      file,
      [{ op: 'column_update', columnId: 'c-name', patch: { name: 'Title' } }],
      coerce,
    );
    const db = openTableFile(file, { readOnly: true });
    try {
      const row = db.prepare(`SELECT "Title" FROM "Sheet1" ORDER BY _pos LIMIT 1`).get();
      expect(row).toEqual({ Title: 'alpha' });
    } finally {
      db.close();
    }

    applyOpsToFile(file, [{ op: 'column_delete', columnId: 'c-due' }], coerce);
    doc = readDocFile(file);
    expect(doc.columns.map((c) => c.id)).toEqual(['c-name', 'c-qty', 'c-status']);
    expect(doc.rows[1]!.cells['c-due']).toBeUndefined();
  });

  it('fractional insert renumbers on precision drift', () => {
    const file = draftFile('ops-pos');
    // squeeze 60 inserts between r1 and r2 — midpoint halving exhausts REAL
    // precision long before 60 without the renumber
    for (let i = 0; i < 60; i++) {
      applyOpsToFile(file, [{ op: 'row_add', rowId: `mid-${i}`, afterRowId: 'r1' }], coerce);
    }
    const doc = readDocFile(file);
    expect(doc.rows).toHaveLength(63);
    expect(doc.rows[0]!.id).toBe('r1');
    expect(doc.rows[1]!.id).toBe('mid-59'); // last insert lands directly after r1
    expect(doc.rows[62]!.id).toBe('r3');
  });
});

describe('promote finalize', () => {
  it('draft → published rename + finalize adds FTS and agrees on shape hash', () => {
    const draft = draftFile('promote');
    const published = path.join(dir, 'promote.sqlite');
    renameSync(draft, published);
    finalizePublishedFile(published);
    const tabs = describeWorkbook(published);
    expect(tabs[0]!.ftsTable).not.toBeNull();
    const db = openTableFile(published, { readOnly: true });
    try {
      const hits = db
        .prepare(`SELECT rowid FROM ${tabs[0]!.ftsTable} WHERE ${tabs[0]!.ftsTable} MATCH '"beta"'`)
        .all();
      expect(hits).toHaveLength(1); // backfill indexed pre-existing rows
    } finally {
      db.close();
    }
    expect(shapeHashOfFile(published)).toBe(shapeHashOf(baseDoc()));
  });
});

describe('windowed reads', () => {
  const manyDoc: TableDocLike = {
    columns: [
      { id: 'c-n', name: 'N', type: 'number' },
      { id: 'c-t', name: 'T', type: 'text' },
    ],
    rows: Array.from({ length: 25 }, (_, i) => ({
      id: `r${String(i).padStart(2, '0')}`,
      cells: { 'c-n': i, 'c-t': i % 2 ? 'odd' : 'even' },
    })),
  };

  it('keyset pages cover everything exactly once', () => {
    const file = draftFile('win-keyset', manyDoc);
    const seen: string[] = [];
    let after: { pos: number; rid: string } | undefined;
    for (;;) {
      const page = listRowsWindow(file, { limit: 7, after });
      seen.push(...page.rows.map((r) => r.id));
      expect(page.total).toBe(25);
      if (!page.cursor) break;
      after = page.cursor;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe('r00');
    expect(seen[24]).toBe('r24');
  });

  it('parity-safe filters/sort push down; formula refs refuse', () => {
    const file = draftFile('win-query', manyDoc);
    const q = queryRowsWindow(file, {
      filters: [
        { colId: 'c-t', op: 'eq', value: 'odd' },
        { colId: 'c-n', op: 'gt', value: 10 },
      ],
      sort: [{ colId: 'c-n', dir: 'desc' }],
      limit: 3,
    });
    expect(q).not.toBeNull();
    expect(q!.total).toBe(7); // 11,13,…,23
    expect(q!.rows.map((r) => r.cells['c-n'])).toEqual([23, 21, 19]);

    const formulaDoc: TableDocLike = {
      columns: [{ id: 'f', name: 'F', type: 'formula', formula: '1' }],
      rows: [],
    };
    const ffile = draftFile('win-formula', formulaDoc);
    expect(queryRowsWindow(ffile, { filters: [{ colId: 'f', op: 'eq', value: '1' }] })).toBeNull();
  });

  it('aggregates match computeAggregate semantics', () => {
    const file = draftFile('win-agg', manyDoc);
    expect(aggregateWindow(file, { columnId: 'c-n', kind: 'sum' })).toBe(300);
    expect(aggregateWindow(file, { columnId: 'c-n', kind: 'avg' })).toBe(12);
    expect(aggregateWindow(file, { columnId: 'c-t', kind: 'filled' })).toBe(25);
    expect(
      aggregateWindow(file, {
        columnId: 'c-n',
        kind: 'count',
        filters: [{ colId: 'c-t', op: 'eq', value: 'even' }],
      }),
    ).toBe(13);
    expect(aggregateWindow(file, { columnId: 'c-t', kind: 'sum' })).toBeNull(); // non-numeric target refuses
  });
});
