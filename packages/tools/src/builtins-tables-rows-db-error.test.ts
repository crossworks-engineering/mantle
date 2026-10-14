/**
 * The row tools never answer a database error's own text (A5 step 4
 * re-audit, LOW-C). applyTableOps can throw a Drizzle error (a deadlock, a
 * lock timeout) whose message carries the SQL and its parameters; the
 * /api/v1 rows routes answer the tool's error as their 400 body, and that
 * entry runs no masking of its own. Each row tool answers such an error in
 * the one mapper's words (publicErrorMessage) for every caller, and keeps
 * the text of an error that is not the database's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getTable: vi.fn(), applyTableOps: vi.fn() };
});
vi.mock('@mantle/content/table-storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tableSqlSurface: vi.fn(async () => null),
}));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSpreadsheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { applyTableOps, getTable } from '@mantle/content';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

const detail = {
  id: TABLE_ID,
  title: 'Services',
  draft: null,
  tabId: 'tab_main',
  tabs: [{ id: 'tab_main', name: 'Main' }],
  data: {
    columns: [{ id: 'c_svc', name: 'Service Name', type: 'text' }],
    rows: [{ id: 'r1', cells: { c_svc: 'Cracking' } }],
  },
};

/** One call per row tool that reaches applyTableOps. */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['table_row_add', { table_id: TABLE_ID, cells: { 'Service Name': 'A' } }],
  ['table_rows_add', { table_id: TABLE_ID, rows: [{ 'Service Name': 'A' }] }],
  [
    'table_rows_upsert',
    { table_id: TABLE_ID, key: 'Service Name', rows: [{ 'Service Name': 'New' }] },
  ],
  ['table_row_update', { table_id: TABLE_ID, row_id: 'r1', cells: { 'Service Name': 'B' } }],
  ['table_row_delete', { table_id: TABLE_ID, row_id: 'r1' }],
  ['table_cell_set', { table_id: TABLE_ID, row_id: 'r1', column: 'Service Name', value: 'C' }],
];

/** A Drizzle query error over a deadlock, shaped as drizzle-orm throws it. */
function drizzleDeadlock(): Error {
  const cause = Object.assign(new Error('deadlock detected'), {
    code: '40P01',
    severity: 'ERROR',
  });
  return Object.assign(
    new Error(
      'Failed query: update "table_drafts" set "doc" = $1 where "id" = $2\nparams: {"secret":1},t1',
    ),
    { name: 'DrizzleQueryError', cause },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(getTable).mockResolvedValue(detail as never);
});

describe('row tools mask a database error thrown by applyTableOps', () => {
  it.each(CALLS)('%s answers the one mapper words, never the SQL', async (slug, input) => {
    vi.mocked(applyTableOps).mockRejectedValue(drizzleDeadlock());
    const tool = TABLE_TOOLS.find((t) => t.slug === slug)!;
    const res = await tool.handler(input, ctx);
    expect(applyTableOps).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, error: DATABASE_ERROR_PUBLIC });
  });

  it.each(CALLS)('%s keeps the text of an error that is not the database', async (slug, input) => {
    vi.mocked(applyTableOps).mockRejectedValue(new Error('cell value is too long'));
    const tool = TABLE_TOOLS.find((t) => t.slug === slug)!;
    const res = await tool.handler(input, ctx);
    expect(res).toEqual({ ok: false, error: 'cell value is too long' });
  });
});
