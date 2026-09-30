/**
 * Recall v2 — the NATIVE write path. A map is one `recall` item in the tree;
 * its cards are rows in `recall_nodes`, written here directly.
 *
 * This is the half of Recall that v2 replaces. v1 compiles a page tree into
 * these rows and treats them as a build artifact, which means the checks run
 * AFTER the commit: a page that broke its map published anyway, the map kept
 * serving its last good rev, and the only sign was a note on every agent read.
 * The dev brain's registry served a two-week-old revision that way. So here
 * the checks run INSIDE the write and refuse it — nothing is ever served that
 * failed one, and there is no stale rev to explain.
 *
 * Every refusal is a `RecallWriteError` whose message names the fix, per this
 * repo's error style guide: the reader is usually an LLM mid-turn, and an
 * error that says what to do next produces one retry instead of a flail.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */

import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';

import {
  db,
  nodes,
  recallMaps,
  recallNodes,
  recallRevisions,
  RECALL_REVISIONS_PER_MAP,
} from '@mantle/db';
import {
  RECALL_BODY_CHAR_BUDGET,
  RECALL_MAX_MAP_NODES,
  recallSlug,
} from '@mantle/content-core/recall-compile';

import { RECALL_ROOT_LABEL, embedPendingRecallPrompts, ensureRecallRoot } from './recall';

/** Who is writing. An `agent` may edit cards in an existing map and have them
 *  served at once, but may not create a map or mint a prompt: those stay the
 *  owner's act, exactly as in v1, where an agent could edit pages inside a
 *  tagged tree but never add the `recall` or `prompt` tag. */
export type RecallActor = {
  kind: 'owner' | 'agent';
  /** The admin login or the agent's node id, for the revision log. */
  id?: string | null;
  /** Display name or agent slug, for the revisions panel. */
  name?: string | null;
};

/** A refused write. `code` is for callers that branch; `message` is written
 *  for the model that has to recover from it. */
export class RecallWriteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecallWriteError';
    this.code = code;
  }
}

export type RecallOptionInput = {
  label: string;
  useWhen: string;
  /** A card slug in this map, or another map's slug with `targetMap`. */
  targetSlug: string;
  targetMap?: string;
};

export type RecallCardInput = {
  title: string;
  bodyMd: string;
  useWhen?: string;
  prompt?: boolean;
  options?: RecallOptionInput[];
  /** Slug of the card to place a NEW card after. Ignored on replace. */
  after?: string;
};

export type RecallWarning = { code: string; message: string; cardSlug?: string };

export type RecallWriteResult = {
  version: number;
  cardSlug?: string;
  warnings: RecallWarning[];
  optionsDropped?: { cardSlug: string; label: string }[];
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CardRow = typeof recallNodes.$inferSelect;

/**
 * Slug from a title, cut at a WORD boundary.
 *
 * `recallSlug` (v1) slices at 60 characters mid-word, which is how the
 * registry ended up with `…-and-the-connector-fal`. It is left alone on
 * purpose: changing it would re-slug every page-built map on its next
 * compile, and a slug is exactly what agents and skills remember.
 */
export function recallNativeSlug(title: string): string {
  const full = recallSlug(title);
  if (full.length < 60) return full;
  const cut = full.lastIndexOf('-');
  // Only back up to a boundary if one exists late enough to leave a usable
  // slug; a single 60-character word has no boundary to find.
  return cut >= 20 ? full.slice(0, cut) : full;
}

/** Make `base` unique among `taken`, counting up. */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new RecallWriteError(
    'slug_exhausted',
    `Cannot make a unique slug from '${base}'. Give the card a more distinctive title.`,
  );
}

/** The map row, or a teaching miss. */
async function mapOr404(tx: Tx, ownerId: string, mapId: string) {
  const [map] = await tx
    .select()
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.id, mapId)))
    .limit(1);
  if (!map) {
    throw new RecallWriteError(
      'map_not_found',
      `No Recall map '${mapId}'. List them with recall_index, or the owner catalog at GET /api/recall/maps.`,
    );
  }
  if (map.nodeId === null) {
    throw new RecallWriteError(
      'map_is_page_built',
      `Map '${map.slug}' is still page-built (v1): its cards come from its page tree, so it cannot be written here. Edit its pages, or re-author it as a native map.`,
    );
  }
  return map;
}

/** Optimistic concurrency. A write without a version is refused rather than
 *  assumed safe: the editor and the agents both have one to send. */
function assertVersion(map: { slug: string; version: number }, sent: number | undefined): void {
  if (sent === undefined) {
    throw new RecallWriteError(
      'version_required',
      `This write needs the map's current version. Read map '${map.slug}' first and send its 'version' (now ${map.version}).`,
    );
  }
  if (sent !== map.version) {
    throw new RecallWriteError(
      'version_stale',
      `Map '${map.slug}' changed since you read it (you sent version ${sent}, it is now ${map.version}). Re-read the map, re-apply your change, and send the new version.`,
    );
  }
}

/** Card body budget. The one refusal a long write is most likely to hit, so
 *  it names the shape of the fix rather than just the number. */
function assertBody(bodyMd: string, title: string): void {
  if (bodyMd.length > RECALL_BODY_CHAR_BUDGET) {
    throw new RecallWriteError(
      'body_too_long',
      `Card '${title}' has ${bodyMd.length} characters of body, over the ${RECALL_BODY_CHAR_BUDGET} budget. Split it: keep the overview here, create a second card with the detail, and add an option on this card leading to it.`,
    );
  }
}

/**
 * Resolve every option's target, and stamp `targetId` so an edge survives a
 * rename. A same-map target must exist; a cross-map target must be a
 * PUBLISHED map, since an option leading somewhere invisible is a dead end an
 * agent cannot diagnose.
 */
async function resolveOptions(
  tx: Tx,
  ownerId: string,
  cards: Pick<CardRow, 'id' | 'slug'>[],
  options: RecallOptionInput[],
  cardTitle: string,
): Promise<RecallOptionInput[] & { targetId?: string }[]> {
  const bySlug = new Map(cards.map((c) => [c.slug, c.id]));
  const out: (RecallOptionInput & { targetId?: string })[] = [];
  for (const o of options) {
    if (!o.label?.trim()) {
      throw new RecallWriteError(
        'option_label_required',
        `An option on card '${cardTitle}' has no label. Each option needs a label and a 'use when' line: they are what a reader chooses between.`,
      );
    }
    if (o.targetMap) {
      const [target] = await tx
        .select({ slug: recallMaps.slug, published: recallMaps.published })
        .from(recallMaps)
        .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.slug, o.targetMap)))
        .limit(1);
      if (!target) {
        throw new RecallWriteError(
          'cross_map_not_found',
          `Option '${o.label}' points at map '${o.targetMap}', which does not exist. recall_index lists the maps.`,
        );
      }
      if (!target.published) {
        throw new RecallWriteError(
          'cross_map_unpublished',
          `Option '${o.label}' points at map '${o.targetMap}', which is not published yet, so no agent could follow it. Publish that map first, or point somewhere else.`,
        );
      }
      out.push({ ...o, targetSlug: o.targetMap });
      continue;
    }
    const id = bySlug.get(o.targetSlug);
    if (!id) {
      const near = [...bySlug.keys()].find(
        (s) => s.startsWith(o.targetSlug.slice(0, 6)) || o.targetSlug.startsWith(s.slice(0, 6)),
      );
      throw new RecallWriteError(
        'option_target_missing',
        `Option '${o.label}' points at card '${o.targetSlug}', which is not in this map${
          near ? ` (did you mean '${near}'?)` : ''
        }. This map's cards: ${[...bySlug.keys()].join(', ')}. For another map's entry card, set targetMap instead.`,
      );
    }
    out.push({ ...o, targetId: id });
  }
  return out as never;
}

/** Advisory findings, returned with the write and shown in the editor. Never
 *  blocking: an orphan card is a normal state while a map is being built, and
 *  refusing it would mean you could not add card two before linking it. */
function warningsFor(cards: CardRow[]): RecallWarning[] {
  const out: RecallWarning[] = [];
  const reached = new Set<string>();
  for (const c of cards) {
    for (const o of c.options ?? []) {
      if (!o.targetMap) reached.add(o.targetSlug);
    }
  }
  const entry = cards.find((c) => c.kind === 'index');
  for (const c of cards) {
    if (c.kind === 'index') continue;
    if (!reached.has(c.slug)) {
      out.push({
        code: 'orphan_card',
        cardSlug: c.slug,
        message: `No option leads to '${c.slug}', so a reader walking the map never arrives. Add an option pointing at it.`,
      });
    }
  }
  if (entry && cards.length > 1 && (entry.options ?? []).length === 0) {
    out.push({
      code: 'entry_without_options',
      cardSlug: entry.slug,
      message: `The entry card has no options, so the map's other ${cards.length - 1} card(s) cannot be reached from it.`,
    });
  }
  return out;
}

/** One revision row, and the prune that keeps the log bounded. */
async function recordRevision(
  tx: Tx,
  ownerId: string,
  mapId: string,
  actor: RecallActor,
  entry: { cardId?: string | null; cardSlug?: string | null; summary: string },
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.insert(recallRevisions).values({
    ownerId,
    mapId,
    cardId: entry.cardId ?? null,
    cardSlug: entry.cardSlug ?? null,
    summary: entry.summary,
    actorKind: actor.kind,
    actorId: actor.id ?? null,
    // Pure snapshots: restore writes `before` back as it was, so nothing
    // that is not part of the content may be smuggled in here.
    before: before as never,
    after: after as never,
  });
  // Keep the last N per map. One statement, so a hot map cannot grow the log.
  await tx.execute(sql`
    delete from ${recallRevisions}
     where ${recallRevisions.mapId} = ${mapId}
       and ${recallRevisions.id} not in (
         select id from ${recallRevisions}
          where map_id = ${mapId}
          order by created_at desc
          limit ${RECALL_REVISIONS_PER_MAP})`);
}

/** Re-stamp the map: version, card count, timestamp. The count matters more
 *  than it looks — `recall_index` hides a map whose node_count is 0, so a
 *  native map that never maintained it would be invisible to every agent. */
async function bumpMap(tx: Tx, mapId: string, version: number): Promise<number> {
  const counted = await tx
    .select({ n: count() })
    .from(recallNodes)
    .where(eq(recallNodes.mapId, mapId));
  const n = counted[0]?.n ?? 0;
  const next = version + 1;
  await tx
    .update(recallMaps)
    .set({ version: next, nodeCount: Number(n), updatedAt: new Date() })
    .where(eq(recallMaps.id, mapId));
  return next;
}

async function cardsOf(tx: Tx, mapId: string): Promise<CardRow[]> {
  return await tx
    .select()
    .from(recallNodes)
    .where(eq(recallNodes.mapId, mapId))
    .orderBy(asc(recallNodes.rank), asc(recallNodes.slug));
}

/**
 * A new map, with its entry card. An agent's map is created UNPUBLISHED: it
 * serves nowhere until the owner publishes it, which is the human act that
 * makes a map exist.
 */
export async function createRecallMap(
  ownerId: string,
  input: { title: string; enterWhen: string; folder?: string },
  actor: RecallActor,
): Promise<{ mapId: string; slug: string; version: number; published: boolean }> {
  const title = input.title?.trim();
  if (!title) {
    throw new RecallWriteError(
      'title_required',
      'A map needs a title: it is what the catalog shows.',
    );
  }
  const enterWhen = input.enterWhen?.trim();
  if (!enterWhen) {
    throw new RecallWriteError(
      'enter_when_required',
      `Map '${title}' needs an 'enter when' line — the one sentence in recall_index that tells an agent whether to come in. Without it the map is invisible in practice.`,
    );
  }
  await ensureRecallRoot(ownerId);
  const path = await resolveFolderPath(ownerId, input.folder);

  return await db.transaction(async (tx) => {
    const taken = new Set(
      (
        await tx
          .select({ slug: recallMaps.slug })
          .from(recallMaps)
          .where(eq(recallMaps.ownerId, ownerId))
      ).map((r) => r.slug),
    );
    const slug = uniqueSlug(recallNativeSlug(title), taken);
    const published = actor.kind === 'owner';
    const [item] = await tx
      .insert(nodes)
      .values({ ownerId, type: 'recall', title, slug, path, data: { enterWhen } })
      .returning({ id: nodes.id });
    const mapId = item!.id;
    await tx.insert(recallMaps).values({
      id: mapId,
      ownerId,
      nodeId: mapId,
      slug,
      title,
      enterWhen,
      nodeCount: 1,
      published,
      version: 1,
    });
    await tx.insert(recallNodes).values({
      ownerId,
      mapId,
      slug: 'start',
      kind: 'index',
      title,
      bodyMd: '',
      bodyChars: 0,
      useWhen: '',
      options: [],
      rank: 0,
      sourceVersion: 1,
    });
    await recordRevision(tx, ownerId, mapId, actor, { summary: 'map created' }, null, {
      title,
      enterWhen,
      slug,
    });
    return { mapId, slug, version: 1, published };
  });
}

/** Folder crumbs ("Mantle / Fleet") to the ltree path a map item sits on.
 *  The folders must already exist: this is Recall's write path, not the
 *  tree's. */
async function resolveFolderPath(ownerId: string, folder?: string): Promise<string> {
  const crumbs = (folder ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (crumbs.length === 0) return RECALL_ROOT_LABEL;
  let path = RECALL_ROOT_LABEL;
  for (const crumb of crumbs) {
    const [row] = await db
      .select({ path: nodes.path })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'branch'),
          eq(nodes.title, crumb),
          sql`${nodes.path}::text like ${`${path}.%`}`,
        ),
      )
      .limit(1);
    if (!row) {
      throw new RecallWriteError(
        'folder_not_found',
        `No Recall folder '${crumb}'${path === RECALL_ROOT_LABEL ? '' : ` under '${path}'`}. Create the folder first, or leave 'folder' off to file the map at the top.`,
      );
    }
    path = String(row.path);
  }
  return path;
}

/** Title, enter-when, slug, publish. Only the fields present change. */
export async function updateRecallMap(
  ownerId: string,
  mapId: string,
  patch: {
    title?: string;
    enterWhen?: string;
    slug?: string;
    published?: boolean;
    version?: number;
  },
  actor: RecallActor,
): Promise<RecallWriteResult> {
  return await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, patch.version);
    if (patch.published !== undefined && actor.kind !== 'owner') {
      throw new RecallWriteError(
        'publish_is_owners',
        `Publishing map '${map.slug}' is the owner's call, not an agent's. Leave it unpublished and tell them it is ready.`,
      );
    }
    const set: Partial<typeof recallMaps.$inferInsert> = {};
    if (patch.title?.trim()) set.title = patch.title.trim();
    if (patch.enterWhen?.trim()) set.enterWhen = patch.enterWhen.trim();
    if (patch.published !== undefined) set.published = patch.published;

    // A rename does NOT move the slug: agents and skills remember slugs, and
    // a title is the thing an owner most often tidies. Changing the slug is a
    // separate, explicit act, and the old one keeps resolving.
    if (patch.slug && patch.slug !== map.slug) {
      const next = recallNativeSlug(patch.slug);
      const [clash] = await tx
        .select({ id: recallMaps.id })
        .from(recallMaps)
        .where(
          and(
            eq(recallMaps.ownerId, ownerId),
            eq(recallMaps.slug, next),
            ne(recallMaps.id, map.id),
          ),
        )
        .limit(1);
      if (clash) {
        throw new RecallWriteError(
          'slug_taken',
          `Another map already answers to '${next}'. Pick a different slug.`,
        );
      }
      set.slug = next;
      set.formerSlugs = [...new Set([...map.formerSlugs, map.slug])];
      // Cross-map options elsewhere point at this map by slug; keep them live.
      await tx.execute(sql`
        update ${recallNodes}
           set options = (
             select jsonb_agg(
               case when o->>'targetMap' = ${map.slug}
                    then jsonb_set(jsonb_set(o, '{targetMap}', to_jsonb(${next}::text)),
                                   '{targetSlug}', to_jsonb(${next}::text))
                    else o end)
               from jsonb_array_elements(options) o)
         where owner_id = ${ownerId}
           and options @> ${JSON.stringify([{ targetMap: map.slug }])}::jsonb`);
    }
    if (Object.keys(set).length > 0)
      await tx.update(recallMaps).set(set).where(eq(recallMaps.id, map.id));
    // The item carries the title and the enter-when line for the tree.
    const itemSet: Record<string, unknown> = {};
    if (set.title) itemSet.title = set.title;
    if (set.slug) itemSet.slug = set.slug;
    if (set.enterWhen) itemSet.data = { enterWhen: set.enterWhen };
    if (Object.keys(itemSet).length > 0 && map.nodeId) {
      await tx.update(nodes).set(itemSet).where(eq(nodes.id, map.nodeId));
    }
    // The entry card's title tracks the map's, so the map does not read as two
    // different things in the catalog and in the editor.
    if (set.title) {
      await tx
        .update(recallNodes)
        .set({ title: set.title })
        .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.kind, 'index')));
    }
    const version = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      { summary: describeMapPatch(set) },
      { title: map.title, enterWhen: map.enterWhen, slug: map.slug, published: map.published },
      set,
    );
    return { version, warnings: warningsFor(await cardsOf(tx, map.id)) };
  });
}

function describeMapPatch(set: Partial<typeof recallMaps.$inferInsert>): string {
  const parts: string[] = [];
  if (set.title) parts.push('renamed');
  if (set.enterWhen) parts.push('enter-when edited');
  if (set.slug) parts.push('slug changed');
  if (set.published === true) parts.push('published');
  if (set.published === false) parts.push('unpublished');
  return parts.length > 0 ? parts.join(', ') : 'no change';
}

/**
 * Create or replace one card. `options` replaces the card's whole list, so a
 * caller edits by read-modify-write.
 *
 * `prompt: true` from an AGENT does not mint a prompt: it records the request
 * (`promptPending`), and the card is neither embedded nor matchable until the
 * owner confirms. This is v1's rule carried over exactly — an agent could edit
 * pages inside a tagged tree but never add the `prompt` tag — and it is the
 * one that keeps "what the owner tells agents to do" an owner-authored set.
 */
export async function putRecallCard(
  ownerId: string,
  mapId: string,
  cardSlug: string | null,
  input: RecallCardInput,
  actor: RecallActor,
  version?: number,
): Promise<RecallWriteResult> {
  const title = input.title?.trim();
  if (!title) {
    throw new RecallWriteError(
      'title_required',
      'A card needs a title: it is what an option points at and what a reader sees first.',
    );
  }
  const bodyMd = input.bodyMd ?? '';
  assertBody(bodyMd, title);
  const useWhen = input.useWhen?.trim() ?? '';
  if (input.prompt && !useWhen) {
    throw new RecallWriteError(
      'prompt_needs_use_when',
      `Card '${title}' asks to be a prompt but has no 'use when' line. That line is the only thing recall_match compares against, so a prompt without one can never be found. Add one sentence describing the task it fits.`,
    );
  }

  const result = await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, version);
    const cards = await cardsOf(tx, map.id);
    const existing = cardSlug ? cards.find((c) => c.slug === cardSlug) : undefined;
    if (cardSlug && !existing) {
      throw new RecallWriteError(
        'card_not_found',
        `No card '${cardSlug}' in map '${map.slug}'. Its cards: ${cards.map((c) => c.slug).join(', ')}. Omit the card id to add a new one.`,
      );
    }
    if (!existing && cards.length >= RECALL_MAX_MAP_NODES) {
      throw new RecallWriteError(
        'map_full',
        `Map '${map.slug}' already holds ${cards.length} cards, the limit of ${RECALL_MAX_MAP_NODES}. A map is meant to stay small enough to hold in mind: start a second map and link to it with a cross-map option.`,
      );
    }

    // Resolve options against the card set INCLUDING a card being created, so
    // a self-referencing or freshly-split card can be linked in one write.
    const slug = existing
      ? existing.slug
      : uniqueSlug(recallNativeSlug(title), new Set(cards.map((c) => c.slug)));
    const options = await resolveOptions(
      tx,
      ownerId,
      [...cards.map((c) => ({ id: c.id, slug: c.slug })), { id: existing?.id ?? slug, slug }],
      input.options ?? [],
      title,
    );

    // The entry card stays the entry card. Otherwise: a prompt if the OWNER
    // says so, a pending request if an agent asks, knowledge by default.
    const promptConfirmed = Boolean(input.prompt) && actor.kind === 'owner';
    const promptPending = Boolean(input.prompt) && actor.kind === 'agent';
    const kind = existing?.kind === 'index' ? 'index' : promptConfirmed ? 'prompt' : 'knowledge';

    // A prompt's vector is dropped when the text it was built from changed, so
    // `embedPendingRecallPrompts` refills it after the commit. NULL means
    // "servable by slug now, matchable in seconds", which is v1's posture and
    // the reason a write never waits on an embedder.
    const embedTextChanged =
      !existing ||
      existing.title !== title ||
      existing.useWhen !== useWhen ||
      existing.bodyMd !== bodyMd;
    const embedding = kind === 'prompt' && embedTextChanged ? null : undefined;

    const values = {
      title,
      bodyMd,
      bodyChars: bodyMd.length,
      useWhen,
      kind,
      promptPending,
      options: options as never,
      sourceVersion: map.version + 1,
      updatedAt: new Date(),
      ...(embedding === null ? { embedding: null } : {}),
      // A card that stops being a prompt must not keep a vector, or it would
      // go on matching from the partial index after the owner demoted it.
      ...(kind !== 'prompt' ? { embedding: null } : {}),
    };

    if (existing) {
      await tx.update(recallNodes).set(values).where(eq(recallNodes.id, existing.id));
    } else {
      const after = input.after ? cards.find((c) => c.slug === input.after) : undefined;
      const rank = after ? after.rank + 1 : (cards.at(-1)?.rank ?? 0) + 1;
      // Make room, so `after` means after and ranks stay dense.
      await tx
        .update(recallNodes)
        .set({ rank: sql`${recallNodes.rank} + 1` })
        .where(and(eq(recallNodes.mapId, map.id), sql`${recallNodes.rank} >= ${rank}`));
      await tx.insert(recallNodes).values({ ownerId, mapId: map.id, slug, rank, ...values });
    }

    const nextVersion = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      {
        cardId: existing?.id ?? null,
        cardSlug: slug,
        summary: existing ? 'card edited' : 'card added',
      },
      existing
        ? {
            title: existing.title,
            bodyMd: existing.bodyMd,
            useWhen: existing.useWhen,
            options: existing.options,
          }
        : null,
      { title, bodyMd, useWhen, options },
    );
    return {
      version: nextVersion,
      cardSlug: slug,
      warnings: warningsFor(await cardsOf(tx, map.id)),
      promptQueued: kind === 'prompt' && embedTextChanged,
    };
  });

  // After the commit, never inside it: the embedder is a network call, and a
  // write that waited on it would hold a transaction open on a hot table.
  if (result.promptQueued) {
    void embedPendingRecallPrompts(ownerId).catch((err) => {
      console.error('[recall] prompt embed failed (non-fatal):', err);
    });
  }
  const { promptQueued: _queued, ...out } = result;
  return out;
}

/**
 * Delete one card. Options pointing at it are removed in the SAME write and
 * listed back, because the alternative is a map that still offers a route to
 * something gone — the failure v1's post-hoc lint reported and did not fix.
 */
export async function deleteRecallCard(
  ownerId: string,
  mapId: string,
  cardSlug: string,
  actor: RecallActor,
  version?: number,
): Promise<RecallWriteResult> {
  return await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, version);
    const cards = await cardsOf(tx, map.id);
    const card = cards.find((c) => c.slug === cardSlug);
    if (!card) {
      throw new RecallWriteError(
        'card_not_found',
        `No card '${cardSlug}' in map '${map.slug}'. Its cards: ${cards.map((c) => c.slug).join(', ')}.`,
      );
    }
    if (card.kind === 'index') {
      throw new RecallWriteError(
        'entry_card_undeletable',
        `Card '${cardSlug}' is the entry card of map '${map.slug}' — every walk starts there, so a map cannot be without one. To retire the whole map, delete the map instead.`,
      );
    }
    await tx.delete(recallNodes).where(eq(recallNodes.id, card.id));

    const optionsDropped: { cardSlug: string; label: string }[] = [];
    for (const other of cards) {
      if (other.id === card.id) continue;
      const kept = (other.options ?? []).filter((o) => {
        const points = !o.targetMap && o.targetSlug === cardSlug;
        if (points) optionsDropped.push({ cardSlug: other.slug, label: o.label });
        return !points;
      });
      if (kept.length !== (other.options ?? []).length) {
        await tx
          .update(recallNodes)
          .set({ options: kept as never })
          .where(eq(recallNodes.id, other.id));
      }
    }

    const version2 = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      { cardId: card.id, cardSlug: card.slug, summary: 'card deleted' },
      { title: card.title, bodyMd: card.bodyMd, useWhen: card.useWhen, options: card.options },
      null,
    );
    return {
      version: version2,
      warnings: warningsFor(await cardsOf(tx, map.id)),
      ...(optionsDropped.length > 0 ? { optionsDropped } : {}),
    };
  });
}

/** Reorder a map's cards. The entry card keeps rank 0 whatever is asked: it is
 *  where a walk starts, and the list is read as an order. */
export async function reorderRecallCards(
  ownerId: string,
  mapId: string,
  slugs: string[],
  actor: RecallActor,
  version?: number,
): Promise<RecallWriteResult> {
  return await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, version);
    const cards = await cardsOf(tx, map.id);
    const known = new Set(cards.map((c) => c.slug));
    const unknown = slugs.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      throw new RecallWriteError(
        'card_not_found',
        `Map '${map.slug}' has no card(s) ${unknown.join(', ')}. Send every card's slug, in the order you want: ${cards.map((c) => c.slug).join(', ')}.`,
      );
    }
    let rank = 1;
    for (const slug of slugs) {
      const card = cards.find((c) => c.slug === slug)!;
      if (card.kind === 'index') continue;
      await tx.update(recallNodes).set({ rank: rank++ }).where(eq(recallNodes.id, card.id));
    }
    await tx
      .update(recallNodes)
      .set({ rank: 0 })
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.kind, 'index')));
    const next = await bumpMap(tx, map.id, map.version);
    await recordRevision(tx, ownerId, map.id, actor, { summary: 'cards reordered' }, null, {
      slugs,
    });
    return { version: next, warnings: warningsFor(await cardsOf(tx, map.id)) };
  });
}

/** Confirm (or drop) an agent's request that a card become a prompt. The
 *  owner's act; it is what makes the card matchable. */
export async function confirmRecallPrompt(
  ownerId: string,
  mapId: string,
  cardSlug: string,
  confirm: boolean,
  actor: RecallActor,
  version?: number,
): Promise<RecallWriteResult> {
  if (actor.kind !== 'owner') {
    throw new RecallWriteError(
      'confirm_is_owners',
      'Only the owner confirms a prompt. An agent can ask by writing the card with prompt: true.',
    );
  }
  const out = await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, version);
    const cards = await cardsOf(tx, map.id);
    const card = cards.find((c) => c.slug === cardSlug);
    if (!card) {
      throw new RecallWriteError(
        'card_not_found',
        `No card '${cardSlug}' in map '${map.slug}'. Its cards: ${cards.map((c) => c.slug).join(', ')}.`,
      );
    }
    if (confirm && !card.useWhen.trim()) {
      throw new RecallWriteError(
        'prompt_needs_use_when',
        `Card '${cardSlug}' has no 'use when' line, and that line is all recall_match compares against. Add one, then confirm.`,
      );
    }
    await tx
      .update(recallNodes)
      .set({
        kind: confirm ? 'prompt' : 'knowledge',
        promptPending: false,
        embedding: null,
      })
      .where(eq(recallNodes.id, card.id));
    const next = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      {
        cardId: card.id,
        cardSlug: card.slug,
        summary: confirm ? 'prompt confirmed' : 'prompt request dropped',
      },
      { kind: card.kind, promptPending: card.promptPending },
      { kind: confirm ? 'prompt' : 'knowledge', promptPending: false },
    );
    return { version: next, cardSlug, warnings: warningsFor(await cardsOf(tx, map.id)), confirm };
  });
  if (out.confirm) {
    void embedPendingRecallPrompts(ownerId).catch((err) => {
      console.error('[recall] prompt embed failed (non-fatal):', err);
    });
  }
  const { confirm: _c, ...rest } = out;
  return rest;
}

/** Delete a whole map: the item goes, and the cascades take the map row, its
 *  cards and its revisions (migration 0202). */
export async function deleteRecallMap(
  ownerId: string,
  mapId: string,
  actor: RecallActor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    if (actor.kind !== 'owner') {
      throw new RecallWriteError(
        'delete_is_owners',
        `Deleting map '${map.slug}' is the owner's call. An agent can empty a map's cards but not retire it.`,
      );
    }
    await tx.delete(nodes).where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, map.nodeId!)));
  });
}

/** The revisions panel: newest first. */
export async function listRecallRevisions(
  ownerId: string,
  mapId: string,
  limit = RECALL_REVISIONS_PER_MAP,
): Promise<
  {
    id: string;
    cardId: string | null;
    cardSlug: string | null;
    actorKind: 'owner' | 'agent';
    actorId: string | null;
    summary: string;
    createdAt: string;
  }[]
> {
  const rows = await db
    .select()
    .from(recallRevisions)
    .where(and(eq(recallRevisions.ownerId, ownerId), eq(recallRevisions.mapId, mapId)))
    .orderBy(desc(recallRevisions.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    cardId: r.cardId,
    cardSlug: r.cardSlug,
    actorKind: r.actorKind as 'owner' | 'agent',
    actorId: r.actorId,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Put one revision's BEFORE state back. The editor's undo.
 *
 * There are three shapes, because a revision records what changed rather than
 * a whole map:
 *  - a card edit (before = the card's content) writes that content back;
 *  - a card ADD (before = null, cardSlug set) is undone by deleting the card;
 *  - a map-level change (no cardSlug) writes the map fields back.
 *
 * A restore is itself a write: it takes the current version, records its own
 * revision, and runs every check. So restoring a card whose body is now over
 * budget, or whose options point at cards since deleted, is refused with the
 * same teaching error as any other write rather than quietly reinstating a
 * map that no longer holds together.
 *
 * The restore is always attributed to the OWNER: it is their act, even when
 * the revision being undone was an agent's.
 */
export async function restoreRecallRevision(
  ownerId: string,
  revisionId: string,
  actor: RecallActor,
): Promise<RecallWriteResult> {
  if (actor.kind !== 'owner') {
    throw new RecallWriteError(
      'restore_is_owners',
      "Restoring a revision is the owner's act. An agent can write a card directly instead.",
    );
  }
  const [rev] = await db
    .select()
    .from(recallRevisions)
    .where(and(eq(recallRevisions.ownerId, ownerId), eq(recallRevisions.id, revisionId)))
    .limit(1);
  if (!rev) {
    throw new RecallWriteError(
      'revision_not_found',
      `No revision '${revisionId}'. The log keeps the last ${RECALL_REVISIONS_PER_MAP} per map, so an older one may have been pruned.`,
    );
  }
  const [map] = await db
    .select({ version: recallMaps.version, slug: recallMaps.slug })
    .from(recallMaps)
    .where(eq(recallMaps.id, rev.mapId))
    .limit(1);
  if (!map) {
    throw new RecallWriteError(
      'map_not_found',
      'That revision belongs to a map that no longer exists.',
    );
  }

  // A card that was ADDED: undoing it means removing it again.
  if (rev.cardSlug && rev.before === null) {
    return await deleteRecallCard(ownerId, rev.mapId, rev.cardSlug, actor, map.version);
  }

  // A card edit or delete: write the old content back. A deleted card comes
  // back as a new card with its old slug, which `putRecallCard` allows because
  // the slug is free again.
  if (rev.cardSlug) {
    const before = (rev.before ?? {}) as {
      title?: string;
      bodyMd?: string;
      useWhen?: string;
      options?: RecallOptionInput[];
    };
    const exists = await db
      .select({ slug: recallNodes.slug })
      .from(recallNodes)
      .where(and(eq(recallNodes.mapId, rev.mapId), eq(recallNodes.slug, rev.cardSlug)))
      .limit(1);
    return await putRecallCard(
      ownerId,
      rev.mapId,
      exists[0] ? rev.cardSlug : null,
      {
        title: before.title ?? rev.cardSlug,
        bodyMd: before.bodyMd ?? '',
        useWhen: before.useWhen,
        options: before.options ?? [],
      },
      actor,
      map.version,
    );
  }

  // A map-level change.
  const before = (rev.before ?? {}) as {
    title?: string;
    enterWhen?: string;
    slug?: string;
    published?: boolean;
  };
  return await updateRecallMap(
    ownerId,
    rev.mapId,
    {
      ...(before.title ? { title: before.title } : {}),
      ...(before.enterWhen ? { enterWhen: before.enterWhen } : {}),
      ...(before.published !== undefined ? { published: before.published } : {}),
      version: map.version,
    },
    actor,
  );
}

/** One card with its body — what the editor opens. */
export async function getRecallCard(
  ownerId: string,
  mapId: string,
  cardSlug: string,
): Promise<CardRow | null> {
  const [row] = await db
    .select()
    .from(recallNodes)
    .where(
      and(
        eq(recallNodes.ownerId, ownerId),
        eq(recallNodes.mapId, mapId),
        eq(recallNodes.slug, cardSlug),
      ),
    )
    .limit(1);
  return row ?? null;
}
