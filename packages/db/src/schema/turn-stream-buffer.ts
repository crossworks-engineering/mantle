import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Short-lived replay buffer for live turn events (`TurnEvent`, see
 * `@mantle/client-types`). Postgres `NOTIFY` has no backlog, so a subscriber
 * whose SSE socket drops and reconnects (mobile background/foreground, a network
 * blip, navigation) misses every delta emitted during the gap. This table is the
 * backlog: the producer (`publishTurnEvent` in `@mantle/turn-stream`) writes each
 * event here keyed by `(turn_id, seq)`, and the SSE route replays `seq > N` for a
 * reconnecting client that sends `Last-Event-ID: N` before live-tailing.
 *
 * **Ephemeral by design.** Liveness, not durability — the authoritative answer is
 * the `assistant_messages` row, journaled separately by DBOS. A lost buffer row
 * is as cosmetic as a lost delta. Rows are swept after a short TTL (lazily, on
 * each turn-start, by the producer), so the table stays small.
 *
 * `turn_id` is the client-minted idempotency-key (also the DBOS workflow id and
 * the stream correlation id), so it's `text`, not a generated uuid. `seq` is the
 * per-turn monotonic cursor; `(turn_id, seq)` is the natural key (and the index
 * the replay query range-scans). `event` is the full `TurnEvent`, typed loosely
 * here because `@mantle/db` deliberately carries no `@mantle/client-types` dep
 * (same as `assistant_messages.data`); the cast lives in the reader.
 */
export const turnStreamBuffer = pgTable(
  'turn_stream_buffer',
  {
    turnId: text('turn_id').notNull(),
    seq: integer('seq').notNull(),
    ownerId: uuid('owner_id').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Natural key + the index the replay query range-scans (turn_id =, seq >).
    primaryKey({ columns: [t.turnId, t.seq] }),
    // Drives the lazy TTL sweep (`delete where created_at < now() - interval`).
    index('turn_stream_buffer_created_idx').on(t.createdAt),
  ],
);

export type TurnStreamBufferRow = typeof turnStreamBuffer.$inferSelect;
export type NewTurnStreamBufferRow = typeof turnStreamBuffer.$inferInsert;
