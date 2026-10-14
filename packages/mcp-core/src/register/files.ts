/**
 * Files and folders. The bridged groups run the in-app handlers; the
 * hand-written verbs stay hand-written because their MCP argument names
 * differ from the builtin's (id vs file_id, path vs folder id) and renaming
 * them would break shipped connectors: their definitions, policy and bodies
 * are in mcp-defs.ts (A5 step 2).
 */

import { FILE_MANAGE_TOOLS, FILE_OPERATOR_TOOLS } from '@mantle/tools';
import { registerMcpTools } from '../mcp-defs';
import type { McpRegisterContext } from './context';

export function registerFileTools(ctx: McpRegisterContext): void {
  const { registerBuiltinTools } = ctx;

  // ─── files / folders ──────────────────────────────────────────────────────

  // Create and destroy: bridged from `mcpOnly` builtins since tier 3 of the
  // 2026-09-02 audit. No in-app tool group grants these, so promoting them
  // shared the implementation without widening what any agent can reach.
  registerBuiltinTools(FILE_OPERATOR_TOOLS);

  // folder_describe, folder_rename: hand-written (mcp-defs.ts).
  registerMcpTools(ctx, 'folders');

  // File-manager verbs + the indexing switch: BRIDGED from @mantle/tools so
  // MCP runs the same implementation as in-app agents (same teaching errors,
  // same indexing reconciliation) — hand-written twins rot, see
  // no-duplicate-tools.test.ts.
  registerBuiltinTools(FILE_MANAGE_TOOLS);

  // file_read, file_get, file_rename: hand-written (mcp-defs.ts).
  registerMcpTools(ctx, 'files');
}
