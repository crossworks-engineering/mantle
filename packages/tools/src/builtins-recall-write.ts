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
 * These are not in any default grant: they ship as the `recall-write` group
 * for the owner to hand out deliberately.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */

import { and, eq } from 'drizzle-orm';
import { db, recallMaps } from '@mantle/db';
import {
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

/** The caller, for the revision log. An agent turn carries its slug. */
function actorOf(ctx: ToolHandlerContext): RecallActor {
  return { kind: 'agent', id: null, name: ctx.agent?.slug ?? null };
}

/** Resolve a map by slug (or id) and hand back its id and current version.
 *  Reading the row is how these tools get the version, so a caller never has
 *  to fetch one first: the write is still refused if the row moved under it,
 *  because the transaction re-reads and compares. */
async function mapRef(
  ownerId: string,
  ref: string,
): Promise<{ id: string; version: number; slug: string } | null> {
  const bySlug = await db
    .select({ id: recallMaps.id, version: recallMaps.version, slug: recallMaps.slug })
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.slug, ref)))
    .limit(1);
  if (bySlug[0]) return bySlug[0];
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
  const byId = await db
    .select({ id: recallMaps.id, version: recallMaps.version, slug: recallMaps.slug })
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.id, ref)))
    .limit(1);
  return byId[0] ?? null;
}

/** Turn a RecallWriteError into the tool's teaching failure, and let anything
 *  else surface as a real error (a bug, not a refusal). */
async function guard(run: () => Promise<ToolHandlerResult>): Promise<ToolHandlerResult> {
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

const OPTIONS_PROP = {
  type: 'array',
  description:
    "The card's whole option list, replacing what was there. Each is an affordance, never a command: a `label`, a `use_when` line, and a `target` card slug in this map — or a `map` slug to lead to another map's entry card.",
  items: {
    type: 'object',
    properties: {
      label: { type: 'string', description: "What the option offers, e.g. 'Box by box'." },
      use_when: {
        type: 'string',
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
      title: { type: 'string', description: "The map's name, e.g. 'Fleet and access'." },
      enter_when: {
        type: 'string',
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
    guard(async () => {
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
    "Create or replace one card in an existing Recall map; it serves to every agent at once. `options` REPLACES the card's whole list, so read the card with `recall_go` first and send the list back edited. A body over its budget is refused and tells you to split the card. `prompt: true` only REQUESTS prompt status: the owner confirms it, and until then the card never matches. To remove a card use `recall_card_delete`.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug from recall_index." },
      card: {
        type: 'string',
        description:
          "The card's slug to replace. Omit to add a new card, whose slug comes from its title.",
      },
      title: { type: 'string', description: "The card's title, e.g. 'Box by box'." },
      body: {
        type: 'string',
        description: 'The card body, in markdown. What a reader arriving here should read.',
      },
      use_when: {
        type: 'string',
        description:
          'For a prompt: the one line recall_match compares a task against. Required with `prompt`.',
      },
      prompt: {
        type: 'boolean',
        description:
          'Ask the owner to make this card a prompt, so it can be matched by meaning. Recorded as a request, never applied by this call.',
      },
      options: OPTIONS_PROP,
      after: {
        type: 'string',
        description: 'For a new card: the slug of the card to place it after.',
      },
    },
    required: ['map', 'title', 'body'],
  },
  handler: async (input, ctx) =>
    guard(async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const res = await putRecallCard(
        ctx.ownerId,
        map.id,
        str(input.card).trim() || null,
        {
          title: str(input.title),
          bodyMd: str(input.body),
          useWhen: str(input.use_when).trim() || undefined,
          prompt: input.prompt === true,
          options: optionsFrom(input.options),
          after: str(input.after).trim() || undefined,
        },
        actorOf(ctx),
        map.version,
      );
      return {
        ok: true,
        output: {
          map: map.slug,
          card: res.cardSlug,
          version: res.version,
          ...(res.warnings.length > 0 ? { warnings: res.warnings.map((w) => w.message) } : {}),
          ...(input.prompt === true
            ? {
                prompt_pending: true,
                note: 'Recorded as a prompt REQUEST. The owner confirms it in the Recall editor; until then the card serves by slug but never matches.',
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
    "Remove one card from a Recall map. Options on other cards that pointed at it are removed in the same write and listed back, so the map cannot be left offering a route to something gone. The map's entry card cannot be deleted.",
  inputSchema: {
    type: 'object',
    properties: {
      map: { type: 'string', description: "The map's slug." },
      card: { type: 'string', description: "The card's slug." },
    },
    required: ['map', 'card'],
  },
  handler: async (input, ctx) =>
    guard(async () => {
      const ref = str(input.map).trim();
      const map = await mapRef(ctx.ownerId, ref);
      if (!map) return { ok: false, error: notFound(ref) };
      const res = await deleteRecallCard(
        ctx.ownerId,
        map.id,
        str(input.card).trim(),
        actorOf(ctx),
        map.version,
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
      title: { type: 'string', description: "The map's new name." },
      enter_when: {
        type: 'string',
        description: 'The new catalog line: when an agent should enter this map.',
      },
    },
    required: ['map'],
  },
  handler: async (input, ctx) =>
    guard(async () => {
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
          version: map.version,
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
