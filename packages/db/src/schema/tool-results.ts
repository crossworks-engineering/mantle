import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { vector } from './_shared';

/**
 * Ephemeral spill store for oversized tool results — the "L6" of the
 * tool-loop. A large tool result (a child agent's full synthesis, a big
 * file_read, a wide search) would otherwise have to live entirely inside the
 * conversation, where it bloats context, is re-sent on every loop iteration,
 * and gets truncated to survive. Instead the full result is stored here and
 * the model gets a compact handle + preview; it dereferences on demand via
 * the `read_result` builtin (page / grep / semantic query).
 *
 * Same store-full / index-compact / dereference-on-demand principle as the
 * brain (content_store ↔ content_index) and recall (message archive ↔
 * conversation_digest) — see architecture §9l. Deliberately NOT a `nodes`
 * row: this is transient working state, not memory, and must never reach the
 * extractor or brain search. TTL-cleaned by age.
 */
export const toolResults = pgTable(
  'tool_results',
  {
    /** Handle the model sees, e.g. `tr_9f3a1c2b`. App-generated. */
    id: text('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    /** Trace this spill happened in — for debugging + cleanup. */
    traceId: uuid('trace_id'),
    /** Which tool produced the result (for the envelope + traces). */
    toolSlug: text('tool_slug').notNull(),
    /** The full, untruncated tool output. */
    content: text('content').notNull(),
    /** Byte length of `content` — surfaced in the envelope. */
    bytes: integer('bytes').notNull(),
    /** Whether the lazy chunk+embed pass has run (only the first semantic
     *  `query` triggers it; page/grep never need it). */
    chunked: boolean('chunked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives TTL cleanup ("delete where created_at < now() - interval").
    index('tool_results_owner_created_idx').on(t.ownerId, t.createdAt),
  ],
);

/**
 * Lazy retrieval chunks for one spilled result, built on the first semantic
 * `read_result(query)` call. Queries are always scoped to a single
 * `result_id` (a handful of chunks), so no ivfflat index is needed — unlike
 * the brain's `content_chunks`, which searches across everything. Cascades
 * when the parent result is deleted.
 */
export const toolResultChunks = pgTable(
  'tool_result_chunks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    resultId: text('result_id')
      .notNull()
      .references(() => toolResults.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    embedding: vector(768)('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('tool_result_chunks_result_idx').on(t.resultId)],
);

export type ToolResult = typeof toolResults.$inferSelect;
export type NewToolResult = typeof toolResults.$inferInsert;
export type ToolResultChunk = typeof toolResultChunks.$inferSelect;
export type NewToolResultChunk = typeof toolResultChunks.$inferInsert;
