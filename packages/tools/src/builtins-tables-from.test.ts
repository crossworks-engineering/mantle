/**
 * Tests for the two import tools: table_from_text and table_from_file.
 *
 * Both ALWAYS create a new table. That is the property that bit hardest in
 * production (NATREF 2026-07-28: an agent reached for table_from_text to
 * append rows and left a stray import behind), so both suites pin that no
 * draft op is ever issued on an existing table.
 *
 * The parsers (parseTextToGrid / parseSpreadsheetToGrid) and the file store
 * (fileById / readFileById) are stubbed; the grid-to-doc conversion
 * (tableDocFromGrid, real) and the tools' own guards are exercised. What is
 * pinned beyond "creates":
 *
 *  - table_from_text: the parsed header becomes typed columns and every row
 *    is coerced through the column type before reaching the store, and an
 *    empty parse is refused before createTable is called.
 *  - table_from_file: the extension gate runs BEFORE the bytes are read (a
 *    500 MB pdf must not be pulled from MinIO to be told it is not a
 *    sheet), every non-empty sheet becomes a TAB of one table (not sibling
 *    tables), the source file id is recorded, and the title falls back to
 *    the filename without its extension.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getTable: vi.fn(), applyTableOps: vi.fn(), createTable: vi.fn() };
});
vi.mock('@mantle/content/table-storage', () => ({ tableSqlSurface: vi.fn(async () => null) }));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSpreadsheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { applyTableOps, createTable } from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { parseSpreadsheetToGrid, parseTextToGrid } from '@mantle/files/sheet-to-grid';
import { recordIngest } from '@mantle/tracing';
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const fromText = TABLE_TOOLS.find((t) => t.slug === 'table_from_text')!;
const fromFile = TABLE_TOOLS.find((t) => t.slug === 'table_from_file')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FILE_ID = 'a1b2c3d4-0000-4000-8000-000000000009';

type Result = Awaited<ReturnType<(typeof fromText)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** What a parser hands back: a typed header + positional rows. */
const sheet = (
  name: string,
  rows: (string | number | null)[][] = [
    [3, 'Bolt'],
    ['5', 'Nut'],
  ],
) => ({
  name,
  columns: [
    { name: 'Qty', type: 'number' as const },
    { name: 'Item', type: 'text' as const },
  ],
  rows,
});

/** The store's answer: whatever it was given, with an id and a title. */
const created = (input: Record<string, unknown>) => ({
  id: 'new_t',
  title: input.title,
  draft: null,
  data: input.data ?? { columns: [], rows: [] },
  tabs: [],
});

/** createTable's second argument on its only call. */
const createInput = () => vi.mocked(createTable).mock.calls[0]![1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createTable).mockImplementation(
    async (_owner, input) => created(input as Record<string, unknown>) as never,
  );
  vi.mocked(parseTextToGrid).mockResolvedValue([sheet('')]);
  vi.mocked(parseSpreadsheetToGrid).mockResolvedValue([sheet('Prices'), sheet('', [])]);
  vi.mocked(fileById).mockResolvedValue({ id: FILE_ID, filename: 'stock.xlsx' } as never);
  vi.mocked(readFileById).mockResolvedValue({ bytes: Buffer.from('xlsx-bytes') } as never);
});

describe('table_from_text', () => {
  it('refuses blank data before parsing', async () => {
    expect(errorOf(await fromText.handler({ data: '  \n' }, ctx))).toMatch(/data is required/);
    expect(parseTextToGrid).not.toHaveBeenCalled();
    expect(createTable).not.toHaveBeenCalled();
  });

  it('refuses text with no table in it, without creating anything', async () => {
    vi.mocked(parseTextToGrid).mockResolvedValue([]);
    expect(errorOf(await fromText.handler({ data: 'just prose' }, ctx))).toMatch(/no table found/);
    // A header-less parse is the same case.
    vi.mocked(parseTextToGrid).mockResolvedValue([{ name: '', columns: [], rows: [] }]);
    expect(errorOf(await fromText.handler({ data: '|' }, ctx))).toMatch(/no table found/);
    expect(createTable).not.toHaveBeenCalled();
  });

  it('surfaces a parser throw as a clean error', async () => {
    vi.mocked(parseTextToGrid).mockRejectedValue(new Error('ragged rows'));
    expect(errorOf(await fromText.handler({ data: 'a,b\n1' }, ctx))).toBe(
      'parse failed: ragged rows',
    );
  });

  it('creates a NEW owner-scoped table with typed columns and coerced rows', async () => {
    const res = await fromText.handler({ data: 'Qty,Item\n3,Bolt\n5,Nut', tags: ['x'] }, ctx);
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTable).mock.calls[0]![0]).toBe('o1');
    const input = createInput();
    expect(input.title).toBe('Imported table');
    expect(input.tags).toEqual(['x']);
    const data = input.data as {
      columns: Array<{ id: string; name: string; type: string }>;
      rows: Array<{ cells: Record<string, unknown> }>;
    };
    expect(data.columns.map((c) => [c.name, c.type])).toEqual([
      ['Qty', 'number'],
      ['Item', 'text'],
    ]);
    // The parser handed '5' as a string; the number column coerces it.
    const qty = data.columns[0]!.id;
    expect(data.rows.map((r) => r.cells[qty])).toEqual([3, 5]);
    // It is an import, never an edit: no draft op on any existing table.
    expect(applyTableOps).not.toHaveBeenCalled();
    const out = outputOf(res);
    expect(out).toMatchObject({ id: 'new_t', title: 'Imported table', rows: 2 });
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        nodeId: 'new_t',
        payload: expect.objectContaining({ via: 'table_from_text_tool', rows: 2 }),
      }),
    );
  });

  it('uses the given title, trimmed', async () => {
    await fromText.handler({ data: 'a\n1', title: '  Parts  ' }, ctx);
    expect(createInput().title).toBe('Parts');
  });

  it('surfaces a store refusal (e.g. the import ceiling) instead of reporting a table', async () => {
    vi.mocked(createTable).mockRejectedValue(new Error('import too large'));
    expect(errorOf(await fromText.handler({ data: 'a\n1' }, ctx))).toBe('import too large');
  });
});

describe('table_from_file', () => {
  it('refuses a blank file_id before touching the file store', async () => {
    expect(errorOf(await fromFile.handler({ file_id: ' ' }, ctx))).toMatch(/file_id is required/);
    expect(fileById).not.toHaveBeenCalled();
  });

  it('reports a missing file with the lookup tools, without reading bytes', async () => {
    vi.mocked(fileById).mockResolvedValue(null);
    const res = await fromFile.handler({ file_id: FILE_ID }, ctx);
    expect(errorOf(res)).toMatch(/file_list/);
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    expect(readFileById).not.toHaveBeenCalled();
  });

  it('gates on the extension BEFORE reading bytes', async () => {
    vi.mocked(fileById).mockResolvedValue({ id: FILE_ID, filename: 'report.pdf' } as never);
    const res = await fromFile.handler({ file_id: FILE_ID }, ctx);
    expect(errorOf(res)).toMatch(/'report.pdf' is not a spreadsheet/);
    expect(readFileById).not.toHaveBeenCalled();
    expect(createTable).not.toHaveBeenCalled();
  });

  it('reports unavailable bytes and a parser throw as clean errors', async () => {
    vi.mocked(readFileById).mockResolvedValue(null);
    expect(errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx))).toMatch(/bytes unavailable/);
    vi.mocked(readFileById).mockResolvedValue({ bytes: Buffer.from('x') } as never);
    vi.mocked(parseSpreadsheetToGrid).mockRejectedValue(new Error('not a zip'));
    expect(errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx))).toBe(
      'spreadsheet parse failed: not a zip',
    );
    expect(createTable).not.toHaveBeenCalled();
  });

  it('refuses a workbook with no tabular data, creating nothing', async () => {
    vi.mocked(parseSpreadsheetToGrid).mockResolvedValue([]);
    expect(errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx))).toMatch(/no tabular data/);
    expect(createTable).not.toHaveBeenCalled();
  });

  it('imports every sheet as a TAB of one table, keyed to the source file', async () => {
    const res = await fromFile.handler({ file_id: FILE_ID, tags: ['import'] }, ctx);
    // Bytes went to the parser with the extension it needs to pick a reader.
    expect(parseSpreadsheetToGrid).toHaveBeenCalledWith(Buffer.from('xlsx-bytes'), 'xlsx');
    expect(createTable).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTable).mock.calls[0]![0]).toBe('o1');
    const input = createInput();
    // Title falls back to the filename minus its extension.
    expect(input.title).toBe('stock');
    expect(input.sourceFileId).toBe(FILE_ID);
    expect(input.tags).toEqual(['import']);
    const tabs = input.tabs as Array<{ name: string; columns: unknown[]; rows: unknown[] }>;
    // Two sheets in, two tabs out (not two tables); an unnamed sheet gets a
    // positional name.
    expect(tabs.map((t) => t.name)).toEqual(['Prices', 'Sheet2']);
    expect(tabs[0]!.rows).toHaveLength(2);
    expect(applyTableOps).not.toHaveBeenCalled();
    const out = outputOf(res);
    expect(out.tabs).toEqual([
      { name: 'Prices', columns: 2, rows: 2 },
      { name: 'Sheet2', columns: 2, rows: 0 },
    ]);
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'new_t',
        payload: expect.objectContaining({
          via: 'table_from_file_tool',
          sourceFileId: FILE_ID,
          sheets: 2,
        }),
      }),
    );
  });

  it('prefers an explicit title over the filename', async () => {
    await fromFile.handler({ file_id: FILE_ID, title: 'Stock list' }, ctx);
    expect(createInput().title).toBe('Stock list');
  });

  it('surfaces a store refusal (the import ceiling) instead of reporting a table', async () => {
    vi.mocked(createTable).mockRejectedValue(new Error('import too large: 60000 rows'));
    expect(errorOf(await fromFile.handler({ file_id: FILE_ID }, ctx))).toMatch(/import too large/);
  });
});
