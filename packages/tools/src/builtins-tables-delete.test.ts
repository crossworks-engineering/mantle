/**
 * Tests for the four table DELETE tools — table_delete, table_row_delete,
 * table_column_delete, table_tab_delete. None had a behavioural test, which
 * made them the largest untested data-loss surface in the tool set.
 *
 * The DB edges (getTable / applyTableOps / deleteTable) are stubbed; the
 * tools' own logic — argument guards, existence checks, tab targeting, and
 * the conflict arm — is real.
 *
 * Three properties carry the weight, and each is a way to lose data quietly:
 *
 *  1. A delete that did not happen must not report that it did. `applyTableOps`
 *     returning `{ok: false}` means a concurrent draft revision won; saying
 *     "deleted" there tells the model the row is gone when it is not.
 *  2. A delete must not be ISSUED for something that is not there. Both
 *     row and column resolve their target first and refuse by name.
 *  3. When a tab is explicitly targeted, the op must CARRY that tab id.
 *     Dropping it applies the delete to the first tab instead — the same
 *     call, silently aimed at the wrong worksheet.
 *
 * The "refuses to delete the last remaining tab" rule in table_tab_delete's
 * description is enforced one layer down, in `applyOpsToFile`, and tested in
 * packages/tabledb/src/multi-tab.test.ts. What is pinned HERE is that the
 * tool surfaces that refusal as a clean error instead of throwing.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getTable: vi.fn(), applyTableOps: vi.fn(), deleteTable: vi.fn() };
});
// Returns a promise: windowFile does `tableSqlSurface(...).catch(...)`, so a
// bare vi.fn() (undefined) throws before the tool's own logic is reached.
vi.mock('@mantle/content/table-storage', () => ({ tableSqlSurface: vi.fn(async () => null) }));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));

import { getTable, applyTableOps, deleteTable } from '@mantle/content';
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const del = TABLE_TOOLS.find((t) => t.slug === 'table_delete')!;
const rowDel = TABLE_TOOLS.find((t) => t.slug === 'table_row_delete')!;
const colDel = TABLE_TOOLS.find((t) => t.slug === 'table_column_delete')!;
const tabDel = TABLE_TOOLS.find((t) => t.slug === 'table_tab_delete')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

type Result = Awaited<ReturnType<(typeof del)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Two columns, one row, two tabs — enough to target the wrong one. */
const detail = (over: Record<string, unknown> = {}) => ({
  id: TABLE_ID,
  title: 'Services',
  draft: null,
  tabId: 'tab_main',
  tabs: [
    { id: 'tab_main', name: 'Main' },
    { id: 'tab_arch', name: 'Archive' },
  ],
  data: {
    columns: [
      { id: 'c_svc', name: 'Service Name', type: 'text' },
      { id: 'c_mol', name: 'Mol %', type: 'number' },
    ],
    rows: [{ id: 'r1', cells: { c_svc: 'Cracking', c_mol: 12 } }],
  },
  ...over,
});

const applied = (ok: boolean) => ({ ok, draftRev: 4, createdIds: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTable).mockResolvedValue(detail() as never);
  vi.mocked(applyTableOps).mockResolvedValue(applied(true) as never);
});

describe('table_delete (whole table, irreversible)', () => {
  it('is confirm-gated', () => {
    // The only guard between an agent and a permanently deleted grid.
    expect(del.requiresConfirm).toBe(true);
  });

  it('refuses a blank id WITHOUT calling the store', async () => {
    const res = await del.handler({ id: '  ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(deleteTable).not.toHaveBeenCalled();
  });

  it('reports not-found rather than success when nothing was deleted', async () => {
    vi.mocked(deleteTable).mockResolvedValue(false);
    const res = await del.handler({ id: TABLE_ID }, ctx);
    // `deleteTable` returning false means the id matched no table the owner
    // has. Reporting `deleted: true` there would tell the model a table it
    // still holds is gone.
    expect(errorOf(res)).toMatch(/not found/i);
  });

  it('reports the deletion when the store confirms it', async () => {
    vi.mocked(deleteTable).mockResolvedValue(true);
    const res = await del.handler({ id: TABLE_ID }, ctx);
    expect(deleteTable).toHaveBeenCalledWith('o1', TABLE_ID);
    expect(outputOf(res)).toEqual({ id: TABLE_ID, deleted: true });
  });

  it('surfaces a store failure instead of reporting success', async () => {
    vi.mocked(deleteTable).mockRejectedValue(new Error('db down'));
    expect(errorOf(await del.handler({ id: TABLE_ID }, ctx))).toBe('db down');
  });
});

describe('table_row_delete', () => {
  it('requires both ids and issues no op without them', async () => {
    expect(errorOf(await rowDel.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and row_id are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a row that is not there, without issuing a delete op', async () => {
    const res = await rowDel.handler({ table_id: TABLE_ID, row_id: 'r_missing' }, ctx);
    expect(errorOf(res)).toMatch(/row r_missing not found/);
    // Issuing the op anyway would burn a draft revision to delete nothing.
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('deletes an existing row and reports the draft write', async () => {
    const res = await rowDel.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx);
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [{ op: 'row_delete', rowId: 'r1' }]);
    const out = outputOf(res);
    expect(out.deleted).toBe(true);
    expect(out.draft_saved).toBe(true);
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    const res = await rowDel.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx);
    // A conflict means the row is still there. This is the arm that must
    // never read as "deleted" — the caller has to retry, not move on.
    expect(errorOf(res)).toMatch(/concurrently/);
  });

  it('reports not-found when the table vanished mid-call', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(null as never);
    expect(errorOf(await rowDel.handler({ table_id: TABLE_ID, row_id: 'r1' }, ctx))).toMatch(
      /not found/i,
    );
  });
});

describe('table_column_delete', () => {
  it('requires both arguments', async () => {
    expect(errorOf(await colDel.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and column are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('resolves a column by NAME and deletes it by id', async () => {
    const res = await colDel.handler({ table_id: TABLE_ID, column: 'Mol %' }, ctx);
    // The op must carry the column ID even though the caller named it — a
    // name-keyed op would not match anything in the grid.
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'column_delete', columnId: 'c_mol' },
    ]);
    expect(outputOf(res).column_id).toBe('c_mol');
  });

  it('refuses an unknown column without issuing an op', async () => {
    const res = await colDel.handler({ table_id: TABLE_ID, column: 'Nope' }, ctx);
    expect(errorOf(res)).toMatch(/column 'Nope' not found/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(errorOf(await colDel.handler({ table_id: TABLE_ID, column: 'Mol %' }, ctx))).toMatch(
      /concurrently/,
    );
  });
});

describe('table_tab_delete', () => {
  it('requires a table and a tab', async () => {
    expect(errorOf(await tabDel.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and tab are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a tab name that is not on the table, and lists what is', async () => {
    const res = await tabDel.handler({ table_id: TABLE_ID, tab: 'Ghost' }, ctx);
    expect(errorOf(res)).toMatch(/no tab 'Ghost'/);
    // The message names the real tabs so the model can correct itself rather
    // than guess again.
    expect(errorOf(res)).toMatch(/Main/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('deletes the named tab by ID', async () => {
    const res = await tabDel.handler({ table_id: TABLE_ID, tab: 'Main' }, ctx);
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'tab_delete', tabId: 'tab_main' },
    ]);
    expect(outputOf(res).tab_id).toBe('tab_main');
  });

  it('surfaces the engine’s last-tab refusal as a clean error', async () => {
    // The rule itself lives in applyOpsToFile (tabledb) and is tested there.
    // What must hold here is that a throw becomes ok:false with the reason
    // intact, not an unhandled rejection out of a tool call.
    vi.mocked(applyTableOps).mockRejectedValue(new Error('cannot delete the last tab'));
    expect(errorOf(await tabDel.handler({ table_id: TABLE_ID, tab: 'Main' }, ctx))).toBe(
      'cannot delete the last tab',
    );
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(errorOf(await tabDel.handler({ table_id: TABLE_ID, tab: 'Main' }, ctx))).toMatch(
      /concurrently/,
    );
  });
});
