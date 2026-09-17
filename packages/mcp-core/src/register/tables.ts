/**
 * Tables: the three hand-written reads, then the bridged write group
 * with those three skipped.
 *
 * Lifted out of registerMantleTools; bodies moved verbatim.
 */

import { z } from 'zod';
import { TABLE_TOOLS } from '@mantle/tools';
import { getTable, listTables, listRows, ensureTableDoc } from '@mantle/content';
import type { McpRegisterContext } from './context';

export function registerTableTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply, registerBuiltinTools } = ctx;

  // ─── Tables (read-only) ────────────────────────────────────────────────────
  //
  // Typed database grids (type='table'). Read-only over MCP — tables are authored
  // in the web grid editor + by the Tables agent. table_list omits the grid;
  // table_get returns columns + a row window; table_rows_list is the addressable
  // row snapshot.

  server.tool(
    'table_list',
    "List the owner's tables. Optional `query` substring-matches title/body/summary; `tag` filters. Grids are summarised (column + row counts) — use table_get for content.",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
    },
    async ({ query, tag }) => {
      const rows = await listTables(ownerId, { query, tag });
      return jsonReply(rows);
    },
  );

  server.tool(
    'table_get',
    'Get a single table by id: its columns and a window of rows (formula columns resolved). `offset`/`limit` page large grids.',
    { id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    async ({ id, offset, limit }) => {
      const row = await getTable(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      const doc = ensureTableDoc(row.data);
      const listed = listRows(doc, { offset: offset ?? 0, limit: limit ?? 100 });
      const out = {
        id: row.id,
        title: row.title,
        tags: row.tags,
        summary: row.summary,
        columns: doc.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        rows: listed.rows,
        total_rows: listed.total,
        aggregates: doc.aggregates ?? {},
      };
      return jsonReply(out);
    },
  );

  server.tool(
    'table_rows_list',
    "Windowed snapshot of a table's rows — each a stable id + short per-cell text. Page via offset/limit.",
    { table_id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    async ({ table_id, offset, limit }) => {
      const row = await getTable(ownerId, table_id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      const listed = listRows(ensureTableDoc(row.data), {
        offset: offset ?? 0,
        limit: limit ?? 50,
      });
      return jsonReply(listed);
    },
  );

  // ─── Tables (write) ───────────────────────────────────────────────────────────
  // Build + operate typed data grids: create (blank / from a file or text),
  // update metadata, edit rows (add/update/delete + per-cell set), edit columns
  // (add/update/delete), set aggregates + views, query/aggregate over rows, and
  // commit drafts. Bridged from the in-app TABLE_TOOLS so an MCP client uses the
  // same tested handlers the Tables agent uses. table_list/table_get/
  // table_rows_list are skipped — already hand-wired above (read-only) — to keep
  // the existing MCP read shape unchanged.
  const TABLE_READ_SLUGS = new Set(['table_list', 'table_get', 'table_rows_list']);
  registerBuiltinTools(TABLE_TOOLS, { skip: (def) => TABLE_READ_SLUGS.has(def.slug) });
}
