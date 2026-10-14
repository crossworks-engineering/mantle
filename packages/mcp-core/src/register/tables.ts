/**
 * Tables: the three hand-written reads (table_list, table_get,
 * table_rows_list: definitions in mcp-defs.ts, A5 step 2), then the bridged
 * write group, less the three the surface defines itself
 * (registerBuiltinTools skips a builtin a definition names).
 */

import { TABLE_TOOLS } from '@mantle/tools';
import { registerMcpTools } from '../mcp-defs';
import type { McpRegisterContext } from './context';

export function registerTableTools(ctx: McpRegisterContext): void {
  const { registerBuiltinTools } = ctx;
  registerMcpTools(ctx, 'tables');

  // ─── Tables (write) ───────────────────────────────────────────────────────────
  // Build + operate typed data grids: create (blank / from a file or text),
  // update metadata, edit rows (add/update/delete + per-cell set), edit columns
  // (add/update/delete), set aggregates + views, query/aggregate over rows, and
  // commit drafts. Bridged from the in-app TABLE_TOOLS so an MCP client uses the
  // same tested handlers the Tables agent uses. table_list/table_get/
  // table_rows_list are the hand-written definitions above (read-only), which
  // keep the existing MCP read shape.
  registerBuiltinTools(TABLE_TOOLS);
}
