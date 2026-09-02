/**
 * Recall — the four serving tools over the memory-map system (S2 of the
 * Recall plan; docs/recall.md, roadmap task 97cf7850).
 *
 *   recall_index()             → the catalog: which maps exist, enter when
 *   recall_open(map)           → a map's index node: content + options
 *   recall_go(map, target)     → any node by slug: content + its options
 *   recall_match(need)         → top prompts by meaning; open the winner
 *
 * Every read is one indexed row off the COMPILED serving tables
 * (recall_maps / recall_nodes, built by commitPage — packages/content/src/
 * recall.ts). No ProseMirror parsing, no joins on the hot path, no LLM;
 * recall_match is one ANN probe over the partial prompt index plus one
 * (cached) embed of the query line. Bodies are budget-capped at COMPILE
 * time, so responses are small by construction.
 *
 * `intent` on every tool is the flight-recorder line (why the caller came).
 * Accepted now for schema stability; RECORDED from S3 — until then it is
 * deliberately dropped, never stored, never echoed.
 *
 * Options are affordances ("use when …"), never commands: the tools present
 * the map's signposts, the caller decides. All four are read-only.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, recallMaps, recallNodes } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';
import { errorMessage } from '@mantle/std';

const MATCH_LIMIT = 3;

/** Shared arg — see the header: accepted for S3's recorder, unused today. */
const INTENT_PROP = {
  intent: {
    type: 'string',
    description:
      "One line on why you came ('starting Destiny FM work'). Recorded for the owner's recall log; optional but appreciated.",
  },
} as const;

type MapRow = typeof recallMaps.$inferSelect;

async function mapBySlugOrId(ownerId: string, ref: string): Promise<MapRow | null> {
  const [bySlug] = await db
    .select()
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.slug, ref)))
    .limit(1);
  if (bySlug) return bySlug;
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
  const [byId] = await db
    .select()
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.id, ref)))
    .limit(1);
  return byId ?? null;
}

/** The stale note a served node carries when the pages ahead of it failed
 *  lint — honest about serving the last GOOD rev, without failing the read. */
function staleNote(map: MapRow): string | undefined {
  return map.lastCompileOk
    ? undefined
    : 'Note: newer edits to this map failed its lint, so you are reading the last good version. The owner can see the report in the editor.';
}

function nodePayload(map: MapRow, row: typeof recallNodes.$inferSelect) {
  return {
    map: map.slug,
    node: row.slug,
    kind: row.kind,
    title: row.title,
    body_md: row.bodyMd,
    ...(row.kind === 'prompt' && row.useWhen ? { use_when: row.useWhen } : {}),
    options: (row.options ?? []).map((o) => ({
      label: o.label,
      use_when: o.useWhen,
      target: o.targetSlug,
    })),
    updated_at: row.updatedAt.toISOString(),
    ...(staleNote(map) ? { note: staleNote(map) } : {}),
  };
}

// ─── recall_index ───────────────────────────────────────────────────────────

const recall_index: BuiltinToolDef = {
  slug: 'recall_index',
  readOnly: true,
  name: 'List the Recall maps',
  description:
    "The catalog of this brain's Recall maps — owner-authored memory maps for agents. Each entry says WHEN to enter it ('enter_when'). Call this before working in a domain a map covers, then recall_open the relevant map and follow its options. For prompts (reusable procedures/styles), recall_match finds them by meaning instead.",
  inputSchema: { type: 'object', properties: { ...INTENT_PROP } },
  handler: async (_input, ctx) => {
    const maps = await db
      .select({
        slug: recallMaps.slug,
        title: recallMaps.title,
        enterWhen: recallMaps.enterWhen,
        nodeCount: recallMaps.nodeCount,
        updatedAt: recallMaps.updatedAt,
      })
      .from(recallMaps)
      .where(and(eq(recallMaps.ownerId, ctx.ownerId), sql`${recallMaps.nodeCount} > 0`))
      .orderBy(recallMaps.slug);
    if (maps.length === 0) {
      return {
        ok: true,
        output: {
          maps: [],
          note: 'No Recall maps yet. The owner authors one by tagging a page tree’s root `recall` — see docs/recall.md.',
        },
      };
    }
    return {
      ok: true,
      output: {
        maps: maps.map((m) => ({
          map: m.slug,
          title: m.title,
          enter_when: m.enterWhen,
          nodes: m.nodeCount,
          updated_at: m.updatedAt.toISOString(),
        })),
        note: 'Enter a map with recall_open(map) and walk it via each node’s options with recall_go(map, target).',
      },
    };
  },
};

// ─── recall_open ────────────────────────────────────────────────────────────

const recall_open: BuiltinToolDef = {
  slug: 'recall_open',
  readOnly: true,
  name: 'Open a Recall map',
  description:
    "Enter a Recall map at its index node: the map's own content plus its options — each option says where it leads and when to follow it ('use when …'). Follow an option with recall_go(map, target). Maps come from recall_index.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug from recall_index (its id also works)." },
      ...INTENT_PROP,
    },
    required: ['map'],
  },
  handler: async (input, ctx) => {
    const ref = str(input.map).trim();
    if (!ref) return { ok: false, error: 'map is required' };
    const map = await mapBySlugOrId(ctx.ownerId, ref);
    if (!map) return { ok: false, error: `No Recall map '${ref}' — recall_index lists them.` };
    const [row] = await db
      .select()
      .from(recallNodes)
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.id, map.id)))
      .limit(1);
    if (!row) {
      return {
        ok: false,
        error: `Map '${map.slug}' has no compiled index yet — its pages likely failed lint. The owner can check the report in the editor.`,
      };
    }
    return { ok: true, output: nodePayload(map, row) };
  },
};

// ─── recall_go ──────────────────────────────────────────────────────────────

const recall_go: BuiltinToolDef = {
  slug: 'recall_go',
  readOnly: true,
  name: 'Go to a Recall node',
  description:
    "Read one node of a Recall map by its slug — the 'target' of an option from recall_open/recall_go, or the winner from recall_match. Returns the node's content and its own options.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug." },
      target: { type: 'string', description: "The node's slug (an option's 'target')." },
      ...INTENT_PROP,
    },
    required: ['map', 'target'],
  },
  handler: async (input, ctx) => {
    const ref = str(input.map).trim();
    const target = str(input.target).trim();
    if (!ref || !target) return { ok: false, error: 'map and target are required' };
    const map = await mapBySlugOrId(ctx.ownerId, ref);
    if (!map) return { ok: false, error: `No Recall map '${ref}' — recall_index lists them.` };
    const [row] = await db
      .select()
      .from(recallNodes)
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.slug, target)))
      .limit(1);
    if (!row) {
      // A map is small by construction, so the miss can afford to be helpful.
      const siblings = await db
        .select({ slug: recallNodes.slug })
        .from(recallNodes)
        .where(eq(recallNodes.mapId, map.id))
        .orderBy(recallNodes.slug);
      const shown = siblings.slice(0, 40);
      const more = siblings.length > shown.length ? `, … (${siblings.length} total)` : '';
      return {
        ok: false,
        error: `No node '${target}' in map '${map.slug}'. Its nodes: ${shown.map((s) => s.slug).join(', ')}${more}.`,
      };
    }
    return { ok: true, output: nodePayload(map, row) };
  },
};

// ─── recall_match ───────────────────────────────────────────────────────────

const recall_match: BuiltinToolDef = {
  slug: 'recall_match',
  readOnly: true,
  name: 'Match a Recall prompt',
  description:
    "Find the owner's Recall PROMPTS (reusable procedures, styles, checklists) that fit a task, by meaning. Call at the start of a distinct task with one line describing it; read each hit's 'use_when' to judge fit, then open the winner with recall_go(map, target) and apply it. Returns pointers only — at most 3, best first. No hits above the floor means no prompt covers this; just proceed.",
  inputSchema: {
    type: 'object',
    properties: {
      need: {
        type: 'string',
        description: "One line describing the task, e.g. 'upload a document to the brain'.",
      },
      ...INTENT_PROP,
    },
    required: ['need'],
  },
  handler: async (input, ctx) => {
    const need = str(input.need).trim();
    if (!need) return { ok: false, error: 'need is required' };

    let vec: string;
    try {
      vec = JSON.stringify(await embed(ctx.ownerId, need));
    } catch (err) {
      return {
        ok: false,
        error: `embed failed: ${errorMessage(err)}`,
      };
    }

    const rows = (await db.execute(sql`
      select ${recallNodes.slug}, ${recallNodes.title}, ${recallNodes.useWhen},
             ${recallMaps.slug} as map_slug,
             1 - (${recallNodes.embedding} <=> ${vec}::vector) as score
        from ${recallNodes}
        inner join ${recallMaps} on ${recallMaps.id} = ${recallNodes.mapId}
       where ${and(
         eq(recallNodes.ownerId, ctx.ownerId),
         eq(recallNodes.kind, 'prompt'),
         isNotNull(recallNodes.embedding),
       )}
       order by ${recallNodes.embedding} <=> ${vec}::vector
       limit ${MATCH_LIMIT}
    `)) as unknown as
      | { slug: string; title: string; use_when: string; map_slug: string; score: number }[]
      | {
          rows?: {
            slug: string;
            title: string;
            use_when: string;
            map_slug: string;
            score: number;
          }[];
        };
    const hits = Array.isArray(rows) ? rows : (rows.rows ?? []);

    if (hits.length === 0) {
      return {
        ok: true,
        output: {
          prompts: [],
          note: 'No prompts in Recall yet (or none embedded). The owner authors one by tagging a page `recall` + `prompt` — see docs/recall.md.',
        },
      };
    }
    return {
      ok: true,
      output: {
        prompts: hits.map((h) => ({
          map: h.map_slug,
          target: h.slug,
          title: h.title,
          use_when: h.use_when,
          score: Math.round(Number(h.score) * 1000) / 1000,
        })),
        note: 'Judge fit by use_when, then recall_go(map, target) for the full prompt. A weak score means no prompt covers this — proceed without one.',
      },
    };
  },
};

export const RECALL_TOOLS: readonly BuiltinToolDef[] = [
  recall_index,
  recall_open,
  recall_go,
  recall_match,
];
