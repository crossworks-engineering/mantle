/**
 * Pages: the two hand-written reads that return the raw ProseMirror
 * document (page_list, page_get: definitions in mcp-defs.ts, A5 step 2),
 * then the bridged authoring group, less the two the surface defines
 * itself (registerBuiltinTools skips a builtin a definition names).
 */

import { PAGE_TOOLS } from '@mantle/tools';
import { registerMcpTools } from '../mcp-defs';
import type { McpRegisterContext } from './context';

export function registerPageTools(ctx: McpRegisterContext): void {
  const { registerBuiltinTools } = ctx;
  registerMcpTools(ctx, 'pages');

  // ─── Pages (write) ───────────────────────────────────────────────────────────
  // The rich-document authoring surface — create pages (blank / from a file,
  // note(s), or journal), edit metadata + draft body, and do block-level edits
  // (list/get/update/insert/delete/split/extract/move blocks) plus mention/share.
  // Bridged from the in-app PAGE_TOOLS so an MCP client authors with the exact
  // same tested handlers the `pages` agent uses. page_list/page_get are the
  // hand-written definitions above (those return the raw ProseMirror document;
  // the builtin read tools return plaintext + block ids — left as the read path
  // for the in-app agent to avoid changing the existing MCP read shape).
  registerBuiltinTools(PAGE_TOOLS);
}
