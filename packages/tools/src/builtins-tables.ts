/**
 * Table builtins — let an agent build and operate typed database grids. A
 * table stores its grid as a structured `TableDoc` (`tables.data`), so these
 * wrap the `@mantle/content` table CRUD + the pure model ops. The addressing
 * primitive is the stable `row.id` / `column.id`: "update row X", "total
 * column Y", "set the status cell of row Z" all map straight onto an id — the
 * grid analog of the `page_block_*` tools.
 *
 * Safety mirrors Pages: every structural edit writes to `draft_data` ONLY (via
 * saveTableDraft); the published grid + its brain index are untouched until the
 * operator commits (`table_commit`, or the Commit button at /tables/<id>). So a
 * misbehaving transform can never silently overwrite the live table.
 */
import {
  addColumn,
  addRow,
  commitTable,
  computeAggregate,
  createTable,
  deleteColumn,
  deleteRow,
  deleteTable,
  ensureTableDoc,
  findColumn,
  findColumnByName,
  findRow,
  getTable,
  groupRows,
  listRows,
  listTables,
  queryRows,
  resolveCell,
  saveTableDraft,
  setAggregate,
  setCell,
  setView,
  tableDocFromGrid,
  updateColumn,
  updateRow,
  updateTable,
  nodeUrl,
  AGGREGATE_KINDS,
  COLUMN_TYPES,
  FILTER_OPS,
  type AggregateKind,
  type CellValue,
  type Column,
  type ColumnType,
  type Filter,
  type SortSpec,
  type TableDoc,
  type TableDetail,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { parseSheetToGrid, parseTextToGrid } from '@mantle/files/sheet-to-grid';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/** The doc an edit operates on: the in-flight draft if present, else published. */
function baseline(table: TableDetail): TableDoc {
  return ensureTableDoc(table.draft ?? table.data);
}

/** Resolve a column reference (id OR name) to its Column. */
function resolveColumn(doc: TableDoc, ref: string): Column | null {
  return findColumn(doc, ref) ?? findColumnByName(doc, ref);
}

/** Map a cells object keyed by column name-or-id to one keyed by column id.
 *  Unknown columns are dropped and reported back to the caller. */
function resolveCells(
  doc: TableDoc,
  input: Record<string, unknown>,
): { cells: Record<string, CellValue>; unknown: string[] } {
  const cells: Record<string, CellValue> = {};
  const unknownRefs: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const col = resolveColumn(doc, k);
    if (col) cells[col.id] = v as CellValue;
    else unknownRefs.push(k);
  }
  return { cells, unknown: unknownRefs };
}

/** Make a clipped page self-announce. Every windowed read caps `rows` at 500;
 *  the exact unbounded count lives in `total`. When more rows match than were
 *  returned, surface `truncated`/`next_offset`/`hint` so a caller never mistakes
 *  the returned slice for the whole result set (and knows to page or to read
 *  the total for counts). Returns {} when nothing was clipped. */
function pageMeta(total: number, offset: number, returned: number): Record<string, unknown> {
  const more = total - (offset + returned);
  if (more <= 0) return {};
  const nextOffset = offset + returned;
  return {
    truncated: true,
    next_offset: nextOffset,
    hint:
      `${more} more row(s) match beyond this page — only ${returned} of ${total} returned. ` +
      `For a COUNT use the total (${total}); to read the rest, re-call with offset=${nextOffset}.`,
  };
}

const DRAFT_REVIEW_HINT = (tableId: string) =>
  `Edit applied to DRAFT — the published table is unchanged. Tell the user to ` +
  `open /tables/${tableId} to review; the editor shows the draft. Commit ` +
  `publishes (and re-indexes), Discard reverts.`;

/** Load a table or return a tool error; then run `fn` against its baseline doc
 *  and persist the result to draft. Centralises the load → edit → saveDraft
 *  shape every mutating tool shares. */
async function editDraft(
  ownerId: string,
  tableId: string,
  fn: (doc: TableDoc) => { doc: TableDoc; output?: Record<string, unknown>; error?: string },
): Promise<ToolHandlerResult> {
  const table = await getTable(ownerId, tableId);
  if (!table) return { ok: false, error: `table ${tableId} not found` };
  const res = fn(baseline(table));
  if (res.error) return { ok: false, error: res.error };
  const ok = await saveTableDraft(ownerId, tableId, res.doc);
  if (!ok) return { ok: false, error: `table ${tableId} not found (race?)` };
  return { ok: true, output: { table_id: tableId, ...res.output, draft_saved: true, hint: DRAFT_REVIEW_HINT(tableId) } };
}

// ───────────────────────── CRUD / metadata ─────────────────────────

const table_create: BuiltinToolDef = {
  slug: 'table_create',
  name: 'Create a table',
  description:
    "Create a typed database grid (a `table` node under /tables). `title` required. Optionally seed `columns` — each `{ name, type }` where type is text|number|currency|percent|date|datetime|checkbox|select|multiselect|url|formula. Starts empty (no rows) so you can add rows next, or import from a spreadsheet with `table_from_file`. The grid is indexed into the brain (summary, embedding, facts) on commit. Prefer this over a Pages table when the data is tabular and you'll want totals, typed columns, sorting, or per-row edits.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'table title, e.g. "Stock list"' },
      columns: {
        type: 'array',
        description: 'optional seed columns',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...COLUMN_TYPES] },
          },
          required: ['name'],
        },
      },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📊"' },
    },
    required: ['title'],
  },
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title is required' };
    const colSpecs = Array.isArray(input.columns) ? input.columns : [];
    const data = colSpecs.length
      ? tableDocFromGrid({
          columns: colSpecs.map((c) => ({
            name: str((c as Record<string, unknown>).name),
            type: str((c as Record<string, unknown>).type) || 'text',
          })),
          rows: [],
        })
      : undefined;
    try {
      const table = await createTable(ctx.ownerId, {
        title: title.slice(0, 200),
        ...(data ? { data } : {}),
        tags: strArr(input.tags),
        ...(str(input.icon).trim() ? { icon: str(input.icon).trim() } : {}),
      });
      ctx.step?.setOutput({ id: table.id, title: table.title });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: table.id,
        summary: `Table created by tool: ${table.title}`,
        payload: { via: 'table_create_tool', ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}) },
      });
      return { ok: true, output: { id: table.id, title: table.title, columns: table.data.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_from_file: BuiltinToolDef = {
  slug: 'table_from_file',
  name: 'Create table(s) from a spreadsheet',
  description:
    "Import a `.xlsx` / `.xls` / `.csv` file into typed grids — bytes go server-side from `files` → SheetJS → typed columns + rows, never round-tripping through your output (scales to large sheets). Column types are inferred (numbers, dates, checkboxes, text). **One table per non-empty sheet:** a multi-sheet workbook yields several tables (the first uses your `title` if given; others are named after their sheet). A very large sheet (beyond ~10k rows) is split into contiguous parts ('… (part 1/N)') so no rows are lost — `part`/`partsTotal` are returned. The grids are committed + indexed immediately. Returns the created table ids. Use this whenever the user hands you a spreadsheet.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', format: 'uuid', description: 'id of the spreadsheet file node' },
      title: { type: 'string', description: 'title for the first sheet; others use their sheet name' },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string' },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return { ok: false, error: `file ${fileId} not found` };
    const ext = (meta.filename ?? '').toLowerCase().match(/\.(xlsx|xls|csv)$/)?.[1];
    if (!ext) {
      return { ok: false, error: `table_from_file: '${meta.filename}' is not a spreadsheet (need .xlsx/.xls/.csv)` };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    let sheets;
    try {
      sheets = parseSheetToGrid(res.bytes);
    } catch (err) {
      return { ok: false, error: `spreadsheet parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (sheets.length === 0) return { ok: false, error: 'no tabular data found in the file' };

    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();
    const baseTitle = str(input.title).trim();
    const created: {
      id: string;
      title: string;
      sheet: string;
      columns: number;
      rows: number;
      part?: number;
      partsTotal?: number;
    }[] = [];
    try {
      for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i]!;
        // A sheet over MAX_GRID_ROWS arrives as several parts (same columns);
        // suffix the title so the parts are distinguishable.
        const parted = (sheet.partsTotal ?? 1) > 1;
        const core = (i === 0 && baseTitle) || sheet.name || `Sheet ${i + 1}`;
        const title = (parted ? `${core} (part ${sheet.part}/${sheet.partsTotal})` : core).slice(
          0,
          200,
        );
        const data = tableDocFromGrid(sheet);
        const table = await createTable(ctx.ownerId, {
          title,
          data,
          tags,
          sourceFileId: fileId,
          ...(icon ? { icon } : {}),
        });
        created.push({
          id: table.id,
          title: table.title,
          sheet: sheet.name,
          columns: data.columns.length,
          rows: data.rows.length,
          // Surface pagination so the model can tell the user a big sheet was
          // split across several tables.
          ...(parted ? { part: sheet.part, partsTotal: sheet.partsTotal } : {}),
        });
        const partNote = parted ? ` part ${sheet.part}/${sheet.partsTotal}` : '';
        void recordIngest({
          source: 'agent_tool',
          ownerId: ctx.ownerId,
          nodeId: table.id,
          summary: `Table imported from ${meta.filename} (${sheet.name}${partNote}): ${table.title}`,
          payload: { via: 'table_from_file_tool', sourceFileId: fileId, sheet: sheet.name, ...(parted ? { part: sheet.part, partsTotal: sheet.partsTotal } : {}), ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}) },
        });
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    ctx.step?.setOutput({ tables: created.length, primary: created[0]?.id });
    return { ok: true, output: { tables: created, primary_id: created[0]?.id } };
  },
};

const table_from_text: BuiltinToolDef = {
  slug: 'table_from_text',
  name: 'Create a table from pasted tabular text',
  description:
    "Build a typed grid from a block of tabular text in ONE call — CSV, TSV, or a markdown pipe table. **This is the right tool for \"make a table from these results / this data\" when the rows are in the conversation.** Do NOT create an empty table and add rows one at a time with table_row_add — that's slow and capped at a handful of rows per turn; this ingests the whole block at once. The header row becomes columns and types are inferred (numbers, dates from xlsx, text). The table is created + indexed immediately. `title` is optional.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: "table title; defaults to 'Imported table'" },
      data: {
        type: 'string',
        description:
          'the tabular text. CSV, TSV, or a markdown table (| col | col |\\n|---|---|\\n| … |). The first row is treated as the header.',
      },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string', description: 'optional emoji icon' },
    },
    required: ['data'],
  },
  handler: async (input, ctx) => {
    const data = str(input.data);
    if (!data.trim()) return { ok: false, error: 'data is required' };
    let sheets;
    try {
      sheets = parseTextToGrid(data);
    } catch (err) {
      return { ok: false, error: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (sheets.length === 0 || sheets[0]!.columns.length === 0) {
      return { ok: false, error: 'no table found in the text — expected CSV, TSV, or a markdown | table |' };
    }
    const doc = tableDocFromGrid(sheets[0]!);
    const title = (str(input.title).trim() || 'Imported table').slice(0, 200);
    const icon = str(input.icon).trim();
    try {
      const table = await createTable(ctx.ownerId, {
        title,
        data: doc,
        tags: strArr(input.tags),
        ...(icon ? { icon } : {}),
      });
      ctx.step?.setOutput({ id: table.id, rows: doc.rows.length, columns: doc.columns.length });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: table.id,
        summary: `Table built from pasted text: ${table.title}`,
        payload: { via: 'table_from_text_tool', rows: doc.rows.length, ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}) },
      });
      return {
        ok: true,
        output: {
          id: table.id,
          title: table.title,
          columns: doc.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          rows: doc.rows.length,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_update: BuiltinToolDef = {
  slug: 'table_update',
  name: 'Update table metadata',
  description:
    "Update a table's metadata (title / tags / icon) — NOT its grid. Pass only the fields you're changing. For grid edits use the row/column tools (they write to draft); for the data structure never use this. Returns the updated row.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const patch: Record<string, unknown> = {};
    if (typeof input.title === 'string') patch.title = input.title.trim().slice(0, 200);
    if (Array.isArray(input.tags)) patch.tags = strArr(input.tags);
    if (typeof input.icon === 'string') patch.icon = input.icon.trim();
    if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update — pass title, tags, or icon' };
    try {
      const table = await updateTable(ctx.ownerId, id, patch);
      if (!table) return { ok: false, error: `table ${id} not found` };
      ctx.step?.setOutput({ id: table.id, title: table.title });
      return { ok: true, output: { id: table.id, title: table.title, tags: table.tags } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_delete: BuiltinToolDef = {
  slug: 'table_delete',
  name: 'Delete a table',
  description: 'Permanently delete a table by id. Irreversible — the grid and its index entries are removed. Confirm with the user first.',
  requiresConfirm: true,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await deleteTable(ctx.ownerId, id);
      if (!ok) return { ok: false, error: `table ${id} not found` };
      ctx.step?.setOutput({ id, deleted: true });
      return { ok: true, output: { id, deleted: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_commit: BuiltinToolDef = {
  slug: 'table_commit',
  name: 'Commit a table draft',
  description:
    "Publish a table's pending draft as canonical and re-index it into the brain. Use after a batch of row/column edits when the user has confirmed they want the changes live (or asked you to 'save'/'publish'). No-op error if there's no draft. Usually you LEAVE the draft for the user to review + commit in the UI — only commit yourself when explicitly asked.",
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const table = await getTable(ctx.ownerId, id);
    if (!table) return { ok: false, error: `table ${id} not found` };
    if (!table.draft) return { ok: false, error: 'no draft to commit — the table is already published' };
    try {
      const published = await commitTable(ctx.ownerId, id, table.draft);
      if (!published) return { ok: false, error: `table ${id} not found (race?)` };
      ctx.step?.setOutput({ id, committed: true });
      return { ok: true, output: { id, committed: true, rows: published.data.rows.length, columns: published.data.columns.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ───────────────────────── reads ─────────────────────────

const table_list: BuiltinToolDef = {
  slug: 'table_list',
  name: 'List tables',
  description:
    "List the owner's tables, newest first. Optional `query` substring-matches title/body/summary; `tag` filters. Grids are summarised (column + row counts), not returned in full. For a single table's content use `table_get` / `table_rows_list`. For semantic search use `search_nodes` with type='table'.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      tag: { type: 'string' },
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
        output: rows.map((r) => ({ id: r.id, title: r.title, tags: r.tags, summary: r.summary, columns: r.columnCount, rows: r.rowCount, updatedAt: r.updatedAt })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_get: BuiltinToolDef = {
  slug: 'table_get',
  name: 'Get a table',
  description:
    "Read one table by id: its columns (id, name, type), a window of rows (default 50; page with `offset`), the total row count, and any column totals (aggregates). Reads the in-flight draft if one exists, else the published grid. **For just the rows addressable by id, `table_rows_list` is lighter.** Large grids page via `offset`/`limit`; the full result spills to the read_result store automatically. Returns a `url` permalink — link the table as a markdown `[title](url)` when you reference it to the user.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'rows per page (default 50, max 500)' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const table = await getTable(ctx.ownerId, id);
    if (!table) return { ok: false, error: `table ${id} not found` };
    const doc = baseline(table);
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = typeof input.limit === 'number' ? input.limit : 50;
    const listed = listRows(doc, { offset, limit });
    const aggregates = Object.entries(doc.aggregates ?? {}).map(([colId, kind]) => ({
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
        columns: doc.columns.map((c) => ({ id: c.id, name: c.name, type: c.type, ...(c.formula ? { formula: c.formula } : {}) })),
        rows: listed.rows,
        total_rows: listed.total,
        offset: listed.offset,
        limit: listed.limit,
        ...pageMeta(listed.total, listed.offset, listed.rows.length),
        ...(aggregates.length ? { aggregates } : {}),
      },
    };
  },
};

const table_rows_list: BuiltinToolDef = {
  slug: 'table_rows_list',
  name: 'List rows in a table',
  description:
    "Return a windowed snapshot of a table's rows — each as a stable `id` plus short per-cell text. **Use this BEFORE any row edit** so you can target rows by id. Pages via `offset`/`limit` (default 50). `column_ids` restricts the cell snapshot (the column summary still lists every column). Reads the draft if one exists. The row `id`s are stable across edits — addressable in `table_row_update` / `table_cell_set` / `table_row_delete`.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'default 50, max 500' },
      column_ids: { type: 'array', items: { type: 'string' }, description: 'restrict the cell snapshot to these column ids' },
      view_id: { type: 'string', description: 'optional saved view (filter+sort) to apply first' },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const table = await getTable(ctx.ownerId, tableId);
    if (!table) return { ok: false, error: `table ${tableId} not found` };
    const doc = baseline(table);
    const listed = listRows(doc, {
      offset: typeof input.offset === 'number' ? input.offset : 0,
      limit: typeof input.limit === 'number' ? input.limit : 50,
      columnIds: strArr(input.column_ids),
      viewId: str(input.view_id).trim() || null,
    });
    ctx.step?.setOutput({ table_id: tableId, total: listed.total });
    return { ok: true, output: { table_id: tableId, ...listed, ...pageMeta(listed.total, listed.offset, listed.rows.length) } };
  },
};

const table_row_get: BuiltinToolDef = {
  slug: 'table_row_get',
  name: 'Get one row',
  description: "Read a single row by id (from `table_rows_list`). Returns its cells keyed by column name and id, formula columns resolved. Reads the draft if present.",
  inputSchema: {
    type: 'object',
    properties: { table_id: { type: 'string' }, row_id: { type: 'string' } },
    required: ['table_id', 'row_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    if (!tableId || !rowId) return { ok: false, error: 'table_id and row_id are required' };
    const table = await getTable(ctx.ownerId, tableId);
    if (!table) return { ok: false, error: `table ${tableId} not found` };
    const doc = baseline(table);
    const row = findRow(doc, rowId);
    if (!row) return { ok: false, error: `row ${rowId} not found (re-run table_rows_list)` };
    const byName: Record<string, CellValue> = {};
    for (const col of doc.columns) byName[col.name] = row.cells[col.id] ?? null;
    return { ok: true, output: { table_id: tableId, row_id: rowId, cells: row.cells, by_name: byName } };
  },
};

const table_query: BuiltinToolDef = {
  slug: 'table_query',
  name: 'Query rows by value',
  description:
    "Find the rows that match a filter — the structured-lookup tool, the right way to answer a question about a specific record or subset of a big grid. `filters` is an array of `{ column, op, value }` (column by name OR id; op ∈ eq|neq|contains|gt|lt|gte|lte|empty|notEmpty), AND-ed by default — pass `match: \"any\"` to OR them. Optional `sort` ([{ column, dir }]) and `columns` (return just these columns). Returns ONLY the matching rows (id + cells keyed by column name, formula columns resolved) plus `total_matches`, so you can answer \"what's the design pressure for circuit 17-P08-D17003\" or \"which CMLs are below their retirement thickness\" directly instead of paging the whole table. Pass `aggregate` ([{ column, kind }], kind ∈ sum|avg|count|min|max|filled|empty) to compute totals over the WHOLE matched set in one call — e.g. max design pressure among CS circuits — without reading the rows back. **`rows` is capped at 500 per call; `total_matches` is exact and unbounded — use it for COUNTS, and `offset` to page the rest (the response sets `truncated`/`next_offset` when clipped).** Read-only — nothing is saved (unlike `table_set_view`). Reads the draft if one exists. For grouped breakdowns (\"count by metallurgy\") use `table_aggregate`.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      filters: {
        type: 'array',
        description: 'predicates over columns; AND-ed unless match="any"',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: { type: 'string', enum: [...FILTER_OPS] },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      match: { type: 'string', enum: ['all', 'any'], description: "combine filters with AND ('all', default) or OR ('any')" },
      sort: {
        type: 'array',
        items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] },
      },
      columns: { type: 'array', items: { type: 'string' }, description: 'restrict returned cells to these columns (id or name)' },
      aggregate: {
        type: 'array',
        description: 'compute totals over the full matched set (not just the returned page)',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: { type: 'string', enum: AGGREGATE_KINDS.filter((k) => k !== 'none') },
          },
          required: ['column', 'kind'],
        },
      },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'max matching rows to return (default 50, max 500)' },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const table = await getTable(ctx.ownerId, tableId);
    if (!table) return { ok: false, error: `table ${tableId} not found` };
    const doc = baseline(table);

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return { colId: col.id, op: str(rec.op) as Filter['op'], value: (rec.value ?? null) as CellValue };
      })
      .filter((f): f is Filter => f !== null);
    const sort: SortSpec[] = (Array.isArray(input.sort) ? input.sort : [])
      .map((s): SortSpec | null => {
        const col = resolveColumn(doc, str((s as Record<string, unknown>).column));
        return col ? { colId: col.id, dir: (s as Record<string, unknown>).dir === 'desc' ? 'desc' : 'asc' } : null;
      })
      .filter((s): s is SortSpec => s !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';

    const matched = queryRows(doc, { filters, sort, match });
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = Math.max(1, Math.min(typeof input.limit === 'number' ? input.limit : 50, 500));

    const wantCols = strArr(input.columns)
      .map((c) => resolveColumn(doc, c))
      .filter((c): c is Column => c !== null);
    const projCols = wantCols.length ? wantCols : doc.columns;
    const rows = matched.slice(offset, offset + limit).map((r) => {
      const cells: Record<string, CellValue> = {};
      for (const col of projCols) cells[col.name] = resolveCell(doc, r, col);
      return { id: r.id, cells };
    });

    // Aggregates over the FULL matched set (not the returned page) — so
    // "max design pressure among CS circuits" is one call, cap-immune.
    const ignoredAggregates: string[] = [];
    const aggregates = (Array.isArray(input.aggregate) ? input.aggregate : [])
      .map((a): { column: string; kind: AggregateKind; value: number | null } | null => {
        const rec = a as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        if (!col || !AGGREGATE_KINDS.includes(kind) || kind === 'none') {
          ignoredAggregates.push(str(rec.column));
          return null;
        }
        return { column: col.name, kind, value: computeAggregate(doc, col.id, kind, matched) };
      })
      .filter((a): a is { column: string; kind: AggregateKind; value: number | null } => a !== null);

    ctx.step?.setOutput({ table_id: tableId, matches: matched.length });
    return {
      ok: true,
      output: {
        table_id: tableId,
        total_matches: matched.length,
        offset,
        limit,
        columns: projCols.map((c) => c.name),
        rows,
        ...(aggregates.length ? { aggregates } : {}),
        ...pageMeta(matched.length, offset, rows.length),
        ...(ignoredFilters.length ? { ignored_filters: ignoredFilters } : {}),
        ...(ignoredAggregates.length ? { ignored_aggregates: ignoredAggregates } : {}),
      },
    };
  },
};

const table_aggregate: BuiltinToolDef = {
  slug: 'table_aggregate',
  name: 'Group + summarise rows',
  description:
    "Summarise a table by category — the GROUP BY tool. `group_by` is one or more columns (id or name); rows are bucketed by their combined value and each group returns its row `count` plus any `metrics` you ask for (`[{ column, kind }]`, kind ∈ sum|avg|count|min|max|filled|empty). Optional `filters` (same `{ column, op, value }` shape as table_query) restrict the rows first, `match` ANDs/ORs them, `sort` ({ by, dir } — by = 'count', a group column, or a metric column) orders the groups (default: most populous first), and `limit`/`offset` page the groups. Answers \"how many circuits per metallurgy\", \"max design pressure by service\", or \"what distinct damage types exist\" (group_by alone) in ONE call — no row paging. Read-only; reads the draft if present.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      group_by: { type: 'array', items: { type: 'string' }, description: 'column(s) to group by (id or name)' },
      metrics: {
        type: 'array',
        description: 'per-group aggregates to compute',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: { type: 'string', enum: AGGREGATE_KINDS.filter((k) => k !== 'none') },
          },
          required: ['column', 'kind'],
        },
      },
      filters: {
        type: 'array',
        description: 'restrict rows before grouping (AND-ed unless match="any")',
        items: {
          type: 'object',
          properties: { column: { type: 'string' }, op: { type: 'string', enum: [...FILTER_OPS] }, value: {} },
          required: ['column', 'op'],
        },
      },
      match: { type: 'string', enum: ['all', 'any'], description: "combine filters with AND ('all', default) or OR ('any')" },
      sort: {
        type: 'object',
        properties: { by: { type: 'string', description: "'count', a group column, or a metric column" }, dir: { type: 'string', enum: ['asc', 'desc'] } },
      },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'max groups to return (default 50, max 500)' },
    },
    required: ['table_id', 'group_by'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const table = await getTable(ctx.ownerId, tableId);
    if (!table) return { ok: false, error: `table ${tableId} not found` };
    const doc = baseline(table);

    const groupCols = strArr(input.group_by)
      .map((r) => resolveColumn(doc, r))
      .filter((c): c is Column => c !== null);
    if (groupCols.length === 0) return { ok: false, error: 'group_by must name at least one existing column' };

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return { colId: col.id, op: str(rec.op) as Filter['op'], value: (rec.value ?? null) as CellValue };
      })
      .filter((f): f is Filter => f !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';

    const metricSpecs = (Array.isArray(input.metrics) ? input.metrics : [])
      .map((m): { colId: string; column: string; kind: AggregateKind } | null => {
        const rec = m as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        return col && AGGREGATE_KINDS.includes(kind) && kind !== 'none' ? { colId: col.id, column: col.name, kind } : null;
      })
      .filter((m): m is { colId: string; column: string; kind: AggregateKind } => m !== null);

    const buckets = groupRows(doc, { groupColIds: groupCols.map((c) => c.id), filters, match });
    type Group = { key: Record<string, CellValue>; count: number; metrics?: { column: string; kind: AggregateKind; value: number | null }[] };
    let groups: Group[] = buckets.map((b) => ({
      key: Object.fromEntries(groupCols.map((c, i) => [c.name, b.key[i] ?? null])),
      count: b.rows.length,
      ...(metricSpecs.length
        ? { metrics: metricSpecs.map((m) => ({ column: m.column, kind: m.kind, value: computeAggregate(doc, m.colId, m.kind, b.rows) })) }
        : {}),
    }));

    // Order the groups. Default = most populous first; or by an explicit
    // { by, dir } over count / a group column / a named metric.
    const sortRec = input.sort && typeof input.sort === 'object' ? (input.sort as Record<string, unknown>) : null;
    const by = sortRec ? str(sortRec.by) || 'count' : 'count';
    const sign = sortRec && str(sortRec.dir) === 'asc' ? 1 : -1;
    groups = [...groups].sort((a, b) => {
      let va: CellValue, vb: CellValue;
      if (by === 'count') {
        va = a.count;
        vb = b.count;
      } else if (metricSpecs.some((m) => m.column === by)) {
        va = a.metrics?.find((x) => x.column === by)?.value ?? null;
        vb = b.metrics?.find((x) => x.column === by)?.value ?? null;
      } else if (groupCols.some((c) => c.name === by)) {
        va = a.key[by] ?? null;
        vb = b.key[by] ?? null;
      } else {
        return 0;
      }
      const na = typeof va === 'number' ? va : null;
      const nb = typeof vb === 'number' ? vb : null;
      const cmp = na !== null && nb !== null ? na - nb : String(va ?? '').localeCompare(String(vb ?? ''));
      return sign * cmp;
    });

    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(input.limit, 500)) : 50;
    const total = groups.length;
    const page = groups.slice(offset, offset + limit);

    ctx.step?.setOutput({ table_id: tableId, groups: total });
    return {
      ok: true,
      output: {
        table_id: tableId,
        group_by: groupCols.map((c) => c.name),
        total_groups: total,
        offset,
        groups: page,
        ...pageMeta(total, offset, page.length),
        ...(ignoredFilters.length ? { ignored_filters: ignoredFilters } : {}),
      },
    };
  },
};

// ───────────────────────── row edits (→ draft) ─────────────────────────

const CELLS_HINT =
  'cells keyed by column NAME or id, e.g. { "Qty": 3, "Status": "Open" }. Values are coerced to the column type.';

const table_row_add: BuiltinToolDef = {
  slug: 'table_row_add',
  name: 'Add a row',
  description: "Append a new row (or insert after `after_row_id`). Returns the new row id. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      cells: { type: 'object', description: CELLS_HINT, additionalProperties: true },
      after_row_id: { type: 'string', description: 'optional — insert after this row instead of appending' },
    },
    required: ['table_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const cellsIn = (input.cells && typeof input.cells === 'object' ? input.cells : {}) as Record<string, unknown>;
    let newRowId = '';
    let unknownRefs: string[] = [];
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const { cells, unknown } = resolveCells(doc, cellsIn);
      unknownRefs = unknown;
      const out = addRow(doc, cells, str(input.after_row_id).trim() || null);
      newRowId = out.row.id;
      return { doc: out.doc, output: { row_id: out.row.id, ...(unknown.length ? { ignored_columns: unknown } : {}) } };
    });
    ctx.step?.setOutput({ table_id: tableId, row_id: newRowId, ...(unknownRefs.length ? { ignored: unknownRefs.length } : {}) });
    return res;
  },
};

const table_row_update: BuiltinToolDef = {
  slug: 'table_row_update',
  name: 'Update a row',
  description: "Patch a row's cells by id (merge — unspecified cells stay). The surgical \"do row X\" tool. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      row_id: { type: 'string' },
      cells: { type: 'object', description: CELLS_HINT, additionalProperties: true },
    },
    required: ['table_id', 'row_id', 'cells'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    if (!tableId || !rowId) return { ok: false, error: 'table_id and row_id are required' };
    const cellsIn = (input.cells && typeof input.cells === 'object' ? input.cells : {}) as Record<string, unknown>;
    if (Object.keys(cellsIn).length === 0) return { ok: false, error: 'cells is required (nothing to update)' };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      if (!findRow(doc, rowId)) return { doc, error: `row ${rowId} not found (re-run table_rows_list)` };
      const { cells, unknown } = resolveCells(doc, cellsIn);
      return { doc: updateRow(doc, rowId, cells), output: { row_id: rowId, ...(unknown.length ? { ignored_columns: unknown } : {}) } };
    });
    ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
    return res;
  },
};

const table_row_delete: BuiltinToolDef = {
  slug: 'table_row_delete',
  name: 'Delete a row',
  description: "Remove a row by id. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: { table_id: { type: 'string' }, row_id: { type: 'string' } },
    required: ['table_id', 'row_id'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    if (!tableId || !rowId) return { ok: false, error: 'table_id and row_id are required' };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      if (!findRow(doc, rowId)) return { doc, error: `row ${rowId} not found` };
      return { doc: deleteRow(doc, rowId), output: { row_id: rowId, deleted: true } };
    });
    ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
    return res;
  },
};

const table_cell_set: BuiltinToolDef = {
  slug: 'table_cell_set',
  name: 'Set one cell',
  description: "Set a single cell — row by id, column by id or name. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      row_id: { type: 'string' },
      column: { type: 'string', description: 'column id or name' },
      value: { description: 'new value (coerced to the column type); null/"" clears' },
    },
    required: ['table_id', 'row_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const rowId = str(input.row_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !rowId || !columnRef) return { ok: false, error: 'table_id, row_id and column are required' };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      if (!findRow(doc, rowId)) return { doc, error: `row ${rowId} not found` };
      const col = resolveColumn(doc, columnRef);
      if (!col) return { doc, error: `column '${columnRef}' not found` };
      return { doc: setCell(doc, rowId, col.id, (input.value ?? null) as CellValue), output: { row_id: rowId, column_id: col.id } };
    });
    ctx.step?.setOutput({ table_id: tableId, row_id: rowId });
    return res;
  },
};

// ───────────────────────── column edits (→ draft) ─────────────────────────

const table_column_add: BuiltinToolDef = {
  slug: 'table_column_add',
  name: 'Add a column',
  description:
    "Add a column. `type` ∈ text|number|currency|percent|date|datetime|checkbox|select|multiselect|url|formula. For currency pass `format.currency` (ISO code); for select/multiselect pass `options` (array of label strings); for a formula column pass `formula` (e.g. \"{Qty} * {Price}\" — references other columns by name). Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string', enum: [...COLUMN_TYPES] },
      format: { type: 'object', description: 'e.g. { "currency": "USD", "decimals": 2 }', additionalProperties: true },
      options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect choices' },
      formula: { type: 'string', description: 'for type=formula, e.g. "{Qty} * {Price}"' },
      after_column: { type: 'string', description: 'optional column id/name to insert after' },
    },
    required: ['table_id', 'name', 'type'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    const type = str(input.type).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    if (!COLUMN_TYPES.includes(type as ColumnType)) return { ok: false, error: `invalid type '${type}'` };
    let newColId = '';
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const spec: Omit<Column, 'id'> = { name, type: type as ColumnType };
      if (input.format && typeof input.format === 'object') spec.format = input.format as Column['format'];
      if (Array.isArray(input.options)) spec.options = strArr(input.options).map((label) => ({ id: label.toLowerCase().replace(/\s+/g, '_'), label }));
      if (str(input.formula).trim()) spec.formula = str(input.formula).trim();
      const after = str(input.after_column).trim();
      const out = addColumn(doc, spec, after ? resolveColumn(doc, after)?.id ?? null : null);
      newColId = out.column.id;
      return { doc: out.doc, output: { column_id: out.column.id, name } };
    });
    ctx.step?.setOutput({ table_id: tableId, column_id: newColId });
    return res;
  },
};

const table_column_update: BuiltinToolDef = {
  slug: 'table_column_update',
  name: 'Update a column',
  description: "Change a column (by id or name): rename, retype (cells are re-coerced), set format/options/formula. Pass only what changes. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      column: { type: 'string', description: 'column id or name' },
      name: { type: 'string' },
      type: { type: 'string', enum: [...COLUMN_TYPES] },
      format: { type: 'object', additionalProperties: true },
      options: { type: 'array', items: { type: 'string' } },
      formula: { type: 'string' },
    },
    required: ['table_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { doc, error: `column '${columnRef}' not found` };
      const patch: Partial<Omit<Column, 'id'>> = {};
      if (str(input.name).trim()) patch.name = str(input.name).trim();
      if (str(input.type).trim()) {
        if (!COLUMN_TYPES.includes(str(input.type).trim() as ColumnType)) return { doc, error: `invalid type '${str(input.type)}'` };
        patch.type = str(input.type).trim() as ColumnType;
      }
      if (input.format && typeof input.format === 'object') patch.format = input.format as Column['format'];
      if (Array.isArray(input.options)) patch.options = strArr(input.options).map((label) => ({ id: label.toLowerCase().replace(/\s+/g, '_'), label }));
      if (typeof input.formula === 'string') patch.formula = input.formula.trim();
      if (Object.keys(patch).length === 0) return { doc, error: 'nothing to update' };
      return { doc: updateColumn(doc, col.id, patch), output: { column_id: col.id } };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

const table_column_delete: BuiltinToolDef = {
  slug: 'table_column_delete',
  name: 'Delete a column',
  description: "Remove a column (by id or name) and all its cells. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: { table_id: { type: 'string' }, column: { type: 'string', description: 'column id or name' } },
    required: ['table_id', 'column'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { doc, error: `column '${columnRef}' not found` };
      return { doc: deleteColumn(doc, col.id), output: { column_id: col.id, deleted: true } };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

const table_set_aggregate: BuiltinToolDef = {
  slug: 'table_set_aggregate',
  name: 'Set a column total',
  description:
    "Set (or clear) a column's footer total — the \"add totals\" tool. `kind` ∈ sum|avg|count|min|max|filled|empty, or `none` to clear. Shows in the totals row and the indexed text. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      column: { type: 'string', description: 'column id or name' },
      kind: { type: 'string', enum: [...AGGREGATE_KINDS] },
    },
    required: ['table_id', 'column', 'kind'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const columnRef = str(input.column).trim();
    const kind = str(input.kind).trim();
    if (!tableId || !columnRef) return { ok: false, error: 'table_id and column are required' };
    if (!AGGREGATE_KINDS.includes(kind as AggregateKind)) return { ok: false, error: `invalid kind '${kind}'` };
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const col = resolveColumn(doc, columnRef);
      if (!col) return { doc, error: `column '${columnRef}' not found` };
      const next = setAggregate(doc, col.id, kind as AggregateKind);
      const value = kind === 'none' ? null : computeAggregate(next, col.id, kind as AggregateKind);
      return { doc: next, output: { column_id: col.id, kind, value } };
    });
    ctx.step?.setOutput({ table_id: tableId });
    return res;
  },
};

const table_set_view: BuiltinToolDef = {
  slug: 'table_set_view',
  name: 'Save a filter/sort view',
  description:
    "Create or update a saved view — a named filter + sort over the table. `sort` is an array of `{ column, dir }` (dir asc|desc; column by id/name). `filters` is an array of `{ column, op, value }` (op ∈ eq|neq|contains|gt|lt|gte|lte|empty|notEmpty). Pass `view_id` to update an existing view. Writes to DRAFT.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
      name: { type: 'string' },
      view_id: { type: 'string', description: 'omit to create a new view' },
      sort: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] } },
      filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['column', 'op'] } },
    },
    required: ['table_id', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    let viewId = '';
    const res = await editDraft(ctx.ownerId, tableId, (doc) => {
      const sort: SortSpec[] = (Array.isArray(input.sort) ? input.sort : [])
        .map((s): SortSpec | null => {
          const col = resolveColumn(doc, str((s as Record<string, unknown>).column));
          return col ? { colId: col.id, dir: (s as Record<string, unknown>).dir === 'desc' ? 'desc' : 'asc' } : null;
        })
        .filter((s): s is SortSpec => s !== null);
      const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
        .map((f): Filter | null => {
          const rec = f as Record<string, unknown>;
          const col = resolveColumn(doc, str(rec.column));
          return col ? { colId: col.id, op: str(rec.op) as Filter['op'], value: (rec.value ?? null) as CellValue } : null;
        })
        .filter((f): f is Filter => f !== null);
      const existing = str(input.view_id).trim();
      viewId = existing || `v_${Math.random().toString(36).slice(2, 10)}`;
      const next = setView(doc, { id: viewId, name, sort, filters });
      return { doc: next, output: { view_id: viewId, name } };
    });
    ctx.step?.setOutput({ table_id: tableId, view_id: viewId });
    return res;
  },
};

export const TABLE_TOOLS: BuiltinToolDef[] = [
  table_create,
  table_from_file,
  table_from_text,
  table_update,
  table_delete,
  table_commit,
  table_list,
  table_get,
  table_rows_list,
  table_row_get,
  table_query,
  table_aggregate,
  table_row_add,
  table_row_update,
  table_row_delete,
  table_cell_set,
  table_column_add,
  table_column_update,
  table_column_delete,
  table_set_aggregate,
  table_set_view,
];

export const TABLE_TOOL_SLUGS: string[] = TABLE_TOOLS.map((t) => t.slug);
