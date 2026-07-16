import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  fileStats,
  readDocFile,
  shapeHashOf,
  snapshotFile,
  writeDocFile,
} from './engine';
import type { TableDocLike } from './doc-types';
import { normalizeDate } from './cells';
import { TableFileMissingError, openTableFile } from './sqlite';
import { dedupe, physicalName } from './names';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-engine-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-1', ownerId: 'owner-1' };

function sampleDoc(): TableDocLike {
  return {
    columns: [
      { id: 'c-name', name: 'Name', type: 'text' },
      { id: 'c-qty', name: 'Qty', type: 'number' },
      { id: 'c-price', name: 'Price', type: 'currency', format: { currency: 'USD', decimals: 2 } },
      { id: 'c-done', name: 'Done', type: 'checkbox' },
      { id: 'c-due', name: 'Due', type: 'date' },
      { id: 'c-tags', name: 'Tags', type: 'multiselect', options: [{ id: 'a', label: 'A' }] },
      { id: 'c-total', name: 'Total', type: 'formula', formula: '{Qty} * {Price}' },
    ],
    rows: [
      {
        id: 'r1',
        cells: {
          'c-name': 'Widget',
          'c-qty': 3,
          'c-price': 9.5,
          'c-done': true,
          'c-due': '2026-07-15',
          'c-tags': ['a', 'b'],
        },
      },
      { id: 'r2', cells: { 'c-name': 'Gadget', 'c-qty': 1 } },
      { id: 'r3', cells: {} },
    ],
    aggregates: { 'c-qty': 'sum' },
    views: [{ id: 'v1', name: 'Open', filters: [{ colId: 'c-done', op: 'neq', value: true }] }],
  };
}

describe('writeDocFile / readDocFile round-trip', () => {
  it('preserves columns, rows, order, aggregates, and views', () => {
    const file = path.join(dir, 'rt.sqlite');
    const res = writeDocFile(file, sampleDoc(), META);
    expect(res.sizeBytes).toBeGreaterThan(0);
    expect(res.stats).toEqual({
      tabs: [{ tabId: 't1', name: 'Sheet1', rows: 3, columns: 7 }],
      totalRows: 3,
    });

    const doc = readDocFile(file);
    expect(doc.columns).toEqual(sampleDoc().columns);
    expect(doc.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(doc.rows[0]!.cells).toEqual({
      'c-name': 'Widget',
      'c-qty': 3,
      'c-price': 9.5,
      'c-done': true,
      'c-due': '2026-07-15',
      'c-tags': ['a', 'b'],
    });
    expect(doc.rows[1]!.cells).toEqual({ 'c-name': 'Gadget', 'c-qty': 1 });
    expect(doc.rows[2]!.cells).toEqual({});
    expect(doc.aggregates).toEqual({ 'c-qty': 'sum' });
    expect(doc.views).toEqual(sampleDoc().views);
  });

  it('atomically replaces an existing file (rebuild-over)', () => {
    const file = path.join(dir, 'replace.sqlite');
    writeDocFile(file, sampleDoc(), META);
    const smaller: TableDocLike = { columns: [{ id: 'c1', name: 'Only', type: 'text' }], rows: [] };
    writeDocFile(file, smaller, META);
    const doc = readDocFile(file);
    expect(doc.columns).toHaveLength(1);
    expect(doc.rows).toHaveLength(0);
  });

  it('stores date text VERBATIM — migration must never mutate cells', () => {
    const file = path.join(dir, 'dates.sqlite');
    const doc: TableDocLike = {
      columns: [{ id: 'd', name: 'When', type: 'date' }],
      rows: [
        { id: 'r1', cells: { d: '07/03/2026' } },
        { id: 'r2', cells: { d: '2026-07-15T10:30:00' } },
        { id: 'r3', cells: { d: 'not a date' } },
      ],
    };
    writeDocFile(file, doc, META);
    const back = readDocFile(file);
    expect(back.rows[0]!.cells.d).toBe('07/03/2026');
    expect(back.rows[1]!.cells.d).toBe('2026-07-15T10:30:00');
    expect(back.rows[2]!.cells.d).toBe('not a date');
  });

  it('exposes a display-named SQL view over the tab', () => {
    const file = path.join(dir, 'view.sqlite');
    writeDocFile(file, sampleDoc(), { ...META, tabName: 'Inventory' });
    const db = openTableFile(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT "Name", "Qty" FROM "Inventory" ORDER BY _pos`).all();
      expect(rows[0]).toEqual({ Name: 'Widget', Qty: 3 });
      // formula column is omitted from the P1 view
      expect(() => db.prepare(`SELECT "Total" FROM "Inventory"`).all()).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('durability posture', () => {
  it('read paths never create: missing file throws TableFileMissingError', () => {
    const missing = path.join(dir, 'nope.sqlite');
    expect(() => readDocFile(missing)).toThrow(TableFileMissingError);
    expect(existsSync(missing)).toBe(false); // and did NOT self-heal an empty one
  });

  it('materializer refuses past maxRows', () => {
    const file = path.join(dir, 'big.sqlite');
    const doc: TableDocLike = {
      columns: [{ id: 'c1', name: 'N', type: 'number' }],
      rows: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, cells: { c1: i } })),
    };
    writeDocFile(file, doc, META);
    expect(() => readDocFile(file, { maxRows: 10 })).toThrow(TableTooLargeError);
    expect(readDocFile(file, { maxRows: 50 }).rows).toHaveLength(50);
    expect(MATERIALIZE_MAX).toBe(10_000);
  });

  it('snapshotFile produces a standalone readable copy', () => {
    const file = path.join(dir, 'snap-src.sqlite');
    writeDocFile(file, sampleDoc(), META);
    const dest = path.join(dir, 'backups', 'snap.sqlite');
    snapshotFile(file, dest);
    const doc = readDocFile(dest);
    expect(doc.rows).toHaveLength(3);
  });
});

describe('stats + shape hash', () => {
  it('fileStats counts without materializing', () => {
    const file = path.join(dir, 'stats.sqlite');
    writeDocFile(file, sampleDoc(), META);
    expect(fileStats(file)).toEqual({
      tabs: [{ tabId: 't1', name: 'Sheet1', rows: 3, columns: 7 }],
      totalRows: 3,
    });
  });

  it('shapeHash ignores cell edits, changes on schema/order-of-magnitude', () => {
    const a = sampleDoc();
    const b = sampleDoc();
    b.rows[0]!.cells['c-name'] = 'Edited';
    expect(shapeHashOf(a)).toBe(shapeHashOf(b));

    const renamed = sampleDoc();
    renamed.columns[0]!.name = 'Renamed';
    expect(shapeHashOf(renamed)).not.toBe(shapeHashOf(a));

    const grown = sampleDoc();
    grown.rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, cells: {} }));
    expect(shapeHashOf(grown)).not.toBe(shapeHashOf(a)); // 3 → 30 crosses a bucket
  });
});

describe('naming hygiene', () => {
  it('dedupes colliding physical names deterministically', () => {
    expect(dedupe([physicalName('c', 'a-b'), physicalName('c', 'a_b')])).toEqual([
      'c_a_b',
      'c_a_b_2',
    ]);
  });

  it('handles duplicate display names and hostile identifiers in views', () => {
    const file = path.join(dir, 'hostile.sqlite');
    const doc: TableDocLike = {
      columns: [
        { id: 'c1', name: 'Amount', type: 'number' },
        { id: 'c2', name: 'amount', type: 'text' },
        { id: 'c3', name: '_pos"; DROP TABLE t; --', type: 'text' },
      ],
      rows: [{ id: 'r1', cells: { c1: 5, c2: 'five', c3: 'x' } }],
    };
    writeDocFile(file, doc, { ...META, tabName: 'Weird "Tab"' });
    const back = readDocFile(file);
    expect(back.columns.map((c) => c.name)).toEqual([
      'Amount',
      'amount',
      '_pos"; DROP TABLE t; --',
    ]);
    const db = openTableFile(file, { readOnly: true });
    try {
      const row = db.prepare(`SELECT "Amount", "amount_2" FROM "Weird ""Tab""" LIMIT 1`).get();
      expect(row).toEqual({ Amount: 5, amount_2: 'five' });
    } finally {
      db.close();
    }
  });
});

describe('normalizeDate', () => {
  it('covers the common shapes', () => {
    expect(normalizeDate('2026-07-15', false)).toBe('2026-07-15');
    expect(normalizeDate('2026-07-15 10:30:00', true)).toBe('2026-07-15T10:30:00');
    expect(normalizeDate('July 3, 2026', false)).toBe('2026-07-03');
    expect(normalizeDate('garbage', false)).toBeNull();
  });
});
