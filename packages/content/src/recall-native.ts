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
 * Concurrency: every write locks the map row (`mapOr404`) before it compares
 * the caller's `version`, so two writes sent from the same version cannot both
 * pass the check. Without the lock both read version N under read committed,
 * both pass, and the second silently overwrites the first (audit 2026-09-30,
 * H1: 12 races out of 12 lost an update).
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 */

import { randomUUID } from 'node:crypto';

import { and, arrayContains, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';

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
  /** Display name, agent slug, or 'mcp' for an external MCP client. Stored on
   *  the revision, so the log still names an actor that is gone. */
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

/**
 * One card write. `title` and `bodyMd` always replace. The other fields are
 * STICKY on a replace: left out, they keep what the card has. That is what
 * lets an agent fix a typo without knowing (or being allowed to set) the
 * card's prompt state, and what stops a caller that did not send `options`
 * from wiping every edge out of the card. Sent, they replace.
 */
export type RecallCardInput = {
  title: string;
  bodyMd: string;
  useWhen?: string;
  /** From the owner: true makes a prompt, false makes knowledge. From an
   *  agent: true records a request (`promptPending`), false withdraws one; an
   *  agent can never turn a confirmed prompt back into knowledge. */
  prompt?: boolean;
  options?: RecallOptionInput[];
  /** Slug of the card to place a NEW card after. Ignored on replace. */
  after?: string;
  /** An explicit slug change on an EXISTING card (owner only). The old slug
   *  keeps resolving in recall_go, and options in this map follow it. */
  slug?: string;
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
type StoredOption = NonNullable<CardRow['options']>[number];

/** An option another card had to a card, kept on the card's delete revision
 *  so a restore can put the edge back. */
type InboundOption = { cardSlug: string; option: StoredOption };

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

/** Every slug a set of cards answers to, current and former: a new card must
 *  not take a slug an agent still remembers for another card. */
function cardSlugsTaken(cards: Pick<CardRow, 'slug' | 'formerSlugs'>[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    out.add(c.slug);
    for (const s of c.formerSlugs ?? []) out.add(s);
  }
  return out;
}

/**
 * The map row, LOCKED for the rest of the transaction, or a teaching miss.
 *
 * The lock is what makes the version check mean something: a second write
 * from the same version waits here until the first commits, then reads the
 * bumped version and is refused as stale.
 */
async function mapOr404(tx: Tx, ownerId: string, mapId: string) {
  const [map] = await tx
    .select()
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), eq(recallMaps.id, mapId)))
    .limit(1)
    .for('update');
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
): Promise<StoredOption[]> {
  const bySlug = new Map(cards.map((c) => [c.slug, c.id]));
  const out: StoredOption[] = [];
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
      out.push({
        label: o.label,
        useWhen: o.useWhen,
        targetSlug: o.targetMap,
        targetMap: o.targetMap,
      });
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
    out.push({ label: o.label, useWhen: o.useWhen, targetSlug: o.targetSlug, targetId: id });
  }
  return out;
}

/**
 * Advisory findings, returned with the write and shown in the editor. Never
 * blocking: an orphan card is a normal state while a map is being built, and
 * refusing it would mean you could not add card two before linking it.
 *
 * A cross-map option whose target map has since been unpublished, re-slugged
 * away or deleted is reported here too: the serving tools already hide it from
 * agents, and this is where the owner learns it needs repointing.
 */
async function warningsFor(tx: Tx, ownerId: string, cards: CardRow[]): Promise<RecallWarning[]> {
  const out: RecallWarning[] = [];
  const reached = new Set<string>();
  const crossMaps = new Set<string>();
  for (const c of cards) {
    for (const o of c.options ?? []) {
      if (o.targetMap) crossMaps.add(o.targetMap);
      else reached.add(o.targetSlug);
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
  if (crossMaps.size > 0) {
    const live = new Set(
      (
        await tx
          .select({ slug: recallMaps.slug })
          .from(recallMaps)
          .where(
            and(
              eq(recallMaps.ownerId, ownerId),
              eq(recallMaps.published, true),
              inArray(recallMaps.slug, [...crossMaps]),
            ),
          )
      ).map((r) => r.slug),
    );
    for (const c of cards) {
      for (const o of c.options ?? []) {
        if (o.targetMap && !live.has(o.targetMap)) {
          out.push({
            code: 'cross_map_target_gone',
            cardSlug: c.slug,
            message: `Option '${o.label}' on '${c.slug}' leads to map '${o.targetMap}', which is no longer a published map, so agents do not see it. Point it at another map or remove it.`,
          });
        }
      }
    }
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
    actorName: actor.name ?? null,
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

/** The slugs other maps answer to, current and former. A slug a map used to
 *  have is still what some agent or skill remembers, so no other map may take
 *  it: that would silently send the remembered slug somewhere else. */
async function mapSlugsTaken(tx: Tx, ownerId: string, exceptMapId?: string): Promise<Set<string>> {
  const rows = await tx
    .select({ id: recallMaps.id, slug: recallMaps.slug, formerSlugs: recallMaps.formerSlugs })
    .from(recallMaps)
    .where(eq(recallMaps.ownerId, ownerId));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.id === exceptMapId) continue;
    out.add(r.slug);
    for (const s of r.formerSlugs ?? []) out.add(s);
  }
  return out;
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
    // Two creates with the same title at once would both pick the same free
    // slug and the second would die on the unique index as a raw 500. One
    // owner-scoped lock makes the slug pick and the insert one step.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`recall-map-create:${ownerId}`}))`,
    );
    const slug = uniqueSlug(recallNativeSlug(title), await mapSlugsTaken(tx, ownerId));
    const published = actor.kind === 'owner';
    const [item] = await tx
      .insert(nodes)
      .values({ ownerId, type: 'recall', title, slug, path, data: { enterWhen, published } })
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
 *  Each crumb is a DIRECT child of the one before it. The folders must already
 *  exist: this is Recall's write path, not the tree's. */
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
          sql`${nodes.path} <@ ${path}::ltree`,
          sql`nlevel(${nodes.path}) = nlevel(${path}::ltree) + 1`,
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
    const title = patch.title?.trim();
    if (title && title !== map.title) set.title = title;
    const enterWhen = patch.enterWhen?.trim();
    if (enterWhen && enterWhen !== map.enterWhen) set.enterWhen = enterWhen;
    if (patch.published !== undefined && patch.published !== map.published) {
      set.published = patch.published;
    }

    // A rename does NOT move the slug: agents and skills remember slugs, and
    // a title is the thing an owner most often tidies. Changing the slug is a
    // separate, explicit act, and the old one keeps resolving. Compared AFTER
    // normalising, so "Fleet Ops" sent to a map already at fleet-ops is no
    // change rather than a former slug equal to the current one.
    const next = patch.slug !== undefined ? recallNativeSlug(patch.slug) : undefined;
    if (next !== undefined && next !== map.slug) {
      if (actor.kind !== 'owner') {
        throw new RecallWriteError(
          'slug_is_owners',
          `Changing map '${map.slug}''s slug is the owner's call: agents and skills remember it.`,
        );
      }
      if ((await mapSlugsTaken(tx, ownerId, map.id)).has(next)) {
        throw new RecallWriteError(
          'slug_taken',
          `Another map answers to '${next}', now or as a former slug that agents may still remember. Pick a different slug.`,
        );
      }
      set.slug = next;
      // A map renamed back to an old slug takes it off its own former list.
      set.formerSlugs = [...new Set([...map.formerSlugs, map.slug])].filter((s) => s !== next);
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
    // Nothing changed: no version bump and no "no change" revision to clutter
    // the log (or to be offered as a restore that does nothing).
    if (Object.keys(set).length === 0) {
      return {
        version: map.version,
        warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)),
      };
    }
    await tx.update(recallMaps).set(set).where(eq(recallMaps.id, map.id));
    // The item carries the title, the enter-when line and the published flag
    // for the tree (a draft pill on an unpublished map). `data` is MERGED, not
    // replaced: an enter-when edit must not wipe the flag, or the reverse.
    const itemSet: Record<string, unknown> = {};
    if (set.title) itemSet.title = set.title;
    if (set.slug) itemSet.slug = set.slug;
    const itemData: Record<string, unknown> = {};
    if (set.enterWhen) itemData.enterWhen = set.enterWhen;
    if (set.published !== undefined) itemData.published = set.published;
    if (Object.keys(itemData).length > 0) {
      itemSet.data = sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify(itemData)}::jsonb`;
    }
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
    return { version, warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)) };
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
 * Create or replace one card. `title` and `bodyMd` replace; `useWhen`,
 * `options` and `prompt` are sticky (see RecallCardInput). `options`, when
 * sent, replaces the card's whole list, so a caller edits by read-modify-write.
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
  return await writeCard(ownerId, mapId, cardSlug, input, actor, version);
}

/**
 * A card's prompt state: what `kind` and `promptPending` were. Card revisions
 * carry it in `before`, so a restore puts a prompt back as a prompt and a
 * pending request back as pending, instead of reading the owner's restore as
 * "make this knowledge".
 */
type PromptState = { kind: 'prompt' | 'knowledge'; promptPending: boolean };

/** The kind a card had, as a restore should put it back. The entry card's kind
 *  is not a prompt state: it is kept by the write whatever is asked. */
function promptStateOf(card: { kind: string; promptPending: boolean }): PromptState {
  return {
    kind: card.kind === 'prompt' ? 'prompt' : 'knowledge',
    promptPending: card.promptPending,
  };
}

/**
 * What a card's kind and pending flag become after a write.
 *
 * Absent `prompt` keeps the card's state: that is the fix for a typo edit
 * demoting a prompt (audit H2). An owner's explicit true or false decides. An
 * agent's true is a request, its false withdraws its request, and neither can
 * turn a confirmed prompt back into knowledge: that is the owner's voice.
 */
function nextPromptState(
  existing: CardRow | undefined,
  prompt: boolean | undefined,
  actor: RecallActor,
): { kind: 'index' | 'prompt' | 'knowledge'; promptPending: boolean; keptPrompt: boolean } {
  if (existing?.kind === 'index') return { kind: 'index', promptPending: false, keptPrompt: false };
  const current: PromptState = existing
    ? promptStateOf(existing)
    : { kind: 'knowledge', promptPending: false };
  if (prompt === undefined) return { ...current, keptPrompt: false };
  if (actor.kind === 'owner') {
    return { kind: prompt ? 'prompt' : 'knowledge', promptPending: false, keptPrompt: false };
  }
  if (current.kind === 'prompt') {
    return { kind: 'prompt', promptPending: false, keptPrompt: prompt === false };
  }
  return { kind: 'knowledge', promptPending: prompt, keptPrompt: false };
}

/** Where a restored card goes back: its old slug, its old rank, and the
 *  options other cards had to it. Only a restore sends this. */
type Placement = { slug: string; rank: number | null; inbound: InboundOption[] };

/**
 * `putRecallCard`'s body. `restore` is the prompt state to put back, and only
 * a restore sends it: it wins over the actor rule, because the owner is
 * reinstating a state that rule already produced once (a pending request an
 * agent made stays pending, rather than being confirmed by the owner's undo).
 * `placement` is a deleted card's old slug, rank and inbound edges.
 */
async function writeCard(
  ownerId: string,
  mapId: string,
  cardSlug: string | null,
  input: RecallCardInput,
  actor: RecallActor,
  version: number | undefined,
  restore?: PromptState,
  placement?: Placement,
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

    const useWhen = input.useWhen === undefined ? (existing?.useWhen ?? '') : input.useWhen.trim();
    const state = restore
      ? {
          kind: existing?.kind === 'index' ? ('index' as const) : restore.kind,
          promptPending: existing?.kind === 'index' ? false : restore.promptPending,
          keptPrompt: false,
        }
      : nextPromptState(existing, input.prompt, actor);
    const { kind, promptPending } = state;
    if ((kind === 'prompt' || promptPending) && !useWhen) {
      throw new RecallWriteError(
        'prompt_needs_use_when',
        `Card '${title}' ${kind === 'prompt' ? 'is' : 'asks to be'} a prompt but has no 'use when' line. That line is the only thing recall_match compares against, so a prompt without one can never be found. Add one sentence describing the task it fits.`,
      );
    }

    // An explicit slug change on an existing card: the owner's act, like the
    // map's. The old slug goes onto former_slugs and keeps resolving.
    let slug: string;
    let formerSlugs: string[] | undefined;
    if (existing) {
      slug = existing.slug;
      const wanted = input.slug !== undefined ? recallNativeSlug(input.slug) : undefined;
      if (wanted !== undefined && wanted !== existing.slug) {
        if (actor.kind !== 'owner') {
          throw new RecallWriteError(
            'slug_is_owners',
            `Changing card '${existing.slug}''s slug is the owner's call: agents remember it.`,
          );
        }
        const others = cardSlugsTaken(cards.filter((c) => c.id !== existing.id));
        if (others.has(wanted)) {
          throw new RecallWriteError(
            'slug_taken',
            `Another card in map '${map.slug}' answers to '${wanted}', now or as a former slug. Pick a different slug.`,
          );
        }
        slug = wanted;
        formerSlugs = [...new Set([...existing.formerSlugs, existing.slug])].filter(
          (s) => s !== wanted,
        );
      }
    } else {
      const taken = cardSlugsTaken(cards);
      slug =
        placement && !taken.has(placement.slug)
          ? placement.slug
          : uniqueSlug(recallNativeSlug(title), taken);
    }
    // A new card's id is minted here rather than by the insert, so an option
    // on the card that points at itself carries a real id.
    const cardId = existing?.id ?? randomUUID();

    // Resolve options against the card set INCLUDING a card being created (or
    // renamed), so a self-referencing or freshly-split card links in one write.
    // Left out on a replace, the card keeps the options it has, untouched.
    const options =
      input.options === undefined && existing
        ? (existing.options ?? [])
        : await resolveOptions(
            tx,
            ownerId,
            [
              ...cards.filter((c) => c.id !== cardId).map((c) => ({ id: c.id, slug: c.slug })),
              { id: cardId, slug },
            ],
            input.options ?? [],
            title,
          );

    // A prompt's vector is dropped when the text it was built from changed, so
    // `embedPendingRecallPrompts` refills it after the commit. NULL means
    // "servable by slug now, matchable in seconds", which is v1's posture and
    // the reason a write never waits on an embedder.
    // A card that only BECOMES a prompt needs a vector too: as knowledge it
    // had none, and an unchanged text would otherwise leave it unmatchable.
    const embedTextChanged =
      !existing ||
      existing.title !== title ||
      existing.useWhen !== useWhen ||
      existing.bodyMd !== bodyMd;
    const needsVector = kind === 'prompt' && (embedTextChanged || existing?.kind !== 'prompt');

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
      ...(needsVector ? { embedding: null } : {}),
      // A card that stops being a prompt must not keep a vector, or it would
      // go on matching from the partial index after the owner demoted it.
      ...(kind !== 'prompt' ? { embedding: null } : {}),
      ...(formerSlugs ? { slug, formerSlugs } : {}),
    };

    if (existing) {
      await tx.update(recallNodes).set(values).where(eq(recallNodes.id, existing.id));
      if (formerSlugs) {
        // Same-map options that led to the old slug follow the card.
        for (const other of cards) {
          if (other.id === existing.id) continue;
          let changed = false;
          const next = (other.options ?? []).map((o) => {
            if (!o.targetMap && (o.targetId === existing.id || o.targetSlug === existing.slug)) {
              changed = true;
              return { ...o, targetSlug: slug, targetId: existing.id };
            }
            return o;
          });
          if (changed) {
            await tx
              .update(recallNodes)
              .set({ options: next as never })
              .where(eq(recallNodes.id, other.id));
          }
        }
      }
    } else {
      let rank: number;
      if (placement && placement.rank !== null) {
        rank = Math.max(1, placement.rank);
      } else if (input.after !== undefined) {
        const after = cards.find((c) => c.slug === input.after);
        if (!after) {
          throw new RecallWriteError(
            'after_not_found',
            `There is no card '${input.after}' to place '${title}' after. This map's cards: ${cards.map((c) => c.slug).join(', ')}. Leave 'after' off to add it at the end.`,
          );
        }
        rank = after.rank + 1;
      } else {
        rank = (cards.at(-1)?.rank ?? 0) + 1;
      }
      // Make room, so `after` means after and ranks stay dense.
      await tx
        .update(recallNodes)
        .set({ rank: sql`${recallNodes.rank} + 1` })
        .where(and(eq(recallNodes.mapId, map.id), sql`${recallNodes.rank} >= ${rank}`));
      await tx
        .insert(recallNodes)
        .values({ id: cardId, ownerId, mapId: map.id, slug, rank, ...values });
      // A restored card gets back the edges other cards had to it, where
      // those cards still exist and do not already lead there.
      for (const edge of placement?.inbound ?? []) {
        const from = cards.find((c) => c.slug === edge.cardSlug);
        if (!from) continue;
        const has = (from.options ?? []).some((o) => !o.targetMap && o.targetSlug === slug);
        if (has) continue;
        await tx
          .update(recallNodes)
          .set({
            options: [
              ...(from.options ?? []),
              { ...edge.option, targetSlug: slug, targetId: cardId },
            ] as never,
          })
          .where(eq(recallNodes.id, from.id));
      }
    }

    const nextVersion = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      {
        cardId,
        cardSlug: slug,
        summary: existing ? 'card edited' : 'card added',
      },
      existing
        ? {
            title: existing.title,
            bodyMd: existing.bodyMd,
            useWhen: existing.useWhen,
            options: existing.options,
            ...promptStateOf(existing),
            // Only a write that MOVED the slug records the old one, so undoing
            // an ordinary edit never re-slugs the card.
            ...(formerSlugs ? { slug: existing.slug } : {}),
          }
        : null,
      {
        title,
        bodyMd,
        useWhen,
        options,
        ...promptStateOf({ kind, promptPending }),
        ...(formerSlugs ? { slug } : {}),
      },
    );
    const warnings = await warningsFor(tx, ownerId, await cardsOf(tx, map.id));
    if (state.keptPrompt) {
      warnings.push({
        code: 'prompt_kept',
        cardSlug: slug,
        message: `Card '${slug}' stays a prompt: only the owner can turn a prompt back into knowledge.`,
      });
    }
    return {
      version: nextVersion,
      cardSlug: slug,
      warnings,
      promptQueued: needsVector,
    };
  });

  // After the commit, never inside it: the embedder is a network call, and a
  // write that waited on it would hold a transaction open on a hot table.
  if (result.promptQueued) queueEmbed(ownerId);
  const { promptQueued: _queued, ...out } = result;
  return out;
}

/** Fire the prompt embed after a commit. Never awaited: a write does not wait
 *  on an embedder, and recall_match refills anything this one misses. */
function queueEmbed(ownerId: string): void {
  void embedPendingRecallPrompts(ownerId).catch((err) => {
    console.error('[recall] prompt embed failed (non-fatal):', err);
  });
}

/**
 * Delete one card. Options pointing at it are removed in the SAME write and
 * listed back, because the alternative is a map that still offers a route to
 * something gone — the failure v1's post-hoc lint reported and did not fix.
 * The revision keeps those edges and the card's rank, so a restore puts the
 * card back where it was, linked as it was.
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
    const inbound: InboundOption[] = [];
    for (const other of cards) {
      if (other.id === card.id) continue;
      const kept = (other.options ?? []).filter((o) => {
        const points = !o.targetMap && o.targetSlug === cardSlug;
        if (points) {
          optionsDropped.push({ cardSlug: other.slug, label: o.label });
          inbound.push({ cardSlug: other.slug, option: o });
        }
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
      {
        title: card.title,
        bodyMd: card.bodyMd,
        useWhen: card.useWhen,
        options: card.options,
        ...promptStateOf(card),
        rank: card.rank,
        inbound,
      },
      null,
    );
    return {
      version: version2,
      warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)),
      ...(optionsDropped.length > 0 ? { optionsDropped } : {}),
    };
  });
}

/** Reorder a map's cards. `slugs` must name every card exactly once (the entry
 *  card may be left out): a partial list would leave two cards on one rank.
 *  The entry card keeps rank 0 whatever is asked: it is where a walk starts,
 *  and the list is read as an order. */
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
    const body = cards.filter((c) => c.kind !== 'index');
    const sent = slugs.filter((s) => cards.find((c) => c.slug === s)?.kind !== 'index');
    const missing = body.filter((c) => !sent.includes(c.slug)).map((c) => c.slug);
    if (missing.length > 0 || new Set(sent).size !== sent.length) {
      throw new RecallWriteError(
        'reorder_incomplete',
        `A reorder must list every card exactly once${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ' (one is listed twice)'}. This map's cards, in their order now: ${cards.map((c) => c.slug).join(', ')}.`,
      );
    }
    const beforeOrder = body.map((c) => c.slug);
    if (sent.every((s, i) => s === beforeOrder[i])) {
      return {
        version: map.version,
        warnings: await warningsFor(tx, ownerId, cards),
      };
    }
    let rank = 1;
    for (const slug of sent) {
      const card = cards.find((c) => c.slug === slug)!;
      await tx.update(recallNodes).set({ rank: rank++ }).where(eq(recallNodes.id, card.id));
    }
    await tx
      .update(recallNodes)
      .set({ rank: 0 })
      .where(and(eq(recallNodes.mapId, map.id), eq(recallNodes.kind, 'index')));
    const next = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      { summary: 'cards reordered' },
      { slugs: beforeOrder },
      { slugs: sent },
    );
    return { version: next, warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)) };
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
    // Confirming (or dropping) would rewrite the entry card's kind, and a map
    // without an index card has nowhere for recall_open to start.
    if (card.kind === 'index') {
      throw new RecallWriteError(
        'entry_card_not_prompt',
        `Card '${cardSlug}' is the entry card of map '${map.slug}'. It is where every walk starts, so it cannot be a prompt. Put the prompt on its own card and add an option to it.`,
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
    return {
      version: next,
      cardSlug,
      warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)),
      confirm,
    };
  });
  if (out.confirm) queueEmbed(ownerId);
  const { confirm: _c, ...rest } = out;
  return rest;
}

/** Delete a whole map: the item goes, and the cascades take the map row, its
 *  cards and its revisions (migration 0203). */
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
    actorName: string | null;
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
    actorName: r.actorName,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** A revision that has no before state to put back. */
function notRestorable(message: string): RecallWriteError {
  return new RecallWriteError('revision_not_restorable', message);
}

/**
 * Put one revision's BEFORE state back. The editor's undo.
 *
 * The shapes, because a revision records what changed rather than a whole map:
 *  - a card edit (before = the card's content and prompt state, plus its old
 *    slug when that write moved it) writes that content back;
 *  - a card delete (before = the content, rank and the options other cards had
 *    to it) brings the card back under its old slug, at its old place, with
 *    those edges;
 *  - a prompt confirm or drop (before = only kind and promptPending) puts back
 *    only that state and leaves the card's content alone;
 *  - a card ADD (before = null, cardSlug set) is undone by deleting the card;
 *  - a reorder (before = the old order) puts the old order back;
 *  - a map-level change (no cardSlug) writes the map fields back, slug too;
 *  - a map CREATE has nothing to put back: deleting the map is the undo.
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

  if (rev.summary === 'map created') {
    throw notRestorable(
      'This revision created the map, so there is nothing before it to put back. To remove the map, delete it.',
    );
  }

  if (rev.summary === 'cards reordered') {
    const before = rev.before as { slugs?: string[] } | null;
    if (!before?.slugs) {
      throw notRestorable(
        'This reorder was logged before undo of reorders existed, so its old order was not kept. Drag the cards back by hand.',
      );
    }
    const current = await db
      .select({ slug: recallNodes.slug, kind: recallNodes.kind })
      .from(recallNodes)
      .where(eq(recallNodes.mapId, rev.mapId))
      .orderBy(asc(recallNodes.rank), asc(recallNodes.slug));
    const now = current.filter((c) => c.kind !== 'index').map((c) => c.slug);
    // The old order for cards that still exist, then any added since, in the
    // order they have now.
    const order = [
      ...before.slugs.filter((s) => now.includes(s)),
      ...now.filter((s) => !before.slugs!.includes(s)),
    ];
    return await reorderRecallCards(ownerId, rev.mapId, order, actor, map.version);
  }

  // A card that was ADDED: undoing it means removing it again.
  if (rev.cardSlug && rev.before === null) {
    return await deleteRecallCard(ownerId, rev.mapId, rev.cardSlug, actor, map.version);
  }

  // A card edit or delete: write the old content back. A deleted card comes
  // back under its old slug when it is free, at its old rank, with the edges
  // other cards had to it (revisions written before 2026-09-30 kept neither,
  // so such a card comes back at the end without them).
  if (rev.cardSlug) {
    const before = (rev.before ?? {}) as {
      title?: string;
      bodyMd?: string;
      useWhen?: string;
      options?: RecallOptionInput[];
      kind?: string;
      promptPending?: boolean;
      slug?: string;
      rank?: number;
      inbound?: InboundOption[];
    };
    const stored: PromptState | undefined =
      before.kind === undefined
        ? undefined
        : promptStateOf({ kind: before.kind, promptPending: Boolean(before.promptPending) });

    // A prompt confirm or drop recorded only the prompt state. Writing that
    // back as a whole card would blank it (title = the slug, no body, no
    // options), so only the state goes back.
    // The card as it is now. By id: a later write may have moved its slug, and
    // a NEW card may since have taken the old slug, which a slug match would
    // then overwrite. Only a revision without a card id falls back to the slug.
    const [current] = await db
      .select({
        slug: recallNodes.slug,
        kind: recallNodes.kind,
        promptPending: recallNodes.promptPending,
      })
      .from(recallNodes)
      .where(
        and(
          eq(recallNodes.mapId, rev.mapId),
          rev.cardId ? eq(recallNodes.id, rev.cardId) : eq(recallNodes.slug, rev.cardSlug),
        ),
      )
      .limit(1);

    if (before.title === undefined && stored) {
      return await restorePromptState(
        ownerId,
        rev.mapId,
        current?.slug ?? rev.cardSlug,
        stored,
        actor,
        map.version,
      );
    }
    const oldSlug = before.slug ?? rev.cardSlug;
    return await writeCard(
      ownerId,
      rev.mapId,
      current ? current.slug : null,
      {
        title: before.title ?? rev.cardSlug,
        bodyMd: before.bodyMd ?? '',
        useWhen: before.useWhen ?? '',
        options: before.options ?? [],
        ...(current && before.slug && before.slug !== current.slug ? { slug: before.slug } : {}),
      },
      actor,
      map.version,
      // A revision written before `before` carried the kind has none: keep the
      // card's current state rather than demote it, since a guess is worse.
      stored ?? (current ? promptStateOf(current) : undefined),
      current
        ? undefined
        : { slug: oldSlug, rank: before.rank ?? null, inbound: before.inbound ?? [] },
    );
  }

  // A map-level change. Only the fields THAT write changed go back (its
  // `after` holds exactly those): `before` snapshots every field, and writing
  // them all back would also undo later, unrelated changes, such as
  // unpublishing a map when the owner only meant to undo a rename.
  const before = (rev.before ?? {}) as {
    title?: string;
    enterWhen?: string;
    slug?: string;
    published?: boolean;
  };
  const changed = (rev.after ?? {}) as Record<string, unknown>;
  return await updateRecallMap(
    ownerId,
    rev.mapId,
    {
      ...('title' in changed && before.title ? { title: before.title } : {}),
      ...('enterWhen' in changed && before.enterWhen ? { enterWhen: before.enterWhen } : {}),
      ...('slug' in changed && before.slug ? { slug: before.slug } : {}),
      ...('published' in changed && before.published !== undefined
        ? { published: before.published }
        : {}),
      version: map.version,
    },
    actor,
  );
}

/**
 * Put a card's prompt state back (the restore of a prompt confirm or drop).
 * The content is not touched. A card going back to being a prompt needs a
 * fresh vector, queued after the commit like any other prompt write.
 */
async function restorePromptState(
  ownerId: string,
  mapId: string,
  cardSlug: string,
  state: PromptState,
  actor: RecallActor,
  version: number,
): Promise<RecallWriteResult> {
  const out = await db.transaction(async (tx) => {
    const map = await mapOr404(tx, ownerId, mapId);
    assertVersion(map, version);
    const cards = await cardsOf(tx, map.id);
    const card = cards.find((c) => c.slug === cardSlug);
    if (!card) {
      throw new RecallWriteError(
        'card_not_found',
        `Card '${cardSlug}' was deleted after this revision, so there is no prompt state to put back. Restore its 'card deleted' revision first, then this one.`,
      );
    }
    if (card.kind === 'index') {
      throw new RecallWriteError(
        'entry_card_not_prompt',
        `Card '${cardSlug}' is the entry card of map '${map.slug}'. It is where every walk starts, so it cannot become a prompt or knowledge.`,
      );
    }
    if (state.kind === 'prompt' && !card.useWhen.trim()) {
      throw new RecallWriteError(
        'prompt_needs_use_when',
        `Card '${cardSlug}' has no 'use when' line now, and that line is all recall_match compares against. Add one, then restore.`,
      );
    }
    const becamePrompt = state.kind === 'prompt' && card.kind !== 'prompt';
    await tx
      .update(recallNodes)
      .set({
        kind: state.kind,
        promptPending: state.promptPending,
        // Keep a prompt's vector only while it stays a prompt; see putRecallCard.
        ...(state.kind === 'prompt' && !becamePrompt ? {} : { embedding: null }),
      })
      .where(eq(recallNodes.id, card.id));
    const next = await bumpMap(tx, map.id, map.version);
    await recordRevision(
      tx,
      ownerId,
      map.id,
      actor,
      { cardId: card.id, cardSlug: card.slug, summary: 'prompt state restored' },
      promptStateOf(card),
      state,
    );
    return {
      version: next,
      cardSlug,
      warnings: await warningsFor(tx, ownerId, await cardsOf(tx, map.id)),
      becamePrompt,
    };
  });
  if (out.becamePrompt) queueEmbed(ownerId);
  const { becamePrompt: _b, ...rest } = out;
  return rest;
}

/** One card with its body: what the editor opens. A slug the card answered
 *  to before an explicit slug change still finds it. */
export async function getRecallCard(
  ownerId: string,
  mapId: string,
  cardSlug: string,
): Promise<CardRow | null> {
  const mine = and(eq(recallNodes.ownerId, ownerId), eq(recallNodes.mapId, mapId));
  const [row] = await db
    .select()
    .from(recallNodes)
    .where(and(mine, eq(recallNodes.slug, cardSlug)))
    .limit(1);
  if (row) return row;
  const [former] = await db
    .select()
    .from(recallNodes)
    .where(and(mine, arrayContains(recallNodes.formerSlugs, [cardSlug])))
    .limit(1);
  return former ?? null;
}
