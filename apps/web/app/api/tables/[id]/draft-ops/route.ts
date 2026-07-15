import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { applyTableOps } from '@/lib/tables';
import type { TableOp } from '@mantle/tabledb';

/**
 * Apply an op batch to the table's DRAFT (P3). The batch is atomic on the
 * server (all ops or none, under the registry lock); `if_rev` is the etag
 * from the last read/apply — a stale value gets 409 + the current rev so the
 * client refetches instead of silently clobbering newer (e.g. agent) edits.
 *
 * The schema is a strict per-op mirror of tabledb's TableOp (audit
 * hardening — this was `{op:string}.passthrough()`). Ids stay charset-free
 * (legacy files carry caller-chosen ids) but every string is length-capped;
 * unknown op kinds are rejected. In column_update, explicit `null` = clear.
 */
const Id = z.string().min(1).max(128);
const Name = z.string().min(1).max(300);
const CellScalar = z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]);
const Cell = z.union([CellScalar, z.array(z.string().max(2000)).max(200)]);
const Cells = z
  .record(Cell)
  .refine((o) => Object.keys(o).length <= 500, { message: 'too many cells in one op' });
const Ref = z.object({ tabId: Id, columnId: Id });
const ColumnType = z.enum([
  'text', 'number', 'currency', 'percent', 'date', 'datetime',
  'checkbox', 'select', 'multiselect', 'url', 'formula', 'reference',
]);
const ColumnFormat = z.object({ currency: z.string().max(8).optional(), decimals: z.number().int().min(0).max(12).optional() });
const SelectOption = z.object({ id: Id, label: z.string().max(500), color: z.string().max(32).optional() });
const ColumnShape = z.object({
  id: Id.optional(),
  name: Name,
  type: ColumnType,
  format: ColumnFormat.optional(),
  options: z.array(SelectOption).max(500).optional(),
  formula: z.string().max(4000).optional(),
  width: z.number().optional(),
  ref: Ref.optional(),
});
const ColumnPatch = z.object({
  name: Name.optional(),
  type: ColumnType.optional(),
  format: ColumnFormat.nullish(),
  options: z.array(SelectOption).max(500).nullish(),
  formula: z.string().max(4000).nullish(),
  width: z.number().nullish(),
  ref: Ref.nullish(),
});
const SortSpec = z.object({ colId: Id, dir: z.enum(['asc', 'desc']) });
const FilterSpec = z.object({
  colId: Id,
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty']),
  value: Cell.optional(),
});
const ViewShape = z.object({
  id: z.string().max(128),
  name: Name,
  sort: z.array(SortSpec).max(20).optional(),
  filters: z.array(FilterSpec).max(50).optional(),
});
const TabTarget = { tabId: Id.optional() };
const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('row_add'), ...TabTarget, rowId: Id.optional(), cells: Cells.optional(), afterRowId: Id.nullish(), atStart: z.boolean().optional() }),
  z.object({ op: z.literal('row_update'), ...TabTarget, rowId: Id, cells: Cells }),
  z.object({ op: z.literal('row_delete'), ...TabTarget, rowId: Id }),
  z.object({ op: z.literal('cell_set'), ...TabTarget, rowId: Id, columnId: Id, value: Cell }),
  z.object({ op: z.literal('column_add'), ...TabTarget, column: ColumnShape, afterColumnId: Id.nullish() }),
  z.object({ op: z.literal('column_update'), ...TabTarget, columnId: Id, patch: ColumnPatch }),
  z.object({ op: z.literal('column_delete'), ...TabTarget, columnId: Id }),
  z.object({ op: z.literal('aggregate_set'), ...TabTarget, columnId: Id, kind: z.enum(['none', 'sum', 'avg', 'count', 'min', 'max', 'empty', 'filled']) }),
  z.object({ op: z.literal('view_set'), ...TabTarget, view: ViewShape }),
  z.object({ op: z.literal('select_option_add'), ...TabTarget, columnId: Id, label: z.string().max(500) }),
  z.object({ op: z.literal('tab_add'), tabId: Id.optional(), name: Name, afterTabId: Id.nullish() }),
  z.object({ op: z.literal('tab_rename'), tabId: Id, name: Name }),
  z.object({ op: z.literal('tab_reorder'), tabId: Id, afterTabId: Id.nullish() }),
  z.object({ op: z.literal('tab_delete'), tabId: Id }),
]);
const Body = z.object({
  ops: z.array(Op).min(1).max(500),
  if_rev: z.number().int().nonnegative().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input: expected { ops: [...], if_rev? }' }, { status: 400 });
  }
  try {
    const result = await applyTableOps(user.id, id, parsed.data.ops as unknown as TableOp[], {
      ...(parsed.data.if_rev !== undefined ? { ifRev: parsed.data.if_rev } : {}),
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'draft changed since you loaded it — refetch and re-apply', current_rev: result.currentRev },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, draft_rev: result.draftRev, created_ids: result.createdIds });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'op batch failed' }, { status: 400 });
  }
}
