/**
 * Reading a table: list, get, the schema digest, raw SQL, and row reads.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import {
  computeAggregate,
  findColumn,
  findRow,
  getTable,
  listRows,
  listTables,
  nodeUrl,
  type AggregateKind,
  type CellValue,
} from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import {
  SQL_ROW_CAP_DEFAULT,
  SQL_ROW_CAP_MAX,
  queryRowsWindow,
  readRowById,
  runTableSql,
  schemaToText,
} from '@mantle/tabledb';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import {
  TABLE_ID_PRE,
  TABLE_NODE_ID_PRE,
  TAB_HINT,
  colSummary,
  loadTab,
  pageMeta,
  windowFile,
} from './common';

export const table_list: BuiltinToolDef = {
  slug: 'table_list',
  readOnly: true,
  name: 'List tables',
  description:
    "List the owner's tables, newest first. Optional `query` substring-matches title/body/summary; `tag` filters. Grids are summarised (column + row counts), not returned in full. For a single table's content use `table_get` / `table_rows_list`. For semantic search use `search_nodes` with type='table'.",
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Substring match over title/body/summary, e.g. "inventory".',
      },
      tag: { type: 'string', description: 'Return only tables carrying this tag.' },
      limit: { type: 'number', description: 'max rows (default 50)' },
    },
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim() || undefined;
    const tag = str(input.tag).trim() || undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(200, input.limit)) : 50;
    try {
      const rows = await listTables(ctx.ownerId, { query, tag, limit });
      ctx.step?.setOutput({ count: rows.length });
      return {
        ok: true,
        output: rows.map((r) => ({
          id: r.id,
          title: r.title,
          tags: r.tags,
          summary: r.summary,
          columns: r.columnCount,
          rows: r.rowCount,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_get: BuiltinToolDef = {
  slug: 'table_get',
  readOnly: true,
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Get a table',
  description:
    'Read one table by id: its columns (id, name, type), a window of rows (default 50; page with `offset`), the total row count, and any column totals (aggregates). Reads the in-flight draft if one exists, else the published grid. **For just the rows addressable by id, `table_rows_list` is lighter.** Large grids page via `offset`/`limit`; the full result spills to the read_result store automatically. Returns a `url` permalink — link the table as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      offset: {
        type: 'number',
        description: "Rows to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'rows per page (default 50, max 500)' },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const loaded = await loadTab(ctx.ownerId, id, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { table, doc, tabId } = loaded;
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = typeof input.limit === 'number' ? input.limit : 50;
    let listed = listRows(doc, { offset, limit });
    // Past the materialize window the doc is a leading slice — totals and
    // pages beyond it come from the file, not the slice (audit finding 4:
    // table_get reported 10k totals and empty pages for a 50k table).
    if (table.docClipped) {
      const file = await windowFile(ctx.ownerId, id);
      const win = file
        ? queryRowsWindow(file, {
            offset,
            limit: Math.max(1, Math.min(limit, 500)),
            ...(tabId ? { tabId } : {}),
          })
        : null;
      if (win) {
        listed = {
          columns: doc.columns.map(colSummary),
          rows: win.rows.map((r, i) => {
            const cells: Record<string, string> = {};
            for (const col of doc.columns) {
              const v = r.cells[col.id];
              if (v === null || v === undefined) continue;
              const text = Array.isArray(v) ? v.join(', ') : String(v);
              if (text) cells[col.id] = text;
            }
            return { id: r.id, index: offset + i, cells };
          }),
          total: win.total,
          offset,
          limit,
        };
      }
    }
    // File-backed tables advertise their SQL surface so table_sql callers
    // know the view/column/FTS names without guessing.
    const surface = await tableSqlSurface(ctx.ownerId, id).catch(() => null);
    const aggregates = table.docClipped
      ? [] // window-only totals would lie — table_query/table_sql aggregate the full set
      : Object.entries(doc.aggregates ?? {}).map(([colId, kind]) => ({
          column_id: colId,
          column: findColumn(doc, colId)?.name ?? colId,
          kind,
          value: computeAggregate(doc, colId, kind as AggregateKind),
        }));
    ctx.step?.setOutput({ id, rows: listed.total });
    return {
      ok: true,
      output: {
        id: table.id,
        title: table.title,
        url: nodeUrl(table.id),
        has_draft: table.draft != null,
        ...(table.tabs && table.tabs.length > 1
          ? {
              tabs: table.tabs,
              tab_id: table.tabId,
              tab_hint: 'columns/rows below are ONE tab — pass `tab` to read another',
            }
          : {}),
        columns: doc.columns.map(colSummary),
        rows: listed.rows,
        total_rows: listed.total,
        offset: listed.offset,
        limit: listed.limit,
        ...pageMeta(listed.total, listed.offset, listed.rows.length),
        ...(aggregates.length ? { aggregates } : {}),
        ...(surface
          ? {
              sql: {
                hint: 'Query committed rows with table_sql against these views (double-quote identifiers; MATCH terms in double quotes).',
                tabs: surface.tabs.map((t) => ({
                  view: t.viewName,
                  fts_table: t.ftsTable,
                  row_count: t.rowCount,
                  columns: t.columns.map((c) => ({
                    name: c.name,
                    type: c.type,
                    ...(c.refersTo ? { linked: true } : {}),
                  })),
                })),
              },
            }
          : {}),
      },
    };
  },
};

const SCHEMA_TABLES_MAX = 20;

export const table_schema: BuiltinToolDef = {
  slug: 'table_schema',
  readOnly: true,
  name: 'Table schemas (data dictionary)',
  description:
    "Data dictionary across tables in one call: every tab with its columns, types, row counts, and the table_sql surface (view + FTS shadow names). Pass `table_ids` for specific tables, or omit to survey the most recently updated (up to 20). Use this to pick the right table and write a table_sql query without fetching each table's rows via `table_get`. Legacy tables not yet file-backed are listed without a schema.",
  inputSchema: {
    type: 'object',
    properties: {
      table_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Table ids (UUIDs) to describe. Omit to survey the most recently updated tables.',
      },
    },
  },
  handler: async (input, ctx) => {
    const ids = Array.isArray(input.table_ids)
      ? input.table_ids.map((v: unknown) => str(v).trim()).filter(Boolean)
      : null;
    let targets: { id: string; title: string; description: string | null }[];
    if (ids && ids.length > 0) {
      const found = await Promise.all(
        ids.slice(0, SCHEMA_TABLES_MAX).map(async (id) => {
          const t = await getTable(ctx.ownerId, id);
          return t ? { id: t.id, title: t.title, description: t.description } : null;
        }),
      );
      targets = found.filter(
        (t): t is { id: string; title: string; description: string | null } => t !== null,
      );
      if (targets.length === 0) return notFound('table', ids[0] ?? '', 'table_list');
    } else {
      const rows = await listTables(ctx.ownerId, { limit: SCHEMA_TABLES_MAX });
      targets = rows.map((r) => ({ id: r.id, title: r.title, description: r.description }));
    }
    const described = await Promise.all(
      targets.map(async (t) => {
        const surface = await tableSqlSurface(ctx.ownerId, t.id).catch(() => null);
        return surface
          ? {
              id: t.id,
              title: t.title,
              schema: schemaToText(surface.tabs, {
                title: t.title,
                nodeId: t.id,
                description: t.description ?? undefined,
              }),
            }
          : {
              id: t.id,
              title: t.title,
              schema: null,
              note: 'legacy storage — no SQL surface until next commit',
            };
      }),
    );
    ctx.step?.setOutput({ tables: described.length });
    return {
      ok: true,
      output: {
        tables: described,
        count: described.length,
        ...(ids && ids.length > SCHEMA_TABLES_MAX
          ? { truncated: true, max: SCHEMA_TABLES_MAX }
          : {}),
        hint: 'Query any listed view with table_sql (double-quote identifiers; FTS MATCH terms in double quotes).',
      },
    };
  },
};

// ───────────────────────── tab CRUD (→ draft) ─────────────────────────

export const table_sql: BuiltinToolDef = {
  slug: 'table_sql',
  readOnly: true,
  preconditions: TABLE_ID_PRE,
  name: 'Query a table with SQL',
  description:
    "Run one read-only SELECT against a table's SQLite workbook and return columns + rows. This is the row-level lookup path: brain search only carries a table's profile, so when a search or profile points at a table, query the actual rows here. Query the tab's SQL view with double-quoted display names (`table_get`'s `sql` block lists views, columns, and the FTS shadow table). Fuzzy/identifier search: `WHERE <fts_table> MATCH '\"K-101\"'` — **always double-quote MATCH terms** (bare hyphens/dots are FTS syntax errors) — or `LIKE '%term%'`. Reads COMMITTED data only (drafts are invisible). For filter-object reads or edits use `table_query` / the row tools instead.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: {
        type: 'string',
        format: 'uuid',
        description: "The table's id — from `table_list` / `search_nodes`.",
      },
      sql: {
        type: 'string',
        description: `One SELECT/WITH statement, e.g. SELECT "Status", count(*) FROM "Circuits" GROUP BY "Status".`,
      },
      max_rows: {
        type: 'number',
        description: 'Row cap for the result.',
        default: SQL_ROW_CAP_DEFAULT,
        minimum: 1,
        maximum: SQL_ROW_CAP_MAX,
      },
    },
    required: ['table_id', 'sql'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const sqlText = str(input.sql);
    if (!tableId || !sqlText.trim()) return { ok: false, error: 'table_id and sql are required' };
    const surface = await tableSqlSurface(ctx.ownerId, tableId);
    if (!surface) {
      return {
        ok: false,
        error:
          `table ${tableId} has no SQL storage yet (it predates sqlite-native tables — any commit converts it). ` +
          `Use table_query / table_rows_list for it, or commit a draft to upgrade it.`,
      };
    }
    try {
      const r = await runTableSql(surface.abs, sqlText, {
        cap: typeof input.max_rows === 'number' ? input.max_rows : undefined,
      });
      ctx.step?.setOutput({ table_id: tableId, rows: r.rowCount, truncated: r.truncated });
      return {
        ok: true,
        output: {
          table_id: tableId,
          columns: r.columns,
          rows: r.rows,
          row_count: r.rowCount,
          duration_ms: r.durationMs,
          ...(r.truncated
            ? {
                truncated: true,
                hint: `Result cut at ${r.rowCount} rows — narrow with WHERE, or aggregate (count/GROUP BY) instead of listing.`,
              }
            : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_rows_list: BuiltinToolDef = {
  slug: 'table_rows_list',
  readOnly: true,
  preconditions: TABLE_ID_PRE,
  name: 'List rows in a table',
  description:
    "Return a windowed snapshot of a table's rows — each as a stable `id` plus short per-cell text. **Use this BEFORE any row edit** so you can target rows by id. Pages via `offset`/`limit` (default 50). `column_ids` restricts the cell snapshot (the column summary still lists every column). Reads the draft if one exists. The row `id`s are stable across edits — addressable in `table_row_update` / `table_cell_set` / `table_row_delete`.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      offset: {
        type: 'number',
        description: "Rows to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'default 50, max 500' },
      column_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'restrict the cell snapshot to these column ids',
      },
      view_id: { type: 'string', description: 'optional saved view (filter+sort) to apply first' },
      tab: { type: 'string', description: TAB_HINT },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { table, doc, tabId } = loaded;
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = Math.max(1, Math.min(typeof input.limit === 'number' ? input.limit : 50, 500));
    if (table.docClipped) {
      // Past the materialize window rows page straight from SQL (document
      // order). Saved views don't apply at this size — use table_query/
      // table_sql for filtered reads.
      if (str(input.view_id).trim()) {
        return {
          ok: false,
          error:
            'saved views are not applied on tables this large — use table_query (filters) or table_sql instead',
        };
      }
      const file = await windowFile(ctx.ownerId, tableId);
      const win = file
        ? queryRowsWindow(file, { offset, limit, ...(tabId ? { tabId } : {}) })
        : null;
      if (!win)
        return { ok: false, error: 'windowed read failed — the workbook file is unavailable' };
      const want = strArr(input.column_ids);
      const wantSet = want.length ? new Set(want) : null;
      const rows = win.rows.map((r, i) => {
        const cells: Record<string, string> = {};
        for (const col of doc.columns) {
          if (wantSet && !wantSet.has(col.id)) continue;
          const v = r.cells[col.id];
          if (v === null || v === undefined) continue;
          const text = Array.isArray(v) ? v.join(', ') : String(v);
          if (text) cells[col.id] = text.length > 60 ? `${text.slice(0, 59)}…` : text;
        }
        return { id: r.id, index: offset + i, cells };
      });
      const columns = doc.columns.map(colSummary);
      ctx.step?.setOutput({ table_id: tableId, total: win.total, pushed: true });
      return {
        ok: true,
        output: {
          table_id: tableId,
          columns,
          rows,
          total: win.total,
          offset,
          limit,
          ...pageMeta(win.total, offset, rows.length),
        },
      };
    }
    const listed = listRows(doc, {
      offset,
      limit,
      columnIds: strArr(input.column_ids),
      viewId: str(input.view_id).trim() || null,
    });
    ctx.step?.setOutput({ table_id: tableId, total: listed.total });
    return {
      ok: true,
      output: {
        table_id: tableId,
        ...listed,
        ...pageMeta(listed.total, listed.offset, listed.rows.length),
      },
    };
  },
};

export const table_row_get: BuiltinToolDef = {
  slug: 'table_row_get',
  preconditions: TABLE_ID_PRE,
  name: 'Get one row',
  description:
    'Read a single row by id (from `table_rows_list`). Returns its cells keyed by column name and id, formula columns resolved. Reads the draft if present.',
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
    const { table, doc, tabId } = loaded;
    let row = findRow(doc, rowId);
    if (!row && table.docClipped) {
      const file = await windowFile(ctx.ownerId, tableId);
      row = file ? readRowById(file, rowId, tabId ? { tabId } : {}) : null;
    }
    if (!row) return { ok: false, error: `row ${rowId} not found (re-run table_rows_list)` };
    const byName: Record<string, CellValue> = {};
    for (const col of doc.columns) byName[col.name] = row.cells[col.id] ?? null;
    return {
      ok: true,
      output: { table_id: tableId, row_id: rowId, cells: row.cells, by_name: byName },
    };
  },
};
