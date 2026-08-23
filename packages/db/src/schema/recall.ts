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
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('recall_maps_owner_slug_uq').on(t.ownerId, t.slug)],
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
     *  never commands — the lint owns that wording contract. */
    options: jsonb('options').$type<{ label: string; useWhen: string; targetSlug: string }[]>(),
    /** Prompts only; NULL elsewhere and while an embed is pending (the
     *  matcher skips NULLs, so a fresh prompt serves by slug immediately and
     *  becomes matchable seconds later). ivfflat index lives in the SQL
     *  migration only, per repo convention. */
    embedding: vector(768)('embedding'),
    /** `pages.version` this row was compiled from — staleness at a glance. */
    sourceVersion: integer('source_version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('recall_nodes_map_slug_uq').on(t.mapId, t.slug),
    index('recall_nodes_owner_kind_idx').on(t.ownerId, t.kind),
  ],
);

export type RecallMap = typeof recallMaps.$inferSelect;
export type RecallNode = typeof recallNodes.$inferSelect;

export const RECALL_NODE_KINDS = ['index', 'knowledge', 'prompt'] as const;
