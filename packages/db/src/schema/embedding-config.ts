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

  // ─── Performance / throughput tuning (all nullable → fall back to env →
  //     code default; see /settings/embedding "Performance & throughput") ───
  /** Max concurrent extraction jobs (pg-boss workers). Null → EXTRACT_CONCURRENCY
   *  env → 2. Drop to 1 on a CPU-only embedder so jobs don't contend for cores.
   *  Boot-time: applies after the agent restarts. */
  extractionConcurrency: integer('extraction_concurrency'),
  /** Minutes a single extraction may run before pg-boss expires + retries the
   *  job. Null → MANTLE_EXTRACT_EXPIRE_MIN env → 60. Boot-time. */
  extractionTimeBudgetMinutes: integer('extraction_time_budget_minutes'),
  /** Texts per local-embedder HTTP request. Null → MANTLE_LOCAL_EMBED_BATCH env
   *  → 16. Smaller (8) clears the timeout on a slow vCPU. Applies live. */
  localEmbedBatchSize: integer('local_embed_batch_size'),
  /** Per-request timeout (ms) for the local embedder. Null →
   *  MANTLE_LOCAL_EMBED_TIMEOUT_MS env → 120000. Applies live. */
  localEmbedRequestTimeoutMs: integer('local_embed_request_timeout_ms'),

  /** Stamped when a primary→backup failover last fired. Surfaced in the UI. */
  lastFailoverAt: timestamp('last_failover_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EmbeddingConfigRow = typeof embeddingConfig.$inferSelect;
