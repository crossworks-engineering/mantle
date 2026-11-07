/**
 * Recall: the OWNER's acts, on the MCP surface only.
 *
 * An MCP client holds the owner's token, so these run with an OWNER actor named
 * 'mcp'; the revision log shows "owner, via mcp". They are `mcpOnly`: never
 * seeded, never in a tool group, so no in-app agent holds them.
 *
 * An MCP client is the person's agent, not the person, so three acts are no
 * tool's (person-only-acts.ts): confirming a prompt, publishing a map and
 * restoring a revision. A person does them in the Recall editor. Publish
 * decides when a map first appears; after that an agent's edit serves at once
 * and the revision log records it (builtins-recall-write.ts).
 *
 * Every description here says the same thing on purpose: call only when the
 * user asked for this act in this conversation.
 */

import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { db, recallMaps, recallNodes } from '@mantle/db';
import {
  RecallWriteError,
  deleteRecallMap,
  getRecallCard,
  listRecallRevisions,
  putRecallCard,
  reorderRecallCards,
  updateRecallMap,
  type RecallActor,
  type RecallWriteResult,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import type { ToolItemArg } from './tool-policy';
import { str } from './coerce';
import { OWNER_ONLY_ERROR, isOwnerSurface } from './surface';
import { mapRef } from './builtins-recall-write';
import { CS } from './client-sourced-rule';

/** The owner, through an MCP client. */
const OWNER_VIA_MCP: RecallActor = { kind: 'owner', id: null, name: 'mcp' };

/** Said on every tool here: these are the owner's acts, never an agent's own
 *  initiative. */
const OWNERS_ACT =
  "The owner's act: call it only when the user asked for this in this conversation.";

async function ownerGuard(
  ctx: ToolHandlerContext,
  run: () => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  if (!isOwnerSurface(ctx.surface)) return { ok: false, error: OWNER_ONLY_ERROR };
  try {
    return await run();
  } catch (err) {
    if (err instanceof RecallWriteError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The version a caller sent, when it sent a usable one. */
function versionOf(input: Record<string, unknown>): number | undefined {
  const v = input.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

const needVersion = (verb: string) =>
  `To ${verb}, send the map's 'version' from recall_pending, recall_go or recall_open. It ties the act to what you showed the user: if the map changed since, the call is refused instead of acting on text nobody saw.`;

const notFound = (ref: string) =>
  `No Recall map '${ref}'. recall_pending lists unpublished maps; recall_index lists published ones.`;

/** The map these tools name (`map`: its slug, a former slug or its id):
 *  the audit row's target, asked before a call is queued (ToolItemArg). */
const MAP_ARG: readonly ToolItemArg[] = [{ param: 'map', by: 'recall-map', missing: notFound }];

/** A write result as these tools answer it. */
function written(map: string, res: RecallWriteResult, extra: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    output: {
      map,
      version: res.version,
      ...extra,
      ...(res.warnings.length > 0 ? { warnings: res.warnings.map((w) => w.message) } : {}),
      ...(res.optionsDropped
        ? { options_removed: res.optionsDropped.map((o) => `${o.cardSlug}: '${o.label}'`) }
        : {}),
    },
  };
}

const MAP_PROP = { type: 'string', description: "The map's slug, e.g. 'fleet-and-access'." };
const VERSION_PROP = {
  type: 'integer',
  minimum: 0,
  description: "The map's version from the read you showed the user, e.g. 12.",
} as const;

// ─── recall_pending ──────────────────────────────────────────────────────────

const recall_pending: BuiltinToolDef = {
  slug: 'recall_pending',
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  mcpOnly: true,
  ownerOnly: true,
  name: 'List what waits for the owner in Recall',
  description:
    'List what in Recall waits for a person: maps an agent made that are not published yet, and cards an agent asked to make a prompt (or whose prompt text an agent changed), with the text. Show the user the text: a person confirms a prompt or publishes a map in the Recall editor, and no tool does. Publish decides when a map first appears; after that an edit serves at once and the revision log records it.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) =>
    ownerGuard(ctx, async () => {
      const drafts = await db
        .select({
          slug: recallMaps.slug,
          title: recallMaps.title,
          enterWhen: recallMaps.enterWhen,
          nodeCount: recallMaps.nodeCount,
          version: recallMaps.version,
        })
        .from(recallMaps)
        .where(
          and(
            eq(recallMaps.ownerId, ctx.ownerId),
            eq(recallMaps.published, false),
            isNotNull(recallMaps.nodeId),
          ),
        )
        .orderBy(desc(recallMaps.updatedAt));
      const prompts = await db
        .select({
          map: recallMaps.slug,
          version: recallMaps.version,
          card: recallNodes.slug,
          title: recallNodes.title,
          useWhen: recallNodes.useWhen,
          bodyMd: recallNodes.bodyMd,
        })
        .from(recallNodes)
        .innerJoin(recallMaps, eq(recallMaps.id, recallNodes.mapId))
        .where(and(eq(recallNodes.ownerId, ctx.ownerId), eq(recallNodes.promptPending, true)))
        // Newest first, so the cut at 50 keeps what changed most recently.
        .orderBy(desc(recallNodes.updatedAt))
        .limit(50);
      return {
        ok: true,
        output: {
          unpublished_maps: drafts.map((d) => ({
            map: d.slug,
            title: d.title,
            enter_when: d.enterWhen,
            cards: d.nodeCount,
            version: d.version,
          })),
          prompt_requests: prompts.map((p) => ({
            map: p.map,
            card: p.card,
            title: p.title,
            use_when: p.useWhen,
            body_md: p.bodyMd,
            version: p.version,
          })),
          note: 'Show the user what waits. A person confirms a prompt or publishes a map in the Recall editor, and no tool does.',
        },
      };
    }),
};

// ─── recall_map_get ──────────────────────────────────────────────────────────

const recall_map_get: BuiltinToolDef = {
  slug: 'recall_map_get',
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  mcpOnly: true,
  ownerOnly: true,
  name: 'Read a whole Recall map as the owner',
  description:
    'Read one Recall map whole, as the owner sees it in the editor: its settings, version and every card with body, use-when, prompt state and options, published or not. Agents walking a published map use `recall_open` instead.',
  inputSchema: { type: 'object', properties: { map: MAP_PROP }, required: ['map'] },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const [row] = await db.select().from(recallMaps).where(eq(recallMaps.id, map.id)).limit(1);
      const cards = await db
        .select()
        .from(recallNodes)
        .where(eq(recallNodes.mapId, map.id))
        .orderBy(asc(recallNodes.rank), asc(recallNodes.slug));
      return {
        ok: true,
        output: {
          map: row!.slug,
          title: row!.title,
          enter_when: row!.enterWhen,
          published: row!.published,
          former_slugs: row!.formerSlugs,
          version: row!.version,
          cards: cards.map((c) => ({
            card: c.slug,
            kind: c.kind,
            title: c.title,
            ...(c.useWhen ? { use_when: c.useWhen } : {}),
            ...(c.promptPending ? { prompt_pending: true } : {}),
            body_md: c.bodyMd,
            options: (c.options ?? []).map((o) => ({
              label: o.label,
              use_when: o.useWhen,
              target: o.targetSlug,
              ...(o.targetMap ? { map: o.targetMap } : {}),
            })),
          })),
        },
      };
    }),
};

// ─── recall_map_delete ───────────────────────────────────────────────────────

const recall_map_delete: BuiltinToolDef = {
  slug: 'recall_map_delete',
  policy: {
    destructive: true, // cannot be undone
    matrix: { action: 'delete', param: 'map', kinds: ['recall'] },
    deletesItem: true,
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    itemArgs: MAP_ARG,
    clientSourced: CS.always(CS.RECALL_GUIDANCE),
  },
  mcpOnly: true,
  ownerOnly: true,
  name: 'Delete a Recall map',
  description: `Delete a whole Recall map with all its cards and its revision log. It cannot be undone. ${OWNERS_ACT} Without confirm: true it only says what would go: tell the user, and call again with confirm: true once they agree.`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      confirm: { type: 'boolean', description: 'true once the user agreed to the delete.' },
    },
    required: ['map'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      if (input.confirm !== true) {
        return {
          ok: false,
          error: `This deletes map '${map.slug}' with all its cards and revisions, and cannot be undone. Tell the user what will be deleted, and call again with confirm: true only after they agree.`,
        };
      }
      await deleteRecallMap(ctx.ownerId, map.id, OWNER_VIA_MCP);
      return { ok: true, output: { map: map.slug, deleted: true } };
    }),
};

// ─── recall_cards_reorder ────────────────────────────────────────────────────

const recall_cards_reorder: BuiltinToolDef = {
  slug: 'recall_cards_reorder',
  policy: {
    matrix: { action: 'edit', param: 'map', kinds: ['recall'] },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    itemArgs: MAP_ARG,
    clientSourced: CS.always(CS.RECALL_GUIDANCE),
  },
  mcpOnly: true,
  ownerOnly: true,
  name: "Reorder a Recall map's cards",
  description: `Set the order of a map's cards: send every card's slug once, in the new order (the entry card stays first). ${OWNERS_ACT}`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      slugs: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: "Every card's slug in the new order, e.g. ['box-by-box', 'access-gaps'].",
      },
      version: VERSION_PROP,
    },
    required: ['map', 'slugs', 'version'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const version = versionOf(input);
      if (version === undefined) return { ok: false, error: needVersion('reorder cards') };
      const slugs = Array.isArray(input.slugs) ? input.slugs.map((s) => str(s).trim()) : [];
      const res = await reorderRecallCards(ctx.ownerId, map.id, slugs, OWNER_VIA_MCP, version);
      return written(map.slug, res);
    }),
};

// ─── recall_revisions ────────────────────────────────────────────────────────

const recall_revisions: BuiltinToolDef = {
  slug: 'recall_revisions',
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  mcpOnly: true,
  ownerOnly: true,
  name: "Read a Recall map's revision log",
  description:
    "A Recall map's revision log, newest first (the last 50): who changed what and when. To undo one, tell the user: a person restores a revision in the Recall editor, and no tool does.",
  inputSchema: { type: 'object', properties: { map: MAP_PROP }, required: ['map'] },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const revs = await listRecallRevisions(ctx.ownerId, map.id);
      return {
        ok: true,
        output: {
          map: map.slug,
          version: map.version,
          revisions: revs.map((r) => ({
            id: r.id,
            summary: r.summary,
            card: r.cardSlug,
            actor: r.actorName ? `${r.actorKind} (${r.actorName})` : r.actorKind,
            at: r.createdAt,
          })),
        },
      };
    }),
};

// ─── recall_map_set_slug / recall_card_set_slug ──────────────────────────────

const recall_map_set_slug: BuiltinToolDef = {
  slug: 'recall_map_set_slug',
  policy: {
    matrix: { action: 'edit', param: 'map', kinds: ['recall'] },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    itemArgs: MAP_ARG,
    clientSourced: CS.always(CS.RECALL_GUIDANCE),
  },
  mcpOnly: true,
  ownerOnly: true,
  name: "Change a Recall map's slug",
  description: `Give a Recall map a new slug. The old one keeps resolving for agents and skills that remember it, and options in other maps follow. ${OWNERS_ACT}`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      slug: { type: 'string', description: "The new slug, e.g. 'fleet'." },
      version: VERSION_PROP,
    },
    required: ['map', 'slug', 'version'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const version = versionOf(input);
      if (version === undefined) return { ok: false, error: needVersion("change a map's slug") };
      const res = await updateRecallMap(
        ctx.ownerId,
        map.id,
        { slug: str(input.slug), version },
        OWNER_VIA_MCP,
      );
      const [now] = await db
        .select({ slug: recallMaps.slug })
        .from(recallMaps)
        .where(eq(recallMaps.id, map.id))
        .limit(1);
      return written(now?.slug ?? map.slug, res, { former: map.slug });
    }),
};

const recall_card_set_slug: BuiltinToolDef = {
  slug: 'recall_card_set_slug',
  policy: {
    matrix: { action: 'edit', param: 'map', kinds: ['recall'] },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    itemArgs: MAP_ARG,
    clientSourced: CS.always(CS.RECALL_GUIDANCE),
  },
  mcpOnly: true,
  ownerOnly: true,
  name: "Change a Recall card's slug",
  description: `Give a card a new slug. The old one keeps resolving in recall_go, and options in the map that led to it follow the card. Its text and prompt state are unchanged. ${OWNERS_ACT}`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      card: { type: 'string', description: "The card's slug now, e.g. 'box'." },
      slug: { type: 'string', description: "The new slug, e.g. 'box-by-box'." },
      version: VERSION_PROP,
    },
    required: ['map', 'card', 'slug', 'version'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const version = versionOf(input);
      if (version === undefined) return { ok: false, error: needVersion("change a card's slug") };
      const cardSlug = str(input.card).trim();
      const card = await getRecallCard(ctx.ownerId, map.id, cardSlug);
      if (!card) {
        return {
          ok: false,
          error: `No card '${cardSlug}' in map '${map.slug}'. recall_open lists its options.`,
        };
      }
      const res = await putRecallCard(
        ctx.ownerId,
        map.id,
        card.slug,
        { title: card.title, bodyMd: card.bodyMd, slug: str(input.slug) },
        OWNER_VIA_MCP,
        version,
      );
      return written(map.slug, res, { card: res.cardSlug, former: card.slug });
    }),
};

export const RECALL_OWNER_TOOLS: readonly BuiltinToolDef[] = [
  recall_pending,
  recall_map_get,
  recall_map_delete,
  recall_cards_reorder,
  recall_revisions,
  recall_map_set_slug,
  recall_card_set_slug,
];
