/**
 * Workbook lifecycle: create (blank, from a file, from text), update
 * metadata, delete, and commit a draft.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import {
  commitTable,
  createTable,
  deleteTable,
  tableDocFromGrid,
  updateTable,
  nodeUrl,
  COLUMN_TYPES,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { parseSpreadsheetToGrid, parseTextToGrid } from '@mantle/files/sheet-to-grid';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, TABLE_NODE_ID_PRE, colSummary } from './common';

export const table_create: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_from_file: BuiltinToolDef = {
  slug: 'table_from_file',
  preconditions: FILE_ID_PRE,
  name: 'Create a table from a spreadsheet',
  description:
    "Import a `.xlsx` / `.xls` / `.csv` file into ONE typed table — bytes go server-side from `files` → exceljs → typed columns + rows, never round-tripping through your output (scales to large sheets). Column types are inferred (numbers, dates, checkboxes, text). **One workbook per file: every non-empty sheet becomes a TAB** of the same table (like Excel), addressable by name in the row/query tools and joinable across tabs with `table_sql`. Very large sheets import whole (sqlite-native storage) up to the box's import ceiling — beyond it the import errors with guidance and nothing partial is created. The table is committed + indexed immediately. Returns the table id and its tabs. Use this whenever the user hands you a spreadsheet.",
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
      sheets = await parseSpreadsheetToGrid(res.bytes, ext);
    } catch (err) {
      return {
        ok: false,
        error: `spreadsheet parse failed: ${errorMessage(err)}`,
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_from_text: BuiltinToolDef = {
  slug: 'table_from_text',
  name: 'Create a table from pasted tabular text',
  description:
    'Build a NEW typed grid from a block of tabular text in ONE call — CSV, TSV, or a markdown pipe table. **This is the right tool for "make a table from these results / this data" when the rows are in the conversation.** It always CREATES a new table — to add rows to an EXISTING table use `table_rows_add` (bulk) or `table_row_add` (single), never this. Do NOT create an empty table and add rows one at a time either — `table_rows_add` ingests a whole batch at once. The header row becomes columns and types are inferred (numbers, dates from xlsx, text). The table is created + indexed immediately. `title` is optional.',
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
      sheets = await parseTextToGrid(data);
    } catch (err) {
      return {
        ok: false,
        error: `parse failed: ${errorMessage(err)}`,
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_update: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_delete: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const table_commit: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// ───────────────────────── reads ─────────────────────────
