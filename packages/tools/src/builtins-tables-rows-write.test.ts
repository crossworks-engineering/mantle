/**
 * Tests for the single-row tools: table_row_add, table_row_update,
 * table_row_get, table_cell_set. (The bulk twins, table_rows_add and
 * table_rows_upsert, live in builtins-tables-rows-add.test.ts.)
 *
 * The DB edges (getTable / applyTableOps) are stubbed; the tools' own logic
 * (cell-key resolution, existence checks, tab targeting, the draft envelope)
 * is real. No sqlite surface is mocked, so the legacy doc path is exercised.
 *
 * Three properties carry the weight:
 *
 *  1. Cells travel under the `cells` key. A call that sends `values` instead
 *     produces an all-NULL row on the add path (nothing validates it there),
 *     so the one place the handler DOES refuse it, table_row_update, is
 *     pinned: an empty `cells` must be an error, not a no-op draft revision.
 *  2. Every write lands in DRAFT and says so. The output must carry
 *     `draft_saved: true` and the review hint, because an agent that reads
 *     the result as "published" will tell the user the live table changed.
 *  3. When a tab is targeted, the op must carry that tab id and the doc it
 *     validated against must be that tab's, otherwise a row-id check passes
 *     on the wrong worksheet.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getTable: vi.fn(), applyTableOps: vi.fn() };
});
vi.mock('@mantle/content/table-storage', () => ({ tableSqlSurface: vi.fn(async () => null) }));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSpreadsheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { getTable, applyTableOps } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const rowAdd = TABLE_TOOLS.find((t) => t.slug === 'table_row_add')!;
const rowUpdate = TABLE_TOOLS.find((t) => t.slug === 'table_row_update')!;
const rowGet = TABLE_TOOLS.find((t) => t.slug === 'table_row_get')!;
const cellSet = TABLE_TOOLS.find((t) => t.slug === 'table_cell_set')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

type Result = Awaited<ReturnType<(typeof rowAdd)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const columns = [
  { id: 'c_svc', name: 'Service Name', type: 'text' },
  { id: 'c_mol', name: 'Mol %', type: 'number' },
];

/** Two columns, one row, two tabs. */
const detail = (over: Record<string, unknown> = {}) => ({
  id: TABLE_ID,
  title: 'Services',
  draft: null,
  tabId: 'tab_main',
  tabs: [
    { id: 'tab_main', name: 'Main' },
    { id: 'tab_arch', name: 'Archive' },
  ],
  data: { columns, rows: [{ id: 'r1', cells: { c_svc: 'Cracking', c_mol: 12 } }] },
  ...over,
});

const applied = (ok: boolean, createdIds: string[] = []) => ({ ok, draftRev: 4, createdIds });

const opsSent = () => vi.mocked(applyTableOps).mock.calls[0]![2] as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTable).mockResolvedValue(detail() as never);
  vi.mocked(applyTableOps).mockResolvedValue(applied(true, ['r_new']) as never);
  vi.mocked(tableSqlSurface).mockResolvedValue(null as never);
});

describe('table_row_add', () => {
  it('requires a table id and issues no op without one', async () => {
    expect(errorOf(await rowAdd.handler({ cells: { 'Mol %': 1 } }, ctx))).toMatch(
      /table_id is required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('keys cells by column id (from names), appends, and reports the DRAFT write', async () => {
    const res = await rowAdd.handler(
      { table_id: TABLE_ID, cells: { 'Service Name': 'Alkylation', c_mol: 7 } },
      ctx,
    );
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'row_add', cells: { c_svc: 'Alkylation', c_mol: 7 }, afterRowId: null },
    ]);
    // Untargeted: no tabId key at all, so the engine applies to the first tab.
    expect(opsSent()[0]).not.toHaveProperty('tabId');
    const out = outputOf(res);
    expect(out.row_id).toBe('r_new');
    expect(out.draft_saved).toBe(true);
    expect(out.hint).toMatch(/published table is unchanged/);
    expect(out).not.toHaveProperty('ignored_columns');
  });

  it('reports unknown column keys instead of dropping them silently', async () => {
    const out = outputOf(
      await rowAdd.handler({ table_id: TABLE_ID, cells: { 'Mol %': 3, Bogus: 'x' } }, ctx),
    );
    expect(out.ignored_columns).toEqual(['Bogus']);
    expect(opsSent()[0]!.cells).toEqual({ c_mol: 3 });
  });

  it('carries after_row_id for an insert', async () => {
    await rowAdd.handler({ table_id: TABLE_ID, cells: {}, after_row_id: 'r1' }, ctx);
    expect(opsSent()[0]!.afterRowId).toBe('r1');
  });

  it('loads the targeted tab and stamps its id on the op', async () => {
    await rowAdd.handler({ table_id: TABLE_ID, cells: { 'Mol %': 1 }, tab: 'archive' }, ctx);
    // Name match is case-insensitive; the scoped read is what validates the
    // column against THAT tab's doc.
    expect(getTable).toHaveBeenCalledWith('o1', TABLE_ID, { tabId: 'tab_arch' });
    expect(opsSent()[0]!.tabId).toBe('tab_arch');
  });

  it('refuses an unknown tab, naming the real ones, without issuing an op', async () => {
    const res = await rowAdd.handler({ table_id: TABLE_ID, cells: {}, tab: 'Ghost' }, ctx);
    expect(errorOf(res)).toMatch(/no tab 'Ghost'.*Main, Archive/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report a row id when the draft moved under it', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(errorOf(await rowAdd.handler({ table_id: TABLE_ID, cells: {} }, ctx))).toMatch(
      /concurrently/,
    );
  });

  it('reports not-found when the table vanished mid-call', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(null as never);
    expect(errorOf(await rowAdd.handler({ table_id: TABLE_ID, cells: {} }, ctx))).toMatch(
      /not found/i,
    );
  });
});

describe('table_row_update', () => {
  it('requires both ids', async () => {
    expect(
      errorOf(await rowUpdate.handler({ table_id: TABLE_ID, cells: { c_mol: 1 } }, ctx)),
    ).toMatch(/table_id and row_id are required/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a call that sends `values` instead of `cells`, before touching the table', async () => {
    // The trap: `values` is not a recognised key, so `cells` is empty. On
    // this path that must be an error, not an empty merge that burns a
    // draft revision and reports success.
    const res = await rowUpdate.handler(
      { table_id: TABLE_ID, row_id: 'r1', values: { 'Mol %': 99 } },
      ctx,
    );
    expect(errorOf(res)).toMatch(/cells is required/);
    expect(getTable).not.toHaveBeenCalled();
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a row that is not there, without issuing an op', async () => {
    const res = await rowUpdate.handler(
      { table_id: TABLE_ID, row_id: 'r_missing', cells: { c_mol: 1 } },
      ctx,
    );
    expect(errorOf(res)).toMatch(/row r_missing not found/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('merges ONLY the given cells (keyed by id) into the draft', async () => {
    const res = await rowUpdate.handler(
      { table_id: TABLE_ID, row_id: 'r1', cells: { 'Mol %': 30, Bogus: 1 } },
      ctx,
    );
    // c_svc is absent from the op: the engine merges, so the untouched cell
    // survives. A whole-row replace here would blank it.
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'row_update', rowId: 'r1', cells: { c_mol: 30 } },
    ]);
    const out = outputOf(res);
    expect(out).toMatchObject({ row_id: 'r1', ignored_columns: ['Bogus'], draft_saved: true });
  });

  it('stamps the targeted tab id on the op', async () => {
    await rowUpdate.handler(
      { table_id: TABLE_ID, row_id: 'r1', cells: { c_mol: 1 }, tab: 'Archive' },
      ctx,
    );
    expect(opsSent()[0]!.tabId).toBe('tab_arch');
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(
        await rowUpdate.handler({ table_id: TABLE_ID, row_id: 'r1', cells: { c_mol: 1 } }, ctx),
      ),
    ).toMatch(/concurrently/);
  });
});

describe('table_row_get', () => {
  it('requires both ids', async () => {
    expect(errorOf(await rowGet.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and row_id are required/,
    );
    expect(getTable).not.toHaveBeenCalled();
  });

  it('returns the cells by id AND by name, filling absent cells with null', async () => {
    vi.mocked(getTable).mockResolvedValue(
      detail({ data: { columns, rows: [{ id: 'r1', cells: { c_svc: 'Cracking' } }] } }) as never,
    );
    const out = outputOf(await rowGet.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx));
    expect(out.cells).toEqual({ c_svc: 'Cracking' });
    expect(out.by_name).toEqual({ 'Service Name': 'Cracking', 'Mol %': null });
    // A read never writes.
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('reads the DRAFT when one is pending, not the published grid', async () => {
    vi.mocked(getTable).mockResolvedValue(
      detail({
        draft: { columns, rows: [{ id: 'r1', cells: { c_svc: 'Cracking', c_mol: 99 } }] },
      }) as never,
    );
    const out = outputOf(await rowGet.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx));
    // Published says 12; the in-flight edit says 99. The edit tools wrote 99,
    // so a follow-up read must see it or the agent will "fix" it again.
    expect((out.by_name as Record<string, unknown>)['Mol %']).toBe(99);
  });

  it('reports a missing row with the recovery tool, without probing the workbook file', async () => {
    const res = await rowGet.handler({ table_id: TABLE_ID, row_id: 'r_missing' }, ctx);
    expect(errorOf(res)).toMatch(/row r_missing not found.*table_rows_list/);
    // The doc is not clipped, so the row is definitively absent: no file probe.
    expect(tableSqlSurface).not.toHaveBeenCalled();
  });

  it('falls through to the workbook file only when the doc is clipped', async () => {
    vi.mocked(getTable).mockResolvedValue(detail({ docClipped: true }) as never);
    const res = await rowGet.handler({ table_id: TABLE_ID, row_id: 'r_far' }, ctx);
    expect(tableSqlSurface).toHaveBeenCalledWith('o1', TABLE_ID);
    // No surface (legacy table): still a clean not-found, not a throw.
    expect(errorOf(res)).toMatch(/row r_far not found/);
  });

  it('reads the targeted tab', async () => {
    await rowGet.handler({ table_id: TABLE_ID, row_id: 'r1', tab: 'Archive' }, ctx);
    expect(getTable).toHaveBeenCalledWith('o1', TABLE_ID, { tabId: 'tab_arch' });
  });
});

describe('table_cell_set', () => {
  it('requires table, row and column', async () => {
    expect(errorOf(await cellSet.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx))).toMatch(
      /table_id, row_id and column are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a missing row or an unknown column without issuing an op', async () => {
    expect(
      errorOf(
        await cellSet.handler({ table_id: TABLE_ID, row_id: 'r9', column: 'Mol %', value: 1 }, ctx),
      ),
    ).toMatch(/row r9 not found/);
    expect(
      errorOf(
        await cellSet.handler({ table_id: TABLE_ID, row_id: 'r1', column: 'Nope', value: 1 }, ctx),
      ),
    ).toMatch(/column 'Nope' not found/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('resolves the column by name and writes the cell to draft by id', async () => {
    const res = await cellSet.handler(
      { table_id: TABLE_ID, row_id: 'r1', column: 'Mol %', value: 55 },
      ctx,
    );
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'cell_set', rowId: 'r1', columnId: 'c_mol', value: 55 },
    ]);
    expect(outputOf(res)).toMatchObject({ row_id: 'r1', column_id: 'c_mol', draft_saved: true });
  });

  it('sends an explicit null when value is omitted, so the cell CLEARS', async () => {
    await cellSet.handler({ table_id: TABLE_ID, row_id: 'r1', column: 'c_mol' }, ctx);
    // `undefined` would be dropped by JSON transport and read as "keep".
    expect(opsSent()[0]!.value).toBeNull();
  });

  it('stamps the targeted tab id on the op', async () => {
    await cellSet.handler(
      { table_id: TABLE_ID, row_id: 'r1', column: 'c_mol', value: 1, tab: 'tab_arch' },
      ctx,
    );
    expect(opsSent()[0]!.tabId).toBe('tab_arch');
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(
        await cellSet.handler({ table_id: TABLE_ID, row_id: 'r1', column: 'c_mol', value: 1 }, ctx),
      ),
    ).toMatch(/concurrently/);
  });
});
