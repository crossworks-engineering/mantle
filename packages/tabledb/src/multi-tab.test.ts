import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  describeWorkbook,
  fileStats,
  readDocClipped,
  readDocFile,
  readWorkbookDoc,
  shapeHashOf,
  shapeHashOfFile,
  writeDocFile,
} from './engine';
import { applyOpsToFile } from './ops';
import { listRowsWindow, queryRowsWindow } from './window';
import type { CellValue, ColumnType, TableDocLike, WorkbookDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-multitab-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-m1', ownerId: 'owner-1' };
// Tests exercise storage, not coercion — pass values through like the engine
// tests do.
const coerce = (v: unknown): CellValue => v as CellValue;

function workbook(): WorkbookDocLike {
  return {
    tabs: [
      {
        id: 'models',
        name: 'Car models',
        columns: [
          { id: 'c-model', name: 'Model', type: 'text' },
          { id: 'c-make', name: 'Make', type: 'text' },
        ],
        rows: [
          { id: 'm1', cells: { 'c-model': 'Corolla', 'c-make': 'Toyota' } },
          { id: 'm2', cells: { 'c-model': 'Model 3', 'c-make': 'Tesla' } },
          { id: 'm3', cells: { 'c-model': 'Ranger', 'c-make': 'Ford' } },
        ],
      },
      {
        id: 'orders',
        name: 'Orders',
        columns: [
          { id: 'c-ref', name: 'Ref', type: 'text' },
          { id: 'c-model2', name: 'Model', type: 'text' },
          { id: 'c-qty', name: 'Qty', type: 'number' },
        ],
        rows: [
          { id: 'o1', cells: { 'c-ref': 'ORD-1', 'c-model2': 'Corolla', 'c-qty': 2 } },
          { id: 'o2', cells: { 'c-ref': 'ORD-2', 'c-model2': 'Model 3', 'c-qty': 1 } },
        ],
      },
    ],
  };
}

function write(name: string, doc: WorkbookDocLike | TableDocLike = workbook()) {
  const abs = path.join(dir, `${name}.sqlite`);
  const res = writeDocFile(abs, doc, { ...META, fts: true });
  return { abs, res };
}

describe('multi-tab writeDocFile', () => {
  it('creates every tab with its own physical table, view, and stats', () => {
    const { abs, res } = write('basic');
    expect(res.stats.tabs.map((t) => [t.tabId, t.name, t.rows, t.columns])).toEqual([
      ['models', 'Car models', 3, 2],
      ['orders', 'Orders', 2, 3],
    ]);
    expect(res.stats.totalRows).toBe(5);
    const tabs = describeWorkbook(abs);
    expect(tabs.map((t) => t.name)).toEqual(['Car models', 'Orders']);
    expect(tabs.map((t) => t.viewName)).toEqual(['Car models', 'Orders']);
    expect(tabs[0]!.ftsTable).not.toBeNull();
    expect(tabs[1]!.ftsTable).not.toBeNull();
  });

  it('dedupes colliding view names across tabs', () => {
    const doc = workbook();
    doc.tabs[1]!.name = 'Car models'; // same display name as tab 1
    const { abs } = write('collide', doc);
    const tabs = describeWorkbook(abs);
    expect(tabs.map((t) => t.viewName)).toEqual(['Car models', 'Car models_2']);
  });

  it('assigns positional tab ids when absent', () => {
    const doc = workbook();
    delete doc.tabs[0]!.id;
    delete doc.tabs[1]!.id;
    const { res } = write('anon-ids', doc);
    expect(res.stats.tabs.map((t) => t.tabId)).toEqual(['t1', 't2']);
  });

  it('a bare TableDocLike still writes the byte-compatible single-tab shape', () => {
    const single: TableDocLike = {
      columns: [{ id: 'c1', name: 'A', type: 'text' as ColumnType }],
      rows: [{ id: 'r1', cells: { c1: 'x' } }],
    };
    const abs = path.join(dir, 'single.sqlite');
    const res = writeDocFile(abs, single, { ...META, tabName: 'Sheet1' });
    expect(res.stats.tabs).toEqual([{ tabId: 't1', name: 'Sheet1', rows: 1, columns: 1 }]);
  });
});

describe('shape hash', () => {
  it('doc-side and file-side hashes agree for multi-tab workbooks', () => {
    const { abs } = write('hash');
    expect(shapeHashOf(workbook())).toBe(shapeHashOfFile(abs));
  });

  it('doc-side and file-side hashes agree for single-tab docs (regression)', () => {
    const single: TableDocLike = {
      columns: [{ id: 'c1', name: 'A', type: 'text' as ColumnType }],
      rows: [{ id: 'r1', cells: { c1: 'x' } }],
    };
    const abs = path.join(dir, 'hash-single.sqlite');
    writeDocFile(abs, single, { ...META, tabName: 'Sheet1' });
    expect(shapeHashOf(single)).toBe(shapeHashOfFile(abs));
  });

  it('changes when a tab is added', () => {
    const doc = workbook();
    const one = shapeHashOf({ tabs: [doc.tabs[0]!] });
    expect(shapeHashOf(doc)).not.toBe(one);
  });
});

describe('per-tab reads', () => {
  it('readDocFile defaults to the first tab and honors tabId', () => {
    const { abs } = write('reads');
    expect(readDocFile(abs).rows).toHaveLength(3);
    expect(readDocFile(abs, { tabId: 'orders' }).rows).toHaveLength(2);
    expect(() => readDocFile(abs, { tabId: 'nope' })).toThrow(/no tab 'nope'/);
  });

  it('readDocClipped clips per tab', () => {
    const { abs } = write('clipped');
    const clipped = readDocClipped(abs, 1, 'orders');
    expect(clipped.total).toBe(2);
    expect(clipped.clipped).toBe(true);
    expect(clipped.doc.rows).toHaveLength(1);
  });

  it('readWorkbookDoc materializes every tab in position order', () => {
    const { abs } = write('whole');
    const wb = readWorkbookDoc(abs);
    expect(wb.tabs.map((t) => [t.id, t.name, t.rows.length])).toEqual([
      ['models', 'Car models', 3],
      ['orders', 'Orders', 2],
    ]);
  });

  it('window readers target a tab', () => {
    const { abs } = write('window');
    expect(listRowsWindow(abs, { tabId: 'orders' }).total).toBe(2);
    expect(listRowsWindow(abs).total).toBe(3); // default first tab
    const q = queryRowsWindow(abs, {
      tabId: 'orders',
      filters: [{ colId: 'c-qty', op: 'eq', value: 2 }],
    });
    expect(q?.rows.map((r) => r.id)).toEqual(['o1']);
  });
});

describe('ops with tabs', () => {
  it('ops target their tabId; default stays the first tab', () => {
    const { abs } = write('ops-target');
    applyOpsToFile(
      abs,
      [
        { op: 'row_add', tabId: 'orders', rowId: 'o3', cells: { 'c-ref': 'ORD-3', 'c-qty': 5 } },
        { op: 'row_add', rowId: 'm4', cells: { 'c-model': 'Ioniq 5' } },
      ],
      coerce,
    );
    expect(readDocFile(abs, { tabId: 'orders' }).rows.map((r) => r.id)).toContain('o3');
    expect(readDocFile(abs).rows.map((r) => r.id)).toContain('m4');
  });

  it('tab_add creates an empty tab; columns then build it out', () => {
    const { abs } = write('tab-add');
    const res = applyOpsToFile(
      abs,
      [
        { op: 'tab_add', tabId: 'specs', name: 'Specs' },
        { op: 'column_add', tabId: 'specs', column: { id: 'c-spec', name: 'Spec', type: 'text' } },
        { op: 'row_add', tabId: 'specs', rowId: 's1', cells: { 'c-spec': 'V8' } },
      ],
      coerce,
    );
    expect(res.createdIds[0]).toBe('specs');
    const tabs = describeWorkbook(abs);
    expect(tabs.map((t) => t.name)).toEqual(['Car models', 'Orders', 'Specs']);
    expect(readDocFile(abs, { tabId: 'specs' }).rows).toHaveLength(1);
  });

  it('tab_rename keeps data and re-derives a unique view name', () => {
    const { abs } = write('tab-rename');
    applyOpsToFile(abs, [{ op: 'tab_rename', tabId: 'orders', name: 'Car models' }], coerce);
    const tabs = describeWorkbook(abs);
    expect(tabs.map((t) => t.name)).toEqual(['Car models', 'Car models']);
    expect(new Set(tabs.map((t) => t.viewName)).size).toBe(2); // deduped
    expect(readDocFile(abs, { tabId: 'orders' }).rows).toHaveLength(2);
  });

  it('tab_reorder moves a tab; tab_delete removes tab + storage', () => {
    const { abs } = write('tab-lifecycle');
    applyOpsToFile(abs, [{ op: 'tab_reorder', tabId: 'orders', afterTabId: null }], coerce);
    expect(describeWorkbook(abs).map((t) => t.name)).toEqual(['Orders', 'Car models']);
    applyOpsToFile(abs, [{ op: 'tab_delete', tabId: 'orders' }], coerce);
    const tabs = describeWorkbook(abs);
    expect(tabs.map((t) => t.name)).toEqual(['Car models']);
    expect(fileStats(abs).totalRows).toBe(3);
  });

  it('tab_delete refuses to remove the last tab', () => {
    const { abs } = write('tab-last');
    applyOpsToFile(abs, [{ op: 'tab_delete', tabId: 'orders' }], coerce);
    expect(() => applyOpsToFile(abs, [{ op: 'tab_delete', tabId: 'models' }], coerce)).toThrow(
      /at least one tab/,
    );
  });

  it('a failing op rolls back the whole batch including tab ops', () => {
    const { abs } = write('tab-rollback');
    expect(() =>
      applyOpsToFile(
        abs,
        [
          { op: 'tab_add', tabId: 'tmp', name: 'Temp' },
          { op: 'row_add', tabId: 'missing-tab', rowId: 'x1' },
        ],
        coerce,
      ),
    ).toThrow(/no tab 'missing-tab'/);
    expect(describeWorkbook(abs).map((t) => t.name)).toEqual(['Car models', 'Orders']);
  });
});
