/**
 * The file database note of file_get and file_read (./file-db-note.ts), on a
 * real file database and mocked rows:
 *  - a file with a database: its tabs and the file_sql line;
 *  - a picture cut from a file: its source's tabs, by the source's id;
 *  - a file file_sql refuses, or with no database: no note;
 *  - many tabs: the first ones and a count of the rest;
 *  - a fault while reading: no note, and no throw.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import { writeDocFile } from '@mantle/tabledb/write';

type Row = { id: string; path: string; title: string; data: Record<string, unknown> };
const rows = new Map<string, Row>();
const dbs = new Map<string, string>();
const refused = new Set<string>();

vi.mock('@mantle/files', () => ({
  fileDataRow: vi.fn(async (_owner: string, id: string) => rows.get(id) ?? null),
  fileDataRefusal: vi.fn(async (_owner: string, row: Row) =>
    refused.has(row.id) ? { code: 'private', message: 'no' } : null,
  ),
  fileDbSqlitePath: vi.fn(async (id: string) => dbs.get(id) ?? null),
  fileSha256Of: vi.fn(() => 'a'.repeat(64)),
}));
vi.mock('@mantle/content/pipeline-registry', () => ({
  boxPipelines: vi.fn(async () => ({ dbExts: new Set(['pdf', 'dwg']) })),
}));

const { fileDbNote } = await import('./file-db-note');

const dir = mkdtempSync(path.join(tmpdir(), 'file-db-note-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DRAWING = '11111111-1111-4111-8111-111111111111';
const PICTURE = '22222222-2222-4222-8222-222222222222';
const MEMO = '33333333-3333-4333-8333-333333333333';
const BOOK = '44444444-4444-4444-8444-444444444444';

/** A file database with these tab names. */
function dbOf(id: string, names: string[]): string {
  const abs = path.join(dir, `${id}.sqlite`);
  const tabs = names.map((name) => ({
    ...tableDocFromGrid({ columns: [{ name: 'Text', type: 'text' }], rows: [['x']] }),
    name,
  }));
  writeDocFile(abs, ensureWorkbookDoc({ tabs }), {
    nodeId: id,
    ownerId: 'owner-1',
    fts: false,
    deleteJournal: true,
  });
  return abs;
}

const row = (id: string, data: Record<string, unknown> = {}): Row => ({
  id,
  path: 'files.x',
  title: 'x.pdf',
  data: { filename: 'x.pdf', ...data },
});

beforeEach(() => {
  rows.clear();
  dbs.clear();
  refused.clear();
});

describe('fileDbNote', () => {
  it('names the tabs of a file with a database, and file_sql', async () => {
    rows.set(DRAWING, row(DRAWING));
    dbs.set(DRAWING, dbOf(DRAWING, ['Pages', 'Texts', 'Tags', 'Lines']));
    const note = await fileDbNote('owner-1', DRAWING);
    expect(note).toEqual({
      tabs: ['Pages', 'Texts', 'Tags', 'Lines'],
      hint: expect.stringContaining('file_sql'),
    });
  });

  it("names a picture's source file and its tabs", async () => {
    rows.set(DRAWING, row(DRAWING));
    dbs.set(DRAWING, dbOf(DRAWING, ['Texts', 'Inserts']));
    rows.set(PICTURE, row(PICTURE, { filename: 'model.png', sourceFileId: DRAWING }));
    const note = await fileDbNote('owner-1', PICTURE);
    expect(note).toMatchObject({ file_id: DRAWING, tabs: ['Texts', 'Inserts'] });
    expect(note?.hint).toContain('not this picture');
  });

  it('gives no note where file_sql would not read', async () => {
    rows.set(MEMO, row(MEMO));
    expect(await fileDbNote('owner-1', MEMO)).toBeUndefined();
    rows.set(DRAWING, row(DRAWING));
    dbs.set(DRAWING, dbOf(DRAWING, ['Texts']));
    refused.add(DRAWING);
    expect(await fileDbNote('owner-1', DRAWING)).toBeUndefined();
    rows.set(PICTURE, row(PICTURE, { sourceFileId: DRAWING }));
    expect(await fileDbNote('owner-1', PICTURE)).toBeUndefined();
    expect(await fileDbNote('owner-1', BOOK)).toBeUndefined();
  });

  it('lists the first tabs of a book and counts the rest', async () => {
    rows.set(BOOK, row(BOOK));
    dbs.set(
      BOOK,
      dbOf(
        BOOK,
        Array.from({ length: 35 }, (_, i) => `Tab ${i + 1}`),
      ),
    );
    const note = await fileDbNote('owner-1', BOOK);
    expect(note?.tabs).toHaveLength(30);
    expect(note?.more_tabs).toBe(5);
  });

  it('gives no note on a fault, and does not throw', async () => {
    rows.set(DRAWING, row(DRAWING));
    dbs.set(DRAWING, path.join(dir, 'gone.sqlite'));
    expect(await fileDbNote('owner-1', DRAWING)).toBeUndefined();
  });
});
