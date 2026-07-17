import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { describeWorkbook, writeDocFile } from './engine';
import type { TableDocLike } from './doc-types';
import { quoteFtsTerm } from './fts';
import { profileFile, profileToText, sampleRows } from './profile';
import { assertReadOnlySelect, runTableSql, stripLiterals } from './sql-runner';
import { openTableFile } from './sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-p2-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const META = { nodeId: 'node-1', ownerId: 'owner-1' };

function circuitDoc(rows = 40): TableDocLike {
  const statuses = ['Active', 'Retired', 'Active', 'Active', 'On hold'];
  return {
    columns: [
      { id: 'c-tag', name: 'Circuit', type: 'text' },
      { id: 'c-status', name: 'Status', type: 'select' },
      { id: 'c-press', name: 'Design Pressure', type: 'number' },
      { id: 'c-insp', name: 'Last Inspection', type: 'date' },
      { id: 'c-notes', name: 'Notes', type: 'text' },
    ],
    rows: Array.from({ length: rows }, (_, i) => ({
      id: `r${i}`,
      cells: {
        'c-tag': `CIR-${String(100 + i)}`,
        'c-status': statuses[i % statuses.length]!,
        'c-press': 100 + i * 5,
        'c-insp': `2026-0${1 + (i % 6)}-15`,
        'c-notes':
          i % 7 === 0
            ? 'Long-form inspection narrative describing corrosion findings, wall thickness readings, and the recommended remediation schedule for this circuit.'
            : `ok ${i}`,
      },
    })),
  };
}

function published(name: string, doc = circuitDoc()): string {
  const file = path.join(dir, `${name}.sqlite`);
  writeDocFile(file, doc, { ...META, fts: true, tabName: 'Circuits' });
  return file;
}

describe('FTS shadows on published writes', () => {
  it('creates a trigram shadow queryable via MATCH (quoted) and LIKE', () => {
    const file = published('fts');
    const tabs = describeWorkbook(file);
    expect(tabs[0]!.ftsTable).toBe(`${tabs[0]!.physicalTable}_fts`);
    const db = openTableFile(file, { readOnly: true });
    try {
      const hits = db
        .prepare(`SELECT rowid FROM ${tabs[0]!.ftsTable} WHERE ${tabs[0]!.ftsTable} MATCH ?`)
        .all(quoteFtsTerm('CIR-105'));
      expect(hits).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('draft writes (fts unset) carry no shadow', () => {
    const file = path.join(dir, 'nofts.sqlite');
    writeDocFile(file, circuitDoc(), META);
    expect(describeWorkbook(file)[0]!.ftsTable).toBeNull();
  });

  it('triggers keep the shadow current after row mutations', () => {
    const file = published('fts-trig');
    const tabs = describeWorkbook(file)[0]!;
    const db = openTableFile(file);
    try {
      db.exec(
        `UPDATE ${tabs.physicalTable} SET c_c_notes = 'zebra quagga finding' WHERE _rid = 'r1'`,
      );
      const hits = db
        .prepare(`SELECT rowid FROM ${tabs.ftsTable} WHERE ${tabs.ftsTable} MATCH ?`)
        .all(quoteFtsTerm('zebra quagga'));
      expect(hits).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('L1 profile', () => {
  it('profiles types, distincts, ranges, top values, prose', () => {
    const file = published('profile');
    const [tab] = profileFile(file);
    expect(tab!.rowCount).toBe(40);
    const byName = Object.fromEntries(tab!.columns.map((c) => [c.name, c]));
    expect(byName['Status']!.distinctCount).toBe(3);
    expect(byName['Status']!.topValues[0]!.value).toBe('Active');
    expect(byName['Design Pressure']!.min).toBe(100);
    expect(byName['Design Pressure']!.max).toBe(295);
    expect(byName['Last Inspection']!.min).toBe('2026-01-15');
    expect(byName['Last Inspection']!.mixedDates).toBeUndefined();
    expect(byName['Notes']!.prose).toBeUndefined(); // mostly short values
    expect(byName['Circuit']!.distinctCount).toBe(40);
    expect(byName['Circuit']!.identifierLike).toBe(true);
    expect(byName['Circuit']!.topValues).toEqual([]); // identifier column — no value dump

    const text = profileToText([tab!], { title: 'Circuit Register' });
    expect(text).toContain('# Circuit Register — table profile');
    expect(text).toContain('## Circuits — 40 rows');
    expect(text).toContain('Status (select)');
    expect(text).toContain('Active (24)');
    expect(text).not.toContain('CIR-103'); // profile carries top distincts, never row dumps
    expect(text).toContain('identifier-like');
  });

  it('flags mixed date formats', () => {
    const doc: TableDocLike = {
      columns: [{ id: 'd', name: 'When', type: 'date' }],
      rows: [
        { id: 'r1', cells: { d: '2026-07-15' } },
        { id: 'r2', cells: { d: 'sometime next week' } },
      ],
    };
    const file = path.join(dir, 'mixed.sqlite');
    writeDocFile(file, doc, META);
    const [tab] = profileFile(file);
    expect(tab!.columns[0]!.mixedDates).toBe(true);
    expect(profileToText([tab!], { title: 'X' })).toContain('MIXED DATE FORMATS');
  });

  it('sampleRows returns a stratified slice in doc shape', () => {
    const file = published('sample');
    const [tab] = sampleRows(file, 10);
    expect(tab!.rows.length).toBe(10);
    expect(tab!.rows[0]!.id).toBe('r0');
    expect(tab!.rows[0]!.cells['c-tag']).toBe('CIR-100');
    // every 4th of 40 rows
    expect(tab!.rows[1]!.id).toBe('r4');
  });
});

describe('table_sql runner', () => {
  it('rejects writes, multi-statements, and blocked verbs with teach messages', () => {
    expect(() => assertReadOnlySelect('DELETE FROM t')).toThrow(/read-only/);
    expect(() => assertReadOnlySelect('SELECT 1; SELECT 2')).toThrow(/one statement/);
    expect(() => assertReadOnlySelect('SELECT 1 FROM pragma_table_info(1)')).toThrow(/PRAGMA/);
    expect(() => assertReadOnlySelect("ATTACH DATABASE '/x' AS y")).toThrow(/read-only/);
    // a blocked verb hidden in a string literal is FINE (it's data)
    expect(assertReadOnlySelect("SELECT 'pragma attach' AS s")).toBe("SELECT 'pragma attach' AS s");
    expect(stripLiterals("SELECT '; attach' -- pragma")).not.toMatch(/attach|pragma/i);
  });

  it('runs a query against the display-named view with a row cap', async () => {
    const file = published('sql');
    const r = await runTableSql(
      file,
      `SELECT "Circuit", "Status" FROM "Circuits" WHERE "Status" = 'On hold' ORDER BY "Circuit"`,
    );
    expect(r.columns).toEqual(['Circuit', 'Status']);
    expect(r.rowCount).toBe(8);
    expect(r.truncated).toBe(false);
    expect(r.rows[0]).toEqual(['CIR-104', 'On hold']);
  });

  it('truncates at the cap and says so', async () => {
    const file = published('sql-cap');
    const r = await runTableSql(file, `SELECT "Circuit" FROM "Circuits"`, { cap: 5 });
    expect(r.rowCount).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('surfaces SQL errors from the worker', async () => {
    const file = published('sql-err');
    await expect(runTableSql(file, 'SELECT nope FROM missing')).rejects.toThrow(/missing/);
  });

  it('watchdog kills a runaway query', async () => {
    const file = published('sql-slow', circuitDoc(400));
    process.env.TABLE_SQL_TIMEOUT_MS = '300';
    try {
      await expect(
        runTableSql(
          file,
          `SELECT count(*) FROM "Circuits" a, "Circuits" b, "Circuits" c, "Circuits" d`,
        ),
      ).rejects.toThrow(/killed/);
    } finally {
      delete process.env.TABLE_SQL_TIMEOUT_MS;
    }
  });
});
