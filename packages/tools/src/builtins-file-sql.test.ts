/**
 * file_sql's answers, each in its place in the order: a file meets the first one
 * that holds. The database and the refusal are stood in here; they are real in
 * server/web/server/file-sql.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const ROOT = '/data/files';
const ABS = `${ROOT}/.file-dbs/${FILE_ID}.${SHA.slice(0, 16)}.sqlite`;

const h = vi.hoisted(() => ({
  fileDataRow: vi.fn(),
  fileDataRefusal: vi.fn(),
  fileDbSqlitePath: vi.fn(),
  filesRootMounted: vi.fn(),
  loadFileHead: vi.fn(),
  readFileDbNone: vi.fn(),
  tableNamingFile: vi.fn(),
  runTableSql: vi.fn(),
  describeWorkbook: vi.fn(),
}));
vi.mock('@mantle/files', () => ({
  fileDataRow: h.fileDataRow,
  fileDataRefusal: h.fileDataRefusal,
  fileDbSqlitePath: h.fileDbSqlitePath,
  filesRootMounted: h.filesRootMounted,
  loadFileHead: h.loadFileHead,
  readFileDbNone: h.readFileDbNone,
  tableNamingFile: h.tableNamingFile,
  filesRoot: () => '/data/files',
  fileDataExt: (row: { title: string }) => row.title.split('.').pop(),
  fileSha256Of: (row: { data: Record<string, unknown> }) => row.data.sha256,
  extractorRefusesFile: (row: { data: Record<string, unknown> }) => !!row.data.snapshot_of,
}));
vi.mock('@mantle/tabledb', () => ({
  SQL_ROW_CAP_DEFAULT: 200,
  SQL_ROW_CAP_MAX: 1000,
  importMaxRows: () => 2_000_000,
  runTableSql: h.runTableSql,
  describeWorkbook: h.describeWorkbook,
}));

import { file_sql } from './builtins-file-sql';
import type { ToolHandlerContext } from './types';

const turn: ToolHandlerContext = { ownerId: 'o1' };
const appRun = { ownerId: 'o1', caller: { entry: 'app', via: 'app' } } as ToolHandlerContext;

const row = (title: string, data: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  path: 'files.m2',
  title,
  data: { sha256: SHA, ...data },
});

const call = (input: Record<string, unknown> = {}, ctx = turn) =>
  file_sql.handler({ file_id: FILE_ID, ...input }, ctx);

const errorOf = async (input: Record<string, unknown> = {}, ctx = turn) => {
  const res = await call(input, ctx);
  if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.output)}`);
  return res.error;
};

const NOT_A_PLAN = Buffer.from('<?xml version="1.0"?><note>hello</note>');

beforeEach(() => {
  vi.resetAllMocks();
  h.fileDataRow.mockResolvedValue(row('sheet.csv'));
  h.fileDataRefusal.mockResolvedValue(null);
  h.fileDbSqlitePath.mockResolvedValue(null);
  h.filesRootMounted.mockResolvedValue(true);
  h.loadFileHead.mockResolvedValue(null);
  h.readFileDbNone.mockResolvedValue(null);
  h.tableNamingFile.mockResolvedValue(null);
});

describe('file_sql, in order', () => {
  it('reads the row first: none means not found, and nothing else is asked', async () => {
    h.fileDataRow.mockResolvedValue(null);
    expect(await errorOf()).toMatch(/^file not found/);
    expect(h.fileDataRefusal).not.toHaveBeenCalled();
    expect(h.fileDbSqlitePath).not.toHaveBeenCalled();
  });

  it('the shared refusal comes before the database, whose name exists', async () => {
    h.fileDataRefusal.mockResolvedValue({ code: 'private', message: 'stays out' });
    h.fileDbSqlitePath.mockResolvedValue(ABS);
    expect(await errorOf({ sql: 'select 1' })).toBe('stays out');
    expect(h.runTableSql).not.toHaveBeenCalled();
  });

  it('a database answers before any reason for having none', async () => {
    h.fileDbSqlitePath.mockResolvedValue(ABS);
    h.readFileDbNone.mockResolvedValue('too-large');
    h.tableNamingFile.mockResolvedValue('t1');
    h.runTableSql.mockResolvedValue({
      columns: ['a'],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    });
    expect(await call({ sql: 'select 1', max_rows: 5 })).toMatchObject({
      ok: true,
      output: { file_id: FILE_ID, columns: ['a'], rows: [[1]], row_count: 1 },
    });
    expect(h.runTableSql).toHaveBeenCalledWith(ABS, 'select 1', { cap: 5 });
    expect(h.readFileDbNone).not.toHaveBeenCalled();
  });

  it('no sql gives the tabs, columns and description, and never table_sql', async () => {
    h.fileDbSqlitePath.mockResolvedValue(ABS);
    h.describeWorkbook.mockReturnValue([
      {
        name: 'Valves',
        viewName: 'Valves',
        ftsTable: 't_1_fts',
        rowCount: 2,
        columns: [{ name: 'Tag', type: 'text' }],
      },
    ]);
    h.runTableSql.mockResolvedValue({ columns: ['v'], rows: [['Plan words']], rowCount: 1 });
    const res = await call();
    expect(res).toMatchObject({
      ok: true,
      output: {
        description: 'Plan words',
        tabs: [
          {
            name: 'Valves',
            view: 'Valves',
            fts_table: 't_1_fts',
            row_count: 2,
            columns: [{ name: 'Tag', type: 'text' }],
          },
        ],
      },
    });
    expect(JSON.stringify(res)).not.toContain('table_sql');
  });

  it('with no mount it says so, before the XML head, a word or a Table', async () => {
    h.filesRootMounted.mockResolvedValue(false);
    h.fileDataRow.mockResolvedValue(row('note.xml'));
    h.loadFileHead.mockResolvedValue(NOT_A_PLAN);
    h.readFileDbNone.mockResolvedValue('no-rows');
    h.tableNamingFile.mockResolvedValue('t1');
    expect(await errorOf()).toMatch(/not mounted/);
    expect(h.loadFileHead).not.toHaveBeenCalled();
  });

  it('an XML that is no plan says so, before a word or a Table', async () => {
    h.fileDataRow.mockResolvedValue(row('note.xml'));
    h.loadFileHead.mockResolvedValue(NOT_A_PLAN);
    h.readFileDbNone.mockResolvedValue('no-rows');
    h.tableNamingFile.mockResolvedValue('t1');
    expect(await errorOf()).toMatch(/^This XML is not a Microsoft Project plan\./);
  });

  it('an XML whose head cannot be read goes on down the list', async () => {
    h.fileDataRow.mockResolvedValue(row('plan.xml'));
    expect(await errorOf()).toMatch(/^No database yet/);
  });

  it('a replaced workbook with a word and an old Table gives the word', async () => {
    h.fileDataRow.mockResolvedValue(row('sheet.xlsx'));
    h.readFileDbNone.mockResolvedValue('too-large');
    h.tableNamingFile.mockResolvedValue('t1');
    const error = await errorOf();
    expect(error).toMatch(/too large/);
    expect(error).not.toContain('table_sql');
    expect(h.tableNamingFile).not.toHaveBeenCalled();
  });

  it('only a workbook is told about CSV, and only under the row cap', async () => {
    const reason = async (title: string) => {
      h.fileDataRow.mockResolvedValue(row(title));
      h.readFileDbNone.mockResolvedValue('too-large');
      return errorOf();
    };
    expect(await reason('sheet.xlsx')).toMatch(
      /past 32 MB of sheet XML, or past 2,000,000 rows\. Under 2,000,000 rows, save it as CSV/,
    );
    for (const title of ['data.csv', 'plan.xml', 'sheet.dwg', 'sheet.dxf', 'set.dwf']) {
      expect(await reason(title), title).not.toMatch(/as CSV/);
    }
  });

  it('no word ever says call again, for any type', async () => {
    for (const title of ['a.xlsx', 'a.xls', 'a.csv', 'a.xml', 'a.dwg', 'a.dxf', 'a.dwf']) {
      for (const word of ['too-large', 'no-rows', 'unreadable']) {
        h.fileDataRow.mockResolvedValue(row(title));
        h.loadFileHead.mockResolvedValue(null);
        h.readFileDbNone.mockResolvedValue(word);
        const error = await errorOf();
        expect(error, `${title} ${word}`).not.toMatch(/call again/i);
        expect(error.length, `${title} ${word}`).toBeGreaterThan(20);
      }
    }
  });

  it('a Table that names the file answers next, with the id', async () => {
    h.tableNamingFile.mockResolvedValue('t1');
    expect(await errorOf()).toBe(
      'Its rows are in Table t1: use table_sql. This Table may hold an older version of the file.',
    );
    expect(h.tableNamingFile).toHaveBeenCalledWith('o1', FILE_ID);
  });

  it('an app run is never told to use table_sql', async () => {
    h.tableNamingFile.mockResolvedValue('t1');
    const error = await errorOf({}, appRun);
    expect(error).toMatch(/^No database yet/);
    expect(error).not.toContain('table_sql');
    expect(h.tableNamingFile).not.toHaveBeenCalled();
  });

  it('a row the extractor refuses has its own answer, after a Table', async () => {
    h.fileDataRow.mockResolvedValue(row('copy.csv', { snapshot_of: 'x' }));
    expect(await errorOf()).toBe('This file was not read into the brain, so it has no database.');
    h.tableNamingFile.mockResolvedValue('t1');
    expect(await errorOf()).toMatch(/^Its rows are in Table t1/);
  });

  it('otherwise: no database yet', async () => {
    expect(await errorOf()).toBe(
      'No database yet. If it was just uploaded, call again. If not, ask an owner to run the rebuild.',
    );
  });
});

describe('file_sql, on a read error', () => {
  const MISSING = `table storage file missing: ${ABS}: the registry references a workbook`;

  it('a name gone during a read goes back through the list: no path', async () => {
    h.fileDbSqlitePath
      .mockResolvedValueOnce(ABS) // the read
      .mockResolvedValueOnce(null) // still there? no
      .mockResolvedValue(null); // the list again
    h.runTableSql.mockRejectedValue(new Error(MISSING));
    h.readFileDbNone.mockResolvedValue('unreadable');
    const error = await errorOf({ sql: 'select 1' });
    expect(error).toMatch(/could not be read/);
    expect(error).not.toContain(ROOT);
    // The row and the refusal are read again: a flip to private is why it went.
    expect(h.fileDataRefusal).toHaveBeenCalledTimes(2);
  });

  it('a flip during a read answers with the refusal, not the error', async () => {
    h.fileDbSqlitePath.mockResolvedValueOnce(ABS).mockResolvedValue(null);
    h.runTableSql.mockRejectedValue(new Error(MISSING));
    h.fileDataRefusal
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ code: 'private', message: 'stays out' });
    expect(await errorOf({ sql: 'select 1' })).toBe('stays out');
  });

  it('a name gone twice ends in the list, not a loop', async () => {
    h.fileDbSqlitePath
      .mockResolvedValueOnce(ABS)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ABS)
      .mockResolvedValue(null);
    h.runTableSql.mockRejectedValue(new Error(MISSING));
    const error = await errorOf({ sql: 'select 1' });
    expect(error).toMatch(/^No database yet/);
    expect(error).not.toContain(ROOT);
    expect(h.runTableSql).toHaveBeenCalledTimes(2);
  });

  it('a read error with the name still there: its words, its own name, no path', async () => {
    h.fileDbSqlitePath.mockResolvedValue(ABS);
    h.runTableSql.mockRejectedValue(
      new Error(`table_sql: no such column: nope in ${ABS} under ${ROOT}/x`),
    );
    const error = await errorOf({ sql: 'select nope' });
    expect(error).toContain('file_sql: no such column: nope');
    expect(error).not.toContain('table_sql');
    expect(error).not.toContain(ROOT);
  });

  it('a read error while describing goes the same way', async () => {
    h.fileDbSqlitePath.mockResolvedValueOnce(ABS).mockResolvedValue(null);
    h.describeWorkbook.mockImplementation(() => {
      throw new Error(MISSING);
    });
    const error = await errorOf();
    expect(error).toMatch(/^No database yet/);
    expect(error).not.toContain(ROOT);
  });
});

describe('file_sql, its policy', () => {
  it('copies dwg_render: a read of one file, no spend, fenced as data', () => {
    expect(file_sql.policy).toEqual({
      matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
      effect: 'read',
      spends: 'none',
      scope: 'any',
      keyArea: 'files',
      outside: { untrusted: true },
    });
  });

  it('asks for a file id', async () => {
    expect(await file_sql.handler({}, turn)).toMatchObject({ ok: false });
    expect(h.fileDataRow).not.toHaveBeenCalled();
  });
});
