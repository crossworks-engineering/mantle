/**
 * v2.2 linked-column modes: refMode select | checkbox (multi deferred). A
 * linked column stores/coerces/filters as its refMode's base type — the whole
 * point of storageType(). Proves the storage round-trips + mode switches +
 * unlink don't corrupt cells, and that pushdown/FTS/profile follow the mode.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readDocFile, writeDocFile } from './engine';
import { storageType } from './doc-types';
import { applyOpsToFile, finalizePublishedFile } from './ops';
import { ftsColumns } from './fts';
import { profileFile, sampleRows } from './profile';
import { queryRowsWindow, listRowsWindow } from './window';
import { openTableFile } from './sqlite';
import type { CellValue, Column, WorkbookDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-refmodes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const META = { nodeId: 'node-rm', ownerId: 'owner-1' };
// The engine's ops take a coerce fn shaped like content's coerceCell (one-way
// dep, so re-implement the families we touch: checkbox + text).
const coerce = (v: unknown, type: string): CellValue => {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'checkbox') {
    if (typeof v === 'boolean') return v;
    return ['true', '1', 'yes', 'y', 'x', '✓'].includes(String(v).trim().toLowerCase());
  }
  return String(v);
};
let n = 0;
function fileWith(link: Partial<Column>): string {
  const abs = path.join(dir, `rm-${n++}.sqlite`);
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

describe('linked select (default / v0.136.0 compat)', () => {
  it('a reference column with no refMode stores + reads as text', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
    expect(linkCol(doc).type).toBe('reference');
    expect(storageType(linkCol(doc))).toBe('select');
  });
});

describe('linked checkbox', () => {
  it('stores as a boolean and round-trips true/false', () => {
    const abs = fileWith({ type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(
      abs,
      [
        { op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': true } },
        { op: 'row_add', tabId: 'main', rowId: 'r2', cells: { 'c-k': 'b', 'c-link': false } },
      ],
      coerce,
    );
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(doc.rows.map((r) => r.cells['c-link'])).toEqual([true, false]);
    expect(storageType(linkCol(doc))).toBe('checkbox');
  });

  it('gets INTEGER SQL affinity, not TEXT', () => {
    const abs = fileWith({ type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } });
    const db = openTableFile(abs, { readOnly: true });
    try {
      const physical = String(
        (db.prepare(`SELECT physical FROM _columns WHERE col_id = 'c-link'`).get() as { physical: string }).physical,
      );
      const info = db.prepare(`PRAGMA table_info(t_main)`).all() as unknown as { name: string; type: string }[];
      expect(info.find((c) => c.name === physical)?.type).toBe('INTEGER');
    } finally {
      db.close();
    }
  });

  it('is excluded from FTS; a linked-select is included', () => {
    const cols: Column[] = [
      { id: 'a', name: 'A', type: 'reference', refMode: 'select', ref: { tabId: 'src', columnId: 'c-opt' } },
      { id: 'b', name: 'B', type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } },
    ];
    const fts = ftsColumns(cols).map((c) => c.id);
    expect(fts).toContain('a');
    expect(fts).not.toContain('b');
  });

  it('filters via pushdown as a checkbox (eq true), not as text', () => {
    const abs = fileWith({ type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(
      abs,
      [
        { op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': true } },
        { op: 'row_add', tabId: 'main', rowId: 'r2', cells: { 'c-k': 'b', 'c-link': false } },
        { op: 'row_add', tabId: 'main', rowId: 'r3', cells: { 'c-k': 'c', 'c-link': true } },
      ],
      coerce,
    );
    const res = queryRowsWindow(abs, {
      tabId: 'main',
      filters: [{ colId: 'c-link', op: 'eq', value: 'true' }],
      match: 'all',
      limit: 100,
    });
    expect(res).not.toBeNull();
    expect(res!.rows.map((r) => r.cells['c-k'])).toEqual(['a', 'c']);
  });
});

describe('mode switches re-coerce values', () => {
  it('select → checkbox converts picked text to booleans', () => {
    const abs = fileWith({ type: 'reference', refMode: 'select', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(
      abs,
      [
        { op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } },
        { op: 'row_add', tabId: 'main', rowId: 'r2', cells: { 'c-k': 'b', 'c-link': 'no' } },
      ],
      coerce,
    );
    applyOpsToFile(abs, [{ op: 'column_update', tabId: 'main', columnId: 'c-link', patch: { refMode: 'checkbox' } }], coerce);
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(doc.rows.map((r) => r.cells['c-link'])).toEqual([true, false]); // 'yes'→true, 'no'→false
    expect(storageType(linkCol(doc))).toBe('checkbox');
    expect(linkCol(doc).refMode).toBe('checkbox');
    expect(linkCol(doc).ref).toEqual({ tabId: 'src', columnId: 'c-opt' }); // ref survives a mode switch
  });

  it('delete link (→ text) keeps values, clears ref + mode', () => {
    const abs = fileWith({ type: 'reference', refMode: 'select', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    applyOpsToFile(
      abs,
      [{ op: 'column_update', tabId: 'main', columnId: 'c-link', patch: { type: 'text', ref: null, refMode: null } }],
      coerce,
    );
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(linkCol(doc).type).toBe('text');
    expect(linkCol(doc).ref).toBeUndefined();
    expect(linkCol(doc).refMode).toBeUndefined();
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
  });
});

describe('forward-compat: a pre-v2.2 file (no ref_mode column) still reads', () => {
  it('window + sample reads do not throw on a file missing ref_mode (audit HIGH)', () => {
    const abs = fileWith({ type: 'reference', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(abs, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    // Simulate a file published before v2.2 — drop the ref_mode column on disk.
    const w = openTableFile(abs, {});
    try {
      w.exec(`ALTER TABLE _columns DROP COLUMN ref_mode`);
    } finally {
      w.close();
    }
    expect(() => queryRowsWindow(abs, { tabId: 'main', limit: 10 })).not.toThrow();
    expect(() => listRowsWindow(abs, { tabId: 'main', limit: 10 })).not.toThrow();
    expect(() => sampleRows(abs, 5)).not.toThrow();
    // And the reference column still behaves as select (missing → 'select').
    const doc = readDocFile(abs, { tabId: 'main' });
    expect(storageType(doc.columns.find((c) => c.id === 'c-link')!)).toBe('select');
    expect(doc.rows[0]!.cells['c-link']).toBe('yes');
  });
});

describe('promote (finalizePublishedFile) rebuilds FTS by mode', () => {
  it('excludes a linked-checkbox from the rebuilt shadow, keeps a linked-select', () => {
    const abs = path.join(dir, `rm-promote-${n++}.sqlite`);
    writeDocFile(
      abs,
      {
        tabs: [
          { id: 'src', name: 'Source', columns: [{ id: 'c-opt', name: 'Opt', type: 'text' }], rows: [] },
          {
            id: 'main',
            name: 'Main',
            columns: [
              { id: 'c-sel', name: 'Sel', type: 'reference', refMode: 'select', ref: { tabId: 'src', columnId: 'c-opt' } },
              { id: 'c-cb', name: 'CB', type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } },
            ],
            rows: [],
          },
        ],
      },
      META,
    );
    finalizePublishedFile(abs); // the promote path — rebuilds FTS shadows
    const db = openTableFile(abs, { readOnly: true });
    try {
      const physicals = (db.prepare(`SELECT col_id, physical FROM _columns WHERE tab_id='main'`).all() as unknown as {
        col_id: string;
        physical: string;
      }[]).reduce<Record<string, string>>((m, c) => ((m[c.col_id] = c.physical), m), {});
      const ftsCols = new Set(
        (db.prepare(`PRAGMA table_info(t_main_fts)`).all() as unknown as { name: string }[]).map((c) => c.name),
      );
      expect(ftsCols.has(physicals['c-sel']!)).toBe(true); // linked-select → text → indexed
      expect(ftsCols.has(physicals['c-cb']!)).toBe(false); // linked-checkbox → boolean → excluded
    } finally {
      db.close();
    }
  });
});

describe('profile', () => {
  it('a linked-checkbox advertises no source edge; a linked-select does', () => {
    const cb = fileWith({ type: 'reference', refMode: 'checkbox', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(cb, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': true } }], coerce);
    const cbCol = profileFile(cb).find((t) => t.name === 'Main')!.columns.find((c) => c.colId === 'c-link')!;
    expect(cbCol.refersTo).toBeUndefined();

    const sel = fileWith({ type: 'reference', refMode: 'select', ref: { tabId: 'src', columnId: 'c-opt' } });
    applyOpsToFile(sel, [{ op: 'row_add', tabId: 'main', rowId: 'r1', cells: { 'c-k': 'a', 'c-link': 'yes' } }], coerce);
    const selCol = profileFile(sel).find((t) => t.name === 'Main')!.columns.find((c) => c.colId === 'c-link')!;
    expect(selCol.refersTo).toEqual({ tab: 'Source', column: 'Opt' });
  });
});
