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
  commitTable,
  computeAggregate,
  createTable,
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
  applyTableOps,
  setAggregate,
  tableDocFromGrid,
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
import { existsSync } from 'node:fs';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { fileById, readFileById } from '@mantle/files';
import { parseSheetToGrid, parseTextToGrid } from '@mantle/files/sheet-to-grid';
import {
  SQL_ROW_CAP_DEFAULT,
  SQL_ROW_CAP_MAX,
  aggregateWindow,
  draftPathFor,
  queryRowsWindow,
  readRowById,
  runTableSql,
  schemaToText,
  type TableOp,
} from '@mantle/tabledb';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { str, strArr } from './coerce';
import { notFound } from './errors';
import type { ToolPrecondition } from './types';

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING node of the right type.
const TABLE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'table_id', nodeType: 'table', lookup: 'table_list' },
];
const TABLE_NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'table', lookup: 'table_list' },
];
const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];

/** The doc an edit operates on: the in-flight draft if present, else published. */
function baseline(table: TableDetail): TableDoc {
  return ensureTableDoc(table.draft ?? table.data);
}

/** Resolve a column reference (id OR name) to its Column. */
function resolveColumn(doc: TableDoc, ref: string): Column | null {
  return findColumn(doc, ref) ?? findColumnByName(doc, ref);
}

/** Column summary for tool outputs. A linked (reference) column also reports
 *  its `linked_to` source ids so the assistant knows where the values come
 *  from (v2.2). */
function colSummary(c: Column): {
  id: string;
  name: string;
  type: ColumnType;
  formula?: string;
  linked_to?: { tab_id: string; column_id: string };
} {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    ...(c.formula ? { formula: c.formula } : {}),
    ...(c.type === 'reference' && c.ref
      ? { linked_to: { tab_id: c.ref.tabId, column_id: c.ref.columnId } }
      : {}),
  };
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

/** Draft-first workbook file for windowed reads/writes; null = legacy JSONB
 *  table (still served by the doc path). */
async function windowFile(ownerId: string, tableId: string): Promise<string | null> {
  const surface = await tableSqlSurface(ownerId, tableId).catch(() => null);
  if (!surface) return null;
  const draftAbs = draftPathFor(surface.abs);
  return existsSync(draftAbs) ? draftAbs : surface.abs;
}

/** Row-existence check that works past the materialize window: the clipped
 *  doc first (free), then the workbook file by id. Legacy tables only have
 *  the doc. */
async function rowExists(
  ownerId: string,
  tableId: string,
  doc: TableDoc,
  rowId: string,
  tabId?: string,
): Promise<boolean> {
  if (findRow(doc, rowId)) return true;
  const file = await windowFile(ownerId, tableId);
  if (!file) return false;
  return readRowById(file, rowId, tabId ? { tabId } : {}) !== null;
}

const TAB_HINT = "Tab to target, by name or id — from `table_get`'s tabs. Omit for the first tab.";

/** Load a table plus the TARGET TAB's baseline doc. `tabRef` is a tab id or
 *  name (case-insensitive); absent = first tab (single-tab tables never need
 *  it). Returns `tabId` only when explicitly targeted — ops then carry it. */
async function loadTab(
  ownerId: string,
  tableId: string,
  tabRef: unknown,
): Promise<{ table: TableDetail; doc: TableDoc; tabId?: string } | { error: string }> {
  const table = await getTable(ownerId, tableId);
  if (!table) return { error: `table ${tableId} not found — check the id with table_list` };
  const want = str(tabRef).trim();
  if (!want) return { table, doc: baseline(table) };
  const tabs = table.tabs ?? [];
  const hit =
    tabs.find((t) => t.id === want) ??
    tabs.find((t) => t.name.toLowerCase() === want.toLowerCase());
  if (!hit) {
    return {
      error: `no tab '${want}' on this table — tabs: ${tabs.map((t) => t.name).join(', ') || '(single tab)'}`,
    };
  }
  if (hit.id === table.tabId) return { table, doc: baseline(table), tabId: hit.id };
  const scoped = await getTable(ownerId, tableId, { tabId: hit.id });
  if (!scoped) return { error: `table ${tableId} not found (race?)` };
  return { table: scoped, doc: baseline(scoped), tabId: hit.id };
}

/** Resolve a `reference: {tab, column}` input (names or ids) to the engine's
 *  {tabId, columnId}. Same-workbook only. */
async function resolveRefTarget(
  ownerId: string,
  tableId: string,
  refInput: unknown,
): Promise<{ ref: { tabId: string; columnId: string } } | { error: string }> {
  const rec = (refInput ?? {}) as Record<string, unknown>;
  const tabRef = str(rec.tab).trim();
  const colRef = str(rec.column).trim();
  if (!tabRef || !colRef) {
    return {
      error:
        "a reference column needs `reference: { tab, column }` — the source tab and column it offers values from (see table_get's tabs)",
    };
  }
  const loaded = await loadTab(ownerId, tableId, tabRef);
  if ('error' in loaded) return { error: loaded.error };
  const srcTabId = loaded.tabId ?? loaded.table.tabId;
  if (!srcTabId)
    return {
      error: `cannot resolve tab '${tabRef}' — this table has no tab metadata (commit it once, then retry)`,
    };
  const col = resolveColumn(loaded.doc, colRef);
  if (!col) return { error: `column '${colRef}' not found on tab '${tabRef}'` };
  if (col.type === 'formula') return { error: 'a reference column cannot target a formula column' };
  return { ref: { tabId: srcTabId, columnId: col.id } };
}

/** Validate against the target tab's baseline doc, then dispatch draft OPS —
 *  the structural (column/view/aggregate) tools' shape since v2.1: the op
 *  path targets any tab and scales past the materialize window (the old
 *  whole-doc save refused clipped tables and would have dropped sibling
 *  tabs). */
async function editViaOps(
  ownerId: string,
  tableId: string,
  tabRef: unknown,
  build: (doc: TableDoc) => { ops: TableOp[]; output?: Record<string, unknown>; error?: string },
): Promise<ToolHandlerResult> {
  const loaded = await loadTab(ownerId, tableId, tabRef);
  if ('error' in loaded) return { ok: false, error: loaded.error };
  const res = build(loaded.doc);
  if (res.error) return { ok: false, error: res.error };
  const targetTabId = loaded.tabId;
  try {
    const applied = await applyTableOps(
      ownerId,
      tableId,
      targetTabId ? res.ops.map((o) => ({ ...o, tabId: targetTabId })) : res.ops,
    );
    if (!applied) return notFound('table', tableId, 'table_list');
    if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
    return {
      ok: true,
      output: {
        table_id: tableId,
        ...(loaded.tabId ? { tab_id: loaded.tabId } : {}),
        ...res.output,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(tableId),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
            name: { type: 'string', description: 'Column header, e.g. "Price".' },
            type: {
              type: 'string',
              enum: [...COLUMN_TYPES],
              description: 'Cell type — governs coercion, sorting, and totals. Defaults to text.',
            },
          },
          required: ['name'],
        },
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
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
        payload: {
          via: 'table_create_tool',
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
      });
      return {
        ok: true,
        output: { id: table.id, title: table.title, columns: table.data.columns.map(colSummary) },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_from_file: BuiltinToolDef = {
  slug: 'table_from_file',
  preconditions: FILE_ID_PRE,
  name: 'Create a table from a spreadsheet',
  description:
    "Import a `.xlsx` / `.xls` / `.csv` file into ONE typed table — bytes go server-side from `files` → SheetJS → typed columns + rows, never round-tripping through your output (scales to large sheets). Column types are inferred (numbers, dates, checkboxes, text). **One workbook per file: every non-empty sheet becomes a TAB** of the same table (like Excel), addressable by name in the row/query tools and joinable across tabs with `table_sql`. Very large sheets import whole (sqlite-native storage) up to the box's import ceiling — beyond it the import errors with guidance and nothing partial is created. The table is committed + indexed immediately. Returns the table id and its tabs. Use this whenever the user hands you a spreadsheet.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The spreadsheet file's id — from `file_list` / `search_nodes`.",
      },
      title: { type: 'string', description: 'table title (defaults to the filename)' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      icon: { type: 'string', description: 'Optional emoji icon, e.g. "📊".' },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'file_list / search_nodes');
    const ext = (meta.filename ?? '').toLowerCase().match(/\.(xlsx|xls|csv)$/)?.[1];
    if (!ext) {
      return {
        ok: false,
        error: `table_from_file: '${meta.filename}' is not a spreadsheet (need .xlsx/.xls/.csv)`,
      };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    let sheets;
    try {
      sheets = parseSheetToGrid(res.bytes);
    } catch (err) {
      return {
        ok: false,
        error: `spreadsheet parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (sheets.length === 0) return { ok: false, error: 'no tabular data found in the file' };

    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();
    const baseTitle = str(input.title).trim();
    const title = (
      baseTitle ||
      meta.filename.replace(/\.(xlsx|xls|csv)$/i, '') ||
      'Imported table'
    ).slice(0, 200);
    // One workbook per file (v2.1 P2): sheets become tabs, not sibling tables.
    const tabs = sheets.map((sheet, i) => ({
      ...tableDocFromGrid(sheet),
      name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
    }));
    try {
      const table = await createTable(ctx.ownerId, {
        title,
        tabs,
        tags,
        sourceFileId: fileId,
        ...(icon ? { icon } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: table.id,
        summary: `Table imported from ${meta.filename} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'}): ${table.title}`,
        payload: {
          via: 'table_from_file_tool',
          sourceFileId: fileId,
          sheets: sheets.length,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
      });
      ctx.step?.setOutput({ id: table.id, tabs: tabs.length });
      return {
        ok: true,
        output: {
          id: table.id,
          title: table.title,
          url: nodeUrl(table.id),
          tabs: tabs.map((t) => ({ name: t.name, columns: t.columns.length, rows: t.rows.length })),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_from_text: BuiltinToolDef = {
  slug: 'table_from_text',
  name: 'Create a table from pasted tabular text',
  description:
    'Build a typed grid from a block of tabular text in ONE call — CSV, TSV, or a markdown pipe table. **This is the right tool for "make a table from these results / this data" when the rows are in the conversation.** Do NOT create an empty table and add rows one at a time with table_row_add — that\'s slow and capped at a handful of rows per turn; this ingests the whole block at once. The header row becomes columns and types are inferred (numbers, dates from xlsx, text). The table is created + indexed immediately. `title` is optional.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: "table title; defaults to 'Imported table'" },
      data: {
        type: 'string',
        description:
          'the tabular text. CSV, TSV, or a markdown table (| col | col |\\n|---|---|\\n| … |). The first row is treated as the header.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
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
      return {
        ok: false,
        error: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (sheets.length === 0 || sheets[0]!.columns.length === 0) {
      return {
        ok: false,
        error: 'no table found in the text — expected CSV, TSV, or a markdown | table |',
      };
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
        payload: {
          via: 'table_from_text_tool',
          rows: doc.rows.length,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
      });
      return {
        ok: true,
        output: {
          id: table.id,
          title: table.title,
          columns: doc.columns.map(colSummary),
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
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Update table metadata',
  description:
    "Update a table's metadata (title / tags / icon) — NOT its grid. Pass only the fields you're changing. For grid edits use the row/column tools (they write to draft); for the data structure never use this. Returns the updated row.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      title: { type: 'string', description: 'New title, e.g. "Q3 stock list".' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Labels for organisation and filtering, e.g. ['work']. Replaces the existing set.",
      },
      icon: { type: 'string', description: 'Emoji icon shown beside the title, e.g. "📊".' },
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
    if (Object.keys(patch).length === 0)
      return { ok: false, error: 'nothing to update — pass title, tags, or icon' };
    try {
      const table = await updateTable(ctx.ownerId, id, patch);
      if (!table) return notFound('table', id, 'table_list');
      ctx.step?.setOutput({ id: table.id, title: table.title });
      return { ok: true, output: { id: table.id, title: table.title, tags: table.tags } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_delete: BuiltinToolDef = {
  slug: 'table_delete',
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Delete a table',
  description:
    'Permanently delete a table by id. Irreversible — the grid and its index entries are removed. Confirm with the user first.',
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await deleteTable(ctx.ownerId, id);
      if (!ok) return notFound('table', id, 'table_list');
      ctx.step?.setOutput({ id, deleted: true });
      return { ok: true, output: { id, deleted: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_commit: BuiltinToolDef = {
  slug: 'table_commit',
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Commit a table draft',
  description:
    "Publish a table's pending draft as canonical and re-index it into the brain. Use after a batch of row/column edits when the user has confirmed they want the changes live (or asked you to 'save'/'publish'). No-op error if there's no draft. Usually you LEAVE the draft for the user to review + commit in the UI — only commit yourself when explicitly asked.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      // Promote the SERVER draft (no doc round-trip): works at any size and
      // can never truncate — the §4 commit semantics.
      const published = await commitTable(ctx.ownerId, id);
      if (!published) return notFound('table', id, 'table_list');
      ctx.step?.setOutput({ id, committed: true });
      return {
        ok: true,
        output: { id, committed: true, rows: published.rowCount, columns: published.columnCount },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ───────────────────────── reads ─────────────────────────

const table_sql: BuiltinToolDef = {
  slug: 'table_sql',
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_list: BuiltinToolDef = {
  slug: 'table_list',
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_get: BuiltinToolDef = {
  slug: 'table_get',
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

const table_schema: BuiltinToolDef = {
  slug: 'table_schema',
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
    let targets: { id: string; title: string }[];
    if (ids && ids.length > 0) {
      const found = await Promise.all(
        ids.slice(0, SCHEMA_TABLES_MAX).map(async (id) => {
          const t = await getTable(ctx.ownerId, id);
          return t ? { id: t.id, title: t.title } : null;
        }),
      );
      targets = found.filter((t): t is { id: string; title: string } => t !== null);
      if (targets.length === 0) return notFound('table', ids[0] ?? '', 'table_list');
    } else {
      const rows = await listTables(ctx.ownerId, { limit: SCHEMA_TABLES_MAX });
      targets = rows.map((r) => ({ id: r.id, title: r.title }));
    }
    const described = await Promise.all(
      targets.map(async (t) => {
        const surface = await tableSqlSurface(ctx.ownerId, t.id).catch(() => null);
        return surface
          ? {
              id: t.id,
              title: t.title,
              schema: schemaToText(surface.tabs, { title: t.title, nodeId: t.id }),
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

const table_tab_add: BuiltinToolDef = {
  slug: 'table_tab_add',
  preconditions: TABLE_ID_PRE,
  name: 'Add a tab',
  description:
    'Add an empty tab (worksheet) to a table — one table is one workbook; tabs are its sheets, queryable together with `table_sql` joins. Build it out with `table_column_add`/`table_row_add` passing `tab`. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      name: { type: 'string', description: 'Tab name shown on the tab bar, e.g. "Car models".' },
      after_tab: {
        type: 'string',
        description: 'optional tab (name or id) to insert after; omit to append',
      },
    },
    required: ['table_id', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id and name are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.after_tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const afterTabId = str(input.after_tab).trim() ? loaded.tabId : undefined;
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'tab_add', name, ...(afterTabId !== undefined ? { afterTabId } : {}) },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      const tabId = applied.createdIds[0] ?? '';
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          name,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_tab_rename: BuiltinToolDef = {
  slug: 'table_tab_rename',
  preconditions: TABLE_ID_PRE,
  name: 'Rename a tab',
  description:
    'Rename a tab (worksheet). Its `table_sql` view name re-derives from the new name; data and row/column ids are untouched. Writes to DRAFT.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      tab: { type: 'string', description: 'the tab to rename, by name or id' },
      name: { type: 'string', description: 'new tab name' },
    },
    required: ['table_id', 'tab', 'name'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    const name = str(input.name).trim();
    if (!tableId || !name) return { ok: false, error: 'table_id, tab and name are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const tabId = loaded.tabId ?? loaded.table.tabId;
    if (!tabId) return { ok: false, error: 'tab is required — name or id from table_get' };
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [
        { op: 'tab_rename', tabId, name },
      ]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          name,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_tab_delete: BuiltinToolDef = {
  slug: 'table_tab_delete',
  preconditions: TABLE_ID_PRE,
  name: 'Delete a tab',
  description:
    'Remove a tab (worksheet) and all its rows/columns from the DRAFT — Discard reverts, Commit makes it permanent. Refuses to delete the last remaining tab; to remove the whole table use `table_delete`.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      tab: { type: 'string', description: 'the tab to delete, by name or id' },
    },
    required: ['table_id', 'tab'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId || !str(input.tab).trim())
      return { ok: false, error: 'table_id and tab are required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const tabId = loaded.tabId;
    if (!tabId) return { ok: false, error: `no tab '${str(input.tab)}' on this table` };
    try {
      const applied = await applyTableOps(ctx.ownerId, tableId, [{ op: 'tab_delete', tabId }]);
      if (!applied) return notFound('table', tableId, 'table_list');
      if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
      ctx.step?.setOutput({ table_id: tableId, tab_id: tabId });
      return {
        ok: true,
        output: {
          table_id: tableId,
          tab_id: tabId,
          deleted: true,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(tableId),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_rows_list: BuiltinToolDef = {
  slug: 'table_rows_list',
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

const table_row_get: BuiltinToolDef = {
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

const table_query: BuiltinToolDef = {
  slug: 'table_query',
  preconditions: TABLE_ID_PRE,
  name: 'Query rows by value',
  description:
    'Find the rows matching `filters` — the structured-lookup tool for questions about a specific record or subset of a big grid. Returns ONLY the matching rows (id + cells keyed by column name, formula columns resolved) plus `total_matches`, so "what\'s the design pressure for circuit 17-P08-D17003" is one call, not a page-through. Filters AND by default — pass `match: "any"` to OR them. Pass `aggregate` to compute totals over the WHOLE matched set without reading the rows back. **`rows` caps at 500 per call; `total_matches` is exact — use it for COUNTS, and page with `offset` (`truncated`/`next_offset` announce clipping).** Read-only — nothing is saved (unlike `table_set_view`). Reads the draft if one exists. For grouped breakdowns ("count by metallurgy") use `table_aggregate`.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      filters: {
        type: 'array',
        description: 'predicates over columns; AND-ed unless match="any"',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: {
              type: 'string',
              enum: [...FILTER_OPS],
              description:
                'How the cell compares to `value`. contains is case-insensitive; ordered comparisons never match empty cells.',
            },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      match: {
        type: 'string',
        enum: ['all', 'any'],
        description: "combine filters with AND ('all', default) or OR ('any')",
      },
      sort: {
        type: 'array',
        description:
          'Order the matched rows before paging, e.g. [{ "column": "Price", "dir": "desc" }].',
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
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'restrict returned cells to these columns (id or name)',
      },
      aggregate: {
        type: 'array',
        description: 'compute totals over the full matched set (not just the returned page)',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: {
              type: 'string',
              enum: AGGREGATE_KINDS.filter((k) => k !== 'none'),
              description:
                'The summary to compute. Numeric kinds skip non-numeric cells; filled/empty count cells.',
            },
          },
          required: ['column', 'kind'],
        },
      },
      offset: {
        type: 'number',
        description: "Matching rows to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'max matching rows to return (default 50, max 500)' },
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

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return {
          colId: col.id,
          op: str(rec.op) as Filter['op'],
          value: (rec.value ?? null) as CellValue,
        };
      })
      .filter((f): f is Filter => f !== null);
    const sort: SortSpec[] = (Array.isArray(input.sort) ? input.sort : [])
      .map((s): SortSpec | null => {
        const col = resolveColumn(doc, str((s as Record<string, unknown>).column));
        return col
          ? { colId: col.id, dir: (s as Record<string, unknown>).dir === 'desc' ? 'desc' : 'asc' }
          : null;
      })
      .filter((s): s is SortSpec => s !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';
    const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
    const limit = Math.max(1, Math.min(typeof input.limit === 'number' ? input.limit : 50, 500));

    const wantCols = strArr(input.columns)
      .map((c) => resolveColumn(doc, c))
      .filter((c): c is Column => c !== null);
    const projCols = wantCols.length ? wantCols : doc.columns;

    // SQL pushdown (P3): file-backed + no formula columns + parity-safe
    // filters/sort → the query runs in SQLite (draft-first) and never
    // materializes the doc. Falls back to the doc path otherwise; a clipped
    // table whose filters can't push down errors with the recovery move.
    const hasFormula = doc.columns.some((c) => c.type === 'formula');
    const file = hasFormula ? null : await windowFile(ctx.ownerId, tableId);
    const aggSpecs = (Array.isArray(input.aggregate) ? input.aggregate : []).map(
      (a): { col: Column; kind: AggregateKind; raw: string } | null => {
        const rec = a as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        if (!col || !AGGREGATE_KINDS.includes(kind) || kind === 'none') return null;
        return { col, kind, raw: str(rec.column) };
      },
    );
    const ignoredAggregates = (Array.isArray(input.aggregate) ? input.aggregate : [])
      .map((a, i) => (aggSpecs[i] ? null : str((a as Record<string, unknown>).column)))
      .filter((x): x is string => x !== null);
    const validAggs = aggSpecs.filter((a): a is NonNullable<typeof a> => a !== null);

    let totalMatches: number;
    let pageRows: { id: string; cells: Record<string, CellValue> }[];
    let aggregates: { column: string; kind: AggregateKind; value: number | null }[] = [];
    const pushed = file
      ? queryRowsWindow(file, { filters, match, sort, offset, limit, ...(tabId ? { tabId } : {}) })
      : null;
    if (pushed) {
      totalMatches = pushed.total;
      pageRows = pushed.rows.map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const col of projCols) cells[col.name] = r.cells[col.id] ?? null;
        return { id: r.id, cells };
      });
      aggregates = validAggs.map((a) => ({
        column: a.col.name,
        kind: a.kind,
        value: aggregateWindow(file!, {
          columnId: a.col.id,
          kind: a.kind,
          filters,
          match,
          ...(tabId ? { tabId } : {}),
        }),
      }));
    } else {
      if (table.docClipped) {
        return {
          ok: false,
          error:
            'these filters cannot run in SQL and the table is too large to load whole — simplify the filters ' +
            '(eq/neq/contains on text columns, ranges on number/date columns), or use table_sql for the lookup.',
        };
      }
      const matched = queryRows(doc, { filters, sort, match });
      totalMatches = matched.length;
      pageRows = matched.slice(offset, offset + limit).map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const col of projCols) cells[col.name] = resolveCell(doc, r, col);
        return { id: r.id, cells };
      });
      // Aggregates over the FULL matched set (not the returned page) — so
      // "max design pressure among CS circuits" is one call, cap-immune.
      aggregates = validAggs.map((a) => ({
        column: a.col.name,
        kind: a.kind,
        value: computeAggregate(doc, a.col.id, a.kind, matched),
      }));
    }
    const rows = pageRows;
    const matchedCount = totalMatches;

    ctx.step?.setOutput({ table_id: tableId, matches: matchedCount, pushed: !!pushed });
    return {
      ok: true,
      output: {
        table_id: tableId,
        total_matches: matchedCount,
        offset,
        limit,
        columns: projCols.map((c) => c.name),
        rows,
        ...(aggregates.length ? { aggregates } : {}),
        ...pageMeta(matchedCount, offset, rows.length),
        ...(ignoredFilters.length ? { ignored_filters: ignoredFilters } : {}),
        ...(ignoredAggregates.length ? { ignored_aggregates: ignoredAggregates } : {}),
      },
    };
  },
};

const table_aggregate: BuiltinToolDef = {
  slug: 'table_aggregate',
  preconditions: TABLE_ID_PRE,
  name: 'Group + summarise rows',
  description:
    'Summarise a table by category — the GROUP BY tool. Rows are bucketed by their combined `group_by` value(s); each group returns its row `count` plus any `metrics` you ask for. Optional `filters` restrict the rows first, `sort` orders the groups (default: most populous first), and `limit`/`offset` page the groups. Answers "how many circuits per metallurgy", "max design pressure by service", or "what distinct damage types exist" (`group_by` alone) in ONE call — no row paging. For the matching rows themselves use `table_query`. Read-only; reads the draft if present.',
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: "The table's id (UUID) — from `table_list`." },
      group_by: {
        type: 'array',
        items: { type: 'string' },
        description: 'column(s) to group by (id or name)',
      },
      tab: { type: 'string', description: TAB_HINT },
      metrics: {
        type: 'array',
        description: 'per-group aggregates to compute',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            kind: {
              type: 'string',
              enum: AGGREGATE_KINDS.filter((k) => k !== 'none'),
              description:
                'The summary to compute. Numeric kinds skip non-numeric cells; filled/empty count cells.',
            },
          },
          required: ['column', 'kind'],
        },
      },
      filters: {
        type: 'array',
        description: 'restrict rows before grouping (AND-ed unless match="any")',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'column id or name' },
            op: {
              type: 'string',
              enum: [...FILTER_OPS],
              description:
                'How the cell compares to `value`. contains is case-insensitive; ordered comparisons never match empty cells.',
            },
            value: { description: 'compared against the cell (omit for empty/notEmpty)' },
          },
          required: ['column', 'op'],
        },
      },
      match: {
        type: 'string',
        enum: ['all', 'any'],
        description: "combine filters with AND ('all', default) or OR ('any')",
      },
      sort: {
        type: 'object',
        description: 'How to order the groups — defaults to most populous first.',
        properties: {
          by: { type: 'string', description: "'count', a group column, or a metric column" },
          dir: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction — defaults to descending.',
          },
        },
      },
      offset: {
        type: 'number',
        description: "Groups to skip for paging — pass the previous call's `next_offset`.",
      },
      limit: { type: 'number', description: 'max groups to return (default 50, max 500)' },
    },
    required: ['table_id', 'group_by'],
  },
  handler: async (input, ctx) => {
    const tableId = str(input.table_id).trim();
    if (!tableId) return { ok: false, error: 'table_id is required' };
    const loaded = await loadTab(ctx.ownerId, tableId, input.tab);
    if ('error' in loaded) return { ok: false, error: loaded.error };
    const { table, doc } = loaded;
    if (table.docClipped) {
      return {
        ok: false,
        error:
          'this table is too large to group in memory — use table_sql, e.g. ' +
          'SELECT "Column", count(*) FROM "<view>" GROUP BY 1 ORDER BY 2 DESC (table_get\'s sql block lists the views/columns).',
      };
    }

    const groupCols = strArr(input.group_by)
      .map((r) => resolveColumn(doc, r))
      .filter((c): c is Column => c !== null);
    if (groupCols.length === 0)
      return { ok: false, error: 'group_by must name at least one existing column' };

    const ignoredFilters: string[] = [];
    const filters: Filter[] = (Array.isArray(input.filters) ? input.filters : [])
      .map((f): Filter | null => {
        const rec = f as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        if (!col) {
          ignoredFilters.push(str(rec.column));
          return null;
        }
        return {
          colId: col.id,
          op: str(rec.op) as Filter['op'],
          value: (rec.value ?? null) as CellValue,
        };
      })
      .filter((f): f is Filter => f !== null);
    const match = str(input.match) === 'any' ? 'any' : 'all';

    const metricSpecs = (Array.isArray(input.metrics) ? input.metrics : [])
      .map((m): { colId: string; column: string; kind: AggregateKind } | null => {
        const rec = m as Record<string, unknown>;
        const col = resolveColumn(doc, str(rec.column));
        const kind = str(rec.kind) as AggregateKind;
        return col && AGGREGATE_KINDS.includes(kind) && kind !== 'none'
          ? { colId: col.id, column: col.name, kind }
          : null;
      })
      .filter((m): m is { colId: string; column: string; kind: AggregateKind } => m !== null);

    const buckets = groupRows(doc, { groupColIds: groupCols.map((c) => c.id), filters, match });
    type Group = {
      key: Record<string, CellValue>;
      count: number;
      metrics?: { column: string; kind: AggregateKind; value: number | null }[];
    };
    let groups: Group[] = buckets.map((b) => ({
      key: Object.fromEntries(groupCols.map((c, i) => [c.name, b.key[i] ?? null])),
      count: b.rows.length,
      ...(metricSpecs.length
        ? {
            metrics: metricSpecs.map((m) => ({
              column: m.column,
              kind: m.kind,
              value: computeAggregate(doc, m.colId, m.kind, b.rows),
            })),
          }
        : {}),
    }));

    // Order the groups. Default = most populous first; or by an explicit
    // { by, dir } over count / a group column / a named metric.
    const sortRec =
      input.sort && typeof input.sort === 'object' ? (input.sort as Record<string, unknown>) : null;
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
      const cmp =
        na !== null && nb !== null ? na - nb : String(va ?? '').localeCompare(String(vb ?? ''));
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
  preconditions: TABLE_ID_PRE,
  name: 'Add a row',
  description:
    'Append a new row (or insert after `after_row_id`). Returns the new row id. Writes to DRAFT.',
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_row_update: BuiltinToolDef = {
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_row_delete: BuiltinToolDef = {
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const table_cell_set: BuiltinToolDef = {
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ───────────────────────── column edits (→ draft) ─────────────────────────

const table_column_add: BuiltinToolDef = {
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

const table_column_update: BuiltinToolDef = {
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

const table_column_delete: BuiltinToolDef = {
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

const table_set_aggregate: BuiltinToolDef = {
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

const table_set_view: BuiltinToolDef = {
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

export const TABLE_TOOLS: BuiltinToolDef[] = [
  table_create,
  table_from_file,
  table_from_text,
  table_update,
  table_delete,
  table_commit,
  table_list,
  table_get,
  table_schema,
  table_sql,
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
  table_tab_add,
  table_tab_rename,
  table_tab_delete,
  table_set_aggregate,
  table_set_view,
];

export const TABLE_TOOL_SLUGS: string[] = TABLE_TOOLS.map((t) => t.slug);
