/**
 * Row edits: add one or many, upsert, update, delete, and per-cell set.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import { coerceCell, applyTableOps, type CellValue, type Column } from '@mantle/content';
import { queryRowsWindow, type TableOp } from '@mantle/tabledb';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import {
  CELLS_HINT,
  DRAFT_REVIEW_HINT,
  TABLE_ID_PRE,
  TAB_HINT,
  loadTab,
  resolveCells,
  resolveColumn,
  rowExists,
  windowFile,
} from './common';

export const table_row_add: BuiltinToolDef = {
  slug: 'table_row_add',
  preconditions: TABLE_ID_PRE,
  name: 'Add a row',
  description:
    'Append a new row (or insert after `after_row_id`). Returns the new row id. Writes to DRAFT. ' +
    'For more than a couple of rows use `table_rows_add` — one atomic call, and it does not eat ' +
    'the per-turn tool-call budget row by row.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      cells: { type: 'object', description: CELLS_HINT, additionalProperties: true },
      after_row_id: {
        type: 'string',
        description: 'optional — insert after this row instead of appending',
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const cellsIn = (input.cells && typeof input.cells === 'object' ? input.cells : {}) as Record<
      string,
      unknown
    >;
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { doc, tabId } = loaded;
    const { cells, unknown } = resolveCells(doc, cellsIn);
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        {
          op: 'row_add',
          cells,
          afterRowId: str(input.after_row_id).trim() || null,
          ...(tabId ? { tabId } : {}),
        },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      const rowId = applied.createdIds[0] ?? '';
      ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          row_id: rowId,
          ...(unknown.length ? { ignored_columns: unknown } : {}),
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// Bulk twin of table_row_add. Born from a real incident (NATREF 2026-07-28):
// appending 101 rows one call at a time ran into the tool-loop's same-tool cap,
// took 6 delegation retries and ~18 minutes, and the cap guidance pushed the
// agent into table_from_text — which CREATES a table — leaving a stray import.
// One call, one atomic applyTableOps batch, one draft rev.
const ROWS_ADD_MAX = 200;

export const table_rows_add: BuiltinToolDef = {
  slug: 'table_rows_add',
  preconditions: TABLE_ID_PRE,
  name: 'Add many rows',
  description:
    `Append MANY rows to an EXISTING table in ONE call — the bulk twin of \`table_row_add\`. ` +
    `Always prefer this over repeated \`table_row_add\` calls for more than a couple of rows: ` +
    `the whole batch lands atomically on the DRAFT (one revision), and it sidesteps the ` +
    `per-turn tool-call caps that cut row-at-a-time appends short. Up to ${ROWS_ADD_MAX} rows ` +
    `per call — for larger loads, call it again with the next batch. Rows append at the end ` +
    `in the order given (no insert-after; use \`table_row_add\` for positioned single inserts). ` +
    `To build a NEW table from bulk data use \`table_from_text\`/\`table_from_file\` instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      rows: {
        type: 'array',
        description: `Rows to append, in order. Each item: ${CELLS_HINT}`,
        items: { type: 'object', additionalProperties: true },
        minItems: 1,
        maxItems: ROWS_ADD_MAX,
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'rows'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const rowsIn = Array.isArray(input.rows) ? input.rows : null;
    if (!rowsIn?.length)
      return { ok: false, error: 'rows must be a non-empty array of cell objects' };
    if (rowsIn.length > ROWS_ADD_MAX) {
      return {
        ok: false,
        error: `${rowsIn.length} rows exceeds the ${ROWS_ADD_MAX}-row cap — split into batches of ${ROWS_ADD_MAX} and call again`,
      };
    }
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { doc, tabId } = loaded;
    const unknownAll = new Set<string>();
    const ops = rowsIn.map((r) => {
      const cellsIn = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const { cells, unknown } = resolveCells(doc, cellsIn);
      for (const u of unknown) unknownAll.add(u);
      return { op: 'row_add' as const, cells, afterRowId: null, ...(tabId ? { tabId } : {}) };
    });
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, ops);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      const rowIds = applied.createdIds.filter((id): id is string => !!id);
      ctx.step?.setOutput({ table_id: tableId, rows_added: rowIds.length });
      return {
        ok: true,
        output: {
          table_id: tableId,
          rows_added: rowIds.length,
          // Full id list only for small batches — 200 UUIDs is context bloat.
          ...(rowIds.length <= 20 ? { row_ids: rowIds } : { first_row_id: rowIds[0] }),
          ...(unknownAll.size ? { ignored_columns: [...unknownAll] } : {}),
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// The real shape of "refresh this table from an export" (NATREF 2026-07-28):
// diff incoming rows against the current grid by key, then insert the new and
// patch the changed — without the agent hand-computing the diff via table_sql
// plus a row-by-row write loop. Whole batch = one atomic applyTableOps.
export const table_rows_upsert: BuiltinToolDef = {
  slug: 'table_rows_upsert',
  preconditions: TABLE_ID_PRE,
  name: 'Upsert many rows by key',
  description:
    `Merge MANY rows into an EXISTING table in ONE call, matched on \`key\` column(s): rows ` +
    `whose key isn't in the table are ADDED, rows whose key matches are UPDATED (only the ` +
    `cells you pass — other cells keep their values; identical rows are left untouched and ` +
    `counted as unchanged). **This is the right tool for "sync/refresh this table from an ` +
    `export" and any add-or-update load** — do NOT hand-compute the diff and replay it with ` +
    `row tools. Key matching is exact (after type coercion; strings trimmed); a key that ` +
    `matches MULTIPLE existing rows is skipped and reported as ambiguous. Up to ` +
    `${ROWS_ADD_MAX} rows per call. Pure appends: \`table_rows_add\`. New table: \`table_from_text\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      key: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Column(s) — by NAME or id — that identify a row, e.g. ["Service Name", "Fluid Name"]. ' +
          'Every incoming row must carry a non-empty value for each key column.',
      },
      rows: {
        type: 'array',
        description: `Rows to merge. Each item: ${CELLS_HINT}`,
        items: { type: 'object', additionalProperties: true },
        minItems: 1,
        maxItems: ROWS_ADD_MAX,
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'key', 'rows'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const keyRefs = (Array.isArray(input.key) ? input.key : [input.key])
      .map((k) => str(k).trim())
      .filter(Boolean);
    if (!keyRefs.length) return { ok: false, error: 'key is required — the column(s) to match on' };
    const rowsIn = Array.isArray(input.rows) ? input.rows : null;
    if (!rowsIn?.length)
      return { ok: false, error: 'rows must be a non-empty array of cell objects' };
    if (rowsIn.length > ROWS_ADD_MAX) {
      return {
        ok: false,
        error: `${rowsIn.length} rows exceeds the ${ROWS_ADD_MAX}-row cap — split into batches of ${ROWS_ADD_MAX} and call again`,
      };
    }
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { doc, tabId } = loaded;
    const keyCols: Column[] = [];
    for (const ref of keyRefs) {
      const col = resolveColumn(doc, ref);
      if (!col) {
        return {
          ok: false,
          error: `key column '${ref}' not found — columns: ${doc.columns.map((c) => c.name).join(', ')}`,
        };
      }
      keyCols.push(col);
    }
    const colType = new Map(doc.columns.map((c) => [c.id, c.type] as const));
    // Normalize one cell value into the comparison domain: coerced by column
    // type, strings trimmed, empty → null — so "98.5" vs 98.5 and " X " vs "X"
    // don't read as changes.
    const norm = (colId: string, v: unknown): CellValue => {
      const coerced = coerceCell(v, colType.get(colId) ?? 'text');
      if (typeof coerced === 'string') {
        const t = coerced.trim();
        return t === '' ? null : t;
      }
      return coerced ?? null;
    };
    const keyOf = (cells: Record<string, CellValue>): string | null => {
      const parts: CellValue[] = [];
      for (const col of keyCols) {
        const v = norm(col.id, cells[col.id]);
        if (v === null) return null;
        parts.push(v);
      }
      return JSON.stringify(parts);
    };

    // Resolve + validate the incoming batch (atomic: any bad row rejects the
    // whole call BEFORE any write, with row indexes the model can fix).
    const unknownAll = new Set<string>();
    const resolved: { cells: Record<string, CellValue>; key: string }[] = [];
    const missingKey: number[] = [];
    const dupKeys = new Set<string>();
    const seenKeys = new Set<string>();
    for (const [i, r] of rowsIn.entries()) {
      const cellsIn = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const { cells, unknown } = resolveCells(doc, cellsIn);
      for (const u of unknown) unknownAll.add(u);
      const key = keyOf(cells);
      if (key === null) {
        missingKey.push(i);
        continue;
      }
      if (seenKeys.has(key)) dupKeys.add(key);
      seenKeys.add(key);
      resolved.push({ cells, key });
    }
    if (missingKey.length) {
      return {
        ok: false,
        error:
          `rows [${missingKey.slice(0, 10).join(', ')}]${missingKey.length > 10 ? '…' : ''} are ` +
          `missing a value for key column(s) ${keyCols.map((c) => `'${c.name}'`).join(' + ')} — ` +
          `every row must identify itself. Nothing was written.`,
      };
    }
    if (dupKeys.size) {
      return {
        ok: false,
        error:
          `the incoming rows repeat ${dupKeys.size} key(s) (e.g. ${[...dupKeys]
            .slice(0, 3)
            .join('; ')}) — an upsert needs one row per key. Merge the duplicates ` +
          `first (or add a column to the key). Nothing was written.`,
      };
    }

    // Existing key → row map from the DRAFT-first workbook (falls back to the
    // in-memory doc for legacy JSONB tables). Ambiguity (a key matching >1
    // existing row) is per-key: those incoming rows are skipped and reported.
    const existing = new Map<
      string,
      { rowId: string; cells: Record<string, CellValue>; n: number }
    >();
    const indexRow = (id: string, cells: Record<string, CellValue>) => {
      const key = keyOf(cells);
      if (key === null) return;
      const prior = existing.get(key);
      if (prior) prior.n += 1;
      else existing.set(key, { rowId: id, cells, n: 1 });
    };
    const file = await windowFile(ctx.ownerId, tableId);
    if (file) {
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const page = queryRowsWindow(file, { offset, limit: PAGE, ...(tabId ? { tabId } : {}) });
        if (!page) return { ok: false, error: 'could not read the table rows — retry' };
        for (const row of page.rows) indexRow(row.id, row.cells);
        if (offset + page.rows.length >= page.total || page.rows.length === 0) break;
      }
    } else {
      for (const row of doc.rows) indexRow(row.id, row.cells);
    }

    const ops: TableOp[] = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const ambiguous: string[] = [];
    for (const { cells, key } of resolved) {
      const hit = existing.get(key);
      if (!hit) {
        ops.push({ op: 'row_add', cells, afterRowId: null, ...(tabId ? { tabId } : {}) });
        added += 1;
        continue;
      }
      if (hit.n > 1) {
        ambiguous.push(key);
        continue;
      }
      const changed = Object.entries(cells).some(
        ([colId, v]) => norm(colId, v) !== norm(colId, hit.cells[colId] ?? null),
      );
      if (!changed) {
        unchanged += 1;
        continue;
      }
      ops.push({ op: 'row_update', rowId: hit.rowId, cells, ...(tabId ? { tabId } : {}) });
      updated += 1;
    }

    try {
      if (ops.length) {
        const applied = await applyTableOps(ctx.ownerId, tableId, ops);
        if (!applied) return notFound('table', tableId, 'table_list');
        if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      }
      ctx.step?.setOutput({ table_id: tableId, added, updated, unchanged });
      return {
        ok: true,
        output: {
          table_id: tableId,
          added,
          updated,
          unchanged,
          ...(ambiguous.length
            ? {
                ambiguous_skipped: ambiguous.length,
                ambiguous_keys: ambiguous.slice(0, 5),
                hint_ambiguous:
                  'these keys match MORE THAN ONE existing row — resolve the duplicates (table_query by key, then table_row_update/table_row_delete) and re-run for them',
              }
            : {}),
          ...(unknownAll.size ? { ignored_columns: [...unknownAll] } : {}),
          draft_saved: ops.length > 0,
          hint: ops.length ? DRAFT_REVIEW_HINT(tableId) : 'nothing changed — draft untouched',
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_row_update: BuiltinToolDef = {
  slug: 'table_row_update',
  preconditions: TABLE_ID_PRE,
  name: 'Update a row',
  description:
    'Patch a row\'s cells by id (merge — unspecified cells stay). The surgical "do row X" tool. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      row_id: {
        type: 'string',
        description: "The row's stable id — from `table_rows_list` / `table_query`.",
      },
      cells: { type: 'object', description: CELLS_HINT, additionalProperties: true },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'row_id', 'cells'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    if (!tableId || !rowId) return { ok: false, error: 'table_id and row_id are required' };
    const cellsIn = (input.cells && typeof input.cells === 'object' ? input.cells : {}) as Record<
      string,
      unknown
    >;
    if (Object.keys(cellsIn).length === 0)
      return { ok: false, error: 'cells is required (nothing to update)' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { doc, tabId } = loaded;
    if (!(await rowExists(ctx.ownerId, tableId, doc, rowId, tabId))) {
      return { ok: false, error: `row ${rowId} not found (re-run table_rows_list)` };
    }
    const { cells, unknown } = resolveCells(doc, cellsIn);
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'row_update', rowId, cells, ...(tabId ? { tabId } : {}) },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          row_id: rowId,
          ...(unknown.length ? { ignored_columns: unknown } : {}),
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_row_delete: BuiltinToolDef = {
  slug: 'table_row_delete',
  preconditions: TABLE_ID_PRE,
  name: 'Delete a row',
  description: 'Remove a row by id. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      row_id: {
        type: 'string',
        description: "The row's stable id — from `table_rows_list` / `table_query`.",
      },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'row_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    if (!tableId || !rowId) return { ok: false, error: 'table_id and row_id are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    if (!(await rowExists(ctx.ownerId, tableId, loaded.doc, rowId, loaded.tabId))) {
      return { ok: false, error: `row ${rowId} not found` };
    }
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'row_delete', rowId, ...(loaded.tabId ? { tabId: loaded.tabId } : {}) },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          row_id: rowId,
          deleted: true,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_cell_set: BuiltinToolDef = {
  slug: 'table_cell_set',
  preconditions: TABLE_ID_PRE,
  name: 'Set one cell',
  description: 'Set a single cell — row by id, column by id or name. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      row_id: {
        type: 'string',
        description: "The row's stable id — from `table_rows_list` / `table_query`.",
      },
      column: { type: 'string', description: 'column id or name' },
      value: { description: 'new value (coerced to the column type); null/"" clears' },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id', 'row_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !rowId || !columnRef)
      return { ok: false, error: 'table_id, row_id and column are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { doc, tabId } = loaded;
    if (!(await rowExists(ctx.ownerId, tableId, doc, rowId, tabId))) {
      return { ok: false, error: `row ${rowId} not found` };
    }
    const col = resolveColumn(doc, columnRef);
    if (!col) return { ok: false, error: `column '${columnRef}' not found` };
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        {
          op: 'cell_set',
          rowId,
          columnId: col.id,
          value: (input.value ?? null) as CellValue,
          ...(tabId ? { tabId } : {}),
        },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          row_id: rowId,
          column_id: col.id,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// ───────────────────────── column edits (→ draft) ─────────────────────────
