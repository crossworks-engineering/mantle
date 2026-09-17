/**
 * Tests for the structural write tools: table_column_add,
 * table_column_update, table_tab_add, table_tab_rename.
 *
 * The DB edges (getTable / applyTableOps) are stubbed; column resolution,
 * the option/format/formula shaping, reference-target resolution and the
 * draft-op envelope are real.
 *
 * What is worth pinning:
 *
 *  - Validation happens BEFORE any op is issued. An invalid type or an
 *    unknown column must not cost a draft revision, and a reference column
 *    without a source must be refused with the shape the caller needs.
 *  - The op carries IDS. A column named by the caller is deleted, updated
 *    or inserted-after by id; a tab is renamed by id. A name-keyed op would
 *    match nothing in the grid, or the wrong thing after a rename.
 *  - column_update sends ONLY the fields given. The engine treats an absent
 *    key as "keep", so a patch that echoes the current name alongside a
 *    retype would still be correct but a patch that sends `formula: ''`
 *    when nothing was asked would clear a formula.
 *  - All four write to DRAFT and refuse to report success on a conflict.
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
import { TABLE_TOOLS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const colAdd = TABLE_TOOLS.find((t) => t.slug === 'table_column_add')!;
const colUpdate = TABLE_TOOLS.find((t) => t.slug === 'table_column_update')!;
const tabAdd = TABLE_TOOLS.find((t) => t.slug === 'table_tab_add')!;
const tabRename = TABLE_TOOLS.find((t) => t.slug === 'table_tab_rename')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

type Result = Awaited<ReturnType<(typeof colAdd)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

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
      { id: 'c_calc', name: 'Calc', type: 'formula', formula: '{Mol %} * 2' },
    ],
    rows: [{ id: 'r1', cells: { c_svc: 'Cracking', c_mol: 12 } }],
  },
  ...over,
});

const applied = (ok: boolean, createdIds: string[] = []) => ({ ok, draftRev: 4, createdIds });

const opsSent = () => vi.mocked(applyTableOps).mock.calls[0]![2] as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTable).mockResolvedValue(detail() as never);
  vi.mocked(applyTableOps).mockResolvedValue(applied(true, ['created_1']) as never);
});

describe('table_column_add', () => {
  it('refuses an invalid type before loading the table', async () => {
    const res = await colAdd.handler({ table_id: TABLE_ID, name: 'X', type: 'money' }, ctx);
    expect(errorOf(res)).toMatch(/invalid type 'money'/);
    expect(getTable).not.toHaveBeenCalled();
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('issues a column_add op carrying a fresh id, and echoes that id', async () => {
    const res = await colAdd.handler({ table_id: TABLE_ID, name: 'Qty', type: 'number' }, ctx);
    const [owner, id] = vi.mocked(applyTableOps).mock.calls[0]!;
    expect([owner, id]).toEqual(['o1', TABLE_ID]);
    const op = opsSent()[0]!;
    expect(op.op).toBe('column_add');
    expect(op.afterColumnId).toBeNull();
    const column = op.column as Record<string, unknown>;
    expect(column).toMatchObject({ name: 'Qty', type: 'number' });
    expect(column.id).toMatch(/^[0-9a-f-]{36}$/);
    const out = outputOf(res);
    // The id the caller gets back must be the id the grid will hold.
    expect(out.column_id).toBe(column.id);
    expect(out.draft_saved).toBe(true);
  });

  it('shapes options into {id,label} pairs and carries format + formula', async () => {
    await colAdd.handler(
      {
        table_id: TABLE_ID,
        name: 'Status',
        type: 'select',
        options: ['Open', 'In Progress'],
        format: { decimals: 0 },
        formula: ' {Mol %} / 2 ',
      },
      ctx,
    );
    const column = opsSent()[0]!.column as Record<string, unknown>;
    expect(column.options).toEqual([
      { id: 'open', label: 'Open' },
      { id: 'in_progress', label: 'In Progress' },
    ]);
    expect(column.format).toEqual({ decimals: 0 });
    expect(column.formula).toBe('{Mol %} / 2');
  });

  it('resolves after_column by NAME to an id', async () => {
    await colAdd.handler(
      { table_id: TABLE_ID, name: 'Qty', type: 'number', after_column: 'Service Name' },
      ctx,
    );
    expect(opsSent()[0]!.afterColumnId).toBe('c_svc');
  });

  it('refuses a reference column without a source, naming the shape needed', async () => {
    const res = await colAdd.handler({ table_id: TABLE_ID, name: 'Model', type: 'reference' }, ctx);
    expect(errorOf(res)).toMatch(/reference: \{ tab, column \}/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('resolves the reference source (tab + column by name) to ids on the column spec', async () => {
    await colAdd.handler(
      {
        table_id: TABLE_ID,
        name: 'Model',
        type: 'reference',
        reference: { tab: 'Archive', column: 'Service Name' },
      },
      ctx,
    );
    // The source tab is read scoped, so the column resolves against ITS doc.
    expect(getTable).toHaveBeenCalledWith('o1', TABLE_ID, { tabId: 'tab_arch' });
    const column = opsSent()[0]!.column as Record<string, unknown>;
    expect(column.ref).toEqual({ tabId: 'tab_arch', columnId: 'c_svc' });
  });

  it('refuses a reference that targets a formula column', async () => {
    const res = await colAdd.handler(
      {
        table_id: TABLE_ID,
        name: 'M',
        type: 'reference',
        reference: { tab: 'Main', column: 'Calc' },
      },
      ctx,
    );
    expect(errorOf(res)).toMatch(/cannot target a formula column/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('stamps the targeted tab id on the op', async () => {
    await colAdd.handler({ table_id: TABLE_ID, name: 'Qty', type: 'number', tab: 'Archive' }, ctx);
    expect(opsSent()[0]!.tabId).toBe('tab_arch');
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(await colAdd.handler({ table_id: TABLE_ID, name: 'Q', type: 'text' }, ctx)),
    ).toMatch(/concurrently/);
  });
});

describe('table_column_update', () => {
  it('requires table and column', async () => {
    expect(errorOf(await colUpdate.handler({ table_id: TABLE_ID, name: 'x' }, ctx))).toMatch(
      /table_id and column are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses an unknown column and an empty patch, issuing no op', async () => {
    expect(
      errorOf(await colUpdate.handler({ table_id: TABLE_ID, column: 'Nope', name: 'x' }, ctx)),
    ).toMatch(/column 'Nope' not found/);
    expect(errorOf(await colUpdate.handler({ table_id: TABLE_ID, column: 'Mol %' }, ctx))).toMatch(
      /nothing to update/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('renames by NAME with a patch holding ONLY the given field', async () => {
    const res = await colUpdate.handler(
      { table_id: TABLE_ID, column: 'Mol %', name: 'Mole %' },
      ctx,
    );
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'column_update', columnId: 'c_mol', patch: { name: 'Mole %' } },
    ]);
    expect(outputOf(res)).toMatchObject({ column_id: 'c_mol', draft_saved: true });
  });

  it('retypes and replaces options in one patch', async () => {
    await colUpdate.handler(
      { table_id: TABLE_ID, column: 'c_svc', type: 'select', options: ['A', 'B c'] },
      ctx,
    );
    expect(opsSent()[0]!.patch).toEqual({
      type: 'select',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b_c', label: 'B c' },
      ],
    });
  });

  it('refuses an invalid type without issuing an op', async () => {
    const res = await colUpdate.handler(
      { table_id: TABLE_ID, column: 'c_mol', type: 'money' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/invalid type 'money'/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a retype to reference without a source', async () => {
    const res = await colUpdate.handler(
      { table_id: TABLE_ID, column: 'c_svc', type: 'reference' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/retyping to reference needs/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(await colUpdate.handler({ table_id: TABLE_ID, column: 'c_mol', name: 'x' }, ctx)),
    ).toMatch(/concurrently/);
  });
});

describe('table_tab_add', () => {
  it('requires table and name', async () => {
    expect(errorOf(await tabAdd.handler({ table_id: TABLE_ID }, ctx))).toMatch(
      /table_id and name are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('appends a tab and reports the id the engine minted', async () => {
    const res = await tabAdd.handler({ table_id: TABLE_ID, name: 'Q3' }, ctx);
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [{ op: 'tab_add', name: 'Q3' }]);
    // No afterTabId key when appending: the engine must not read "after null"
    // as "insert at the start".
    expect(opsSent()[0]).not.toHaveProperty('afterTabId');
    expect(outputOf(res)).toMatchObject({ tab_id: 'created_1', name: 'Q3', draft_saved: true });
  });

  it('resolves after_tab by name to an id', async () => {
    await tabAdd.handler({ table_id: TABLE_ID, name: 'Q3', after_tab: 'Archive' }, ctx);
    expect(opsSent()[0]!.afterTabId).toBe('tab_arch');
  });

  it('refuses an unknown after_tab without issuing an op', async () => {
    const res = await tabAdd.handler({ table_id: TABLE_ID, name: 'Q3', after_tab: 'Ghost' }, ctx);
    expect(errorOf(res)).toMatch(/no tab 'Ghost'/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report a tab id on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(errorOf(await tabAdd.handler({ table_id: TABLE_ID, name: 'Q3' }, ctx))).toMatch(
      /concurrently/,
    );
  });
});

describe('table_tab_rename', () => {
  it('requires a new name', async () => {
    expect(errorOf(await tabRename.handler({ table_id: TABLE_ID, tab: 'Main' }, ctx))).toMatch(
      /name are required/,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('renames the named tab by ID', async () => {
    const res = await tabRename.handler({ table_id: TABLE_ID, tab: 'Archive', name: 'Old' }, ctx);
    expect(applyTableOps).toHaveBeenCalledWith('o1', TABLE_ID, [
      { op: 'tab_rename', tabId: 'tab_arch', name: 'Old' },
    ]);
    expect(outputOf(res)).toMatchObject({ tab_id: 'tab_arch', name: 'Old', draft_saved: true });
  });

  it('refuses an unknown tab without issuing an op', async () => {
    const res = await tabRename.handler({ table_id: TABLE_ID, tab: 'Ghost', name: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/no tab 'Ghost'/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('refuses a legacy table with no tab metadata rather than renaming nothing', async () => {
    vi.mocked(getTable).mockResolvedValue(detail({ tabs: [], tabId: undefined }) as never);
    const res = await tabRename.handler({ table_id: TABLE_ID, name: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/tab is required/);
    expect(applyTableOps).not.toHaveBeenCalled();
  });

  it('does NOT report success on a concurrent draft change', async () => {
    vi.mocked(applyTableOps).mockResolvedValue(applied(false) as never);
    expect(
      errorOf(await tabRename.handler({ table_id: TABLE_ID, tab: 'Main', name: 'x' }, ctx)),
    ).toMatch(/concurrently/);
  });
});
