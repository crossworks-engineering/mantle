import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per member chat turn, written when the turn is QUEUED (migration
 * 0182, audit F09). The member daily cap counts these, not the inbound
 * `team_messages` rows the workflow writes later, so turns still waiting on a
 * busy queue count too. `turn_id` is the workflow id (login plus the
 * Idempotency-Key), unique: a retry with the same key is the same turn and is
 * not counted twice. Rows older than a week are pruned as new ones land.
 *
 * `login_id` FKs auth.users ON DELETE CASCADE in the SQL (Drizzle manages
 * public.* only). Written and read through systemDb; no viewer role reads it.
 */
export const memberTurnLedger = pgTable(
  'member_turn_ledger',
  {
    turnId: text('turn_id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    loginId: uuid('login_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('member_turn_ledger_login_idx').on(t.loginId, t.createdAt)],
);

export type MemberTurnLedgerRow = typeof memberTurnLedger.$inferSelect;
