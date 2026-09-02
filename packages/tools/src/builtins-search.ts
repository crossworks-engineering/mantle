/**
 * Builtins: search_nodes / search_chunks / read_section / tree_list — retrieval over the brain.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { searchNodes, searchChunks, readSection, resolveSupersededTargets } from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { nodeUrl } from '@mantle/content';
import { type BuiltinToolDef } from './types';
import { str, strOpt, numOpt as num } from './coerce';
import { errorMessage } from '@mantle/std';
import { NODE_ID_PRE } from './builtins-common';

export const search_nodes: BuiltinToolDef = {
  slug: 'search_nodes',
  readOnly: true,
  name: 'Search nodes',
  description:
    "Hybrid full-text + semantic search across the user's entire Mantle (notes, files, emails, events, tasks, pages, telegram messages — everything). **Ranked by relevance, NOT by date.** " +
    "Use for topic/content questions — 'find emails about the Lister contract', 'notes mentioning the printer', 'anything about Alice's passport'. " +
    'This finds whole NODES (returns their spine — title/tags/summary). To pull the relevant *passages* from inside long documents — the cheaper move for a "what does X say about Y" question, and the one that avoids reading whole files into context — use `search_chunks`. ' +
    "For **time-windowed** questions ('what arrived today', 'last 5 days of email', 'this week's events') use the dedicated list tools — `email_list`, `event_list`, `task_list`, `note_list`, `page_list`, `file_list` — which ARE date-sorted and accept `since` / `window`. " +
    'For past **conversation** recall (replaying what was actually said) use `find_window` + `replay_window`. For the **public web** use `web_search`. ' +
    "Optional `branch` (ltree prefix, e.g. 'files.work') scopes; `type` filters to one node kind; `tags` narrows further. " +
    'Each hit carries a `url` permalink — when you surface an item to the user, link it as a markdown `[title](url)` so they can click straight through to it.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: { type: 'string', description: "ltree prefix scope, e.g. 'files.work'" },
      type: {
        type: 'string',
        description: 'node type filter',
        enum: [
          'branch',
          'email',
          'email_thread',
          'file',
          'note',
          'page',
          'sermon',
          'contact',
          'task',
          'event',
          'printer_project',
          'telegram_message',
          'documentation',
          'journal',
          'formula',
          'draw',
        ],
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "only nodes carrying at least one of these tags, e.g. ['work']",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Max results to return.',
      },
    },
  },
  handler: async (input, ctx) => {
    try {
      const q = strOpt(input.q);
      // Embed the query so searchNodes runs its hybrid (vector-led) ranker —
      // the legacy FTS-only path recalls ~8% on natural-language queries
      // (docs/recall-eval.md). A failed embed degrades to FTS, not an error.
      let queryEmbedding: number[] | undefined;
      if (q && q.trim()) {
        try {
          queryEmbedding = await embed(ctx.ownerId, q);
        } catch (err) {
          console.error('[search_nodes] query embed failed, falling back to FTS:', err);
        }
      }
      const rows = await searchNodes({
        ownerId: ctx.ownerId,
        q,
        branch: strOpt(input.branch),
        type: strOpt(input.type) as Parameters<typeof searchNodes>[0]['type'],
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        limit: num(input.limit, 20),
        queryEmbedding,
      });
      ctx.step?.setOutput({ count: rows.length });
      // Content-currency annotation: a superseded hit still surfaces (the
      // demotion is a nudge, not a filter) but must carry its living
      // successor so the model prefers the current copy.
      const successors = await resolveSupersededTargets(
        ctx.ownerId,
        rows.filter((r) => r.supersededBy).map((r) => r.id),
      );
      return {
        ok: true,
        output: rows.map((r) => {
          const succ = successors.get(r.id);
          return {
            id: r.id,
            type: r.type,
            title: r.title,
            path: r.path,
            tags: r.tags,
            url: nodeUrl(r.id),
            summary:
              typeof (r.data as Record<string, unknown> | null)?.summary === 'string'
                ? (r.data as Record<string, unknown>).summary
                : null,
            updatedAt: r.updatedAt.toISOString(),
            ...(succ
              ? {
                  superseded_by: {
                    id: succ.id,
                    title: succ.title,
                    url: nodeUrl(succ.id),
                    note: 'SUPERSEDED — prefer this successor; do not present the old copy as current.',
                  },
                }
              : {}),
          };
        }),
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const search_chunks: BuiltinToolDef = {
  slug: 'search_chunks',
  readOnly: true,
  name: 'Search document passages',
  description:
    'Semantic (vector) search over document passages — finds the most relevant *sections* inside long files, pages, emails, and documentation (not just whole-node hits). **Reach for this FIRST on a content question** ("what does the CoF procedure say about inventory grouping?"): it returns the exact passages, so you answer (and quote) without loading whole files into context. ' +
    "`branch` scopes by ltree path (e.g. 'files' for uploaded documents, 'pages', 'documentation'). Each hit returns the source node id, its heading, ordinal, and passage text. Quote the passage directly. When you need the WHOLE section in order (a full procedure/clause/table), don't read the entire file — pass the hit's `nodeId` + `heading` (or ordinal) to `read_section`. Only `file_read` / `node_read` the whole document for a short file or an explicit exhaustive review.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: {
        type: 'string',
        description: "ltree prefix scope, e.g. 'files' or 'documentation'",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results to return.',
      },
    },
    required: ['q'],
  },
  handler: async (input, ctx) => {
    try {
      const q = str(input.q);
      if (!q) return { ok: false, error: 'q is required' };
      const embedding = await embed(ctx.ownerId, q);
      const hits = await searchChunks({
        ownerId: ctx.ownerId,
        embedding,
        // Hybrid: the query text feeds the FTS booster arm, so exact rare
        // tokens (error codes, field names) are findable alongside vector.
        q,
        branch: strOpt(input.branch),
        limit: num(input.limit, 10),
      });
      ctx.step?.setOutput({ count: hits.length });
      // Content-currency annotation: passages from a superseded node carry
      // their living successor so the model quotes the current copy instead.
      const successors = await resolveSupersededTargets(
        ctx.ownerId,
        hits.filter((h) => h.nodeSupersededBy).map((h) => h.nodeId),
      );
      return {
        ok: true,
        output: hits.map((h) => {
          const succ = successors.get(h.nodeId);
          return {
            nodeId: h.nodeId,
            nodeTitle: h.nodeTitle,
            nodeType: h.nodeType,
            heading: h.headingPath,
            ordinal: h.ordinal,
            text: h.text,
            ...(succ
              ? {
                  superseded_by: {
                    id: succ.id,
                    title: succ.title,
                    note: 'SUPERSEDED — this passage is from an outdated copy; check the successor before quoting.',
                  },
                }
              : {}),
          };
        }),
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const read_section: BuiltinToolDef = {
  slug: 'read_section',
  readOnly: true,
  name: 'Read a document section',
  description:
    "Read one SECTION of a long document in full and in order — the rung between `search_chunks` (scattered passages) and `file_read`/`node_read` (the entire document). Reach for this once you know WHERE the answer lives: feed a `search_chunks` hit's `nodeId` plus its `heading` (or an ordinal range) here to read the whole procedure / clause / table contiguously, WITHOUT loading the entire file into context. " +
    "Pass ONLY `node_id` to get the OUTLINE (heading ranges with their ordinals) and pick a section from the document's structure. Output is capped (~24k chars) and returns `next_ordinal` to continue from when a section runs long. Only fall back to `file_read` for genuinely short documents, or when the outline says there are no indexed passages.",
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description:
          'the document node — the `nodeId` from a search_chunks hit, or any file/page id',
      },
      heading: {
        type: 'string',
        description: 'read all passages whose heading path contains this text (case-insensitive)',
      },
      from_ordinal: {
        type: 'integer',
        minimum: 0,
        description: 'start of an ordinal range (inclusive)',
      },
      to_ordinal: {
        type: 'integer',
        minimum: 0,
        description: 'end of an ordinal range (inclusive); defaults to from_ordinal',
      },
      max_chars: {
        type: 'integer',
        minimum: 2000,
        maximum: 60000,
        description: 'cap on returned characters (default 24000)',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id);
    if (!nodeId) return { ok: false, error: 'node_id required' };
    const res = await readSection({
      ownerId: ctx.ownerId,
      nodeId,
      heading: strOpt(input.heading),
      fromOrdinal: num(input.from_ordinal),
      toOrdinal: num(input.to_ordinal),
      maxChars: num(input.max_chars),
    });
    if ('error' in res) return { ok: false, error: res.error };
    ctx.step?.setOutput(
      res.mode === 'outline'
        ? { mode: 'outline', passages: res.totalPassages, sections: res.sections.length }
        : {
            mode: 'section',
            passages: res.passages,
            chars: res.text.length,
            truncated: res.truncated,
          },
    );
    return { ok: true, output: res };
  },
};

export const tree_list: BuiltinToolDef = {
  slug: 'tree_list',
  readOnly: true,
  name: 'List tree children',
  description:
    "List children of a branch in the user's tree (the universal navigator — whatever kinds of nodes live under that branch). Pass `path` to scope (ltree, e.g. 'files.work'). Omit for top-level branches. " +
    'For files specifically use `file_list`; for folders use `folder_list`; for searching by content/topic use `search_nodes` (or `search_chunks` to pull the relevant passages from inside documents).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'parent ltree path; omit for top-level' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 100,
        description: 'Max results to return.',
      },
    },
  },
  handler: async (input, ctx) => {
    const path = strOpt(input.path);
    const limit = num(input.limit, 100) ?? 100;
    const conds = [eq(nodes.ownerId, ctx.ownerId)];
    if (path) conds.push(sql`${nodes.path}::text = ${path}`);
    else conds.push(eq(nodes.type, 'branch'));
    const rows = await db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.updatedAt))
      .limit(limit);
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

// ─── entities / facts ─────────────────────────────────────────────────────

/** Read the brain by id, plus the corpus-capacity self-check. */
/** Retrieval over the brain: hybrid search, chunk search, section reads, the tree. */
export const SEARCH_TOOLS: readonly BuiltinToolDef[] = [
  search_nodes,
  search_chunks,
  read_section,
  tree_list,
];
