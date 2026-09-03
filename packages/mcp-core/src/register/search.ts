/**
 * Hand-written search entrypoints: `tree_list` and `search`.
 * `search` is still a 63-line fork of the search_nodes builtin, not a
 * schema-compat twin. That remains an open audit item; moving it here does
 * not fix it, it just stops it hiding inside a 921-line function.
 *
 * Lifted out of registerMantleTools; bodies moved verbatim.
 */

import { z } from 'zod';
import { db, nodes } from '@mantle/db';
import { searchNodes } from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { and, eq } from 'drizzle-orm';
import type { McpRegisterContext } from './context';

export function registerSearchTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply, leanNode } = ctx;

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
          'formula',
          'draw',
        ])
        .optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ q, branch, type, tags, since, limit }) => {
      // Embed the query so searchNodes runs its hybrid (vector-led) ranker. The
      // legacy FTS-only path recalled ~8% on natural-language queries
      // (docs/recall-eval.md); a failed embed degrades to FTS, not an error.
      let queryEmbedding: number[] | undefined;
      if (q && q.trim()) {
        try {
          queryEmbedding = await embed(ownerId, q);
        } catch (err) {
          console.error('[search] query embed failed, falling back to FTS:', err);
        }
      }
      const results = await searchNodes({
        ownerId: ownerId,
        q,
        branch,
        type,
        tags,
        since: since ? new Date(since) : undefined,
        limit,
        queryEmbedding,
      });
      return jsonReply(results.map(leanNode));
    },
  );
}
