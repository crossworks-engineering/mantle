/**
 * Recall v2: the OWNER's acts, on the MCP surface only.
 *
 * Jason, 2026-09-30: "I still want to be able to confirm it through mcp if
 * needed." Every owner route under /api/recall has a twin here, so everything
 * the Recall editor does can be done from an MCP client too. An MCP client
 * holds the owner's token and acts for the owner, exactly like
 * `pending_approve` (builtins-pending.ts), so these run with an OWNER actor
 * named 'mcp'; the revision log shows "owner, via mcp".
 *
 * They are `mcpOnly`: never seeded, never in a tool group, so no in-app agent
 * can hold them. That matters more here than anywhere: publishing a map and
 * confirming a prompt are the two acts that decide what the brain tells every
 * agent to do, and an agent that could confirm its own prompt request would
 * defeat the gate the request exists for. The in-app agent tools
 * (builtins-recall-write.ts) stay agent-actor tools.
 *
 * Every description says the same thing on purpose: call only when the user
 * asked for this act in this conversation. Nothing here is auto-confirmed.
 */

import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { db, recallMaps, recallNodes, recallRevisions } from '@mantle/db';
import {
  RecallWriteError,
  confirmRecallPrompt,
  deleteRecallMap,
  getRecallCard,
  listRecallRevisions,
  putRecallCard,
  reorderRecallCards,
  restoreRecallRevision,
  updateRecallMap,
  type RecallActor,
  type RecallWriteResult,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str } from './coerce';
import { OWNER_ONLY_ERROR, isOwnerSurface } from './surface';
import { mapRef } from './builtins-recall-write';

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
  mcpOnly: true,
  ownerOnly: true,
  readOnly: true,
  name: 'List what waits for the owner in Recall',
  description:
    'List what in Recall waits for the owner: maps an agent made that are not published yet, and cards an agent asked to make a prompt (or whose prompt text an agent changed), with the text to confirm and the map version to confirm it at. Use before `recall_prompt_confirm` or `recall_map_publish`, and show the user the text first.',
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
          note: 'Show the user what they would approve. Then recall_prompt_confirm or recall_map_publish, with the version from here.',
        },
      };
    }),
};

// ─── recall_map_get ──────────────────────────────────────────────────────────

const recall_map_get: BuiltinToolDef = {
  slug: 'recall_map_get',
  mcpOnly: true,
  ownerOnly: true,
  readOnly: true,
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

// ─── recall_prompt_confirm ───────────────────────────────────────────────────

const recall_prompt_confirm: BuiltinToolDef = {
  slug: 'recall_prompt_confirm',
  mcpOnly: true,
  ownerOnly: true,
  name: 'Confirm or drop a Recall prompt',
  description: `Confirm a card an agent asked to make a prompt, so recall_match finds it (confirm: true), or drop the request (confirm: false); false on a confirmed prompt turns it back into knowledge. ${OWNERS_ACT} Send the version from \`recall_pending\`: a card changed since is refused, so nobody confirms text the user did not see.`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      card: { type: 'string', description: "The card's slug, e.g. 'deploy-steps'." },
      confirm: { type: 'boolean', description: 'true to confirm, false to drop or demote.' },
      version: VERSION_PROP,
    },
    required: ['map', 'card', 'confirm', 'version'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const version = versionOf(input);
      if (version === undefined) return { ok: false, error: needVersion('confirm a prompt') };
      if (typeof input.confirm !== 'boolean') {
        return { ok: false, error: 'Send confirm: true to confirm, or confirm: false to drop.' };
      }
      const card = str(input.card).trim();
      const res = await confirmRecallPrompt(
        ctx.ownerId,
        map.id,
        card,
        input.confirm,
        OWNER_VIA_MCP,
        version,
      );
      return written(map.slug, res, { card, prompt: input.confirm });
    }),
};

// ─── recall_map_publish ──────────────────────────────────────────────────────

const recall_map_publish: BuiltinToolDef = {
  slug: 'recall_map_publish',
  mcpOnly: true,
  ownerOnly: true,
  name: 'Publish or unpublish a Recall map',
  description: `Publish a Recall map, so every agent can find and walk it (published: true), or take it back out of their view (published: false). ${OWNERS_ACT} Send the version from \`recall_pending\` or \`recall_open\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      map: MAP_PROP,
      published: { type: 'boolean', description: 'true to publish, false to unpublish.' },
      version: VERSION_PROP,
    },
    required: ['map', 'published', 'version'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const version = versionOf(input);
      if (version === undefined) return { ok: false, error: needVersion('publish a map') };
      if (typeof input.published !== 'boolean') {
        return { ok: false, error: 'Send published: true to publish, or false to unpublish.' };
      }
      const res = await updateRecallMap(
        ctx.ownerId,
        map.id,
        { published: input.published, version },
        OWNER_VIA_MCP,
      );
      return written(map.slug, res, { published: input.published });
    }),
};

// ─── recall_map_delete ───────────────────────────────────────────────────────

const recall_map_delete: BuiltinToolDef = {
  slug: 'recall_map_delete',
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
  mcpOnly: true,
  ownerOnly: true,
  readOnly: true,
  name: "Read a Recall map's revision log",
  description:
    "A Recall map's revision log, newest first (the last 50): who changed what and when, with each revision's id for `recall_revision_restore`.",
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

// ─── recall_revision_restore ─────────────────────────────────────────────────

const recall_revision_restore: BuiltinToolDef = {
  slug: 'recall_revision_restore',
  mcpOnly: true,
  ownerOnly: true,
  name: 'Restore a Recall revision',
  description: `Undo one Recall write: put back what that revision replaced (a card's text, a deleted card, an old order, the map fields it changed). Undoing "card added" deletes that card. ${OWNERS_ACT} Revision ids come from \`recall_revisions\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      revision_id: { type: 'string', format: 'uuid', description: 'The revision id to restore.' },
    },
    required: ['revision_id'],
  },
  handler: async (input, ctx) =>
    ownerGuard(ctx, async () => {
      const id = str(input.revision_id).trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return { ok: false, error: 'revision_id is the id of one row from recall_revisions.' };
      }
      // The map it belongs to, for the answer (and a teaching miss when the
      // id is not one of this owner's revisions).
      const [owning] = await db
        .select({ slug: recallMaps.slug })
        .from(recallRevisions)
        .innerJoin(recallMaps, eq(recallMaps.id, recallRevisions.mapId))
        .where(and(eq(recallRevisions.ownerId, ctx.ownerId), eq(recallRevisions.id, id)))
        .limit(1);
      const res = await restoreRecallRevision(ctx.ownerId, id, OWNER_VIA_MCP);
      return written(owning?.slug ?? '', res, { restored: id });
    }),
};

// ─── recall_map_set_slug / recall_card_set_slug ──────────────────────────────

const recall_map_set_slug: BuiltinToolDef = {
  slug: 'recall_map_set_slug',
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
  recall_prompt_confirm,
  recall_map_publish,
  recall_map_delete,
  recall_cards_reorder,
  recall_revisions,
  recall_revision_restore,
  recall_map_set_slug,
  recall_card_set_slug,
];
