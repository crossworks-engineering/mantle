/**
 * Tests for the table-level write tools: table_create, table_update,
 * table_commit, table_set_view, table_set_aggregate.
 *
 * The DB edges (createTable / updateTable / commitTable / getTable /
 * applyTableOps) are stubbed; the tools' own logic (argument guards, patch
 * shaping, column resolution, the draft-op envelope) is real.
 *
 * What is worth pinning, per tool:
 *
 *  - table_create: the seed columns reach the store already narrowed to a
 *    valid TableDoc (an unknown type becomes text, not a crash), and an
 *    ingest trace is recorded, because creation is the moment the node
 *    becomes visible to the brain.
 *  - table_update: only the fields the caller passed reach the store. A
 *    patch that carries `title: undefined` would clear the title on some
 *    store shapes, so "absent" must stay absent.
 *  - table_commit: the SERVER draft is promoted. The tool must not pass a
 *    doc of its own (the third argument), because a round-tripped doc is
 *    the clipped materialize window and would truncate a large table.
 *  - table_set_view / table_set_aggregate: both go through editViaOps, so
 *    they write to DRAFT, target the named tab by id, and refuse to report
 *    success on a concurrent-draft conflict.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getTable: vi.fn(),
    applyTableOps: vi.fn(),
    createTable: vi.fn(),
    updateTable: vi.fn(),
    commitTable: vi.fn(),
  };
});
vi.mock('@mantle/content/table-storage', () => ({ tableSqlSurface: vi.fn(async () => null) }));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSpreadsheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { getTable, applyTableOps, createTable, updateTable, commitTable } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const create = TABLE_TOOLS.find((t) => t.slug === 'table_create')!;
const update = TABLE_TOOLS.find((t) => t.slug === 'table_update')!;
const commit = TABLE_TOOLS.find((t) => t.slug === 'table_commit')!;
const setView = TABLE_TOOLS.find((t) => t.slug === 'table_set_view')!;
const setAgg = TABLE_TOOLS.find((t) => t.slug === 'table_set_aggregate')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

type Result = Awaited<ReturnType<(typeof create)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Two columns, two numeric rows (so a sum has something to add), two tabs. */
const detail = (over: Record<string, unknown> = {}) => ({
  id: TABLE_ID,
  title: 'Services',
  tags: ['ops'],
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
    rows: [
      { id: 'r1', cells: { c_svc: 'Cracking', c_mol: 12 } },
      { id: 'r2', cells: { c_svc: 'Reforming', c_mol: 30 } },
    ],
  },
  ...over,
});

const applied = (ok: boolean) => ({ ok, draftRev: 4, createdIds: [] });

/** The op list handed to applyTableOps on the first call. */
const opsSent = () => vi.mocked(applyTableOps).mock.calls[0]![2] as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTable).mockResolvedValue(detail() as never);
  vi.mocked(applyTableOps).mockResolvedValue(applied(true) as never);
  vi.mocked(createTable).mockResolvedValue(
    detail({ id: 'new_t', title: 'Stock', data: { columns: [], rows: [] } }) as never,
  );
  vi.mocked(updateTable).mockResolvedValue(detail({ title: 'Renamed' }) as never);
  vi.mocked(commitTable).mockResolvedValue(
    detail({ rowCount: 2, columnCount: 2, draft: null }) as never,
  );
});

describe('table_create', () => {
  it('refuses a blank title without touching the store', async () => {
    expect(errorOf(await create.handler({ title: '  ' }, ctx))).toMatch(/title is required/);
    expect(createTable).not.toHaveBeenCalled();
  });

  it('seeds the columns as a narrowed TableDoc, owner-scoped', async () => {
    await create.handler(
      { title: 'Stock', columns: [{ name: 'Qty', type: 'number' }, { name: 'Note' }], tags: ['x'] },
      ctx,
    );
    expect(createTable).toHaveBeenCalledTimes(1);
    const [owner, input] = vi.mocked(createTable).mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(owner).toBe('o1');
    expect(input.title).toBe('Stock');
    expect(input.tags).toEqual(['x']);
    const data = input.data as { columns: Array<{ name: string; type: string }>; rows: unknown[] };
    // A missing type defaults to text rather than producing an untyped column.
    expect(data.columns.map((c) => [c.name, c.type])).toEqual([
      ['Qty', 'number'],
      ['Note', 'text'],
    ]);
    expect(data.rows).toEqual([]);
  });

  it('omits `data` entirely when no columns are given, so the store starts an empty grid', async () => {
    await create.handler({ title: 'Blank' }, ctx);
    const input = vi.mocked(createTable).mock.calls[0]![1] as Record<string, unknown>;
    expect(input).not.toHaveProperty('data');
  });

  it('caps the title at 200 characters', async () => {
    await create.handler({ title: 'x'.repeat(250) }, ctx);
    const input = vi.mocked(createTable).mock.calls[0]![1] as Record<string, unknown>;
    expect((input.title as string).length).toBe(200);
  });

  it('reports the created table and records the ingest', async () => {
    vi.mocked(createTable).mockResolvedValue(
      detail({
        id: 'new_t',
        title: 'Stock',
        data: { columns: [{ id: 'c1', name: 'Qty', type: 'number' }], rows: [] },
      }) as never,
    );
    const out = outputOf(await create.handler({ title: 'Stock' }, ctx));
    expect(out).toEqual({
      id: 'new_t',
      title: 'Stock',
      columns: [{ id: 'c1', name: 'Qty', type: 'number' }],
    });
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        nodeId: 'new_t',
        payload: expect.objectContaining({ via: 'table_create_tool' }),
      }),
    );
  });

  it('surfaces a store failure as an error', async () => {
    vi.mocked(createTable).mockRejectedValue(new Error('db down'));
    expect(errorOf(await create.handler({ title: 'Stock' }, ctx))).toBe('db down');
  });
});

describe('table_update', () => {
  it('refuses a blank id without calling the store', async () => {
    expect(errorOf(await update.handler({ id: ' ', title: 'x' }, ctx))).toMatch(/id is required/);
    expect(updateTable).not.toHaveBeenCalled();
  });

  it('refuses an empty patch, and a wrongly-typed field does not count as a patch', async () => {
    // `tags` must be an array; a bare string is ignored, so this is "nothing".
    const res = await update.handler({ id: TABLE_ID, tags: 'ops' }, ctx);
    expect(errorOf(res)).toMatch(/nothing to update/);
    expect(updateTable).not.toHaveBeenCalled();
  });

  it('sends ONLY the fields given, trimmed, owner-scoped', async () => {
    await update.handler({ id: TABLE_ID, title: '  Renamed  ' }, ctx);
    // An absent field must stay absent: `{ title, tags: undefined }` would
    // read as "clear the tags" on a store that spreads the patch.
    expect(updateTable).toHaveBeenCalledWith('o1', TABLE_ID, { title: 'Renamed' });
  });

  it('replaces the tag set, keeping only string members', async () => {
    await update.handler({ id: TABLE_ID, tags: ['a', 7, 'b'] }, ctx);
    expect(updateTable).toHaveBeenCalledWith('o1', TABLE_ID, { tags: ['a', 'b'] });
  });

  it('reports not-found when the store matched nothing the owner has', async () => {
    vi.mocked(updateTable).mockResolvedValue(null);
    expect(errorOf(await update.handler({ id: TABLE_ID, title: 'x' }, ctx))).toMatch(/table_list/);
  });

  it('echoes the updated metadata', async () => {
    const out = outputOf(await update.handler({ id: TABLE_ID, title: 'Renamed' }, ctx));
    expect(out).toEqual({ id: TABLE_ID, title: 'Renamed', tags: ['ops'] });
  });
});

describe('table_commit (draft to published)', () => {
  it('refuses a blank id without calling the store', async () => {
    expect(errorOf(await commit.handler({ id: '' }, ctx))).toMatch(/id is required/);
    expect(commitTable).not.toHaveBeenCalled();
  });

  it('promotes the SERVER draft: owner + id only, never a doc of its own', async () => {
    await commit.handler({ id: TABLE_ID }, ctx);
    // Exactly two arguments. Passing a doc here would publish the clipped
    // materialize window over the full table.
    expect(commitTable).toHaveBeenCalledWith('o1', TABLE_ID);
    expect(vi.mocked(commitTable).mock.calls[0]).toHaveLength(2);
  });

  it('reports the published shape', async () => {
    const out = outputOf(await commit.handler({ id: TABLE_ID }, ctx));
    expect(out).toEqual({ id: TABLE_ID, committed: true, rows: 2, columns: 2 });
  });

  it('reports not-found rather than committed when the store matched nothing', async () => {
    vi.mocked(commitTable).mockResolvedValue(null);
    expect(errorOf(await commit.handler({ id: TABLE_ID }, ctx))).toMatch(/not found/i);
  });

  it('surfaces a store failure instead of reporting committed', async () => {
    vi.mocked(commitTable).mockRejectedValue(new Error('table is app-owned'));
    expect(errorOf(await commit.handler({ id: TABLE_ID }, ctx))).toBe('table is app-owned');
  });
});

describe('table_set_view', () => {
  it('requires a table and a name, issuing no op without them', async () => {
    expect(errorOf(await setView.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and name are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('resolves sort and filter columns by NAME to ids and writes a new view to draft', async () => {
    const res = await setView.handler(
      {
        table_id: TABLE_ID,
        name: 'Big ones',
        sort: [{ column: 'Mol %', dir: 'desc' }],
        filters: [{ column: 'Mol %', op: 'gt', value: 10 }],
      },
      ctx,
    );
    const [owner, id] = vi.mocked(applyTableOps).mock.calls[0]!;
    expect([owner, id]).toEqual(['o1', TABLE_ID]);
    const op = opsSent()[0]!;
    expect(op.op).toBe('view_set');
    const view = op.view as Record<string, unknown>;
    expect(view.name).toBe('Big ones');
    expect(view.sort).toEqual([{ colId: 'c_mol', dir: 'desc' }]);
    expect(view.filters).toEqual([{ colId: 'c_mol', op: 'gt', value: 10 }]);
    expect(view.id).toMatch(/^v_/);
    const out = outputOf(res);
    expect(out.view_id).toBe(view.id);
    expect(out.draft_saved).toBe(true);
  });

  it('keeps the given view_id so an update replaces rather than duplicates', async () => {
    await setView.handler({ table_id: TABLE_ID, name: 'Renamed view', view_id: 'v_keep' }, ctx);
    expect((opsSent()[0]!.view as Record<string, unknown>).id).toBe('v_keep');
  });

  it('carries the targeted tab id on the op and loads that tab', async () => {
    await setView.handler({ table_id: TABLE_ID, name: 'Arch', tab: 'Archive' }, ctx);
    expect(getTable).toHaveBeenCalledWith('o1', TABLE_ID, { tabId: 'tab_arch' });
    expect(opsSent()[0]!.tabId).toBe('tab_arch');
  });

  it('refuses an unknown tab without issuing an op', async () => {
    expect(
      errorOf(await setView.handler({ table_id: TABLE_ID, name: 'x', tab: 'Ghost' }, ctx)),
    ).toMatch(/no tab 'Ghost'/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(errorOf(await setView.handler({ table_id: TABLE_ID, name: 'x' }, ctx))).toMatch(
      /concurrently/,
    );
  });
});

describe('table_set_aggregate', () => {
  it('refuses an invalid kind before loading the table', async () => {
    const res = await setAgg.handler({ table_id: TABLE_ID, column: 'Mol %', kind: 'total' }, ctx);
    expect(errorOf(res)).toMatch(/invalid kind 'total'/);
    expect(getTable).not.toHaveBeenCalled();
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses an unknown column without issuing an op', async () => {
    const res = await setAgg.handler({ table_id: TABLE_ID, column: 'Nope', kind: 'sum' }, ctx);
    expect(errorOf(res)).toMatch(/column 'Nope' not found/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('resolves the column by name, writes the aggregate to draft, and previews the value', async () => {
    const res = await setAgg.handler({ table_id: TABLE_ID, column: 'Mol %', kind: 'sum' }, ctx);
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'aggregate_set', columnId: 'c_mol', kind: 'sum' },
    ]);
    const out = outputOf(res);
    // Computed over the baseline rows (12 + 30) so the caller can quote the
    // total without a second read.
    expect(out).toMatchObject({ column_id: 'c_mol', kind: 'sum', value: 42, draft_saved: true });
  });

  it("clears with kind 'none' and reports a null value", async () => {
    const out = outputOf(
      await setAgg.handler({ table_id: TABLE_ID, column: 'c_mol', kind: 'none' }, ctx),
    );
    expect(opsSent()[0]).toEqual({ op: 'aggregate_set', columnId: 'c_mol', kind: 'none' });
    expect(out.value).toBeNull();
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(await setAgg.handler({ table_id: TABLE_ID, column: 'Mol %', kind: 'sum' }, ctx)),
    ).toMatch(/concurrently/);
  });
});
