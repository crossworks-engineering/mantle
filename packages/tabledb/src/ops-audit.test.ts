/**
 * Regression coverage for the v2.1 audit round: formula↔stored retypes are
 * DDL (a formula column has no physical column — retyping without the ALTER
 * bricked every subsequent read), explicit front inserts, null = clear in
 * column_update patches, and view names colliding with engine table names.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readDocFile, writeDocFile } from './engine';
import { applyOpsToFile } from './ops';
import { openTableFile } from './sqlite';
import type { CellValue, TableDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-ops-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const coerce = (v: unknown): CellValue => v as CellValue;
let n = 0;

function fileWith(doc: TableDocLike): string {
  const abs = path.join(dir, `audit-${n++}.sqlite`);
  writeDocFile(abs, doc, { nodeId: `audit-${n}`, ownerId: 'owner-a' });
  return abs;
}

function baseDoc(): TableDocLike {
  return {
    columns: [
      { id: 'c1', name: 'Item', type: 'text' },
      { id: 'c2', name: 'Total', type: 'formula', formula: 'c1' },
    ],
    rows: [
      { id: 'r1', cells: { c1: 'Widget' } },
      { id: 'r2', cells: { c1: 'Gadget' } },
    ],
    aggregates: {},
    views: [],
  };
}

function physicalColumns(abs: string, table: string): string[] {
  const db = openTableFile(abs, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
  } finally {
    db.close();
  }
}

function physicalTableOf(abs: string): string {
  const db = openTableFile(abs, { readOnly: true });
  try {
    return String(
      db.prepare(`SELECT physical_table FROM _tabs ORDER BY position LIMIT 1`).get()!
        .physical_table,
    );
  } finally {
    db.close();
  }
}

describe('formula ↔ stored retypes are DDL', () => {
  it('formula → text adds the physical column; the file stays readable', () => {
    const abs = fileWith(baseDoc());
    applyOpsToFile(
      abs,
      [{ op: 'column_update', columnId: 'c2', patch: { type: 'text', formula: null } }],
      coerce,
    );
    // Pre-fix this threw `no such column` on every read from here on.
    const doc = readDocFile(abs);
    expect(doc.columns.find((c) => c.id === 'c2')!.type).toBe('text');
    expect(doc.rows.map((r) => r.cells.c2 ?? null)).toEqual([null, null]);
    const table = physicalTableOf(abs);
    expect(physicalColumns(abs, table)).toContain('c_c2');
    // And the retyped column accepts writes.
    applyOpsToFile(abs, [{ op: 'cell_set', rowId: 'r1', columnId: 'c2', value: 'hello' }], coerce);
    expect(readDocFile(abs).rows[0]!.cells.c2).toBe('hello');
  });

  it('text → formula drops the physical column and the view survives', () => {
    const abs = fileWith({
      columns: [
        { id: 'c1', name: 'Item', type: 'text' },
        { id: 'c2', name: 'Note', type: 'text' },
      ],
      rows: [{ id: 'r1', cells: { c1: 'Widget', c2: 'x' } }],
      aggregates: {},
      views: [],
    });
    applyOpsToFile(
      abs,
      [{ op: 'column_update', columnId: 'c2', patch: { type: 'formula', formula: 'c1' } }],
      coerce,
    );
    const doc = readDocFile(abs);
    expect(doc.columns.find((c) => c.id === 'c2')!.type).toBe('formula');
    // Doc semantics: formula cells are never stored.
    expect(doc.rows[0]!.cells.c2).toBeUndefined();
    const table = physicalTableOf(abs);
    expect(physicalColumns(abs, table)).not.toContain('c_c2');
    // The display view must not project the dropped column.
    const db = openTableFile(abs, { readOnly: true });
    try {
      expect(() => db.prepare(`SELECT * FROM "Sheet1"`).all()).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('column_update: explicit null clears a property', () => {
  it('clears width, format, options and formula; absent keys keep values', () => {
    const abs = fileWith({
      columns: [
        {
          id: 'c1',
          name: 'Qty',
          type: 'number',
          width: 240,
          format: { decimals: 2 },
          options: [{ id: 'o1', label: 'legacy' }],
        },
      ],
      rows: [],
      aggregates: {},
      views: [],
    });
    // Absent keys: nothing changes.
    applyOpsToFile(
      abs,
      [{ op: 'column_update', columnId: 'c1', patch: { name: 'Quantity' } }],
      coerce,
    );
    let col = readDocFile(abs).columns[0]!;
    expect(col.width).toBe(240);
    expect(col.format).toEqual({ decimals: 2 });
    // Explicit nulls: cleared.
    applyOpsToFile(
      abs,
      [
        {
          op: 'column_update',
          columnId: 'c1',
          patch: { width: null, format: null, options: null },
        },
      ],
      coerce,
    );
    col = readDocFile(abs).columns[0]!;
    expect(col.width).toBeUndefined();
    expect(col.format).toBeUndefined();
    expect(col.options === undefined || col.options.length === 0).toBe(true);
  });
});

describe('row_add atStart', () => {
  it('inserts at the front; afterRowId null still appends', () => {
    const abs = fileWith({
      columns: [{ id: 'c1', name: 'Item', type: 'text' }],
      rows: [
        { id: 'a', cells: { c1: 'A' } },
        { id: 'b', cells: { c1: 'B' } },
      ],
      aggregates: {},
      views: [],
    });
    applyOpsToFile(abs, [{ op: 'row_add', rowId: 'front', atStart: true }], coerce);
    applyOpsToFile(abs, [{ op: 'row_add', rowId: 'tail', afterRowId: null }], coerce);
    expect(readDocFile(abs).rows.map((r) => r.id)).toEqual(['front', 'a', 'b', 'tail']);
  });

  it('repeated front inserts stack newest-first without colliding positions', () => {
    const abs = fileWith({
      columns: [{ id: 'c1', name: 'Item', type: 'text' }],
      rows: [{ id: 'a', cells: { c1: 'A' } }],
      aggregates: {},
      views: [],
    });
    for (let i = 1; i <= 12; i++) {
      applyOpsToFile(abs, [{ op: 'row_add', rowId: `f${i}`, atStart: true }], coerce);
    }
    const ids = readDocFile(abs).rows.map((r) => r.id);
    expect(ids[0]).toBe('f12');
    expect(ids[ids.length - 1]).toBe('a');
    expect(ids).toHaveLength(13);
  });
});

describe('view names vs the engine namespace', () => {
  it('a tab literally named like a physical table gets a suffixed view instead of failing', () => {
    const abs = path.join(dir, `audit-collide-${n++}.sqlite`);
    // Tab 1's physical table is t_t1 (id t1) — tab 2 is NAMED "t_t1".
    expect(() =>
      writeDocFile(
        abs,
        {
          tabs: [
            {
              id: 't1',
              name: 'First',
              columns: [{ id: 'c1', name: 'A', type: 'text' }],
              rows: [{ id: 'r1', cells: { c1: 'x' } }],
            },
            {
              id: 't2',
              name: 't_t1',
              columns: [{ id: 'c2', name: 'B', type: 'text' }],
              rows: [],
            },
          ],
        },
        { nodeId: 'audit-collide', ownerId: 'owner-a' },
      ),
    ).not.toThrow();
    const db = openTableFile(abs, { readOnly: true });
    try {
      const views = (
        db.prepare(`SELECT view_name FROM _tabs ORDER BY position`).all() as unknown as {
          view_name: string;
        }[]
      ).map((v) => v.view_name);
      expect(views[0]).toBe('First');
      expect(views[1]).not.toBe('t_t1'); // suffixed away from the physical table
      expect(() => db.prepare(`SELECT * FROM "${views[1]}"`).all()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('tab_rename to an engine table name suffixes via uniqueViewName', () => {
    const abs = fileWith(baseDoc());
    applyOpsToFile(abs, [{ op: 'tab_add', name: 'Extra' }], coerce);
    const db0 = openTableFile(abs, { readOnly: true });
    const tabs = db0
      .prepare(`SELECT tab_id, physical_table FROM _tabs ORDER BY position`)
      .all() as unknown as {
      tab_id: string;
      physical_table: string;
    }[];
    db0.close();
    const firstPhysical = tabs[0]!.physical_table;
    applyOpsToFile(
      abs,
      [{ op: 'tab_rename', tabId: tabs[1]!.tab_id, name: firstPhysical }],
      coerce,
    );
    const db = openTableFile(abs, { readOnly: true });
    try {
      const renamed = db
        .prepare(`SELECT view_name FROM _tabs WHERE tab_id = ?`)
        .get(tabs[1]!.tab_id) as { view_name: string };
      expect(renamed.view_name).not.toBe(firstPhysical);
      expect(() => db.prepare(`SELECT * FROM "${renamed.view_name}"`).all()).not.toThrow();
    } finally {
      db.close();
    }
  });
});
