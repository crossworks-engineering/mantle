/**
 * Hand-written search entrypoints.
 *
 * `tree_list` stays hand-written: its MCP schema (an optional `path`) is not
 * the builtin's, and renaming arguments under shipped connectors is not worth
 * the dedupe. See no-duplicate-tools.test.ts.
 *
 * `search` was a 63-line FORK of the `search_nodes` builtin, and it survived
 * every duplicate check we had for one reason: the MCP surface calls it
 * `search` while the builtin is `search_nodes`, so a slug comparison never saw
 * two implementations of the same thing. It had drifted the way forks do —
 * silently, and only in the direction of being worse:
 *
 *   · no `url` permalink on a hit, so a client could not link one
 *   · NO supersession annotation at all, so a stale copy came back looking
 *     current while the in-app agent got "prefer this successor" on the same
 *     row. That is the content-currency machinery the whole retrieval layer is
 *     built around, absent on the surface Claude Desktop actually uses.
 *   · a thrown error instead of an `isError` reply
 *   · `journal` missing from its type filter
 *
 * It now runs the builtin, through the same `callBuiltin` path every bridged
 * tool uses. The MCP-facing NAME, description and argument names are kept
 * exactly, because connectors depend on them; the reply gains `url` and
 * `superseded_by`, which is additive.
 */

import { z } from 'zod';
import { db, nodes } from '@mantle/db';
import { SEARCH_TOOLS } from '@mantle/tools';
import { and, eq } from 'drizzle-orm';
import type { BuiltinToolDef } from '@mantle/tools';
import type { McpRegisterContext } from './context';

/** The builtin `search` runs. Resolved from the group rather than imported
 *  directly, so it stays tied to the set build-server.ts skips it from: if the
 *  slug ever leaves SEARCH_TOOLS, registration fails loudly here instead of
 *  quietly handing MCP an undefined handler. */
function searchNodesBuiltin(): BuiltinToolDef {
  const def = SEARCH_TOOLS.find((t) => t.slug === 'search_nodes');
  if (!def)
    throw new Error(
      'search_nodes is no longer in SEARCH_TOOLS — MCP `search` has no implementation',
    );
  return def;
}

export function registerSearchTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply, callBuiltin } = ctx;
  const search_nodes = searchNodesBuiltin();

  server.tool(
    'tree_list',
    'List children of a branch in the Mantle tree. Pass no path for top-level branches.',
    { path: z.string().optional() },
    async ({ path }) => {
      const rows = await db
        .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
        .from(nodes)
        .where(
          and(eq(nodes.ownerId, ownerId), path ? eq(nodes.path, path) : eq(nodes.type, 'branch')),
        )
        .limit(200);
      return jsonReply(rows);
    },
  );

  server.tool(
    'search',
    "Hybrid semantic + full-text search over the user's Mantle — ranks by meaning (vector) with keyword as a booster, so vague/natural queries work, not just exact words. Use `branch` (ltree path) to scope, `type` to filter. Returns the spine (title, tags, summary) — use node_read / file_read / email_get for a full body.",
    {
      q: z.string().optional(),
      branch: z.string().optional(),
      type: z
        .enum([
          'branch',
          'email',
          'email_thread',
          'file',
          'note',
          'page',
          'sermon',
          'contact',
          'secret',
          'task',
          'event',
          'printer_project',
          'telegram_message',
          'documentation',
          'journal',
          'formula',
          'draw',
        ])
        .optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ q, branch, type, tags, since, limit }) =>
      callBuiltin(search_nodes, { q, branch, type, tags, since, limit }),
  );
}
