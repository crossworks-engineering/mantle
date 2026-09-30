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
 * Recall's SERVING layer — the compiled artifact behind the memory-map
 * system (design: "Recall — architecture plan v1" on the dev brain; roadmap
 * task 97cf7850). Pages are the AUTHORING layer: a page tree whose root
 * carries the `recall` tag is a map, a page tagged `prompt` is a prompt.
 * `commitPage` compiles that tree into these rows so every agent-facing read
 * is one indexed row — no ProseMirror parsing, no joins, no LLM on the hot
 * path.
 *
 * Rows are a BUILD ARTIFACT, never edited directly (the `app_build`
 * source→artifact pattern applied to knowledge). The compiler owns them:
 * it upserts on commit, deletes on untag/delete, and refuses to overwrite a
 * map with a lint-broken rev — the last good rev keeps serving and the
 * report lands in `last_compile_report`.
 *
 * ── Recall v2 (in progress) ────────────────────────────────────────────────
 * v2 promotes these rows from artifact to SOURCE: a map becomes one `recall`
 * NODE in the item tree and its cards are written here directly, checked in
 * the same transaction, so there is no compile step and no stale-rev note.
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 *
 * R1 (this schema) is contract only — the columns below marked v2 are added,
 * defaulted and unread. The v1 compiler still owns every row until the native
 * write path lands in R2. A native map's id is its `node_id`; a v1 map's id
 * is its root page id. No native map ever reuses a page id, which is why the
 * v1 page hooks (all of which key on page ids) can never reach a native row.
 */

export const recallMaps = pgTable(
  'recall_maps',
  {
    /** The map root page's node id — a map IS its root page. */
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    /** Stable entry name agents use: `recall_open('mantle-registry')`. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** One line for the catalog — when an agent should enter this map.
     *  From the root page's "Use when: …" paragraph; falls back to the title. */
    enterWhen: text('enter_when').default('').notNull(),
    /** Compiled node count. 0 = never compiled clean; the catalog hides it. */
    nodeCount: integer('node_count').default(0).notNull(),
    /** Last compile outcome. `false` means the SERVED rows are one rev behind
     *  the committed pages — the lint report says why. */
    lastCompileOk: boolean('last_compile_ok').default(true).notNull(),
    lastCompileReport: jsonb('last_compile_report').$type<unknown[]>(),
    /** v2: the map's `recall` node — the item in the tree. NULL for a v1 row
     *  that is still page-built. FK to nodes(id) ON DELETE CASCADE lives in
     *  the SQL migration, so deleting the item takes the map row and (via
     *  recall_nodes.map_id) its cards. */
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
    /** The source page's node id. */
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    /** The map this node serves under. Standalone prompts (a `recall`+`prompt`
     *  tagged page with no tree) compile as a one-node map of themselves. */
    mapId: uuid('map_id').notNull(),
    slug: text('slug').notNull(),
    /** 'index' (the root), 'knowledge', or 'prompt' (embedded for match). */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** Rendered markdown of the body, WITHOUT the Options section. Budgeted
     *  at compile (chars, not tokens — the repo's size-budget convention). */
    bodyMd: text('body_md').default('').notNull(),
    bodyChars: integer('body_chars').default(0).notNull(),
    /** Prompts: the matcher line recall_match shows before a caller commits
     *  context to the body. */
    useWhen: text('use_when').default('').notNull(),
    /** Parsed Options block: [{label, useWhen, targetSlug}]. Affordances,
     *  never commands — the lint owns that wording contract.
     *
     *  v2 adds `targetId` (the target card's id, so an edge survives a slug
     *  change) and `targetMap` (another map's slug, for a cross-map option to
     *  that map's entry card). `targetSlug` stays and is rewritten in the same
     *  transaction when a slug changes, so the read path is still one row with
     *  no join. Both are optional: a v1-compiled row carries neither. */
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
    /** v1: `pages.version` this row was compiled from — staleness at a
     *  glance. v2: the map `version` the card was written at. */
    sourceVersion: integer('source_version').default(0).notNull(),
    /** v2: card order in the editor (drag to reorder). */
    rank: integer('rank').default(0).notNull(),
    /** v2: an agent asked for prompt status and the owner has not confirmed.
     *  A pending card is not embedded and never matches. */
    promptPending: boolean('prompt_pending').default(false).notNull(),
    /** v2: slugs this card answered to before a rename. */
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
