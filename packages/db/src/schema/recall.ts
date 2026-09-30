import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { sql } from 'drizzle-orm';

import { vector } from './_shared';

/**
 * Recall's serving tables, and since v2 its SOURCE: a map is one `recall`
 * NODE in the item tree (`node_id`) and its cards are rows written here
 * directly by packages/content/src/recall-native.ts, checked in the same
 * transaction, so every agent-facing read is one indexed row with no compile
 * step, no ProseMirror parsing and no LLM on the hot path.
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 *
 * History: until R5 (2026-09-30) these rows could also be a BUILD ARTIFACT
 * compiled from a `recall`-tagged page tree (a "page-built" or v1 map, with
 * node_id NULL and the root page's id as the map id). R5 removed that
 * compiler; migration 0209 deleted the remaining rows. `last_compile_ok` and
 * `last_compile_report` stay, unused, so the release before R5 still runs on
 * this table after a rollback; a later migration drops them.
 */

export const recallMaps = pgTable(
  'recall_maps',
  {
    /** The map's id, which equals `node_id`. */
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    /** Stable entry name agents use: `recall_open('mantle-registry')`. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** One line for the catalog — when an agent should enter this map. */
    enterWhen: text('enter_when').default('').notNull(),
    /** Card count, recounted on every write. 0 = no cards; the catalog hides it. */
    nodeCount: integer('node_count').default(0).notNull(),
    /** UNUSED since R5: the v1 compile outcome. Kept (and declared, so the
     *  schema drift test still matches the table) only so the release before
     *  R5 runs after a rollback. Nothing reads or writes them; drop both in a
     *  later migration. */
    lastCompileOk: boolean('last_compile_ok').default(true).notNull(),
    lastCompileReport: jsonb('last_compile_report').$type<unknown[]>(),
    /** The map's `recall` node — the item in the tree. Nullable only because
     *  page-built rows had none; every serving query requires it. FK to
     *  nodes(id) ON DELETE CASCADE lives in the SQL migration, so deleting the
     *  item takes the map row and (via recall_nodes.map_id) its cards. */
    nodeId: uuid('node_id'),
    /** v2: false while a map an AGENT created waits for the owner to publish
     *  it. recall_index / recall_open / recall_match skip unpublished maps.
     *  Every existing row defaults true and keeps serving. */
    published: boolean('published').default(true).notNull(),
    /** v2: optimistic-concurrency token. Bumped on every native write; the
     *  editor and the write tools carry it and a stale one is refused. */
    version: integer('version').default(0).notNull(),
    /** v2: slugs this map answered to before a rename, so a remembered slug
     *  keeps resolving (the mantle-recall skill hard-codes one). */
    formerSlugs: text('former_slugs').array().default([]).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('recall_maps_owner_slug_uq').on(t.ownerId, t.slug),
    uniqueIndex('recall_maps_node_uq').on(t.nodeId),
  ],
);

export const recallNodes = pgTable(
  'recall_nodes',
  {
    /** The card's own id, minted here — a card is not a page. */
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** The map this card belongs to. */
    mapId: uuid('map_id').notNull(),
    slug: text('slug').notNull(),
    /** 'index' (the entry card), 'knowledge', or 'prompt' (embedded for match). */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** Markdown body. Budgeted on the write (chars, not tokens — the repo's
     *  size-budget convention). */
    bodyMd: text('body_md').default('').notNull(),
    bodyChars: integer('body_chars').default(0).notNull(),
    /** Prompts: the matcher line recall_match shows before a caller commits
     *  context to the body. */
    useWhen: text('use_when').default('').notNull(),
    /** Options: [{label, useWhen, targetSlug}]. Affordances, never commands.
     *
     *  v2 adds `targetId` (the target card's id, so an edge survives a slug
     *  change) and `targetMap` (another map's slug, for a cross-map option to
     *  that map's entry card). `targetSlug` stays and is rewritten in the same
     *  transaction when a slug changes, so the read path is still one row with
     *  no join. */
    options: jsonb('options').$type<
      {
        label: string;
        useWhen: string;
        targetSlug: string;
        targetId?: string;
        targetMap?: string;
      }[]
    >(),
    /** Prompts only; NULL elsewhere and while an embed is pending (the
     *  matcher skips NULLs, so a fresh prompt serves by slug immediately and
     *  becomes matchable seconds later). The partial HNSW index lives in the
     *  SQL migration only, per repo convention — HNSW rather than ivfflat
     *  because this table is born empty (see 0153, and 0060 which retired
     *  ivfflat everywhere). */
    embedding: vector(768)('embedding'),
    /** The map `version` the card was written at. */
    sourceVersion: integer('source_version').default(0).notNull(),
    /** v2: card order in the editor (drag to reorder). */
    rank: integer('rank').default(0).notNull(),
    /** v2: an agent asked for prompt status and the owner has not confirmed.
     *  A pending card is not embedded and never matches. */
    promptPending: boolean('prompt_pending').default(false).notNull(),
    /** v2: slugs this card answered to before an explicit slug change (a
     *  retitle never moves a slug). recall_go and the card GET still find it. */
    formerSlugs: text('former_slugs').array().default([]).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('recall_nodes_map_slug_uq').on(t.mapId, t.slug),
    index('recall_nodes_owner_kind_idx').on(t.ownerId, t.kind),
  ],
);

/**
 * v2: one row per native write, kept to the last 50 per map. Backs undo in
 * the editor and the audit of AGENT edits, which matters because v2 serves an
 * agent's card edit immediately (there is no compile gate to hold it back).
 *
 * Not the flight recorder (v1 S3, still unbuilt) and not a walk log: this
 * records what CHANGED, never who read what.
 */
export const recallRevisions = pgTable(
  'recall_revisions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** FK to recall_maps(id) ON DELETE CASCADE, in the SQL migration. */
    mapId: uuid('map_id').notNull(),
    /** NULL when the write was the map's own (title, enter-when, publish,
     *  folder) rather than one card's. */
    cardId: uuid('card_id'),
    /** 'owner' (the UI) or 'agent' (a recall-write tool). CHECK in SQL. */
    actorKind: text('actor_kind').notNull(),
    actorId: uuid('actor_id'),
    /** The actor's name when the write happened: the agent's slug, 'mcp' for
     *  an external MCP client, or the admin's display name. Stored rather than
     *  joined, so the log still names an agent or admin that is gone (0206). */
    actorName: text('actor_name'),
    /** The card's slug at the time, so the panel can name a deleted card. */
    cardSlug: text('card_slug'),
    /** One line for the panel. Its own column so `before`/`after` stay pure
     *  snapshots — restore writes `before` back exactly as it was. */
    summary: text('summary').default('changed').notNull(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('recall_revisions_map_time_idx').on(t.mapId, t.createdAt)],
);

export type RecallMap = typeof recallMaps.$inferSelect;
export type RecallNode = typeof recallNodes.$inferSelect;
export type RecallRevision = typeof recallRevisions.$inferSelect;

export const RECALL_NODE_KINDS = ['index', 'knowledge', 'prompt'] as const;

/** v2: who wrote a revision. */
export const RECALL_ACTOR_KINDS = ['owner', 'agent'] as const;

/** v2: revisions kept per map; the write path prunes beyond this. */
export const RECALL_REVISIONS_PER_MAP = 50;
