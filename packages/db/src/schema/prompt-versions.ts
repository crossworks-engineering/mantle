import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Prose version history for Agent Studio (docs/agent-studio.md Phase 2).
 *
 * Append-only history of every human-editable prompt field — agent
 * `system_prompt`, skill `instructions`, worker `system_prompt` /
 * `extraction_prompt`. One row per saved version: `(entity_type, entity_id,
 * field)` identifies the prose, `version` is monotonic within that key (v1 = the
 * original snapshot, captured lazily on first edit). Every edit AND every revert
 * appends a row — nothing is ever overwritten, so a live prompt is always one
 * revert away.
 *
 * Polymorphic: `entity_id` points at agents / skills / ai_workers, so there's no
 * FK. `trace_id` is reserved for Phase 4 (sandbox outcome-correlation).
 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** 'agent' | 'skill' | 'worker' (the prose registry's entity types). */
    entityType: text('entity_type').notNull(),
    /** The agents / skills / ai_workers row id. */
    entityId: uuid('entity_id').notNull(),
    /** 'system_prompt' | 'instructions' | 'extraction_prompt'. */
    field: text('field').notNull(),
    /** Monotonic within (entity_type, entity_id, field); 1 = original snapshot. */
    version: integer('version').notNull(),
    body: text('body').notNull(),
    /** "Why I changed this" — free text (what worked / what didn't). */
    note: text('note'),
    /** Who made the edit (single-user = ownerId; kept for future). */
    author: uuid('author'),
    /** Reserved: the Phase-4 sandbox run that produced/validated this version. */
    traceId: uuid('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('prompt_versions_key_version_uq').on(t.entityType, t.entityId, t.field, t.version),
    index('prompt_versions_key_idx').on(t.entityType, t.entityId, t.field),
    index('prompt_versions_owner_idx').on(t.ownerId),
  ],
);

export type PromptVersion = typeof promptVersions.$inferSelect;
export type NewPromptVersion = typeof promptVersions.$inferInsert;
