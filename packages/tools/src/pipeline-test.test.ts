/**
 * The test of one pipeline on one file (docs/pipelines.md, "Test on one
 * file"): testPipeline and `pipeline_test`. On a temporary files root with
 * made-up files and databases; the file row, its bytes and the state of a
 * pipeline are stand-ins, so no Postgres. The parser is a stubbed fetch.
 *
 * The check it holds: a test calls no writer. Every writer of a file's
 * database (the whole write and the patch, in @mantle/tabledb/write and in
 * the table broker; the word of a file) and the writer of the state are
 * spies that throw, and the database folder is the same after a test.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import type { ToolHandlerContext } from './types';

type Row = { id: string; path: string; title: string; data: Record<string, unknown> };
const h = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  bytes: new Map<string, Buffer>(),
  saved: {} as Record<string, unknown>,
  writes: [] as string[],
  /** The files file_sql refuses as private (a stand-in of fileDataRefusal). */
  private: new Set<string>(),
}));
const wrote = (name: string) => () => {
  h.writes.push(name);
  throw new Error(`a test called the writer ${name}`);
};

vi.mock('@mantle/tabledb/write', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tabledb/write')>();
  return {
    ...real,
    writeDocFile: vi.fn(wrote('writeDocFile')),
    patchDocFile: vi.fn(wrote('patchDocFile')),
  };
});
vi.mock('@mantle/content/table-broker', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/table-broker')>();
  return {
    ...real,
    writeFileDatabaseDoc: vi.fn(wrote('writeFileDatabaseDoc')),
    patchFileDatabaseDoc: vi.fn(wrote('patchFileDatabaseDoc')),
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...real,
    writeFileDbNone: vi.fn(wrote('writeFileDbNone')),
    fileDataRow: vi.fn(async (_owner: string, id: string) => h.rows.get(id) ?? null),
    fileDataRefusal: vi.fn(async (_owner: string, row: Row) =>
      h.private.has(row.id) ? { code: 'private', message: 'This file is set to stay out.' } : null,
    ),
    readFileNodeBytes: vi.fn(async (row: Row) =>
      h.bytes.has(row.id)
        ? { bytes: h.bytes.get(row.id)!, filename: row.title, ext: '', mime: '' }
        : null,
    ),
  };
});
vi.mock('@mantle/content/pipeline-state', async () => {
  const f = await import('@mantle/files');
  return {
    pipelineStateOf: vi.fn(async (_owner: string, m: import('@mantle/files').PipelineManifest) => {
      const options = f.effectiveOptions(m, h.saved);
      return {
        workspaces: f.defaultState(m).workspaces,
        options,
        optionsHash: f.optionsHash(m, options),
      };
    }),
    setPipelineState: vi.fn(wrote('setPipelineState')),
  };
});
// The spy on the one read: a test passes no decider, so no model call can start.
vi.mock('@mantle/content/file-database', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/file-database')>();
  return { ...real, parseFileSheets: vi.fn(real.parseFileSheets) };
});

const { fileDbPaths, fileDbsDir } = await import('@mantle/files');
const { parseFileSheets } = await import('@mantle/content/file-database');
const realWrite =
  await vi.importActual<typeof import('@mantle/tabledb/write')>('@mantle/tabledb/write');
const {
  testPipeline,
  pipeline_test,
  PIPELINE_TEST_CELL_MAX,
  PIPELINE_TEST_COLUMNS_MAX,
  PIPELINE_TEST_NAME_MAX,
  PIPELINE_TEST_TABS_MAX,
} = await import('./pipeline-test');

const OWNER = '00000000-0000-4000-8000-000000000000';
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const sha = (c: string) => c.repeat(64);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-pipeline-test-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  mkdirSync(fileDbsDir(), { recursive: true });
  h.rows.clear();
  h.bytes.clear();
  h.saved = {};
  h.writes = [];
  h.private.clear();
  vi.mocked(parseFileSheets).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A file row, with its bytes. */
function file(n: number, filename: string, c: string, bytes?: Buffer) {
  h.rows.set(id(n), {
    id: id(n),
    path: 'files',
    title: filename,
    data: { filename, sha256: sha(c) },
  });
  if (bytes) h.bytes.set(id(n), bytes);
}

/** The database of file `n` at its bytes, with these tabs. Written with the
 *  real writer, before any test runs. */
function database(
  n: number,
  c: string,
  tabs: { name: string; columns: string[]; rows: unknown[][] }[],
) {
  realWrite.writeDocFile(
    fileDbPaths(id(n), sha(c))!.sqlite,
    ensureWorkbookDoc({
      tabs: tabs.map((t) => ({
        ...tableDocFromGrid({
          columns: t.columns.map((name) => ({ name, type: 'text' })),
          rows: t.rows as (string | null)[][],
        }),
        name: t.name,
      })),
    }),
    { nodeId: id(n), ownerId: OWNER },
  );
}

/** The database folder: each file and a hash of its bytes. SQLite's own
 *  side files of a read (-shm, -wal) are left out: a read only open makes
 *  them, as file_sql's does, and the database's bytes stay the same. */
const dbFolder = () =>
  readdirSync(fileDbsDir())
    .filter((name) => !/-(shm|wal)$/.test(name))
    .sort()
    .map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(fileDbsDir(), name)))
        .digest('hex'),
    ]);

/** Every parser job answers `res()`. */
function stubParser(res: () => Response) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const calls = vi.fn(async () => res());
  vi.stubGlobal('fetch', calls);
  return calls;
}

const ok = async (...args: Parameters<typeof testPipeline>) => {
  const res = await testPipeline(...args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
};

describe('testPipeline: a reader', () => {
  it('a CSV: its tab with the first 5 rows, each cell cut; nothing is written', async () => {
    const long = 'x'.repeat(PIPELINE_TEST_CELL_MAX + 50);
    const csv = ['tag,note', ...Array.from({ length: 8 }, (_, i) => `P-10${i},${long}`)].join('\n');
    file(1, 'list.csv', 'a', Buffer.from(csv));
    const before = dbFolder();
    const r = await ok(OWNER, 'sheet', { fileId: id(1) });
    expect(r).toMatchObject({
      status: 'ok',
      pipeline: 'sheet',
      version: '1.0.0',
      writes: ['file_tabs_write'],
      word: null,
      warnings: [],
    });
    expect(r.tabs).toHaveLength(1);
    expect(r.tabs[0]).toMatchObject({ rows: 8, columns: ['tag', 'note'] });
    expect(r.tabs[0]!.first).toHaveLength(5);
    expect(r.tabs[0]!.first[0]).toEqual(['P-100', 'x'.repeat(PIPELINE_TEST_CELL_MAX)]);
    // Nothing in the database folder, and no writer was called.
    expect(dbFolder()).toEqual(before);
    expect(h.writes).toEqual([]);
  });

  it('a private file is not_mine with the word of its refusal, and nothing of it is parsed', async () => {
    file(5, 'kept-out.csv', 'e', Buffer.from('tag\nP-101\n'));
    h.private.add(id(5));
    const r = await ok(OWNER, 'sheet', { fileId: id(5) });
    expect(r).toMatchObject({ status: 'not_mine', tabs: [], writes: [], word: 'private' });
    expect(parseFileSheets).not.toHaveBeenCalled();
  });

  it('a wide book is bounded: 20 tabs, 100 columns a tab, names cut, one warning each', async () => {
    const long = 'n'.repeat(PIPELINE_TEST_NAME_MAX + 30);
    const sheets = Array.from({ length: PIPELINE_TEST_TABS_MAX + 5 }, (_, i) => ({
      name: `Tab ${i}`,
      columns: Array.from({ length: PIPELINE_TEST_COLUMNS_MAX + 20 }, (_, c) => ({
        name: c === 0 ? long : `c${c}`,
        type: 'text' as const,
      })),
      rows: [Array.from({ length: PIPELINE_TEST_COLUMNS_MAX + 20 }, (_, c) => `v${c}`)],
    }));
    vi.mocked(parseFileSheets).mockResolvedValueOnce({ kind: 'sheets', sheets });
    file(6, 'wide.xlsx', 'f', Buffer.from('made up'));
    const r = await ok(OWNER, 'sheet', { fileId: id(6) });
    expect(r.status).toBe('ok');
    expect(r.tabs).toHaveLength(PIPELINE_TEST_TABS_MAX);
    for (const t of r.tabs) {
      expect(t.columns).toHaveLength(PIPELINE_TEST_COLUMNS_MAX);
      expect(t.first[0]).toHaveLength(PIPELINE_TEST_COLUMNS_MAX);
    }
    expect(r.tabs[0]!.columns[0]).toBe(long.slice(0, PIPELINE_TEST_NAME_MAX));
    expect(r.warnings).toEqual([
      `Only the first ${PIPELINE_TEST_TABS_MAX} of ${PIPELINE_TEST_TABS_MAX + 5} tabs are shown.`,
      `Only the first ${PIPELINE_TEST_COLUMNS_MAX} columns of a tab are shown.`,
    ]);
  });

  it('an XML that is not a plan is not_mine', async () => {
    file(2, 'notes.xml', 'b', Buffer.from('<?xml version="1.0"?><notes><n>hi</n></notes>'));
    const r = await ok(OWNER, 'plan-mspdi', { fileId: id(2) });
    expect(r).toMatchObject({ status: 'not_mine', tabs: [], writes: [], word: null });
    expect(h.writes).toEqual([]);
  });

  it('a file of an extension the pipeline does not read is not_mine with no-match, and reads no bytes', async () => {
    file(3, 'list.csv', 'c', Buffer.from('a\n1\n'));
    const r = await ok(OWNER, 'drawing-cad', { fileId: id(3) });
    expect(r).toMatchObject({ status: 'not_mine', word: 'no-match' });
    expect(parseFileSheets).not.toHaveBeenCalled();
  });

  it('a PDF the rules leave unsure gives unsure, and passes no decider', async () => {
    const page = {
      page: 1,
      status: 'ok',
      class: 'vector_text',
      size: 'a1',
      widthMm: 841,
      heightMm: 594,
      rotate: 0,
      chars: 4000,
      runs: 700,
      hiddenShare: 0,
      imageCover: 0,
      segments: 20000,
      axes: { h: 0.6, v: 0.3, iso: 0.01, other: 0.09, longMm: 60000 },
      tagLike: 40,
      instruments: 30,
      lineNumbers: 12,
      markups: 0,
      markupsWithText: 0,
      kind: 'unsure',
      eye: null,
    };
    stubParser(() =>
      Response.json({
        ok: true,
        numPages: 1,
        pageCountMayBeShort: false,
        allRead: true,
        kind: 'unsure',
        pages: [page],
        sample: 'MADE UP TITLE',
      }),
    );
    file(4, 'sheet.pdf', 'd', Buffer.from(randomUUID()));
    const r = await ok(OWNER, 'drawing-pdf', { fileId: id(4) });
    expect(r.status).toBe('unsure');
    expect(r.tabs.map((t) => t.name)).toContain('File');
    expect(r.shapes).toContain('pdf-file-v1');
    // The one read, with no decider: no model call can start.
    expect(parseFileSheets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(parseFileSheets).mock.calls[0]![2]).not.toHaveProperty('pdfKind');
    expect(h.writes).toEqual([]);
  });

  it('a busy parser gives busy, asked once as an interactive call', async () => {
    const calls = stubParser(() =>
      Response.json({ ok: false, error: { code: 'busy', message: 'busy' } }, { status: 429 }),
    );
    file(5, 'plan.pdf', 'e', Buffer.from(randomUUID()));
    const r = await ok(OWNER, 'drawing-pdf', { fileId: id(5) });
    expect(r).toMatchObject({ status: 'busy', tabs: [], word: null });
    // A person waits: no busy retries.
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('bytes that cannot be read are failed, with the word unreadable', async () => {
    file(6, 'gone.csv', 'f');
    expect(await ok(OWNER, 'sheet', { fileId: id(6) })).toMatchObject({
      status: 'failed',
      word: 'unreadable',
    });
  });
});

describe('testPipeline: an after pipeline', () => {
  const TEXTS = {
    name: 'Texts',
    columns: ['Text', 'Layer'],
    rows: [
      ['EA-101 FIC-201', 'TAGS'],
      ['NOTE-1', 'TAGS'],
    ],
  };

  it('Site tags on a made-up drawing, with unsaved options over the saved ones; nothing is written', async () => {
    file(7, 'unit.dwg', '7');
    database(7, '7', [TEXTS]);
    const before = dbFolder();
    const plain = await ok(OWNER, 'site-tags', { fileId: id(7) });
    expect(plain.status).toBe('ok');
    expect(plain.tabs.map((t) => t.name)).toEqual(['Site tags']);
    const typeOf = (r: typeof plain, tag: string) => {
      const t = r.tabs[0]!;
      const row = t.first.find((x) => x[t.columns.indexOf('Tag')] === tag);
      return row?.[t.columns.indexOf('Type')];
    };
    expect(typeOf(plain, 'EA-101')).toBe('instrument');
    // Saved: one option. Tried: another, over it. The saved one stays.
    h.saved = { not_tags: ['FIC'] };
    const tried = await ok(OWNER, 'site-tags', {
      fileId: id(7),
      options: { equipment_types: ['EA'] },
    });
    expect(typeOf(tried, 'EA-101')).toBe('equipment');
    expect(typeOf(tried, 'FIC-201')).toBeUndefined();
    expect(tried.writes).toEqual(['file_tabs_write']);
    expect(dbFolder()).toEqual(before);
    expect(h.writes).toEqual([]);
  });

  it('no database is not_mine with no-database; a database without the shape is no-match', async () => {
    file(8, 'none.dwg', '8');
    expect(await ok(OWNER, 'site-tags', { fileId: id(8) })).toMatchObject({
      status: 'not_mine',
      word: 'no-database',
    });
    file(9, 'other.dwg', '9');
    database(9, '9', [{ name: 'Layers', columns: ['Layer'], rows: [['0']] }]);
    expect(await ok(OWNER, 'site-tags', { fileId: id(9) })).toMatchObject({
      status: 'not_mine',
      word: 'no-match',
    });
    // A spreadsheet with a Texts tab: its extension is not in the list.
    file(1, 'texts.xlsx', '0');
    database(1, '0', [TEXTS]);
    expect(await ok(OWNER, 'site-tags', { fileId: id(1) })).toMatchObject({ word: 'no-match' });
  });
});

describe('testPipeline: refusals', () => {
  it('an unknown pipeline, a file the caller cannot read, a bad option', async () => {
    expect(await testPipeline(OWNER, 'nope', { fileId: id(1) })).toMatchObject({
      ok: false,
      missing: 'pipeline',
    });
    expect(await testPipeline(OWNER, 'sheet', { fileId: id(2) })).toMatchObject({
      ok: false,
      missing: 'file',
    });
    file(3, 'a.dwg', '1');
    const bad = await testPipeline(OWNER, 'site-tags', {
      fileId: id(3),
      options: { not_an_option: 1 },
    });
    expect(bad).toEqual({ ok: false, error: 'Site tags has no option "not_an_option".' });
    expect(h.writes).toEqual([]);
  });
});

describe('pipeline_test', () => {
  it('reads, MCP only, in the settings area, not systemWhole', () => {
    expect(pipeline_test.mcpOnly).toBe(true);
    expect(pipeline_test.policy).toMatchObject({ effect: 'read', spends: 'none' });
    expect(pipeline_test.policy.scope).toEqual({ area: 'settings' });
    expect(pipeline_test.inputSchema.required).toEqual(['id', 'file_id']);
  });

  it('gives the same result as testPipeline, but the time', async () => {
    file(4, 'b.csv', '2', Buffer.from('tag\nP-1\n'));
    const out = await pipeline_test.handler({ id: 'sheet', file_id: id(4) }, {
      ownerId: OWNER,
    } as ToolHandlerContext);
    const direct = await ok(OWNER, 'sheet', { fileId: id(4) });
    expect(out).toEqual({ ok: true, output: { ...direct, ms: expect.any(Number) } });
    expect(
      await pipeline_test.handler({ id: 'sheet', file_id: id(5) }, {
        ownerId: OWNER,
      } as ToolHandlerContext),
    ).toMatchObject({ ok: false, error: expect.stringContaining('file_list') });
  });
});
