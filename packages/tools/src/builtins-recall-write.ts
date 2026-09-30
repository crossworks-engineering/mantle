/**
 * Recall v2 — the four WRITE tools, so an agent can keep the owner's maps
 * current instead of only reading them.
 *
 * The line these draw is the one v1 drew with tags: an agent could edit pages
 * inside a `recall`-tagged tree, and those edits served at once, but it could
 * never add the `recall` or `prompt` tag. So here an agent edits and adds
 * cards in an existing map and they serve immediately, while three things stay
 * the owner's act: publishing a map (a map an agent creates is invisible until
 * they do), making a card a prompt (an agent's request is recorded and neither
 * embedded nor matchable until confirmed), and deleting a map.
 *
 * That split is deliberate. What an agent may change is what the brain KNOWS;
 * what it may not change is what the brain TELLS OTHER AGENTS TO DO. The
 * second is the owner's voice, and a prompt an agent minted for itself would
 * be an agent instructing every future agent.
 *
 * Inside the app these are in no default grant: they ship as the
 * `recall-write` group for the owner to hand out deliberately. On the MCP
 * surface they are always registered (packages/mcp-core/src/build-server.ts),
 * like the rest of the owner's tools there: an MCP client holds the owner's
 * token, and the agent-kind actor still keeps publish, prompt minting and map
 * delete with the owner (decided 2026-09-30, audit finding M1).
 *
 * Versions: every read (recall_open, recall_go) returns the map's `version`.
 * Replacing or deleting a card REQUIRES it, so an agent writing from a stale
 * read is refused instead of silently overwriting the owner's newer edit.
 * Adding a card or retitling the map takes it when sent.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */

import { and, arrayContains, eq, isNotNull } from 'drizzle-orm';
import { db, recallMaps } from '@mantle/db';
import {
  RECALL_LABEL_MAX,
  RECALL_LINE_MAX,
  RECALL_OPTIONS_MAX,
  RECALL_TITLE_MAX,
  RecallWriteError,
  createRecallMap,
  deleteRecallCard,
  putRecallCard,
  updateRecallMap,
  type RecallActor,
  type RecallOptionInput,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str } from './coerce';
import { OWNER_ONLY_ERROR, isOwnerSurface } from './surface';

/** The caller, for the revision log: the agent's slug in the app, 'mcp' for an
 *  external MCP client (it runs as the owner's token, not as a named agent). */
function actorOf(ctx: ToolHandlerContext): RecallActor {
  const via = ctx.surface?.kind === 'owner' ? ctx.surface.via : null;
  return { kind: 'agent', id: null, name: ctx.agent?.slug ?? via ?? null };
}

/** Resolve a map by slug, a slug it answered to before a rename, or its id,
 *  and hand back its id and current version. A map row with no tree item is a
 *  leftover page-built (v1) map, retired in R5: it does not resolve. */
export async function mapRef(
  ownerId: string,
  ref: string,
): Promise<{ id: string; version: number; slug: string } | null> {
  const cols = { id: recallMaps.id, version: recallMaps.version, slug: recallMaps.slug };
  const mine = and(eq(recallMaps.ownerId, ownerId), isNotNull(recallMaps.nodeId));
  const bySlug = await db
    .select(cols)
    .from(recallMaps)
    .where(and(mine, eq(recallMaps.slug, ref)))
    .limit(1);
  if (bySlug[0]) return bySlug[0];
  // A remembered slug still lands, as it does for recall_open.
  const byFormer = await db
    .select(cols)
    .from(recallMaps)
    .where(and(mine, arrayContains(recallMaps.formerSlugs, [ref])))
    .limit(1);
  if (byFormer[0]) return byFormer[0];
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
  const byId = await db
    .select(cols)
    .from(recallMaps)
    .where(and(mine, eq(recallMaps.id, ref)))
    .limit(1);
  return byId[0] ?? null;
}

/** The version a caller sent, when it sent a usable one. */
function versionOf(input: Record<string, unknown>): number | undefined {
  const v = input.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** The refusal for a replace or delete sent without the version it read. */
const needVersion = (map: string, verb: string) =>
  `To ${verb} a card, send the map's 'version' from your last read of it (recall_go or recall_open on map '${map}' returns it). The version is what stops your write from overwriting an edit made since you read the card.`;

/** Turn a RecallWriteError into the tool's teaching failure, and let anything
 *  else surface as a real error (a bug, not a refusal). Owner surfaces only:
 *  a team or client turn never writes Recall. */
async function guard(
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

const notFound = (ref: string) =>
  `No Recall map '${ref}'. recall_index lists the maps by slug. To start a new one, use recall_map_create.`;

/** The option shape agents send. Kept identical to what recall_open returns,
 *  so a caller can read a card's options and send them back edited. */
function optionsFrom(input: unknown): RecallOptionInput[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const targetMap = str(o.map ?? o.targetMap).trim();
    return {
      label: str(o.label).trim(),
      useWhen: str(o.use_when ?? o.useWhen).trim(),
      targetSlug: str(o.target ?? o.targetSlug).trim(),
      ...(targetMap ? { targetMap } : {}),
    };
  });
}

const VERSION_PROP = {
  type: 'integer',
  minimum: 0,
  description: "The map's version from your last recall_go or recall_open, e.g. 12.",
} as const;

const OPTIONS_PROP = {
  type: 'array',
  maxItems: RECALL_OPTIONS_MAX,
  description:
    "The card's whole option list, replacing what was there; omit it to keep the card's options. Each is an affordance, never a command: a `label`, a `use_when` line, and a `target` card slug in this map, or a `map` slug to lead to another map's entry card.",
  items: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        maxLength: RECALL_LABEL_MAX,
        description: "What the option offers, e.g. 'Box by box'.",
      },
      use_when: {
        type: 'string',
        maxLength: RECALL_LINE_MAX,
        description: "When a reader should follow it, e.g. 'You need one box'.",
      },
      target: { type: 'string', description: "The target card's slug in this map." },
      map: { type: 'string', description: "Another map's slug, for a cross-map option." },
    },
    required: ['label', 'use_when'],
    additionalProperties: false,
  },
} as const;

// ─── recall_map_create ──────────────────────────────────────────────────────

const recall_map_create: BuiltinToolDef = {
  slug: 'recall_map_create',
  name: 'Start a Recall map',
  description:
    'Start a new Recall map with its entry card, and return its slug. The map is NOT served to agents until the owner publishes it in the Recall editor, so recall_index and recall_match will not show it yet — tell the owner it is ready. To add to a map that already exists use `recall_card_put` instead, which serves immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        maxLength: RECALL_TITLE_MAX,
        description: "The map's name, e.g. 'Fleet and access'.",
      },
      enter_when: {
        type: 'string',
        maxLength: RECALL_LINE_MAX,
        description:
          "The one line recall_index shows: when an agent should come in, e.g. 'Working on any box in the fleet'.",
      },
      folder: {
        type: 'string',
        description:
          "An existing Recall folder to file it under, e.g. 'Mantle' or 'Mantle / Fleet'. Omit to leave it unsorted.",
      },
    },
    required: ['title', 'enter_when'],
  },
  handler: async (input, ctx) =>
    guard(ctx, async () => {
      const made = await createRecallMap(
        ctx.ownerId,
        {
          title: str(input.title),
          enterWhen: str(input.enter_when),
          folder: str(input.folder).trim() || undefined,
        },
        actorOf(ctx),
      );
      return {
        ok: true,
        output: {
          map: made.slug,
          version: made.version,
          published: made.published,
          note: `Created with an entry card ('start'). It is unpublished, so no agent can reach it yet: add its cards with recall_card_put, then ask the owner to publish it.`,
        },
      };
    }),
};

// ─── recall_card_put ────────────────────────────────────────────────────────

const recall_card_put: BuiltinToolDef = {
  slug: 'recall_card_put',
  name: 'Write a Recall card',
  description:
    'Create or replace one card in an existing Recall map; it serves to every agent at once. To replace, read the card with `recall_go` first and send its `version`: a card changed since your read is refused, not overwritten. `title` and `body` replace; `use_when`, `options` and `prompt` keep their value when omitted, and `options` when sent replaces the whole list. A body over budget is refused and tells you to split the card. `prompt: true` only REQUESTS prompt status, and changing the text of a confirmed prompt sends it back to the owner to confirm. To remove a card use `recall_card_delete`.',
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug from recall_index." },
      card: {
        type: 'string',
        description:
          "The card's slug to replace. Omit to add a new card, whose slug comes from its title.",
      },
      title: {
        type: 'string',
        maxLength: RECALL_TITLE_MAX,
        description: "The card's title, e.g. 'Box by box'.",
      },
      body: {
        type: 'string',
        description: 'The card body, in markdown. What a reader arriving here should read.',
      },
      use_when: {
        type: 'string',
        maxLength: RECALL_LINE_MAX,
        description:
          'For a prompt: the one line recall_match compares a task against. Required with `prompt`.',
      },
      prompt: {
        type: 'boolean',
        description:
          'true asks the owner to make this card a prompt (a request, never applied by this call); false withdraws your request. Omit to leave it as it is.',
      },
      options: OPTIONS_PROP,
      after: {
        type: 'string',
        description: 'For a new card: the slug of the card to place it after.',
      },
      version: VERSION_PROP,
    },
    required: ['map', 'title', 'body'],
  },
  handler: async (input, ctx) =>
    guard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const card = str(input.card).trim() || null;
      const sent = versionOf(input);
      // Replacing needs the version the caller READ: a fresh one would always
      // match and let a stale read overwrite a newer edit (audit H3). Adding a
      // card cannot clobber anything, so it may go without.
      if (card && sent === undefined) return { ok: false, error: needVersion(map.slug, 'replace') };
      const res = await putRecallCard(
        ctx.ownerId,
        map.id,
        card,
        {
          title: str(input.title),
          bodyMd: str(input.body),
          ...(input.use_when !== undefined ? { useWhen: str(input.use_when).trim() } : {}),
          ...(typeof input.prompt === 'boolean' ? { prompt: input.prompt } : {}),
          ...(optionsFrom(input.options) ? { options: optionsFrom(input.options) } : {}),
          after: str(input.after).trim() || undefined,
        },
        actorOf(ctx),
        sent ?? map.version,
      );
      return {
        ok: true,
        output: {
          map: map.slug,
          card: res.cardSlug,
          version: res.version,
          ...(res.warnings.length > 0 ? { warnings: res.warnings.map((w) => w.message) } : {}),
          ...(input.prompt === true && res.cardSlug !== 'start'
            ? {
                note: 'If this card was not already a prompt, this is recorded as a prompt REQUEST. The owner confirms it in the Recall editor; until then the card serves by slug but never matches.',
              }
            : {}),
        },
      };
    }),
};

// ─── recall_card_delete ─────────────────────────────────────────────────────

const recall_card_delete: BuiltinToolDef = {
  slug: 'recall_card_delete',
  name: 'Delete a Recall card',
  description:
    "Remove one card from a Recall map. Options on other cards that pointed at it are removed in the same write and listed back, so the map cannot be left offering a route to something gone. The map's entry card cannot be deleted. Send the map's `version` from your last read, so a card changed since is not deleted blind.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug." },
      card: { type: 'string', description: "The card's slug." },
      version: VERSION_PROP,
    },
    required: ['map', 'card', 'version'],
  },
  handler: async (input, ctx) =>
    guard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const sent = versionOf(input);
      if (sent === undefined) return { ok: false, error: needVersion(map.slug, 'delete') };
      const res = await deleteRecallCard(
        ctx.ownerId,
        map.id,
        str(input.card).trim(),
        actorOf(ctx),
        sent,
      );
      return {
        ok: true,
        output: {
          map: map.slug,
          version: res.version,
          ...(res.optionsDropped
            ? {
                options_removed: res.optionsDropped.map((o) => `${o.cardSlug}: '${o.label}'`),
              }
            : {}),
          ...(res.warnings.length > 0 ? { warnings: res.warnings.map((w) => w.message) } : {}),
        },
      };
    }),
};

// ─── recall_map_update ──────────────────────────────────────────────────────

const recall_map_update: BuiltinToolDef = {
  slug: 'recall_map_update',
  name: 'Update a Recall map',
  description:
    "Change a Recall map's title or its `enter_when` line. A rename does NOT change the map's slug, because agents and skills remember slugs. Publishing, unpublishing and deleting a map are the owner's, not available here.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug." },
      title: { type: 'string', maxLength: RECALL_TITLE_MAX, description: "The map's new name." },
      enter_when: {
        type: 'string',
        maxLength: RECALL_LINE_MAX,
        description: 'The new catalog line: when an agent should enter this map.',
      },
      version: VERSION_PROP,
    },
    required: ['map'],
  },
  handler: async (input, ctx) =>
    guard(ctx, async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const title = str(input.title).trim();
      const enterWhen = str(input.enter_when).trim();
      if (!title && !enterWhen) {
        return {
          ok: false,
          error: `Nothing to change on map '${map.slug}'. Send 'title', 'enter_when', or both.`,
        };
      }
      const res = await updateRecallMap(
        ctx.ownerId,
        map.id,
        {
          ...(title ? { title } : {}),
          ...(enterWhen ? { enterWhen } : {}),
          version: versionOf(input) ?? map.version,
        },
        actorOf(ctx),
      );
      return { ok: true, output: { map: map.slug, version: res.version } };
    }),
};

export const RECALL_WRITE_TOOLS: readonly BuiltinToolDef[] = [
  recall_map_create,
  recall_card_put,
  recall_card_delete,
  recall_map_update,
];
