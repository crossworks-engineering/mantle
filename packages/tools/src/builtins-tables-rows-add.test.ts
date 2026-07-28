/**
 * Tests for table_rows_add — the bulk twin of table_row_add.
 *
 * The contract under test is what makes it safe to prefer over N single
 * calls: the WHOLE batch goes to applyTableOps in one call (one atomic
 * draft revision — never a half-applied append), cell keys resolve by
 * column name or id with unknown columns reported (not silently dropped
 * per-row), and the row-id echo stays context-lean for big batches.
 * Real doc helpers (ensureTableDoc/findColumn/…) run under the mock; only
 * the DB edges (getTable/applyTableOps) are stubbed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getTable: vi.fn(), applyTableOps: vi.fn() };
});
vi.mock('@mantle/content/table-storage', () => ({ tableSqlSurface: vi.fn() }));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files/sheet-to-grid', () => ({
  parseSheetToGrid: vi.fn(),
  parseTextToGrid: vi.fn(),
}));

import { getTable, applyTableOps } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { TABLE_TOOLS, TABLE_TOOL_SLUGS } from './builtins-tables';
import type { ToolHandlerContext } from './types';

const rowsAdd = TABLE_TOOLS.find((t) => t.slug === 'table_rows_add')!;
const rowsUpsert = TABLE_TOOLS.find((t) => t.slug === 'table_rows_upsert')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TABLE_ID = 'f8b1a3a0-0000-4000-8000-000000000001';

/** Minimal TableDetail: two named columns, no rows, single tab. */
const detail = () => ({
  id: TABLE_ID,
  title: 'Services',
  draft: null,
  data: {
    columns: [
      { id: 'c_svc', name: 'Service Name', type: 'text' },
      { id: 'c_mol', name: 'Mol %', type: 'number' },
    ],
    rows: [],
  },
  tabs: [],
  tabId: undefined,
});

beforeEach(() => {
  vi.mocked(getTable).mockReset();
  vi.mocked(applyTableOps).mockReset();
  vi.mocked(getTable).mockResolvedValue(detail() as never);
  // No sqlite surface → windowFile yields null → the upsert reads doc.rows
  // (the legacy path), which is what the fixtures populate.
  vi.mocked(tableSqlSurface).mockReset();
  vi.mocked(tableSqlSurface).mockResolvedValue(null as never);
});

describe('table_rows_add', () => {
  it('is registered and exported in the slug list', () => {
    expect(rowsAdd).toBeDefined();
    expect(TABLE_TOOL_SLUGS).toContain('table_rows_add');
  });

  it('sends the whole batch as ONE applyTableOps call, in order, keyed to column ids', async () => {
    vi.mocked(applyTableOps).mockResolvedValue({
      ok: true,
      draftRev: 2,
      createdIds: ['r1', 'r2', 'r3'],
    });
    const res = await rowsAdd.handler(
      {
        table_id: TABLE_ID,
        rows: [
          { 'Service Name': 'A', 'Mol %': 98.5 },
          { 'Service Name': 'B', 'Mol %': 1.5 },
          { c_svc: 'C' }, // id-keyed works too
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(vi.mocked(applyTableOps)).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(applyTableOps).mock.calls[0]![2];
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ op: 'row_add', cells: { c_svc: 'A', c_mol: 98.5 } });
    expect(ops[2]).toMatchObject({ op: 'row_add', cells: { c_svc: 'C' } });
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out.rows_added).toBe(3);
    expect(out.row_ids).toEqual(['r1', 'r2', 'r3']);
  });

  it('reports unknown columns once across the batch instead of silently dropping them', async () => {
    vi.mocked(applyTableOps).mockResolvedValue({ ok: true, draftRev: 2, createdIds: ['r1', 'r2'] });
    const res = await rowsAdd.handler(
      {
        table_id: TABLE_ID,
        rows: [
          { 'Service Name': 'A', Bogus: 1 },
          { 'Service Name': 'B', Bogus: 2 },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out.ignored_columns).toEqual(['Bogus']);
  });

  it('elides the per-row id list above 20 rows (context lean)', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `r${i}`);
    vi.mocked(applyTableOps).mockResolvedValue({ ok: true, draftRev: 2, createdIds: ids });
    const res = await rowsAdd.handler(
      { table_id: TABLE_ID, rows: ids.map((_, i) => ({ 'Service Name': `S${i}` })) },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out.rows_added).toBe(30);
    expect(out.row_ids).toBeUndefined();
    expect(out.first_row_id).toBe('r0');
  });

  it('rejects an over-cap batch with guidance, without touching the draft', async () => {
    const res = await rowsAdd.handler(
      { table_id: TABLE_ID, rows: Array.from({ length: 201 }, () => ({ 'Service Name': 'x' })) },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('200');
    expect(vi.mocked(applyTableOps)).not.toHaveBeenCalled();
  });

  it('surfaces a draft-rev conflict as a retryable error', async () => {
    vi.mocked(applyTableOps).mockResolvedValue({ ok: false, conflict: true, currentRev: 5 });
    const res = await rowsAdd.handler(
      { table_id: TABLE_ID, rows: [{ 'Service Name': 'A' }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('retry');
  });

  it('rejects an empty rows array', async () => {
    const res = await rowsAdd.handler({ table_id: TABLE_ID, rows: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(vi.mocked(applyTableOps)).not.toHaveBeenCalled();
  });
});

/** Fixture with EXISTING rows for the upsert (legacy doc path: no sqlite
 *  surface mocked, so the handler reads `doc.rows` directly). Keyed on the
 *  composite Service Name + Fluid Name, like the NATREF services table. */
const detailWithRows = () => ({
  ...detail(),
  data: {
    columns: [
      { id: 'c_svc', name: 'Service Name', type: 'text' },
      { id: 'c_fluid', name: 'Fluid Name', type: 'text' },
      { id: 'c_mol', name: 'Mol %', type: 'number' },
    ],
    rows: [
      { id: 'r_a', cells: { c_svc: '16000 Gasoil', c_fluid: 'DIESEL', c_mol: 98.5 } },
      { id: 'r_b', cells: { c_svc: '16000 Gasoil', c_fluid: 'SULFUR', c_mol: 1.5 } },
      // Duplicate key pair — any incoming row matching it must be ambiguous.
      { id: 'r_c', cells: { c_svc: '16000 Dup', c_fluid: 'WATER', c_mol: 50 } },
      { id: 'r_d', cells: { c_svc: '16000 Dup', c_fluid: 'WATER', c_mol: 50 } },
    ],
  },
});

describe('table_rows_upsert', () => {
  const KEY = ['Service Name', 'Fluid Name'];
  beforeEach(() => {
    vi.mocked(getTable).mockResolvedValue(detailWithRows() as never);
  });

  it('adds new keys, updates changed rows, counts identical rows unchanged — one atomic batch', async () => {
    vi.mocked(applyTableOps).mockResolvedValue({ ok: true, draftRev: 3, createdIds: ['r_new'] });
    const res = await rowsUpsert.handler(
      {
        table_id: TABLE_ID,
        key: KEY,
        rows: [
          // identical (98.5 arrives as a string — coercion must not read it as a change)
          { 'Service Name': '16000 Gasoil', 'Fluid Name': 'DIESEL', 'Mol %': '98.5' },
          // changed
          { 'Service Name': '16000 Gasoil', 'Fluid Name': 'SULFUR', 'Mol %': 2.0 },
          // new
          { 'Service Name': '16000 Fresh', 'Fluid Name': 'WATER', 'Mol %': 100 },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({ added: 1, updated: 1, unchanged: 1 });
    expect(vi.mocked(applyTableOps)).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(applyTableOps).mock.calls[0]![2];
    expect(ops).toHaveLength(2);
    expect(ops.find((o: { op: string }) => o.op === 'row_update')).toMatchObject({
      rowId: 'r_b',
      cells: { c_mol: 2.0 },
    });
    expect(ops.find((o: { op: string }) => o.op === 'row_add')).toMatchObject({
      cells: { c_svc: '16000 Fresh' },
    });
  });

  it('skips + reports keys matching more than one existing row', async () => {
    const res = await rowsUpsert.handler(
      {
        table_id: TABLE_ID,
        key: KEY,
        rows: [{ 'Service Name': '16000 Dup', 'Fluid Name': 'WATER', 'Mol %': 60 }],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out.ambiguous_skipped).toBe(1);
    expect(vi.mocked(applyTableOps)).not.toHaveBeenCalled();
  });

  it('rejects the whole call when a row is missing a key value — nothing written', async () => {
    const res = await rowsUpsert.handler(
      {
        table_id: TABLE_ID,
        key: KEY,
        rows: [
          { 'Service Name': '16000 Gasoil', 'Fluid Name': 'DIESEL', 'Mol %': 1 },
          { 'Service Name': '16000 Gasoil', 'Mol %': 2 }, // no Fluid Name
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('[1]');
    expect(vi.mocked(applyTableOps)).not.toHaveBeenCalled();
  });

  it('rejects duplicate keys within the incoming batch', async () => {
    const res = await rowsUpsert.handler(
      {
        table_id: TABLE_ID,
        key: KEY,
        rows: [
          { 'Service Name': 'S', 'Fluid Name': 'F', 'Mol %': 1 },
          { 'Service Name': 'S', 'Fluid Name': 'F', 'Mol %': 2 },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('one row per key');
    expect(vi.mocked(applyTableOps)).not.toHaveBeenCalled();
  });

  it('rejects an unknown key column, naming the real ones', async () => {
    const res = await rowsUpsert.handler(
      { table_id: TABLE_ID, key: ['Nope'], rows: [{ 'Service Name': 'S' }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('Service Name');
  });
});
