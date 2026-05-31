import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys';

/**
 * Embedding config — THE single source of truth for how the brain embeds.
 *
 * One row per owner (the `owner_id` PK enforces the singleton). Everything
 * that calls `embed()` resolves from this row; nothing else in the system
 * may choose an embedder. This replaces the old sprawl of override points
 * (the `embedding` ai-worker kind, `MANTLE_EMBEDDING_MODEL` env, per-agent
 * `memory_config.embedding_model`, the extractor's `params.embedding_model`,
 * and per-call `opts.model`) — see migration 0061.
 *
 * The brain is vector-space-locked: every stored vector must come from the
 * SAME model, or cosine similarity across the corpus is meaningless. So
 * there is exactly ONE `model` + ONE `dimensions`. The primary and backup
 * are two *routes* to that same model — a different host/provider, NEVER a
 * different model. Backup is for availability (primary host down), not for a
 * second model. The `/settings/embedding` form enforces backup.model = model.
 */
export const embeddingConfig = pgTable('embedding_config', {
  /** One row per owner — the singleton key. */
  ownerId: uuid('owner_id').primaryKey(),
  /** The one embedding model identity. Changing it requires a full re-embed
   *  (and a schema migration if its dimension differs). */
  model: text('model').notNull(),
  /** The locked output dimension. Must equal the `vector(N)` column shape
   *  (768 since migration 0060). Both routes must emit exactly this. */
  dimensions: integer('dimensions').notNull().default(768),

  // ─── Primary route ───────────────────────────────────────────────────
  /** Provider id driving adapter dispatch (e.g. `local`, `openrouter`). */
  primaryProvider: text('primary_provider').notNull(),
  /** Optional per-route base URL override. Null = the adapter's default
   *  (e.g. the `local` adapter's `MANTLE_LOCAL_EMBEDDING_URL`). */
  primaryBaseUrl: text('primary_base_url'),
  /** Pinned API key, or null to fall through to `getApiKey(owner, provider)`.
   *  Keyless providers (`local`) leave this null. */
  primaryApiKeyId: uuid('primary_api_key_id').references(() => apiKeys.id, {
    onDelete: 'set null',
  }),

  // ─── Backup route (same model, different endpoint) ───────────────────
  /** When false, there is no failover — a primary outage hard-fails. */
  backupEnabled: boolean('backup_enabled').notNull().default(false),
  primaryLabel: text('primary_label'),
  backupProvider: text('backup_provider'),
  backupBaseUrl: text('backup_base_url'),
  backupApiKeyId: uuid('backup_api_key_id').references(() => apiKeys.id, {
    onDelete: 'set null',
  }),
  backupLabel: text('backup_label'),

  /** Stamped when a primary→backup failover last fired. Surfaced in the UI. */
  lastFailoverAt: timestamp('last_failover_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EmbeddingConfigRow = typeof embeddingConfig.$inferSelect;
