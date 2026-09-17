/**
 * Pages: the two hand-written reads that return the raw ProseMirror
 * document, then the bridged authoring group with those two skipped.
 *
 * Lifted out of registerMantleTools; bodies moved verbatim.
 */

import { z } from 'zod';
import { PAGE_TOOLS } from '@mantle/tools';
import { getPage, listPages } from '@mantle/content';
import type { McpRegisterContext } from './context';

export function registerPageTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply, registerBuiltinTools } = ctx;

  // ─── Pages (read-only) ─────────────────────────────────────────────────────
  //
  // Rich TipTap documents (type='page'). Read-only over MCP for now — pages are
  // authored in the web editor; the assistant finds and reads them. page_list
  // omits the document body; page_get returns the full ProseMirror JSON.

  server.tool(
    'page_list',
    "List the owner's pages. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted — use page_get for the full document.",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
    },
    async ({ query, tag }) => {
      const rows = await listPages(ownerId, { query, tag });
      return jsonReply(rows);
    },
  );

  server.tool(
    'page_get',
    'Get a single page by id, including its full ProseMirror/TipTap document.',
    { id: z.string() },
    async ({ id }) => {
      const row = await getPage(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return jsonReply(row);
    },
  );

  // ─── Pages (write) ───────────────────────────────────────────────────────────
  // The rich-document authoring surface — create pages (blank / from a file,
  // note(s), or journal), edit metadata + draft body, and do block-level edits
  // (list/get/update/insert/delete/split/extract/move blocks) plus mention/share.
  // Bridged from the in-app PAGE_TOOLS so an MCP client authors with the exact
  // same tested handlers the `pages` agent uses. page_list/page_get are skipped:
  // they're already hand-wired above (those return the raw ProseMirror document;
  // the builtin read tools return plaintext + block ids — left as the read path
  // for the in-app agent to avoid changing the existing MCP read shape).
  const PAGE_READ_SLUGS = new Set(['page_list', 'page_get']);
  registerBuiltinTools(PAGE_TOOLS, { skip: (def) => PAGE_READ_SLUGS.has(def.slug) });
}
