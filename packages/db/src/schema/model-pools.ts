import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Curated model pools — the CURATOR's working store behind /models.
 *
 * One row = one curated model inside one pool. A pool is either the shared
 * `agents` pool (all conversational agents/specialists pick from it) or one
 * per ai_worker kind ('summarizer', 'tts', …; embedding is excluded — the
 * 768-dim singleton is not switchable). The pool id vocabulary lives in
 * server/web/lib/model-pools.ts, deliberately NOT a pgEnum: pools follow
 * worker kinds, and enum churn per new kind is migration churn for a purely
 * advisory list.
 *
 * A curated entry is the MODEL, not one provider's slug:
 *   - `routes`  — every way to reach it: [{provider, model}] (OpenRouter slug
 *     vs direct-provider slug differ; the picker later chooses the route the
 *     brain holds a key for).
 *   - `pricing` — a SNAPSHOT copied in at curation time ({inputPerM,
 *     outputPerM, currency, capturedAt, source}). Baked on purpose: a brain
 *     talking to Anthropic directly has no price catalog at runtime, and the
 *     $100 comparison must still work. Snapshots ship with the repo when the
 *     curated set is exported (packages/client-types, later phase).
 *
 * This table is the AUTHORING surface (drafting, ordering, ratings); the
 * repo-shipped template is generated FROM it via the export route.
 */
export const curatedModels = pgTable(
  'curated_models',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** Pool id: 'agents' or an ai_worker kind (never 'embedding'). */
    pool: text('pool').notNull(),
    /** Sort position within the pool (0-based; priciest-first by convention). */
    position: integer('position').notNull().default(0),
    /** Display name, e.g. 'Claude Sonnet 5'. */
    name: text('name').notNull(),
    /** Model vendor for grouping, e.g. 'Anthropic'. */
    vendor: text('vendor'),
    /** [{provider, model}] — one row per provider route (openrouter/anthropic/…). */
    routes: jsonb('routes').notNull().default([]),
    /** {inputPerM, outputPerM, currency, capturedAt, source} — snapshot, USD per 1M tokens. */
    pricing: jsonb('pricing'),
    /** Curated rating 1–5, optional. */
    rating: integer('rating'),
    /** Curator's note ('flagship', 'gets the job done', caveats). */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('curated_models_owner_pool_name_uq').on(t.ownerId, t.pool, t.name)],
);

export type CuratedModel = typeof curatedModels.$inferSelect;
export type NewCuratedModel = typeof curatedModels.$inferInsert;

/** One provider route to a curated model. */
export type CuratedRoute = { provider: string; model: string };

/** The pricing snapshot copied in at curation time. USD per 1M tokens. */
export type CuratedPricing = {
  inputPerM: number | null;
  outputPerM: number | null;
  currency: 'USD';
  capturedAt: string;
  /** Where the numbers came from, e.g. 'openrouter'. */
  source: string;
};
