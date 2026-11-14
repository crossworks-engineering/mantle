/**
 * patchDocFile, the one way to change some tabs of a file written whole:
 *  - a patch adds a tab and sets `_meta` keys; every other tab, its rows,
 *    its search shadow, its view and the other `_meta` keys are the same,
 *    row for row (and the kept tables' pages hold the same rows);
 *  - a second patch replaces the tab; the same input twice gives the same
 *    content;
 *  - a failure at any step leaves the file byte for byte as it was, and
 *    no build file is left beside it;
 *  - the file stays in DELETE journal mode, with no -wal beside it;
 *  - a write that lands during the patch (a new database renamed over the
 *    old one) stays: the patch throws and puts nothing back.
 * Made-up rows only.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { describeWorkbook, patchDocFile, readDocMeta, writeDocFile } from './engine';
import type { WorkbookTabDoc } from './doc-types';
import { openTableFile } from './sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-patch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STAMP = {
  pipeline_id: 'drawing-pdf',
  pipeline_version: '1.0.0',
  pipeline_api: '1',
  shapes: 'pdf-file-v1',
};

/** A made-up drawing database: the texts, and a File tab whose rows a
 *  model paid for (the kind answer). */
function base(name: string): string {
  const abs = path.join(dir, name);
  writeDocFile(
    abs,
    {
      tabs: [
        {
          id: 't1',
          name: 'Texts',
          columns: [
            { id: 'c1', name: 'Page', type: 'number' },
            { id: 'c2', name: 'Text', type: 'text' },
          ],
          rows: [
            { id: 'r1', cells: { c1: 1, c2: 'FIC-101 FLOW' } },
            { id: 'r2', cells: { c1: 1, c2: 'P-1001-A1A' } },
            { id: 'r3', cells: { c1: 2, c2: 'EA-101 COOLER' } },
          ],
        },
        {
          id: 't2',
          name: 'File',
          columns: [
            { id: 'k1', name: 'Kind', type: 'text' },
            { id: 'k2', name: 'Decider answer', type: 'text' },
          ],
          rows: [{ id: 'f1', cells: { k1: 'pid', k2: 'a made-up paid answer' } }],
        },
      ],
    },
    {
      nodeId: 'node-1',
      ownerId: 'owner-1',
      fts: true,
      deleteJournal: true,
      extraMeta: { description: 'A made-up drawing.', ...STAMP },
    },
  );
  return abs;
}

const tagsTab = (rows: [string, string][], id = 'r'): WorkbookTabDoc => ({
  name: 'Site tags',
  columns: [
    { id: 'g1', name: 'Tag', type: 'text' },
    { id: 'g2', name: 'Type', type: 'text' },
  ],
  rows: rows.map(([tag, type], i) => ({ id: `${id}${i}`, cells: { g1: tag, g2: type } })),
  aggregates: {},
  views: [],
});

/** Every row of every table and view the patch must not touch, by name:
 *  the kept tabs' data, their FTS shadow tables, `_tabs`, `_columns` and
 *  `_meta` rows, and the schema text of every kept object. */
function keptDump(abs: string, replaced: readonly string[] = ['Site tags']) {
  const db = openTableFile(abs, { readOnly: true });
  try {
    const gone = new Set(
      db
        .prepare(`SELECT tab_id FROM _tabs WHERE name IN (${replaced.map(() => '?').join(',')})`)
        .all(...replaced)
        .map((r) => String(r.tab_id)),
    );
    const physicalGone = [...gone].map((id) => `t_${id}`);
    // t_t3, t_t3_fts*, t_t3_pos, sqlite_autoindex_t_t3_1: not t_t30.
    const isGone = (name: string) =>
      physicalGone.some((p) => new RegExp(`(^|_)${p}(_|$)`).test(name));
    const objects = db
      .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
      .all()
      .filter((o) => !isGone(String(o.name)) && String(o.name) !== 'Site tags');
    const tables: Record<string, unknown[]> = {};
    for (const o of objects) {
      if (o.type !== 'table' || String(o.name).startsWith('sqlite_')) continue;
      const name = String(o.name);
      if (name === '_meta') {
        tables[name] = db
          .prepare(`SELECT * FROM _meta WHERE k != 'pipelines_after' ORDER BY k`)
          .all();
      } else if (['_tabs', '_columns', '_views', '_aggregates'].includes(name)) {
        tables[name] = db
          .prepare(`SELECT * FROM ${name} ORDER BY 1, 2`)
          .all()
          .filter((r) => !gone.has(String(r.tab_id)));
      } else {
        // A virtual table's rows are its shadow tables' rows, dumped there.
        if (String(o.sql ?? '').startsWith('CREATE VIRTUAL')) continue;
        // A WITHOUT ROWID table (two of FTS5's) is in its key order.
        const withoutRowid = /WITHOUT ROWID\s*$/i.test(String(o.sql ?? ''));
        tables[name] = db
          .prepare(
            withoutRowid
              ? `SELECT * FROM "${name}"`
              : `SELECT rowid AS _rowid_, * FROM "${name}" ORDER BY rowid`,
          )
          .all();
      }
    }
    return { objects, tables };
  } finally {
    db.close();
  }
}

const search = (abs: string, physical: string, term: string) => {
  const db = openTableFile(abs, { readOnly: true });
  try {
    return Number(
      db
        .prepare(`SELECT count(*) AS n FROM ${physical}_fts WHERE ${physical}_fts MATCH ?`)
        .get(`"${term}"`)?.n,
    );
  } finally {
    db.close();
  }
};

const tabOf = (abs: string, name: string) => describeWorkbook(abs).find((t) => t.name === name);
const builds = () => readdirSync(dir).filter((f) => f.includes('.build-'));

describe('patchDocFile', () => {
  it('adds a tab and the meta key; everything else is the same, row for row', () => {
    const abs = base('add.sqlite');
    const before = keptDump(abs);
    expect(search(abs, 't_t1', 'FIC-101')).toBe(1);

    patchDocFile(abs, {
      replaceTabs: ['Site tags'],
      tabs: [tagsTab([['FIC-101', 'instrument']])],
      setMeta: { pipelines_after: 'site-tags@1.0.0' },
    });

    expect(keptDump(abs)).toEqual(before);
    expect(describeWorkbook(abs).map((t) => t.name)).toEqual(['Texts', 'File', 'Site tags']);
    expect(tabOf(abs, 'Site tags')?.rowCount).toBe(1);
    // The old search still finds its text; the new tab has its own shadow.
    expect(search(abs, 't_t1', 'FIC-101')).toBe(1);
    expect(search(abs, tabOf(abs, 'Site tags')!.physicalTable, 'FIC-101')).toBe(1);
    expect(readDocMeta(abs, ['pipeline_id', 'pipelines_after', 'description'])).toEqual({
      ...{ pipeline_id: 'drawing-pdf', pipelines_after: 'site-tags@1.0.0' },
      description: 'A made-up drawing.',
    });
    expect(builds()).toEqual([]);
  });

  it('a second patch replaces the tab; the same input twice gives the same content', () => {
    const abs = base('again.sqlite');
    const before = keptDump(abs);
    const one = { replaceTabs: ['Site tags'], setMeta: { pipelines_after: 'site-tags@1.0.0' } };
    patchDocFile(abs, {
      ...one,
      tabs: [
        tagsTab([
          ['P-1', 'equipment'],
          ['P-2', 'equipment'],
        ]),
      ],
    });
    expect(tabOf(abs, 'Site tags')?.rowCount).toBe(2);

    patchDocFile(abs, { ...one, tabs: [tagsTab([['FIC-101', 'instrument']])] });
    const first = keptDump(abs, []);
    expect(tabOf(abs, 'Site tags')?.rowCount).toBe(1);
    expect(search(abs, tabOf(abs, 'Site tags')!.physicalTable, 'P-1')).toBe(0);
    patchDocFile(abs, { ...one, tabs: [tagsTab([['FIC-101', 'instrument']])] });
    // The whole file content, the new tab included: the same as after the
    // first patch of this input.
    expect(keptDump(abs, [])).toEqual(first);
    expect(keptDump(abs)).toEqual(before);
    expect(describeWorkbook(abs).filter((t) => t.name === 'Site tags')).toHaveLength(1);
  });

  it('a name in replaceTabs with no new tab only removes the tab', () => {
    const abs = base('remove.sqlite');
    const before = keptDump(abs);
    const meta = { pipelines_after: 'site-tags@1.0.0' };
    patchDocFile(abs, {
      replaceTabs: ['Site tags'],
      tabs: [tagsTab([['P-1', 'x']])],
      setMeta: meta,
    });
    patchDocFile(abs, { replaceTabs: ['Site tags'], tabs: [], setMeta: meta });
    expect(tabOf(abs, 'Site tags')).toBeUndefined();
    expect(keptDump(abs)).toEqual(before);
  });

  it('leaves the file in DELETE journal mode, with no -wal or -shm beside it', () => {
    const abs = base('journal.sqlite');
    patchDocFile(abs, { replaceTabs: ['Site tags'], tabs: [tagsTab([['P-1', 'x']])], setMeta: {} });
    expect(existsSync(`${abs}-wal`)).toBe(false);
    expect(existsSync(`${abs}-shm`)).toBe(false);
    // Bytes 18 and 19 of the header: 1 is the rollback journal, 2 is WAL.
    const head = readFileSync(abs).subarray(18, 20);
    expect([...head]).toEqual([1, 1]);
  });

  describe('a database that changes during the patch', () => {
    it('is kept as the new one, byte for byte, and the patch throws', () => {
      const abs = base('changed.sqlite');
      // A read rebuilds the database after the patch's copy: a whole new
      // file renamed over the old one, as writeDocFile does.
      const rebuilt = base('changed-rebuilt.sqlite');
      let bytes: Buffer | undefined;
      const swap = () => {
        renameSync(rebuilt, abs);
        bytes = readFileSync(abs);
        writeFileSync(`${abs}-wal`, 'a made-up sidecar');
      };
      expect(() =>
        patchDocFile(
          abs,
          {
            replaceTabs: ['Site tags'],
            tabs: [tagsTab([['FIC-101', 'instrument']])],
            setMeta: { pipelines_after: 'site-tags@1.0.0' },
          },
          { beforeSwap: swap },
        ),
      ).toThrow('the database changed during the patch');
      expect(readFileSync(abs).equals(bytes!)).toBe(true);
      // A refused patch touches nothing of the original, its sidecars too.
      expect(readFileSync(`${abs}-wal`, 'utf8')).toBe('a made-up sidecar');
      rmSync(`${abs}-wal`);
      expect(tabOf(abs, 'Site tags')).toBeUndefined();
      expect(builds()).toEqual([]);
    });

    it('refuses when the caller read the file before a rebuild', () => {
      const abs = base('since.sqlite');
      const rebuilt = base('since-rebuilt.sqlite');
      // The caller takes the mark, reads its input, and a read rebuilds
      // the database before the patch starts.
      const since = statSync(abs);
      renameSync(rebuilt, abs);
      const bytes = readFileSync(abs);
      expect(() =>
        patchDocFile(abs, {
          since,
          replaceTabs: ['Site tags'],
          tabs: [tagsTab([['FIC-101', 'instrument']])],
          setMeta: { pipelines_after: 'site-tags@1.0.0' },
        }),
      ).toThrow('the database changed during the patch');
      expect(readFileSync(abs).equals(bytes)).toBe(true);
      expect(tabOf(abs, 'Site tags')).toBeUndefined();
      expect(builds()).toEqual([]);
    });

    it('a file that did not change is patched as before', () => {
      const abs = base('unchanged.sqlite');
      let called = false;
      patchDocFile(
        abs,
        {
          replaceTabs: ['Site tags'],
          tabs: [tagsTab([['FIC-101', 'instrument']])],
          setMeta: { pipelines_after: 'site-tags@1.0.0' },
        },
        {
          beforeSwap: () => {
            called = true;
          },
        },
      );
      expect(called).toBe(true);
      expect(tabOf(abs, 'Site tags')?.rowCount).toBe(1);
      expect(builds()).toEqual([]);
    });
  });

  describe('a failure leaves the file as it was, and no build file', () => {
    const cases: [string, Parameters<typeof patchDocFile>[1]][] = [
      [
        'a reserved meta key',
        { replaceTabs: ['Site tags'], tabs: [], setMeta: { node_id: 'other' } },
      ],
      [
        'a tab the patch does not replace (a reader tab)',
        { replaceTabs: ['Site tags'], tabs: [{ ...tagsTab([]), name: 'Texts' }], setMeta: {} },
      ],
      [
        'a tab named twice',
        { replaceTabs: ['Site tags'], tabs: [tagsTab([]), tagsTab([])], setMeta: {} },
      ],
      [
        // Two rows with one id fail the insert inside the transaction,
        // after the old tab was dropped in the copy.
        'an insert that fails half way',
        {
          replaceTabs: ['Site tags', 'File'],
          tabs: [
            {
              ...tagsTab([
                ['A-1', 'x'],
                ['A-2', 'x'],
              ]),
              rows: [
                { id: 'same', cells: { g1: 'A-1' } },
                { id: 'same', cells: { g1: 'A-2' } },
              ],
            },
          ],
          setMeta: { pipelines_after: 'site-tags@1.0.0' },
        },
      ],
    ];
    it.each(cases)('%s', (_label, patch) => {
      const abs = base(`fail-${builds().length}-${Math.random().toString(36).slice(2)}.sqlite`);
      // A tab of an earlier patch, so a failed patch has one to lose.
      patchDocFile(abs, {
        replaceTabs: ['Site tags'],
        tabs: [tagsTab([['FIC-101', 'instrument']])],
        setMeta: { pipelines_after: 'site-tags@1.0.0' },
      });
      const bytes = readFileSync(abs);
      expect(() => patchDocFile(abs, patch)).toThrow();
      expect(readFileSync(abs).equals(bytes)).toBe(true);
      expect(builds()).toEqual([]);
    });

    it('a file that is not a database', () => {
      const abs = path.join(dir, 'not-a-db.sqlite');
      writeFileSync(abs, 'not a database at all, made up');
      const bytes = readFileSync(abs);
      expect(() =>
        patchDocFile(abs, { replaceTabs: ['Site tags'], tabs: [tagsTab([])], setMeta: {} }),
      ).toThrow();
      expect(readFileSync(abs).equals(bytes)).toBe(true);
      expect(builds()).toEqual([]);
    });

    it('no file at all', () => {
      const abs = path.join(dir, 'gone.sqlite');
      expect(() =>
        patchDocFile(abs, { replaceTabs: ['Site tags'], tabs: [], setMeta: {} }),
      ).toThrow();
      expect(existsSync(abs)).toBe(false);
      expect(builds()).toEqual([]);
    });
  });
});
