/**
 * Linked (reference) columns: a reference stores/coerces/filters as 'select'
 * (text) — the whole point of storageType(). Proves the storage round-trips,
 * unlink keeps cells, and FTS/profile follow the storage type.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readDocFile, writeDocFile } from './engine';
import { storageType } from './doc-types';
import { applyOpsToFile } from './ops';
import { ftsColumns } from './fts';
import { profileFile, sampleRows } from './profile';
import { queryRowsWindow, listRowsWindow } from './window';
import type { CellValue, Column, WorkbookDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-refcols-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const META = { nodeId: 'node-rc', ownerId: 'owner-1' };
// The engine's ops take a coerce fn shaped like content's coerceCell (one-way
// dep, so re-implement the one family we touch: text).
const coerce = (v: unknown, _type: string): CellValue => {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
};
let n = 0;
function fileWith(link: Partial<Column>): string {
  const abs = path.join(dir, `rc-${n++}.sqlite`);
  const tabs: WorkbookDocLike['tabs'] = [
    {
      id: 'src',
      name: 'Source',
      columns: [{ id: 'c-opt', name: 'Opt', type: 'text' }],
      rows: [
        { id: 's1', cells: { 'c-opt': 'yes' } },
        { id: 's2', cells: { 'c-opt': 'no' } },
      ],
    },
    {
      id: 'main',
      name: 'Main',
      columns: [
        { id: 'c-k', name: 'K', type: 'text' },
        { id: 'c-link', name: 'Link', ...link } as Column,
      ],
      rows: [],
    },
  ];
  writeDocFile(abs, { tabs }, META);
  return abs;
}
const linkCol = (doc: { columns: Column[] }) => doc.columns.find((c) => c.id === 'c-link')!;

describe('linked (reference) column stores + reads as text', () => {
  it('stores + reads its picked value as text', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
    expect(linkCol(doc).type).toBe('reference');
    expect(storageType(linkCol(doc))).toBe('select');
  });

  it('is included in FTS (text storage)', () => {
    const cols: Column[] = [{ id: 'a', name: 'A', type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } }];
    expect(ftsColumns(cols).map((c) => c.id)).toContain('a');
  });
});

describe('unlink keeps values', () => {
  it('delete link (→ text) keeps values, clears ref', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    applyOpsToFile(
      abs,
      [{ op: 'column_update', tabId: 'main', columnId: 'c-link', patch: { type: 'text', ref: null } }],
      coerce,
    );
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(linkCol(doc).type).toBe('text');
    expect(linkCol(doc).ref).toBeUndefined();
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
  });
});

describe('reads round-trip a workbook with reference columns', () => {
  it('window + sample reads do not throw', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    expect(() => queryRowsWindow(abs, { tabId: 'main', limit: 10 })).not.toThrow();
    expect(() => listRowsWindow(abs, { tabId: 'main', limit: 10 })).not.toThrow();
    expect(() => sampleRows(abs, 5)).not.toThrow();
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(storageType(doc.columns.find((c) => c.id === 'c-link')!)).toBe('select');
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
  });
});

describe('profile', () => {
  it('a linked column advertises its source edge', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    const col = profileFile(abs).find((t) => t.name === 'Main')!.columns.find((c) => c.colId === 'c-link')!;
    expect(col.refersTo).toEqual({ tab: 'Source', column: 'Opt' });
  });
});
