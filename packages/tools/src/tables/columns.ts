/**
 * Column edits plus the aggregate and view settings that ride on them.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import {
  computeAggregate,
  setAggregate,
  AGGREGATE_KINDS,
  COLUMN_TYPES,
  FILTER_OPS,
  type AggregateKind,
  type CellValue,
  type Column,
  type ColumnType,
  type Filter,
  type SortSpec,
} from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { TABLE_ID_PRE, TAB_HINT, editViaOps, resolveColumn, resolveRefTarget } from './common';

export const table_column_add: BuiltinToolDef = {
  slug: 'table_column_add',
  preconditions: TABLE_ID_PRE,
  name: 'Add a column',
  description:
    'Add a column. For currency pass `format.currency` (ISO code); for select/multiselect pass `options`; for a formula column pass `formula` (e.g. "{Qty} * {Price}" — references other columns by name). Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      name: { type: 'string', description: 'Column header, e.g. "Unit price".' },
      type: {
        type: 'string',
        enum: [...COLUMN_TYPES],
        description: 'Cell type — governs coercion, sorting, and totals.',
      },
      format: {
        type: 'object',
        description: 'e.g. { "currency": "USD", "decimals": 2 }',
        additionalProperties: true,
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'select/multiselect choices',
      },
      formula: { type: 'string', description: 'for type=formula, e.g. "{Qty} * {Price}"' },
      after_column: { type: 'string', description: 'optional column id/name to insert after' },
      tab: { type: 'string', description: TAB_HINT },
      reference: {
        type: 'object',
        description:
          'For type=reference: the source column this column offers values from (a convenience picker — values are copied as plain text, no live link), e.g. { "tab": "Car models", "column": "Model" }. Same workbook only.',
        properties: {
          tab: { type: 'string', description: 'source tab, by name or id' },
          column: { type: 'string', description: 'source column, by name or id' },
        },
        required: ['tab', 'column'],
      },
    },
    required: ['table_id', 'name', 'type'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    const type = str(input.type).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    if (!COLUMN_TYPES.includes(type as ColumnType))
      return { ok: false, error: `invalid type '${type}'` };
    let ref: { tabId: string; columnId: string } | undefined;
    if (type === 'reference') {
      const resolved = await resolveRefTarget(ctx.ownerId, tableId, input.reference);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      ref = resolved.ref;
    }
    const newColId = crypto.randomUUID();
    const res = await editViaOps(ctx.ownerId, tableId, input.tab, (doc) => {
      const spec: Omit<Column, 'id'> & { id: string } = {
        id: newColId,
        name,
        type: type as ColumnType,
      };
      if (input.format && typeof input.format === 'object')
        spec.format = input.format as Column['format'];
      if (Array.isArray(input.options))
        spec.options = strArr(input.options).map((label) => ({
          id: label.toLowerCase().replace(/\s+/g, '_'),
          label,
        }));
      if (str(input.formula).trim()) spec.formula = str(input.formula).trim();
      if (ref) spec.ref = ref;
      const after = str(input.after_column).trim();
      const afterColumnId = after ? (resolveColumn(doc, after)?.id ?? null) : null;
      return {
        ops: [{ op: 'column_add', column: spec, afterColumnId }],
        output: { column_id: newColId, name },
      };
    });
    ctx.step?.setOutput({ table_id: tableId, column_id: newColId });
    return res;
  },
};

export const table_column_update: BuiltinToolDef = {
  slug: 'table_column_update',
  preconditions: TABLE_ID_PRE,
  name: 'Update a column',
  description:
    'Change a column (by id or name): rename, retype (cells are re-coerced), set format/options/formula. Pass only what changes. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      column: { type: 'string', description: 'column id or name' },
      name: { type: 'string', description: 'New column header (rename).' },
      type: {
        type: 'string',
        enum: [...COLUMN_TYPES],
        description: 'New cell type — existing cells are re-coerced to it.',
      },
      format: {
        type: 'object',
        description: 'Display format, e.g. { "currency": "USD", "decimals": 2 }.',
        additionalProperties: true,
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Choice labels for select/multiselect columns — replaces the existing set.',
      },
      formula: {
        type: 'string',
        description:
          'Formula expression, e.g. "{Qty} * {Price}" — references other columns by name.',
      },
      tab: { type: 'string', description: TAB_HINT },
      reference: {
        type: 'object',
        description:
          'For type=reference: the source column this column offers values from, e.g. { "tab": "Car models", "column": "Model" }. Required when retyping to reference; pass alone to re-point an existing reference.',
        properties: {
          tab: { type: 'string', description: 'source tab, by name or id' },
          column: { type: 'string', description: 'source column, by name or id' },
        },
        required: ['tab', 'column'],
      },
    },
    required: ['table_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    let ref: { tabId: string; columnId: string } | undefined;
    if (input.reference !== undefined) {
      const resolved = await resolveRefTarget(ctx.ownerId, tableId, input.reference);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      ref = resolved.ref;
    }
    const res = await editViaOps(ctx.ownerId, tableId, input.tab, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { ops: [], error: `column '${columnRef}' not found` };
      const patch: Partial<Omit<Column, 'id'>> = {};
      if (str(input.name).trim()) patch.name = str(input.name).trim();
      if (str(input.type).trim()) {
        if (!COLUMN_TYPES.includes(str(input.type).trim() as ColumnType))
          return { ops: [], error: `invalid type '${str(input.type)}'` };
        patch.type = str(input.type).trim() as ColumnType;
      }
      if (input.format && typeof input.format === 'object')
        patch.format = input.format as Column['format'];
      if (Array.isArray(input.options))
        patch.options = strArr(input.options).map((label) => ({
          id: label.toLowerCase().replace(/\s+/g, '_'),
          label,
        }));
      if (typeof input.formula === 'string') patch.formula = input.formula.trim();
      if (ref) patch.ref = ref;
      if (
        (patch.type === 'reference' || (ref && col.type !== 'reference' && !patch.type)) &&
        !ref &&
        !col.ref
      ) {
        return {
          ops: [],
          error:
            'retyping to reference needs `reference: { tab, column }` — the source it offers values from',
        };
      }
      if (Object.keys(patch).length === 0) return { ops: [], error: 'nothing to update' };
      return {
        ops: [{ op: 'column_update', columnId: col.id, patch }],
        output: { column_id: col.id },
      };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

export const table_column_delete: BuiltinToolDef = {
  slug: 'table_column_delete',
  preconditions: TABLE_ID_PRE,
  name: 'Delete a column',
  description: 'Remove a column (by id or name) and all its cells. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      column: { type: 'string', description: 'column id or name' },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    const res = await editViaOps(ctx.ownerId, tableId, input.tab, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { ops: [], error: `column '${columnRef}' not found` };
      return {
        ops: [{ op: 'column_delete', columnId: col.id }],
        output: { column_id: col.id, deleted: true },
      };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

export const table_set_aggregate: BuiltinToolDef = {
  slug: 'table_set_aggregate',
  preconditions: TABLE_ID_PRE,
  name: 'Set a column total',
  description:
    'Set (or clear) a column\'s footer total — the "add totals" tool. Shows in the totals row and the indexed text. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      column: { type: 'string', description: 'column id or name' },
      kind: {
        type: 'string',
        enum: [...AGGREGATE_KINDS],
        description: "The total to show ('none' clears it). Numeric kinds skip non-numeric cells.",
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'column', 'kind'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    const kind = str(input.kind).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    if (!AGGREGATE_KINDS.includes(kind as AggregateKind))
      return { ok: false, error: `invalid kind '${kind}'` };
    const res = await editViaOps(ctx.ownerId, tableId, input.tab, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { ops: [], error: `column '${columnRef}' not found` };
      const value =
        kind === 'none'
          ? null
          : computeAggregate(
              setAggregate(doc, col.id, kind as AggregateKind),
              col.id,
              kind as AggregateKind,
            );
      return {
        ops: [{ op: 'aggregate_set', columnId: col.id, kind: kind as AggregateKind }],
        output: { column_id: col.id, kind, value },
      };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

export const table_set_view: BuiltinToolDef = {
  slug: 'table_set_view',
  preconditions: TABLE_ID_PRE,
  name: 'Save a filter/sort view',
  description:
    'Create or update a saved view — a named filter + sort over the table. Pass `view_id` to update an existing view. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      name: { type: 'string', description: 'View name shown in the UI, e.g. "Open items".' },
      view_id: { type: 'string', description: 'omit to create a new view' },
      sort: {
        type: 'array',
        description: 'Sort order the view applies, e.g. [{ "column": "Due", "dir": "asc" }].',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'Column to sort by (id or name).' },
            dir: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort direction — defaults to ascending.',
            },
          },
          required: ['column'],
        },
      },
      filters: {
        type: 'array',
        description: 'Predicates a row must match to appear in the view.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: {
              type: 'string',
              enum: [...FILTER_OPS],
              description: 'How the cell compares to `value` — same ops as `table_query` filters.',
            },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    let viewId = '';
    const res = await editViaOps(ctx.ownerId, tableId, input.tab, (doc) => {
      const sort: SortSpec[] = (Array.isArray(input.sort) ? input.sort : [])
        .map((s): SortSpec | null => {
          const col = resolveColumn(doc, str((s as Record<string, unknown>).column));
          return col
            ? { colId: col.id, dir: (s as Record<string, unknown>).dir === 'desc' ? 'desc' : 'asc' }
            : null;
        })
        .filter((s): s is SortSpec => s !== null);
      const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
        .map((f): Filter | null => {
          const rec = f as Record<string, unknown>;
          const col = resolveColumn(doc, str(rec.column));
          return col
            ? {
                colId: col.id,
                op: str(rec.op) as Filter['op'],
                value: (rec.value ?? null) as CellValue,
              }
            : null;
        })
        .filter((f): f is Filter => f !== null);
      const existing = str(input.view_id).trim();
      viewId = existing || `v_${Math.random().toString(36).slice(2, 10)}`;
      return {
        ops: [{ op: 'view_set', view: { id: viewId, name, sort, filters } }],
        output: { view_id: viewId, name },
      };
    });
    ctx.step?.setOutput({ table_id: tableId, view_id: viewId });
    return res;
  },
};
