/**
 * The request schema for a table op batch: a strict per-op mirror of
 * tabledb's TableOp (audit hardening; this was `{op:string}.passthrough()`).
 * Ids stay charset-free (legacy files carry caller-chosen ids) but every
 * string is length-capped; unknown op kinds are rejected. In column_update,
 * explicit `null` = clear. Shared by the owner's draft-ops route and the
 * member's own-table draft route.
 */
import { z } from 'zod';

const Id = z.string().min(1).max(128);
const Name = z.string().min(1).max(300);
const CellScalar = z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]);
const Cell = z.union([CellScalar, z.array(z.string().max(2000)).max(200)]);
const Cells = z
  .record(z.string(), Cell)
  .refine((o) => Object.keys(o).length <= 500, { message: 'too many cells in one op' });
const Ref = z.object({ tabId: Id, columnId: Id });
const ColumnType = z.enum([
  'text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'checkbox',
  'select',
  'multiselect',
  'url',
  'formula',
  'reference',
]);
const ColumnFormat = z.object({
  currency: z.string().max(8).optional(),
  decimals: z.number().int().min(0).max(12).optional(),
});
const SelectOption = z.object({
  id: Id,
  label: z.string().max(500),
  color: z.string().max(32).optional(),
});
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
  z.object({
    op: z.literal('row_add'),
    ...TabTarget,
    rowId: Id.optional(),
    cells: Cells.optional(),
    afterRowId: Id.nullish(),
    atStart: z.boolean().optional(),
  }),
  z.object({ op: z.literal('row_update'), ...TabTarget, rowId: Id, cells: Cells }),
  z.object({ op: z.literal('row_delete'), ...TabTarget, rowId: Id }),
  z.object({ op: z.literal('cell_set'), ...TabTarget, rowId: Id, columnId: Id, value: Cell }),
  z.object({
    op: z.literal('column_add'),
    ...TabTarget,
    column: ColumnShape,
    afterColumnId: Id.nullish(),
  }),
  z.object({ op: z.literal('column_update'), ...TabTarget, columnId: Id, patch: ColumnPatch }),
  z.object({ op: z.literal('column_delete'), ...TabTarget, columnId: Id }),
  z.object({
    op: z.literal('aggregate_set'),
    ...TabTarget,
    columnId: Id,
    kind: z.enum(['none', 'sum', 'avg', 'count', 'min', 'max', 'empty', 'filled']),
  }),
  z.object({ op: z.literal('view_set'), ...TabTarget, view: ViewShape }),
  z.object({
    op: z.literal('select_option_add'),
    ...TabTarget,
    columnId: Id,
    label: z.string().max(500),
  }),
  z.object({
    op: z.literal('tab_add'),
    tabId: Id.optional(),
    name: Name,
    afterTabId: Id.nullish(),
  }),
  z.object({ op: z.literal('tab_rename'), tabId: Id, name: Name }),
  z.object({ op: z.literal('tab_reorder'), tabId: Id, afterTabId: Id.nullish() }),
  z.object({ op: z.literal('tab_delete'), tabId: Id }),
]);

/** One op batch: all ops or none, under the table's registry lock. */
export const TableOpsSchema = z.array(Op).min(1).max(500);
