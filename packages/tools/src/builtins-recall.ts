/**
 * Recall — the four serving tools over the memory-map system (S2 of the
 * Recall plan; docs/recall.md, roadmap task 97cf7850).
 *
 * v2 (task 5d6ce06a) makes the rows below the SOURCE rather than a compiled
 * artifact, and a map an item in the Recall tree. These four tools keep their
 * names and their payload shapes; the changes are additive fields (`folder` on
 * a catalog entry, `map` on a cross-map option) plus filters that hide what an
 * owner has not published. Two were bugs rather than additions: recall_open
 * looked for its entry card by id, which is only true of a page-built map, and
 * recall_match promised a score floor it never applied.
 *
 *   recall_index()             → the catalog: which maps exist, enter when
 *   recall_open(map)           → a map's index node: content + options
 *   recall_go(map, target)     → any node by slug: content + its options
 *   recall_match(need)         → top prompts by meaning; open the winner
 *
 * Every read is one indexed row off the serving tables (recall_maps /
 * recall_nodes): written directly by the native path for a v2 map
 * (packages/content/src/recall-native.ts), compiled from pages for a v1 map
 * until R5 retires those. No ProseMirror parsing, no LLM; recall_match is one
 * ANN probe over the partial prompt index plus one (cached) embed of the
 * query line. Bodies are budget-capped at write time, so responses are small
 * by construction.
 *
 * Owner surfaces only (web, Telegram, owner paths such as MCP). The grant
 * already keeps these away from team and client agents; the check here is the
 * second lock, so an owner who widens `recall-read` by mistake does not open
 * every prompt to a team agent before team sharing exists (R6).
 *
 * `intent` on every tool is the flight-recorder line (why the caller came).
 * Accepted now for schema stability; RECORDED from S3 — until then it is
 * deliberately dropped, never stored, never echoed.
 *
 * Options are affordances ("use when …"), never commands: the tools present
 * the map's signposts, the caller decides. All four are read-only.
 */

import { and, arrayContains, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, nodes, recallMaps, recallNodes } from '@mantle/db';
import { embedPendingRecallPrompts, recallFolderCrumbs } from '@mantle/content';
import { embed } from '@mantle/embeddings';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str } from './coerce';
import { errorMessage } from '@mantle/std';
import { OWNER_ONLY_ERROR, isOwnerSurface } from './surface';

const MATCH_LIMIT = 3;

/**
 * The floor `recall_match`'s own description has always promised ("no hits
 * above the floor means no prompt covers this"). It had none: the query was
 * an ordered ANN probe with a limit and no threshold, so three unrelated
 * prompts came back looking like answers and the caller was told to judge a
 * gate that did not exist.
 *
 * Cosine similarity on the one embedder config. 0.35 is deliberately low: a
 * prompt the owner wrote for a task is usually well above it, and the cost of
 * a false negative (an agent works without a prompt that existed) is higher
 * than a weak hit the caller can still reject by reading `use_when`.
 */
const MATCH_FLOOR = 0.35;

/** Shared arg — see the header: accepted for S3's recorder, unused today. */
const INTENT_PROP = {
  intent: {
    type: 'string',
    description:
      "One line on why you came ('starting the fleet-app work'). Recorded for the owner's recall log; optional but appreciated.",
  },
} as const;

type MapRow = typeof recallMaps.$inferSelect;

/** The refusal for anyone who is not the owner (see the header). */
function notOwner(ctx: Pick<ToolHandlerContext, 'surface'>): ToolHandlerResult | null {
  return isOwnerSurface(ctx.surface) ? null : { ok: false, error: OWNER_ONLY_ERROR };
}

/**
 * Resolve a map reference the way an agent might hold one: its slug, a slug it
 * answered to before a rename (`former_slugs`), or its id.
 *
 * Unpublished maps never resolve here. A map an agent created waits for the
 * owner to publish it, and until then it must be invisible to every serving
 * tool rather than merely absent from the catalog.
 */
async function mapBySlugOrId(ownerId: string, ref: string): Promise<MapRow | null> {
  const mine = and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.published, true));
  const [bySlug] = await db
    .select()
    .from(recallMaps)
    .where(and(mine, eq(recallMaps.slug, ref)))
    .limit(1);
  if (bySlug) return bySlug;
  // A remembered slug still lands: renames are cheap for the owner and
  // expensive for every agent and skill that hard-coded the old one.
  const [byFormer] = await db
    .select()
    .from(recallMaps)
    .where(and(mine, arrayContains(recallMaps.formerSlugs, [ref])))
    .limit(1);
  if (byFormer) return byFormer;
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
  const [byId] = await db
    .select()
    .from(recallMaps)
    .where(and(mine, eq(recallMaps.id, ref)))
    .limit(1);
  return byId ?? null;
}

/** The stale note a served node carries when the pages ahead of it failed
 *  lint — honest about serving the last GOOD rev, without failing the read. */
function staleNote(map: MapRow): string | undefined {
  // A native map cannot be stale: its rows ARE the source, and a write that
  // fails its checks is refused rather than served one rev behind. Guarded on
  // the linkage rather than on `last_compile_ok`, so a leftover false from the
  // map's v1 life can never attach the note to content it does not describe.
  if (nativeMap(map)) return undefined;
  return map.lastCompileOk
    ? undefined
    : 'Note: newer edits to this map failed its lint, so you are reading the last good version. The owner can see the report in the editor.';
}

/** A map whose rows are written directly (v2) rather than compiled from a
 *  page tree (v1). The node linkage is the discriminator. */
function nativeMap(map: MapRow): boolean {
  return map.nodeId !== null;
}

/**
 * One card as agents read it.
 *
 * `use_when` rides on every card that has one, not only on prompts: an agent
 * edits by read-modify-write, and a line it was never shown is a line its
 * write would not carry. `version` is the map's, for the same reason: a write
 * tool that is sent it refuses a card that changed since this read.
 *
 * A cross-map option to a map that is no longer published (or no longer
 * exists) is left out: an agent cannot follow it, and it cannot tell a dead
 * option from a live one. The owner sees it as a warning in the editor.
 */
async function nodePayload(ownerId: string, map: MapRow, row: typeof recallNodes.$inferSelect) {
  const crossMaps = [
    ...new Set((row.options ?? []).flatMap((o) => (o.targetMap ? [o.targetMap] : []))),
  ];
  const live =
    crossMaps.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ slug: recallMaps.slug })
              .from(recallMaps)
              .where(
                and(
                  eq(recallMaps.ownerId, ownerId),
                  eq(recallMaps.published, true),
                  inArray(recallMaps.slug, crossMaps),
                ),
              )
          ).map((r) => r.slug),
        );
  return {
    map: map.slug,
    node: row.slug,
    kind: row.kind,
    title: row.title,
    body_md: row.bodyMd,
    ...(row.useWhen ? { use_when: row.useWhen } : {}),
    options: (row.options ?? [])
      .filter((o) => !o.targetMap || live.has(o.targetMap))
      .map((o) => ({
        label: o.label,
        use_when: o.useWhen,
        target: o.targetSlug,
        // Cross-map option: the target is another map's entry card. Additive:
        // an older caller ignores the extra key and `recall_go(map, target)`
        // still lands, because `target` resolves across maps too (see below).
        ...(o.targetMap ? { map: o.targetMap } : {}),
      })),
    ...(nativeMap(map) ? { version: map.version } : {}),
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
    const refused = notOwner(ctx);
    if (refused) return refused;
    const rows = await db
      .select({
        id: recallMaps.id,
        slug: recallMaps.slug,
        title: recallMaps.title,
        enterWhen: recallMaps.enterWhen,
        nodeCount: recallMaps.nodeCount,
        updatedAt: recallMaps.updatedAt,
        path: nodes.path,
      })
      .from(recallMaps)
      // The map's item, for its folder. A left join: a v1 map has no node,
      // and an inner join would have quietly emptied the catalog.
      .leftJoin(nodes, eq(nodes.id, recallMaps.nodeId))
      .where(
        and(
          eq(recallMaps.ownerId, ctx.ownerId),
          eq(recallMaps.published, true),
          sql`${recallMaps.nodeCount} > 0`,
        ),
      )
      .orderBy(asc(recallMaps.title));
    const crumbs = await recallFolderCrumbs(
      ctx.ownerId,
      rows.map((r) => ({ id: r.id, path: r.path === null ? null : String(r.path) })),
    );
    // Folder first, then title: the catalog reads as the tree looks. Unsorted
    // maps (no folder) come last — they are the ones the owner has not filed.
    const maps = [...rows].sort((a, b) => {
      const fa = crumbs.get(a.id) ?? null;
      const fb = crumbs.get(b.id) ?? null;
      if (fa !== fb) {
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fa.localeCompare(fb);
      }
      return a.title.localeCompare(b.title);
    });
    if (maps.length === 0) {
      return {
        ok: true,
        output: {
          maps: [],
          note: 'No Recall maps yet. The owner starts one in the Recall screen (see docs/recall.md).',
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
          // Where the owner filed it ("Mantle", "Mantle / Fleet"); null when
          // unsorted. The catalog IS the index in v2 — there is no authored
          // "start here" map — so the grouping has to travel with it.
          folder: crumbs.get(m.id) ?? null,
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
    const refused = notOwner(ctx);
    if (refused) return refused;
    const ref = str(input.map).trim();
    if (!ref) return { ok: false, error: 'map is required' };
    const map = await mapBySlugOrId(ctx.ownerId, ref);
    if (!map) return { ok: false, error: `No Recall map '${ref}' — recall_index lists them.` };
    // The entry card is the one of kind 'index'.
    //
    // This used to select `recallNodes.id = map.id`, which is only ever true
    // for a v1 map: there the entry card IS the root page, so card id and map
    // id are the same uuid. A native map's entry card is an ordinary row with
    // its own id, so that query found nothing and every natively created map
    // answered "has no compiled index yet, its pages likely failed lint" —
    // a lint failure that had not happened, on pages that do not exist.
    // `kind` is the honest key and is correct for both.
    let [row] = await db
      .select()
      .from(recallNodes)
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.kind, 'index')))
      .limit(1);
    // A v1 one-page prompt map compiles its only page as kind 'prompt', so it
    // has no 'index' row; its root card shares the map id. Until R5 retires v1.
    if (!row && !nativeMap(map)) {
      [row] = await db
        .select()
        .from(recallNodes)
        .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.id, map.id)))
        .limit(1);
    }
    if (!row) {
      return {
        ok: false,
        error: nativeMap(map)
          ? `Map '${map.slug}' has no entry card. The owner can add one in the Recall editor.`
          : `Map '${map.slug}' has no compiled index yet — its pages likely failed lint. The owner can check the report in the editor.`,
      };
    }
    return { ok: true, output: await nodePayload(ctx.ownerId, map, row) };
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
    const refused = notOwner(ctx);
    if (refused) return refused;
    const ref = str(input.map).trim();
    const target = str(input.target).trim();
    if (!ref || !target) return { ok: false, error: 'map and target are required' };
    const map = await mapBySlugOrId(ctx.ownerId, ref);
    if (!map) return { ok: false, error: `No Recall map '${ref}' — recall_index lists them.` };
    // Resolution order: a card in this map, a slug a card in this map used to
    // answer to, then a map by that slug (serving ITS entry card, with the
    // payload's `map` naming that one). A cross-map option is served as
    // { target: X, map: X }, so the natural follow is recall_go(map: X,
    // target: X): the target names the map itself, and lands on its entry.
    // recall_go(this map, X) lands the same way, for a caller that only knows
    // the old two arguments.
    let [row] = await db
      .select()
      .from(recallNodes)
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.slug, target)))
      .limit(1);
    if (!row) {
      [row] = await db
        .select()
        .from(recallNodes)
        .where(and(eq(recallNodes.mapId, map.id), arrayContains(recallNodes.formerSlugs, [target])))
        .limit(1);
    }
    if (!row) {
      const other = await mapBySlugOrId(ctx.ownerId, target);
      if (other) {
        const [entry] = await db
          .select()
          .from(recallNodes)
          .where(and(eq(recallNodes.mapId, other.id), eq(recallNodes.kind, 'index')))
          .limit(1);
        if (entry) return { ok: true, output: await nodePayload(ctx.ownerId, other, entry) };
      }
    }
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
    return { ok: true, output: await nodePayload(ctx.ownerId, map, row) };
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
    const refused = notOwner(ctx);
    if (refused) return refused;
    const need = str(input.need).trim();
    if (!need) return { ok: false, error: 'need is required' };

    // Self-healing: a prompt whose embed failed at write time (the embedder
    // was down, the process restarted) has a NULL vector and never matches.
    // One cheap indexed probe here refills it in the background, so the next
    // match finds it without a sweep job.
    const [missing] = await db
      .select({ id: recallNodes.id })
      .from(recallNodes)
      .where(
        and(
          eq(recallNodes.ownerId, ctx.ownerId),
          eq(recallNodes.kind, 'prompt'),
          isNull(recallNodes.embedding),
        ),
      )
      .limit(1);
    if (missing) {
      void embedPendingRecallPrompts(ctx.ownerId).catch((err) => {
        console.error('[recall] prompt embed refill failed (non-fatal):', err);
      });
    }

    let vec: string;
    try {
      vec = JSON.stringify(await embed(ctx.ownerId, need));
    } catch (err) {
      return {
        ok: false,
        error: `embed failed: ${errorMessage(err)}`,
      };
    }

    // Every filter belongs INSIDE this query, never on its result: the probe
    // is ordered-by-distance with a limit, so dropping rows afterwards would
    // silently lose a prompt that ranked just outside the limit and report it
    // as "no prompt covers this". The same holds for the reader filter when
    // team sharing lands (R6) — it joins here, it does not post-filter.
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
         // A prompt an agent asked for and the owner has not confirmed.
         eq(recallNodes.promptPending, false),
         // A map an agent created and the owner has not published.
         eq(recallMaps.published, true),
       )}
         and 1 - (${recallNodes.embedding} <=> ${vec}::vector) >= ${MATCH_FLOOR}
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
          note: 'No prompt fits this closely enough to be worth reading, or none is embedded yet. Proceed without one.',
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
